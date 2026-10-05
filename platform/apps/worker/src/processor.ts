// Worker 的事件投影器：把 outbox 里的原始 telemetry_events 按类型展开写入各类聚合/采样表，
// 并在成功后回填 telemetry_events.processed_at。性能样本与页面视图用事务级咨询锁串行化，
// 避免多 Worker 并发对同一 sample/view 产生重复或乱序写入。
import type { DatabaseHandle } from '@browser-monitor/database';
import type {
  CustomSignalPayload,
  PerformanceMetricName,
  PerformancePayload,
  TelemetryEventV3,
  ViewPayload,
} from '@browser-monitor/protocol';
import {
  DEFAULT_THRESHOLDS,
  mergeThresholds,
  rateMetric,
  type MetricThreshold,
  type RatedMetricName,
  type ThresholdSet,
} from '@browser-monitor/shared';
import type { PoolClient } from 'pg';

import { shouldApplySequence } from './sequence.js';

// 阈值上下文：threshold_versions 的 id（可能为空表示用全局默认）与合并后的完整阈值集
interface ThresholdContext {
  id: string | null;
  thresholds: ThresholdSet;
}

// 事件投影器：本身无状态（每次处理自带事务），可被多个 Worker 实例共用同一份逻辑
export class EventProcessor {
  constructor(private readonly database: DatabaseHandle) {}

  // 入口：按 event.payload.type 分派到性能/页面/自定义信号三类投影，统一开事务并回填 processed_at
  async process(projectId: string, event: TelemetryEventV3): Promise<void> {
    // 单条事件一个独立事务：投影写入与 processed_at 更新要么一起成功、要么一起回滚
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // 三类投影覆盖全部 payload：performance / view / 其余（event、trace、span 归为自定义信号）
      if (event.payload.type === 'performance') {
        await this.processPerformance(client, projectId, event, event.payload);
      } else if (event.payload.type === 'view') {
        await this.processView(client, projectId, event, event.payload);
      } else {
        await this.processCustomSignal(client, projectId, event, event.payload);
      }
      // 回填 processed_at：标记该原始事件已完成领域投影（原始事件页据此区分"已接收/已处理"）；
      // 定位键含 occurred_at，因为 telemetry_events 是 Timescale 分区表
      await client.query(
        `UPDATE telemetry_events SET processed_at = now()
         WHERE project_id = $1 AND event_id = $2 AND occurred_at = $3`,
        [projectId, event.eventId, new Date(event.occurredAt)],
      );
      await client.query('COMMIT');
    } catch (error) {
      // 任一步失败整条回滚，避免"投影已写但 processed_at 未更新"的半完成状态
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 自定义信号投影：写入 custom_signal_samples（trace/span 额外记录起止时间、时长、链路 id），
  // 再把 payload.metrics 及 trace/span 的 duration 逐条展开写入 custom_metric_samples
  private async processCustomSignal(
    client: PoolClient,
    projectId: string,
    event: TelemetryEventV3,
    payload: CustomSignalPayload,
  ): Promise<void> {
    // 只有 trace/span 才有 startedAt/endedAt/durationMs/status；event 类型为 undefined
    const timed = payload.type === 'trace' || payload.type === 'span' ? payload : undefined;
    // 写入信号主表：靠唯一键去重，重复执行命中冲突即忽略（幂等）
    await client.query(
      `INSERT INTO custom_signal_samples(
        project_id, event_id, occurred_at, kind, name, status, started_at, ended_at,
        duration_ms, trace_id, span_id, parent_span_id, environment, app_version,
        route_name, session_id, view_id, user_hash, attributes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
      ON CONFLICT DO NOTHING`,
      [
        projectId,
        event.eventId,
        new Date(event.occurredAt),
        payload.type,
        event.name,
        timed?.status ?? null,
        timed ? new Date(timed.startedAt) : null,
        timed ? new Date(timed.endedAt) : null,
        timed?.durationMs ?? null,
        event.correlation.traceId ?? null,
        event.correlation.spanId ?? null,
        event.correlation.parentSpanId ?? null,
        event.app.environment,
        event.app.version,
        event.context.routeName,
        event.context.sessionId,
        event.context.viewId,
        event.context.user?.id ?? null,
        JSON.stringify(payload.attributes ?? {}),
      ],
    );

    // 展开为待写入的指标行：payload.metrics 逐项 + trace/span 额外补一条 duration
    // （duration 是协议保留字段，业务 metrics 不允许同名，故不会冲突）
    const metrics = [
      ...Object.entries(payload.metrics ?? {}).map(([name, metric]) => ({ name, ...metric })),
      ...(timed ? [{ name: 'duration', value: timed.durationMs, unit: 'ms' }] : []),
    ];
    // 逐条写入 custom_metric_samples，同样靠唯一键去重保证重复执行幂等
    for (const metric of metrics) {
      await client.query(
        `INSERT INTO custom_metric_samples(
          project_id, event_id, occurred_at, signal_kind, signal_name, metric_name,
          unit, value, environment, app_version, route_name, session_id, view_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT DO NOTHING`,
        [
          projectId,
          event.eventId,
          new Date(event.occurredAt),
          payload.type,
          event.name,
          metric.name,
          metric.unit,
          metric.value,
          event.app.environment,
          event.app.version,
          event.context.routeName,
          event.context.sessionId,
          event.context.viewId,
        ],
      );
    }
  }
  // 性能样本投影：用咨询锁串行化同一 sample 的并发修订，按 sequence 决定是否覆盖，
  // 计算服务端评级并结合客户端评级/视图是否结束判定终态，最后按"是否存在"决定插入或更新
  private async processPerformance(
    client: PoolClient,
    projectId: string,
    event: TelemetryEventV3,
    payload: PerformancePayload,
  ): Promise<void> {
    // Multiple Worker instances may receive provisional/final revisions for the
    // same sample at the same time. A transaction-scoped advisory lock makes
    // the sequence check and write one atomic, cross-process critical section.
    // 咨询锁 Key = performance:<projectId>:<sampleId>，随事务提交自动释放
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`performance:${projectId}:${payload.sampleId}`],
    );
    // 锁内读取当前样本，读到的即最新状态；observed_at 作为后续 UPDATE 的定位键
    const existing = await client.query<{ observed_at: Date; sequence: number; state: string }>(
      `SELECT observed_at, sequence, state FROM performance_samples
       WHERE project_id = $1 AND sample_id = $2
       ORDER BY observed_at DESC LIMIT 1 FOR UPDATE`,
      [projectId, payload.sampleId],
    );
    const current = existing.rows[0];
    // 只接受更高 sequence：重复投递与乱序到达在此被静默丢弃（At-least-once 下的幂等关键）
    if (!shouldApplySequence(current?.sequence ?? null, payload.sequence)) return;

