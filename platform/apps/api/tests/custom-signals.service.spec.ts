import { describe, expect, it, vi } from 'vitest';

import { CustomSignalsService, type Aggregation } from '../src/analytics/custom-signals.service.js';

const recent = {
  from: new Date(Date.now() - 60 * 60_000),
  to: new Date(Date.now() + 60_000),
  routeName: '/checkout',
};

function setup(rows: Array<Record<string, unknown>> = []) {
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows }));
  const requireAccess = vi.fn(async () => ({ role: 'owner' }));
  const service = new CustomSignalsService(
    { pool: { query } } as never,
    { requireAccess } as never,
  );
  return { service, query, requireAccess };
}

describe('custom signal analytics', () => {
  it('maps every aggregate to a server-owned SQL expression and filters by route', async () => {
    const expressions: Record<Aggregation, string> = {
      count: 'sum(sample_count)',
      sum: 'sum(total)',
      avg: 'sum(total) / NULLIF(sum(sample_count), 0)',
      min: 'min(minimum)',
      max: 'max(maximum)',
      p50: 'approx_percentile(0.5, rollup(value_percentiles))',
      p75: 'approx_percentile(0.75, rollup(value_percentiles))',
      p90: 'approx_percentile(0.9, rollup(value_percentiles))',
      p95: 'approx_percentile(0.95, rollup(value_percentiles))',
      p99: 'approx_percentile(0.99, rollup(value_percentiles))',
    };
    const { service, query, requireAccess } = setup([{ count: 3, session_count: 2, value: 150 }]);
    for (const [aggregation, expression] of Object.entries(expressions) as Array<[Aggregation, string]>) {
      query.mockClear();
      await service.detail('user-1', 'project-1', recent, {
        kind: 'span', name: 'page.stay', metric: 'duration', unit: 'ms', aggregation,
      });
      expect(requireAccess).toHaveBeenCalledWith('user-1', 'project-1');
      const metricQueries = query.mock.calls.filter(([sql]) => sql.includes('FROM custom_metric_rollup_1m'));
      expect(metricQueries).toHaveLength(3);
      expect(metricQueries.every(([sql]) => sql.includes(expression))).toBe(true);
      expect(metricQueries.every(([, values]) => values.includes('/checkout') && values.includes('ms'))).toBe(true);
    }
  });

  it('switches long ranges to hourly rollups and keeps names separate', async () => {
    const { service, query } = setup([]);
    await service.list('user-1', 'project-1', {
      from: new Date(Date.now() - 40 * 24 * 60 * 60_000), to: new Date(),
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('FROM custom_signal_rollup_1h'),
      expect.stringContaining('FROM custom_metric_rollup_1h'),
    ]);
  });

  it('returns cursor-paged raw records and flags traces missing a root or parent span', async () => {
    const row = {
      event_id: 'event-1', kind: 'span', name: 'payment', occurred_at: new Date(),
      started_at: new Date(), ended_at: new Date(), duration_ms: 100,
      trace_id: 'trace-1', span_id: 'span-1', parent_span_id: 'missing-parent',
      route_name: '/checkout', session_id: 'session-1', view_id: 'view-1',
      environment: 'test', app_version: '1', attributes: {}, metrics: {},
    };
    const { service, query } = setup([row, { ...row, event_id: 'event-2' }]);
    const records = await service.records('user-1', 'project-1', recent, { kind: 'span', name: 'payment' }, undefined, 1);
    expect(records.records).toHaveLength(1);
    expect(records.nextCursor).toBeTruthy();
    query.mockResolvedValueOnce({ rows: [row] });
    const trace = await service.trace('user-1', 'project-1', 'trace-1', recent);
    expect(trace.incomplete).toBe(true);
    expect(trace.records[0]).toMatchObject({ traceId: 'trace-1', parentSpanId: 'missing-parent' });
  });
});