import { describe, expect, it } from 'vitest';

import { createBatchFixture, invalidProtocolFixture } from '../src/fixtures';
import { telemetryBatchHeaderV2Schema, telemetryBatchV2Schema } from '../src/schemas';

describe('Browser Monitor protocol 2.0', () => {
  it('accepts a valid shared fixture', () => {
    expect(telemetryBatchV2Schema.safeParse(createBatchFixture()).success).toBe(true);
  });

  it('rejects protocol 1.0', () => {
    expect(telemetryBatchHeaderV2Schema.safeParse(invalidProtocolFixture).success).toBe(false);
  });

  it('rejects an envelope whose type differs from its payload', () => {
    const batch = createBatchFixture();
    batch.events[0]!.type = 'event';
    expect(telemetryBatchV2Schema.safeParse(batch).success).toBe(false);
  });

  it('allows the server to validate a batch header before partially validating events', () => {
    const batch = { ...createBatchFixture(), events: [createBatchFixture().events[0], { invalid: true }] };
    expect(telemetryBatchHeaderV2Schema.safeParse(batch).success).toBe(true);
    expect(telemetryBatchV2Schema.safeParse(batch).success).toBe(false);
  });
});