    // 取生效阈值（项目覆盖优先），据此计算服务端评级；客户端评级仅作对照保存
    const threshold = await this.thresholds(client, projectId);
    const serverRating = rateMetric(payload.name, payload.value, threshold.thresholds);
    const clientRating = 'clientRating' in payload ? payload.clientRating : null;
    const detail = this.performanceDetail(payload);
    // 该 View 是否已结束：结束则本次样本直接进入终态
    const viewEnded = await client.query(
      `SELECT 1 FROM view_records WHERE project_id = $1 AND view_id = $2 AND ended_at IS NOT NULL LIMIT 1`,
      [projectId, event.context.viewId],
    );
    // A higher late sequence may correct the value, but it must never reopen a
    // sample that has already reached its terminal state.
    // final 是单向终态：SDK 已定稿 / 库里已是 final / View 已结束，任一成立即 final，永不回退
    const state =
      payload.state === 'final' || current?.state === 'final' || viewEnded.rowCount === 1
        ? 'final'
        : 'provisional';

    // 首次观测：INSERT，observed_at 用本次 occurredAt 冻结，后续修订都原位 UPDATE
    if (!current) {
      await client.query(
        `INSERT INTO performance_samples(
          project_id, sample_id, observed_at, last_updated_at, name, value, unit,
          sequence, state, server_rating, client_rating, threshold_version_id,
          environment, app_version, route_name, session_id, view_id, detail
        ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
        [
          projectId,
          payload.sampleId,
          new Date(event.occurredAt),
          payload.name,
          payload.value,
          payload.unit,
          payload.sequence,
          state,
          serverRating,
          clientRating,
          threshold.id,
          event.app.environment,
          event.app.version,
          event.context.routeName,
          event.context.sessionId,
          event.context.viewId,
          JSON.stringify(detail),
        ],
      );
      return;
    }

    // 已有样本：原位 UPDATE（以 project_id + sample_id + 冻结的 observed_at 定位），刷新值/sequence/评级/detail
    await client.query(
      `UPDATE performance_samples SET
         last_updated_at = $4, value = $5, sequence = $6, state = $7,
         server_rating = $8, client_rating = $9, threshold_version_id = $10,
         environment = $11, app_version = $12, route_name = $13,
         session_id = $14, view_id = $15, detail = $16::jsonb
       WHERE project_id = $1 AND sample_id = $2 AND observed_at = $3`,
      [
        projectId,
        payload.sampleId,
        current.observed_at,
        new Date(event.occurredAt),
        payload.value,
        payload.sequence,
        state,
        serverRating,
        clientRating,
        threshold.id,
        event.app.environment,
        event.app.version,
        event.context.routeName,
        event.context.sessionId,
        event.context.viewId,
        JSON.stringify(detail),
      ],
    );
  }

  // 页面视图投影：咨询锁串行化同一 view 的 start/end；首条写 view_records，
  // view.end 则补 ended_at/route/url，并把该 view 下仍为 provisional 的性能样本置为 final
  private async processView(
    client: PoolClient,
    projectId: string,
    event: TelemetryEventV3,
    payload: ViewPayload,
  ): Promise<void> {
    // Route transitions can enqueue view.start and view.end close together.
    // Serialize both projections so a concurrent insert cannot create a second
    // record or overwrite the terminal state with an older observation.
    // 咨询锁 Key = view:<projectId>:<viewId>
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`view:${projectId}:${payload.viewId}`],
    );
    // 锁内读现有视图记录，保证 start/end 在跨进程下被串行化
    const existing = await client.query<{ started_at: Date }>(
      `SELECT started_at FROM view_records WHERE project_id = $1 AND view_id = $2
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [projectId, payload.viewId],
    );
    // 首条（通常是 view.start）：INSERT；若已带 endedAt 也一并写入
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO view_records(
          project_id, view_id, started_at, ended_at, route_name, url, source,
          environment, app_version, session_id, user_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          projectId,
          payload.viewId,
          new Date(payload.startedAt),
          payload.endedAt ? new Date(payload.endedAt) : null,
          payload.routeName,
          payload.url,
          payload.source,
          event.app.environment,
          event.app.version,
          event.context.sessionId,
          event.context.user?.id ?? null,
        ],
      );
    } else if (payload.name === 'view.end' && payload.endedAt !== undefined) {
      // 已存在且收到 view.end：按冻结的 started_at 定位，补写 ended_at 与路由信息
      await client.query(
        `UPDATE view_records SET ended_at = $4, route_name = $5, url = $6
         WHERE project_id = $1 AND view_id = $2 AND started_at = $3`,
        [
          projectId,
          payload.viewId,
          existing.rows[0].started_at,
          new Date(payload.endedAt),
          payload.routeName,
          payload.url,
        ],
      );
    }

    // view.end 兜底：把该 View 下仍为 provisional 的性能样本一并终结为 final，并补齐 route_name
    if (payload.name === 'view.end') {
      await client.query(
        `UPDATE performance_samples SET state = 'final', route_name = $3
         WHERE project_id = $1 AND view_id = $2 AND state = 'provisional'`,
        [projectId, payload.viewId, payload.routeName],
      );
    }
  }

  // 取生效阈值：优先项目自建 active 版本；若无则回退全局默认（project_id IS NULL）；
  // 项目覆盖项经 mergeThresholds 与 DEFAULT_THRESHOLDS 合并成完整集合
  private async thresholds(client: PoolClient, projectId: string): Promise<ThresholdContext> {
    // 一条查询取"项目 active 版本优先，否则全局默认"：NULLS LAST 让项目行排在前
    const result = await client.query<{ id: string; config: Partial<Record<RatedMetricName, Partial<MetricThreshold>>> }>(
      `SELECT id, config FROM threshold_versions
       WHERE (project_id = $1 AND active)
          OR (project_id IS NULL AND active AND NOT EXISTS (
            SELECT 1 FROM threshold_versions p WHERE p.project_id = $1 AND p.active
          ))
       ORDER BY project_id NULLS LAST LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    // 命中则把项目覆盖项合并进默认阈值集；完全未配置时退回全局默认常量
    return row
      ? { id: row.id, thresholds: mergeThresholds(row.config) }
      : { id: null, thresholds: DEFAULT_THRESHOLDS };
  }

  // 性能样本 detail 列：FPS/LoAF 保留完整 detail；其余核心指标只保留 delta 与导航上下文，缩减体积
  private performanceDetail(payload: PerformancePayload): Record<string, unknown> {
    if (payload.name === 'FPS' || payload.name === 'LoAF') return payload.detail;
    return {
      delta: payload.delta,
      navigationType: payload.navigationType,
      navigationId: payload.navigationId,
    };
  }
}
