import type { DatabaseHandle } from '@browser-monitor/database';
import type { TelemetryEventV2 } from '@browser-monitor/protocol';
import type { WorkerConfig } from '@browser-monitor/shared';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { EventProcessor } from './processor.js';

interface OutboxTask {
  id: string;
  project_id: string;
  event_id: string;
  event: TelemetryEventV2;
  attempts: number;
}

export class OutboxWorker {
  private readonly workerId = `worker-${randomUUID()}`;
  private readonly processor: EventProcessor;
  private running = false;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly redis: Redis,
    private readonly config: WorkerConfig,
  ) {
    this.processor = new EventProcessor(database);
  }

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      const tasks = await this.claim();
      if (tasks.length === 0) {
        await this.delay(this.config.WORKER_POLL_INTERVAL_MS);
        continue;
      }
      for (let index = 0; index < tasks.length; index += 10) {
        await Promise.all(tasks.slice(index, index + 10).map((task) => this.handle(task)));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  async finalizeStaleSamples(): Promise<number> {
    const result = await this.database.pool.query<{ project_id: string }>(
      `UPDATE performance_samples SET state = 'final'
       WHERE state = 'provisional' AND last_updated_at < now() - INTERVAL '5 minutes'
       RETURNING project_id`,
    );
    for (const projectId of new Set(result.rows.map((row) => row.project_id))) {
      await this.redis.incr(`analytics:version:${projectId}`);
    }
    return result.rowCount ?? 0;
  }

  async housekeeping(): Promise<void> {
    await this.database.pool.query(
      `DELETE FROM outbox_tasks WHERE status = 'completed' AND completed_at < now() - INTERVAL '7 days'`,
    );
    await this.database.pool.query(
      `DELETE FROM user_sessions WHERE expires_at < now()`,
    );
  }

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

  private async handle(task: OutboxTask): Promise<void> {
    try {
      await this.processor.process(task.project_id, task.event);
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

  private async fail(task: OutboxTask, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    if (task.attempts >= 8) {
      const client = await this.database.pool.connect();
      try {
        await client.query('BEGIN');
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
    const backoffSeconds = Math.min(300, 2 ** task.attempts);
    await this.database.pool.query(
      `UPDATE outbox_tasks SET status = 'pending', available_at = now() + ($2 * INTERVAL '1 second'),
         last_error = $3, locked_at = NULL, locked_by = NULL
       WHERE id = $1`,
      [task.id, backoffSeconds, message.slice(0, 8_000)],
    );
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
