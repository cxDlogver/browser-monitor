import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseHandle } from '@browser-monitor/database';

import { DATABASE } from '../infrastructure/tokens.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { AnalyticsFilters } from './analytics.service.js';

export type SignalKind = 'event' | 'trace' | 'span';
export type Aggregation = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p90' | 'p95' | 'p99';

export interface SignalSelection {
  kind: SignalKind;
  name: string;
  metric?: string | undefined;
  unit?: string | undefined;
  aggregation: Aggregation;
}

interface SqlFilter {
  where: string;
  values: unknown[];
}

const PERCENTILES: Partial<Record<Aggregation, number>> = {
  p50: 0.5,
  p75: 0.75,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
};

function aggregateSql(aggregation: Aggregation): string {
  if (aggregation === 'count') return 'sum(sample_count)';
  if (aggregation === 'sum') return 'sum(total)';
  if (aggregation === 'avg') return 'sum(total) / NULLIF(sum(sample_count), 0)';
  if (aggregation === 'min') return 'min(minimum)';
  if (aggregation === 'max') return 'max(maximum)';
  return `approx_percentile(${PERCENTILES[aggregation]}, rollup(value_percentiles))`;
}

function number(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class CustomSignalsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly projects: ProjectsService,
  ) {}

  private rollupSuffix(filters: AnalyticsFilters): '1m' | '1h' {
    return filters.from.getTime() < Date.now() - 29 * 24 * 60 * 60_000 ? '1h' : '1m';
  }

  private filter(
    alias: string,
    projectId: string,
    filters: AnalyticsFilters,
    timeColumn: string,
  ): SqlFilter {
    const values: unknown[] = [projectId, filters.from, filters.to];
    const clauses = [
      `${alias}.project_id = $1`,
      `${alias}.${timeColumn} >= $2`,
      `${alias}.${timeColumn} < $3`,
    ];
    for (const [column, value] of [
      ['environment', filters.environment],
      ['app_version', filters.version],
      ['route_name', filters.routeName],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${alias}.${column} = $${values.length}`);
      }
    }
    return { where: clauses.join(' AND '), values };
  }

  private selectSignal(filter: SqlFilter, selection: SignalSelection, alias: string): SqlFilter {
    const values = [...filter.values, selection.kind, selection.name];
    return {
      where: `${filter.where} AND ${alias}.kind = $${values.length - 1} AND ${alias}.name = $${values.length}`,
      values,
    };
  }

  private selectMetric(filter: SqlFilter, selection: SignalSelection, alias: string): SqlFilter {
    const values = [...filter.values, selection.kind, selection.name, selection.metric, selection.unit];
    const prefix = 'signal_';
    return {
      where: `${filter.where} AND ${alias}.${prefix}kind = $${values.length - 3}` +
        ` AND ${alias}.${prefix}name = $${values.length - 2}` +
        ` AND ${alias}.metric_name = $${values.length - 1} AND ${alias}.unit = $${values.length}`,
      values,
    };
  }

  async list(userId: string, projectId: string, filters: AnalyticsFilters): Promise<unknown[]> {
    await this.projects.requireAccess(userId, projectId);
    const suffix = this.rollupSuffix(filters);
    const signalFilter = this.filter('s', projectId, filters, 'bucket');
    const metricFilter = this.filter('m', projectId, filters, 'bucket');
    const [signals, metrics] = await Promise.all([
      this.database.pool.query(
        `SELECT kind, name, sum(signal_count)::bigint AS count,
          distinct_count(rollup(session_hll))::bigint AS session_count,
          max(latest_at) AS last_seen_at
         FROM custom_signal_rollup_${suffix} s WHERE ${signalFilter.where}
         GROUP BY kind, name ORDER BY last_seen_at DESC, name`,
        signalFilter.values,
      ),
      this.database.pool.query(
        `SELECT signal_kind, signal_name, metric_name, unit
         FROM custom_metric_rollup_${suffix} m WHERE ${metricFilter.where}
         GROUP BY signal_kind, signal_name, metric_name, unit`,
        metricFilter.values,
      ),
    ]);
    const metricMap = new Map<string, Array<{ name: string; unit: string }>>();
    for (const row of metrics.rows) {
      const key = `${row.signal_kind}:${row.signal_name}`;
      const bucket = metricMap.get(key) ?? [];
      bucket.push({ name: row.metric_name, unit: row.unit });
      metricMap.set(key, bucket);
    }
    return signals.rows.map((row) => ({
      kind: row.kind,
      name: row.name,
      count: Number(row.count),
      sessionCount: Number(row.session_count),
      lastSeenAt: row.last_seen_at,
      metrics: metricMap.get(`${row.kind}:${row.name}`) ?? [],
    }));
  }

  async detail(
    userId: string,
    projectId: string,
    filters: AnalyticsFilters,
    selection: SignalSelection,
  ) {
    await this.projects.requireAccess(userId, projectId);
    const suffix = this.rollupSuffix(filters);
    const signalFilter = this.selectSignal(this.filter('s', projectId, filters, 'bucket'), selection, 's');
    const signalRows = await this.database.pool.query(
      `SELECT sum(signal_count)::bigint AS count,
        distinct_count(rollup(session_hll))::bigint AS session_count,
        max(latest_at) AS last_seen_at
       FROM custom_signal_rollup_${suffix} s WHERE ${signalFilter.where}`,
      signalFilter.values,
    );
    const count = Number(signalRows.rows[0]?.count ?? 0);
    const sessionCount = Number(signalRows.rows[0]?.session_count ?? 0);
    const lastSeenAt = signalRows.rows[0]?.last_seen_at ?? null;

    if (!selection.metric) {
      const [points, routes] = await Promise.all([
        this.database.pool.query(
          `SELECT bucket, sum(signal_count)::bigint AS value
           FROM custom_signal_rollup_${suffix} s WHERE ${signalFilter.where}
           GROUP BY bucket ORDER BY bucket`,
          signalFilter.values,
        ),
        this.database.pool.query(
          `SELECT route_name, sum(signal_count)::bigint AS value
           FROM custom_signal_rollup_${suffix} s WHERE ${signalFilter.where}
           GROUP BY route_name ORDER BY value DESC LIMIT 100`,
          signalFilter.values,
        ),
      ]);
      return {
        kind: selection.kind, name: selection.name, metric: 'count', unit: 'count', aggregation: 'count',
        count, sessionCount, lastSeenAt, value: count,
        points: points.rows.map((row) => ({ bucket: row.bucket, value: Number(row.value) })),
        routes: routes.rows.map((row) => ({ routeName: row.route_name, value: Number(row.value) })),
      };
    }

    if (!selection.unit) throw new Error('unit is required for a metric');
    const metricFilter = this.selectMetric(this.filter('m', projectId, filters, 'bucket'), selection, 'm');
    const expression = aggregateSql(selection.aggregation);
    const [summary, points, routes] = await Promise.all([
      this.database.pool.query(
        `SELECT ${expression} AS value FROM custom_metric_rollup_${suffix} m WHERE ${metricFilter.where}`,
        metricFilter.values,
      ),
      this.database.pool.query(
        `SELECT bucket, ${expression} AS value FROM custom_metric_rollup_${suffix} m
         WHERE ${metricFilter.where} GROUP BY bucket ORDER BY bucket`,
        metricFilter.values,
      ),
      this.database.pool.query(
        `SELECT route_name, ${expression} AS value FROM custom_metric_rollup_${suffix} m
         WHERE ${metricFilter.where} GROUP BY route_name ORDER BY value DESC NULLS LAST LIMIT 100`,
        metricFilter.values,
      ),
    ]);
    return {
      kind: selection.kind, name: selection.name, metric: selection.metric,
      unit: selection.unit, aggregation: selection.aggregation,
      count, sessionCount, lastSeenAt, value: number(summary.rows[0]?.value),
      points: points.rows.map((row) => ({ bucket: row.bucket, value: number(row.value) })),
      routes: routes.rows.map((row) => ({ routeName: row.route_name, value: number(row.value) })),
    };
  }

  async records(
    userId: string,
    projectId: string,
    filters: AnalyticsFilters,
    selection: Pick<SignalSelection, 'kind' | 'name'>,
    cursor?: string,
    limit: number = 50,
  ) {
    await this.projects.requireAccess(userId, projectId);
    const filter = this.selectSignal(
      this.filter('s', projectId, filters, 'occurred_at'),
      { ...selection, aggregation: 'count' },
      's',
    );
    const values = [...filter.values];
    let where = filter.where;
    if (cursor) {
      try {
        const [date, eventId] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
        const parsed = new Date(date);
        if (Number.isFinite(parsed.getTime()) && eventId) {
          values.push(parsed, eventId);
          where += ` AND (s.occurred_at, s.event_id) < ($${values.length - 1}, $${values.length})`;
        }
      } catch {
        // Invalid cursors start at the first page.
      }
    }
    values.push(limit + 1);
    const result = await this.database.pool.query(
      `SELECT s.*, COALESCE(jsonb_object_agg(m.metric_name,
         jsonb_build_object('value', m.value, 'unit', m.unit))
         FILTER (WHERE m.metric_name IS NOT NULL), '{}'::jsonb) AS metrics
       FROM custom_signal_samples s
       LEFT JOIN custom_metric_samples m ON m.project_id = s.project_id
         AND m.event_id = s.event_id AND m.occurred_at = s.occurred_at
       WHERE ${where}
       GROUP BY s.project_id, s.event_id, s.occurred_at
       ORDER BY s.occurred_at DESC, s.event_id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      records: rows.map((row) => this.recordRow(row)),
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify([last.occurred_at, last.event_id])).toString('base64url')
        : null,
    };
  }

  async trace(userId: string, projectId: string, traceId: string, filters: AnalyticsFilters) {
    await this.projects.requireAccess(userId, projectId);
    const filter = this.filter('s', projectId, filters, 'occurred_at');
    const values = [...filter.values, traceId];
    const result = await this.database.pool.query(
      `SELECT s.*, COALESCE(jsonb_object_agg(m.metric_name,
         jsonb_build_object('value', m.value, 'unit', m.unit))
         FILTER (WHERE m.metric_name IS NOT NULL), '{}'::jsonb) AS metrics
       FROM custom_signal_samples s
       LEFT JOIN custom_metric_samples m ON m.project_id = s.project_id
         AND m.event_id = s.event_id AND m.occurred_at = s.occurred_at
       WHERE ${filter.where} AND s.trace_id = $${values.length}
       GROUP BY s.project_id, s.event_id, s.occurred_at
       ORDER BY s.occurred_at, s.event_id LIMIT 1001`,
      values,
    );
    const records = result.rows.slice(0, 1000).map((row) => this.recordRow(row));
    const spanIds = new Set(records.filter((row) => row.kind === 'span').map((row) => row.spanId));
    const incomplete = result.rows.length > 1000 || !records.some((row) => row.kind === 'trace') ||
      records.some((row) => row.parentSpanId && !spanIds.has(row.parentSpanId));
    return { traceId, incomplete, records };
  }

  private recordRow(row: Record<string, unknown>) {
    return {
      eventId: row.event_id,
      kind: row.kind,
      name: row.name,
      occurredAt: row.occurred_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: number(row.duration_ms),
      status: row.status,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      routeName: row.route_name,
      sessionId: row.session_id,
      viewId: row.view_id,
      environment: row.environment,
      version: row.app_version,
      attributes: row.attributes,
      metrics: row.metrics,
    };
  }
}