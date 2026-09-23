import { createPerformanceEventFixture } from '@browser-monitor/protocol/fixtures';
import { describe, expect, it, vi } from 'vitest';

import { EventProcessor } from '../src/processor.js';

describe('custom signal projection', () => {
  it('writes one signal and one row per numeric metric including system duration', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const client = { query, release: vi.fn() };
    const database = { pool: { connect: vi.fn(async () => client) } };
    const processor = new EventProcessor(database as never);
    const base = createPerformanceEventFixture();
    const event = {
      ...base,
      type: 'span',
      name: 'checkout.payment',
      correlation: { traceId: 'trace-1', spanId: 'span-1' },
      payload: {
        type: 'span', name: 'checkout.payment', source: 'custom',
        startedAt: 100, endedAt: 250, durationMs: 150, status: 'ok',
        attributes: { page: 'payment' },
        metrics: { amount: { value: -5, unit: 'USD' }, retries: { value: 2, unit: 'count' } },
      },
    };
    await processor.process('project-1', event as never);
    const signal = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO custom_signal_samples'));
    const metrics = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO custom_metric_samples'));
    expect(signal?.[1]?.slice(0, 5)).toEqual(['project-1', base.eventId, expect.any(Date), 'span', 'checkout.payment']);
    expect(metrics).toHaveLength(3);
    expect(metrics.map(([, values]) => [values?.[5], values?.[6], values?.[7]])).toEqual([
      ['amount', 'USD', -5],
      ['retries', 'count', 2],
      ['duration', 'ms', 150],
    ]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});