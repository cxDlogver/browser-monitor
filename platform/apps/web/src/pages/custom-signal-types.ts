export type CustomSignalKind = 'event' | 'trace' | 'span';
export type CustomAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p75' | 'p90' | 'p95' | 'p99';

export interface CustomSignalSummary {
  kind: CustomSignalKind;
  name: string;
  count: number;
  sessionCount: number;
  lastSeenAt: string | null;
  metrics: Array<{ name: string; unit: string }>;
}

export interface CustomSignalDetail {
  kind: CustomSignalKind;
  name: string;
  metric: string;
  unit: string;
  aggregation: CustomAggregation;
  count: number;
  sessionCount: number;
  lastSeenAt: string | null;
  value: number | null;
  points: Array<{ bucket: string; value: number | null }>;
  routes: Array<{ routeName: string; value: number | null }>;
}

export interface CustomSignalRecord {
  eventId: string;
  kind: CustomSignalKind;
  name: string;
  occurredAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'cancelled' | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  routeName: string;
  sessionId: string;
  viewId: string;
  environment: string;
  version: string;
  attributes: Record<string, unknown>;
  metrics: Record<string, { value: number; unit: string }>;
}

export interface CustomSignalRecordPage {
  records: CustomSignalRecord[];
  nextCursor: string | null;
}

export interface CustomTraceDetail {
  traceId: string;
  incomplete: boolean;
  records: CustomSignalRecord[];
}