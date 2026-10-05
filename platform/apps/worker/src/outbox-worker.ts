// Outbox 消费 Worker：以「领取 → 处理」为主循环，从 PostgreSQL 的 outbox_tasks 中安全领取
// 待投影任务（FOR UPDATE SKIP LOCKED），交给 EventProcessor 完成领域投影；成功后标记 completed
// 并递增 Analytics 缓存版本，失败则指数退避重试，超过 8 次进入 dead_letter_tasks。
// 此外还承担两个后台维护任务：终结超时的 provisional 性能样本、定期清理过期数据。
import type { DatabaseHandle } from '@browser-monitor/database';
import type { TelemetryEventV3 } from '@browser-monitor/protocol';
import type { WorkerConfig } from '@browser-monitor/shared';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { EventProcessor } from './processor.js';

// claim() 返回的一条待处理任务（outbox_tasks 的列子集）
interface OutboxTask {
  id: string; // outbox_tasks 主键
  project_id: string; // 所属项目
  event_id: string; // 对应的协议事件 id
  event: TelemetryEventV3; // 待投影的（服务端已脱敏）协议事件
  attempts: number; // 领取后的累计尝试次数（claim 时已 +1）
}

export class OutboxWorker {
  // 本进程唯一标识，写入 locked_by：用于判断任务是否仍归自己持有（避免误更新他人任务）
  private readonly workerId = `worker-${randomUUID()}`;
  // 领域投影器：在独立事务里把事件写入各投影表并更新 telemetry_events.processed_at
  private readonly processor: EventProcessor;
  // 主循环开关；stop() 置 false 后，当前批次处理完即退出
  private running = false;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly redis: Redis,
    private readonly config: WorkerConfig,
  ) {
    this.processor = new EventProcessor(database);
  }

  // 主循环：领取一批 → 空则等待 → 否则按每 10 条一组并发处理。
  // 领取规模由 WORKER_BATCH_SIZE 决定，单组并发固定为 10，两者不是同一个参数。
  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      const tasks = await this.claim();
      if (tasks.length === 0) {
        // 没有可领取的任务：按 WORKER_POLL_INTERVAL_MS 休眠后再轮询（短轮询 Pull，非 Broker 推送）
        await this.delay(this.config.WORKER_POLL_INTERVAL_MS);
        continue;
      }
      // 已领取的批次切成 10 条一组并发执行，避免一次性打开过多数据库连接、放大锁竞争
      for (let index = 0; index < tasks.length; index += 10) {
        await Promise.all(tasks.slice(index, index + 10).map((task) => this.handle(task)));
      }
    }
  }

  // 请求停止：只把开关置 false；已进入当前批次的已领取任务仍会被处理完（配合优雅关闭）
  stop(): void {
    this.running = false;
  }

  // 超时兜底：把 5 分钟未更新的 provisional 性能样本统一置为 final，并对涉及项目递增缓存版本；
  // 返回被终结的样本数。由 main.ts 每 60 秒调用一次（应对浏览器被强杀、Beacon 丢失等情况）。
  async finalizeStaleSamples(): Promise<number> {
    const result = await this.database.pool.query<{ project_id: string }>(
      `UPDATE performance_samples SET state = 'final'
       WHERE state = 'provisional' AND last_updated_at < now() - INTERVAL '5 minutes'
       RETURNING project_id`,
    );
    // 对每个受影响项目去重后版本 +1，使看板旧缓存失效
    for (const projectId of new Set(result.rows.map((row) => row.project_id))) {
      await this.redis.incr(`analytics:version:${projectId}`);
    }
    return result.rowCount ?? 0;
  }

  // 定期清理：删除 7 天前已完成的任务，以及已过期的用户会话；由 main.ts 每小时调用一次
  async housekeeping(): Promise<void> {
    await this.database.pool.query(
      `DELETE FROM outbox_tasks WHERE status = 'completed' AND completed_at < now() - INTERVAL '7 days'`,
    );
    await this.database.pool.query(
      `DELETE FROM user_sessions WHERE expires_at < now()`,
    );
  }

  // 原子领取一批任务。候选条件二选一：到期的 pending，或锁定超过 5 分钟的 processing（stale 回收）。
  // FOR UPDATE SKIP LOCKED 让并发 Worker 跳过彼此已锁定的行——既不重复处理也不互相等待；
  // 领取与状态变更在同一条 SQL 内完成，并写入 locked_by、递增 attempts。
  private async claim(): Promise<OutboxTask[]> {
    const result = await this.database.pool.query<OutboxTask>(
      `WITH candidates AS (
         SELECT id FROM outbox_tasks
         WHERE (
           status = 'pending' AND available_at <= now()
         ) OR (
           status = 'processing' AND locked_at < now() - INTERVAL '5 minutes'
         )
         ORDER BY available_at, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_tasks o SET
         status = 'processing', locked_at = now(), locked_by = $2, attempts = attempts + 1
       FROM candidates c WHERE o.id = c.id
       RETURNING o.id, o.project_id, o.event_id, o.event, o.attempts`,
      [this.config.WORKER_BATCH_SIZE, this.workerId],
    );
    return result.rows;
  }

  // 处理单条任务：领域投影（独立事务）→ 标记 outbox completed → 递增缓存版本。
  // 三步同处一个 try，任一步失败都进入 fail()（包括 Redis 递增失败）。
  private async handle(task: OutboxTask): Promise<void> {
    try {
      await this.processor.process(task.project_id, task.event);
      // 仅当任务仍由本 Worker 持有时才标记完成（locked_by 兜底，防止重复领取后误更新）
      await this.database.pool.query(
        `UPDATE outbox_tasks SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL
         WHERE id = $1 AND locked_by = $2`,
        [task.id, this.workerId],
      );
      await this.redis.incr(`analytics:version:${task.project_id}`);
    } catch (error) {
      await this.fail(task, error);
    }
  }

  // 失败处理：达到 8 次尝试则「写死信 + 置 failed」在同一事务内原子提交；
  // 否则回到 pending，并按指数退避设置下次可领取时间。
  private async fail(task: OutboxTask, error: unknown): Promise<void> {
    // 记录错误堆栈（无 stack 时退化为 message），并统一截断到 8000 字符防超长
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    if (task.attempts >= 8) {
      // 死信明细与 outbox 状态必须原子提交，避免「有死信但任务仍待执行」等不一致状态
      const client = await this.database.pool.connect();
      try {
        await client.query('BEGIN');
        // 按主键冲突时更新：同一任务反复失败不会重复插行，只刷新次数与错误
        await client.query(
          `INSERT INTO dead_letter_tasks(id, project_id, event_id, event, attempts, last_error)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6)
           ON CONFLICT (id) DO UPDATE SET attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error, failed_at = now()`,
          [task.id, task.project_id, task.event_id, JSON.stringify(task.event), task.attempts, message.slice(0, 8_000)],
        );
        await client.query(
          `UPDATE outbox_tasks SET status = 'failed', last_error = $2, locked_at = NULL, locked_by = NULL
           WHERE id = $1`,
          [task.id, message.slice(0, 8_000)],
        );
        await client.query('COMMIT');
      } catch (nested) {
        await client.query('ROLLBACK');
        throw nested;
      } finally {
        client.release();
      }
      return;
    }
    // 指数退避（秒）：min(300, 2^attempts)，即 2/4/8/…/256/300 封顶；任务回 pending 等待重新领取
    const backoffSeconds = Math.min(300, 2 ** task.attempts);
    await this.database.pool.query(
      `UPDATE outbox_tasks SET status = 'pending', available_at = now() + ($2 * INTERVAL '1 second'),
         last_error = $3, locked_at = NULL, locked_by = NULL
       WHERE id = $1`,
      [task.id, backoffSeconds, message.slice(0, 8_000)],
    );
  }

  // 异步休眠：空轮询时使用
  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
