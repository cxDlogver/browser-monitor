import { describe, expect, it, vi } from 'vitest';

import { AnalyticsController } from '../src/analytics/analytics.controller.js';

describe('custom signal query validation', () => {
  it('accepts business metric names without applying the performance metric enum', () => {
    const detail = vi.fn(() => ({ value: 42 }));
    const controller = new AnalyticsController({} as never, { detail } as never);
    const result = controller.customSignalDetail(
      { id: 'user-1' } as never,
      'project-1',
      { kind: 'span', name: 'page.stay', metric: 'duration', unit: 'ms', aggregation: 'p95', routeName: '/page' },
    );
    expect(result).toEqual({ value: 42 });
    expect(detail).toHaveBeenCalledWith('user-1', 'project-1',
      expect.objectContaining({ routeName: '/page' }),
      expect.objectContaining({ metric: 'duration', unit: 'ms', aggregation: 'p95' }),
    );
  });

  it('rejects missing units and unsupported aggregation names', () => {
    const controller = new AnalyticsController({} as never, { detail: vi.fn() } as never);
    const user = { id: 'user-1' } as never;
    expect(() => controller.customSignalDetail(user, 'project-1', {
      kind: 'event', name: 'purchase', metric: 'amount', aggregation: 'sum',
    })).toThrow();
    expect(() => controller.customSignalDetail(user, 'project-1', {
      kind: 'event', name: 'purchase', metric: 'amount', unit: 'USD', aggregation: 'median',
    })).toThrow();
  });
});