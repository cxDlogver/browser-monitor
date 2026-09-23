import { describe, expect, it } from 'vitest';

import { SignalHub } from '../../src/core/signal-hub';
import type { TelemetryEventV3 as TelemetryEnvelope } from '@browser-monitor/protocol';
import { Transport } from '../../src/transport';
import { FakeSender } from '../helpers/fake-sender';

function performanceEnvelope(id: string): TelemetryEnvelope {
  return {
    protocolVersion: '3.0',
    eventId: id,
    type: 'performance',
    name: 'LCP',
    occurredAt: Date.now(),
    app: { name: 'app', version: '1', environment: 'test' },
    context: {
      sessionId: 'session',
      viewId: 'view',
      routeName: '/home',
      url: 'https://example.test/',
      runtime: { sdk: { name: 'sdk', version: '1' } },
    },
    correlation: {},
    payload: {
      type: 'performance',
      name: 'LCP',
      sampleId: id,
      sequence: 0,
      state: 'provisional',
      value: 1_000,
      delta: 1_000,
      clientRating: 'good',
      unit: 'ms',
      kind: 'core-web-vital',
      source: 'web-vitals',
      navigationType: 'navigate',
      navigationId: 0,
    },
  };
}

describe('transport', () => {
  it('batches queued envelopes and exposes bounded diagnostics', async () => {
    const signals = new SignalHub();
    const sender = new FakeSender();
    const transport = new Transport(
      {
        maxQueueSize: 2,
        batchSize: 2,
        maxBatchBytes: 100_000,
        flushIntervalMs: 60_000,
        retry: { maxAttempts: 1, baseDelayMs: 1 },
      },
      sender,
      signals,
    );

    transport.install();
    transport.start();
    transport.enqueue(performanceEnvelope('1'));
    transport.enqueue(performanceEnvelope('2'));
    await transport.flush();

    expect(sender.batches).toHaveLength(1);
    expect(sender.batches[0]).toHaveLength(2);
    expect(transport.getQueueSize()).toBe(0);
    expect(transport.getDroppedCount()).toBe(0);

    transport.destroy();
  });
});
