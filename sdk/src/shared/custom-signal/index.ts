import {
  WORKFLOW_ATTRIBUTE,
  type CustomMetric,
  type CustomSignalData,
  type CustomSignalStatus,
  type JsonValue,
  type MetricUnit,
} from '@cxdlogver/browser-monitor-protocol';

export interface CustomSignalInput {
  attributes?: Readonly<Record<string, unknown>>;
  metrics?: Readonly<Record<string, Readonly<CustomMetric>>>;
}

export interface CustomSignalEndInput extends CustomSignalInput {
  status?: CustomSignalStatus;
}

export interface NormalizedSignalData {
  attributes: Record<string, JsonValue>;
  metrics: Record<string, CustomMetric>;
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 4096);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 5) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => toJsonValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, nested]) => [key.slice(0, 128), toJsonValue(nested, depth + 1)]),
  );
}

export function requiredName(value: string, field = 'Signal name'): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(field + ' is required.');
  if (normalized.length > 128) throw new Error(field + ' may contain at most 128 characters.');
  return normalized;
}

function normalizeMetric(name: string, value: number, unit: MetricUnit): [string, CustomMetric] {
  const metricName = requiredName(name, 'Metric name');
  const normalizedUnit = unit.trim();
  if (metricName === 'duration') throw new Error('duration is a reserved metric name.');
  if (metricName.length > 64) throw new Error('Metric name may contain at most 64 characters.');
  if (!Number.isFinite(value)) throw new Error('Metric value must be finite.');
  if (
    !normalizedUnit ||
    normalizedUnit.length > 32 ||
    !/^[a-zA-Z][a-zA-Z0-9_./%-]*$/.test(normalizedUnit)
  ) {
    throw new Error('Metric unit is invalid.');
  }
  return [metricName, { value, unit: normalizedUnit }];
}

export function normalizeData(data?: CustomSignalInput, attributeLimit = 50): NormalizedSignalData {
  for (const key of Object.keys(data ?? {})) {
    if (key !== 'attributes' && key !== 'metrics')
      throw new Error('Unknown custom signal field: ' + key);
  }
  const entries = Object.entries(data?.attributes ?? {});
  if (entries.some(([key]) => key.slice(0, 128) === WORKFLOW_ATTRIBUTE)) {
    throw new Error(WORKFLOW_ATTRIBUTE + ' is a reserved attribute name.');
  }
  const attributes = Object.fromEntries(
    entries.slice(0, attributeLimit).map(([key, value]) => [key.slice(0, 128), toJsonValue(value)]),
  );
  const metricEntries = Object.entries(data?.metrics ?? {});
  if (metricEntries.length > 20) throw new Error('metrics may contain at most 20 entries.');
  const metrics = Object.fromEntries(
    metricEntries.map(([name, metric]) => normalizeMetric(name, metric.value, metric.unit)),
  );
  return { attributes, metrics };
}

/** Validate the complete merge before changing the handle, so a failed end can be retried. */
export function mergeData(
  target: NormalizedSignalData,
  data?: CustomSignalInput,
  attributeLimit = 50,
): void {
  if (!data) return;
  const normalized = normalizeData(data, attributeLimit);
  const metrics = { ...target.metrics, ...normalized.metrics };
  if (Object.keys(metrics).length > 20) throw new Error('metrics may contain at most 20 entries.');
  target.attributes = Object.fromEntries(
    Object.entries({ ...target.attributes, ...normalized.attributes }).slice(0, attributeLimit),
  );
  target.metrics = metrics;
}

export function presentData(data: NormalizedSignalData): CustomSignalData {
  return {
    ...(Object.keys(data.attributes).length > 0 ? { attributes: data.attributes } : {}),
    ...(Object.keys(data.metrics).length > 0 ? { metrics: data.metrics } : {}),
  };
}
