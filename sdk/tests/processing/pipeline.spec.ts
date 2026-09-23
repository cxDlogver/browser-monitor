import { describe, expect, it } from 'vitest';

import { createProcessingPipeline } from '../../src/processing';
import type { TelemetryEventV3 as TelemetryEnvelope } from '@browser-monitor/protocol';

function envelope(value: number = 1_000): TelemetryEnvelope {
  return {
    protocolVersion: '3.0',
    eventId: 'event-' + value,
    type: 'performance',
    name: 'LCP',
    occurredAt: value,
    app: { name: 'app', version: '1', environment: 'test' },
    context: {
      sessionId: 'session-1',
      viewId: 'view-1',
      routeName: '/home',
      url: 'https://example.test/?token=secret',
      runtime: { sdk: { name: 'sdk', version: '1' } },
    },
    correlation: {},
    payload: {
      type: 'performance',
      name: 'LCP',
      sampleId: 'metric-1',
      sequence: 0,
      state: 'provisional',
      value,
      delta: value,
      clientRating: 'good',
      unit: 'ms',
      kind: 'core-web-vital',
      source: 'web-vitals',
      navigationType: 'navigate',
      navigationId: 0,
    },
  };
}

describe('processing pipeline', () => {
  it('runs safety and data-volume stages in the specified order', () => {
    const pipeline = createProcessingPipeline({
      sensitiveKeys: ['token'],
      excludeUrls: [],
      dedupeWindowMs: 1_000,
      samplingRate: 1,
      rateLimit: { maxEvents: 10, windowMs: 60_000 },
    });

    const first = pipeline.process(envelope());
    const duplicate = pipeline.process({ ...envelope(), eventId: 'event-duplicate' });
    const changed = pipeline.process({
      ...envelope(1_100),
      eventId: 'event-changed',
    });

    expect(first?.context.url).toBe('https://example.test/');
    expect(duplicate).toBeUndefined();
    expect(changed?.payload).toMatchObject({ value: 1_100 });
  });
});
