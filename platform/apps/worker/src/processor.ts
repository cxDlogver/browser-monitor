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

export class EventProcessor {
  constructor(private readonly database: DatabaseHandle) {}

  // 入口：按 event.payload.type 分派到性能/页面/自定义信号三类投影，统一开事务并回填 processed_at
  async process(projectId: string, event: TelemetryEventV3): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      if (event.payload.type === 'performance') {
        await this.processPerformance(client, projectId, event, event.payload);
      } else if (event.payload.type === 'view') {
        await this.processView(client, projectId, event, event.payload);
      } else {
        await this.processCustomSignal(client, projectId, event, event.payload);
      }
      await client.query(
        `UPDATE telemetry_events SET processed_at = now()
         WHERE project_id = $1 AND event_id = $2 AND occurred_at = $3`,
        [projectId, event.eventId, new Date(event.occurredAt)],
      );
      await client.query('COMMIT');
    } catch (error) {
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
    const timed = payload.type === 'trace' || payload.type === 'span' ? payload : undefined;
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

    const metrics = [
      ...Object.entries(payload.metrics ?? {}).map(([name, metric]) => ({ name, ...metric })),
      ...(timed ? [{ name: 'duration', value: timed.durationMs, unit: 'ms' }] : []),
    ];
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
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`performance:${projectId}:${payload.sampleId}`],
    );
    const existing = await client.query<{ observed_at: Date; sequence: number; state: string }>(
      `SELECT observed_at, sequence, state FROM performance_samples
       WHERE project_id = $1 AND sample_id = $2
       ORDER BY observed_at DESC LIMIT 1 FOR UPDATE`,
      [projectId, payload.sampleId],
    );
    const current = existing.rows[0];
    if (!shouldApplySequence(current?.sequence ?? null, payload.sequence)) return;

    const threshold = await this.thresholds(client, projectId);
    const serverRating = rateMetric(payload.name, payload.value, threshold.thresholds);
    const clientRating = 'clientRating' in payload ? payload.clientRating : null;
    const detail = this.performanceDetail(payload);
    const viewEnded = await client.query(
      `SELECT 1 FROM view_records WHERE project_id = $1 AND view_id = $2 AND ended_at IS NOT NULL LIMIT 1`,
      [projectId, event.context.viewId],
    );
    // A higher late sequence may correct the value, but it must never reopen a
    // sample that has already reached its terminal state.
    const state =
      payload.state === 'final' || current?.state === 'final' || viewEnded.rowCount === 1
        ? 'final'
        : 'provisional';

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
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`view:${projectId}:${payload.viewId}`],
    );
    const existing = await client.query<{ started_at: Date }>(
      `SELECT started_at FROM view_records WHERE project_id = $1 AND view_id = $2
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [projectId, payload.viewId],
    );
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
