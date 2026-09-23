import { PROTOCOL_VERSION, SDK_NAME } from './constants';
import type { TelemetryBatchV3, TelemetryEventV3 } from './schemas';

export function createPerformanceEventFixture(
  overrides: Partial<TelemetryEventV3> = {},
): TelemetryEventV3 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'event-fixture-1',
    type: 'performance',
    name: 'LCP',
    occurredAt: 1_700_000_000_000,
    app: { name: 'fixture-app', version: '1.0.0', environment: 'test' },
    context: {
      sessionId: 'session-fixture-1',
      viewId: 'view-fixture-1',
      routeName: 'home',
      url: 'https://example.test/home',
      runtime: { sdk: { name: SDK_NAME, version: '0.3.0' } },
    },
    correlation: {},
    payload: {
      type: 'performance',
      name: 'LCP',
      sampleId: 'metric-fixture-1',
      sequence: 0,
      state: 'provisional',
      value: 1_800,
      unit: 'ms',
      kind: 'core-web-vital',
      source: 'web-vitals',
      delta: 1_800,
      clientRating: 'good',
      navigationType: 'navigate',
      navigationId: 0,
    },
    ...overrides,
  } as TelemetryEventV3;
}

export function createBatchFixture(events = [createPerformanceEventFixture()]): TelemetryBatchV3 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sentAt: 1_700_000_000_100,
    sdk: { name: SDK_NAME, version: '0.3.0' },
    events,
  };
}

export const invalidProtocolFixture = {
  protocolVersion: '1.0',
  sentAt: 1_700_000_000_100,
  sdk: { name: SDK_NAME, version: '0.1.0' },
  events: [],
} as const;

