import { describe, expect, it } from 'vitest';

import { createBatchFixture, invalidProtocolFixture } from '../src/fixtures';
import { telemetryBatchHeaderV3Schema, telemetryBatchV3Schema } from '../src/schemas';

describe('Browser Monitor protocol 3.0', () => {
  it('accepts a valid shared fixture', () => {
    expect(telemetryBatchV3Schema.safeParse(createBatchFixture()).success).toBe(true);
  });

  it('rejects protocol 1.0', () => {
    expect(telemetryBatchHeaderV3Schema.safeParse(invalidProtocolFixture).success).toBe(false);
  });

  it('rejects an envelope whose type differs from its payload', () => {
    const batch = createBatchFixture();
    batch.events[0]!.type = 'event';
    expect(telemetryBatchV3Schema.safeParse(batch).success).toBe(false);
  });

  it('allows the server to validate a batch header before partially validating events', () => {
    const batch = { ...createBatchFixture(), events: [createBatchFixture().events[0], { invalid: true }] };
    expect(telemetryBatchHeaderV3Schema.safeParse(batch).success).toBe(true);
    expect(telemetryBatchV3Schema.safeParse(batch).success).toBe(false);
  });
  it('validates event, trace and span using the same attribute and metric contract', () => {
    const base = createBatchFixture().events[0]!;
    const attributes = { channel: 'web' };
    const metrics = {
      amount: { value: -9.5, unit: 'CNY' },
      retries: { value: 2, unit: 'count' },
    };
    const event = {
      ...base, type: 'event', name: 'order.refund', correlation: {},
      payload: { type: 'event', name: 'order.refund', source: 'custom', attributes, metrics },
    };
    const trace = {
      ...base, type: 'trace', name: 'checkout.flow', correlation: { traceId: 'trace-1' },
      payload: { type: 'trace', name: 'checkout.flow', source: 'custom', attributes, metrics,
        startedAt: 100, endedAt: 250, durationMs: 150, status: 'ok' },
    };
    const span = {
      ...base, type: 'span', name: 'checkout.payment',
      correlation: { traceId: 'trace-1', spanId: 'span-1', parentSpanId: 'span-0' },
      payload: { type: 'span', name: 'checkout.payment', source: 'custom', attributes, metrics,
        startedAt: 120, endedAt: 220, durationMs: 100, status: 'cancelled' },
    };
    expect(telemetryBatchV3Schema.safeParse(createBatchFixture([event, trace, span] as never)).success).toBe(true);
    for (const candidate of [
      { ...event, payload: { ...event.payload, metrics: { invalid: { value: NaN, unit: 'ms' } } } },
      { ...event, payload: { ...event.payload, metrics: { duration: { value: 2, unit: 'ms' } } } },
      { ...event, payload: { ...event.payload, metrics: Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`m${index}`, { value: index, unit: 'count' }]),
      ) } },
      { ...event, payload: { ...event.payload, metrics: { invalid: { value: 1, unit: '' } } } },
      { ...trace, payload: { ...trace.payload, endedAt: 99 } },
      { ...span, correlation: { spanId: 'span-1' } },
      { ...event, protocolVersion: '2.0' },
    ]) {
      expect(telemetryBatchV3Schema.safeParse(createBatchFixture([candidate] as never)).success).toBe(false);
    }
  });
});
