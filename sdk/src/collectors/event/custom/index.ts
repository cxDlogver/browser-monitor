import type { ContextManager } from '../../../context';
import type { MonitorModule } from '../../../core/module-registry';
import type { TelemetryEmitter } from '../../../core/pipeline';
import { createId } from '../../../shared/id';
import type { SignalSubscriber } from '../../../signals';
import type {
  CorrelationContext,
  CustomMetric,
  CustomSignalData,
  CustomSignalStatus,
  JsonValue,
  MetricUnit,
  TelemetryContext,
} from '@browser-monitor/protocol';

export interface CustomSignalInput {
  attributes?: Readonly<Record<string, unknown>>;
  metrics?: Readonly<Record<string, Readonly<CustomMetric>>>;
}

export interface CustomSignalEndInput extends CustomSignalInput {
  status?: CustomSignalStatus;
}

interface NormalizedSignalData {
  attributes: Record<string, JsonValue>;
  metrics: Record<string, CustomMetric>;
}

export interface TraceHandle {
  readonly traceId: string;
  startSpan(name: string, data?: CustomSignalInput): SpanHandle;
  span<T>(name: string, callback: (span: SpanHandle) => T, data?: CustomSignalInput): T;
  addEvent(name: string, data?: CustomSignalInput): void;
  setAttribute(key: string, value: unknown): void;
  setMetric(name: string, value: number, unit: MetricUnit): void;
  end(options?: CustomSignalEndInput): void;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  startSpan(name: string, data?: CustomSignalInput): SpanHandle;
  span<T>(name: string, callback: (span: SpanHandle) => T, data?: CustomSignalInput): T;
  addEvent(name: string, data?: CustomSignalInput): void;
  setAttribute(key: string, value: unknown): void;
  setMetric(name: string, value: number, unit: MetricUnit): void;
  end(options?: CustomSignalEndInput): void;
}

function toJsonValue(value: unknown, depth: number = 0): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 5) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => toJsonValue(item, depth + 1));
  if (typeof value !== 'object') return null;

  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 50)) {
    result[key.slice(0, 128)] = toJsonValue(nested, depth + 1);
  }
  return result;
}

function requiredName(value: string, field: string = 'Signal name'): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > 128) throw new Error(`${field} may contain at most 128 characters.`);
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

function normalizeData(data?: CustomSignalInput): NormalizedSignalData {
  for (const key of Object.keys(data ?? {})) {
    if (key !== 'attributes' && key !== 'metrics')
      throw new Error('Unknown custom signal field: ' + key);
  }
  const attributes: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(data?.attributes ?? {}).slice(0, 50)) {
    attributes[key.slice(0, 128)] = toJsonValue(value);
  }

  const metrics: Record<string, CustomMetric> = {};
  const entries = Object.entries(data?.metrics ?? {});
  if (entries.length > 20) throw new Error('metrics may contain at most 20 entries.');
  for (const [name, metric] of entries) {
    const [normalizedName, normalizedMetric] = normalizeMetric(name, metric.value, metric.unit);
    metrics[normalizedName] = normalizedMetric;
  }
  return { attributes, metrics };
}

function mergeData(target: NormalizedSignalData, data?: CustomSignalInput): void {
  if (!data) return;
  const normalized = normalizeData({
    ...(data.attributes ? { attributes: data.attributes } : {}),
    ...(data.metrics ? { metrics: data.metrics } : {}),
  });
  Object.assign(target.attributes, normalized.attributes);
  for (const [name, metric] of Object.entries(normalized.metrics)) {
    if (!(name in target.metrics) && Object.keys(target.metrics).length >= 20) {
      throw new Error('metrics may contain at most 20 entries.');
    }
    target.metrics[name] = metric;
  }
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function presentData(data: NormalizedSignalData): CustomSignalData {
  return {
    ...(Object.keys(data.attributes).length > 0 ? { attributes: data.attributes } : {}),
    ...(Object.keys(data.metrics).length > 0 ? { metrics: data.metrics } : {}),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

interface EndableHandle {
  end(options?: CustomSignalEndInput): void;
}

abstract class TimedHandle {
  protected readonly startedAt = Date.now();
  protected readonly startedMonotonic = monotonicNow();
  protected readonly data: NormalizedSignalData;
  protected ended = false;

  constructor(
    protected readonly owner: CustomTelemetryManager | undefined,
    readonly name: string,
    initialData?: CustomSignalInput,
  ) {
    this.data = normalizeData(initialData);
  }

  setAttribute(key: string, value: unknown): void {
    if (this.ended) return;
    const normalized = key.trim();
    if (!normalized) throw new Error('Attribute name is required.');
    this.data.attributes[normalized.slice(0, 128)] = toJsonValue(value);
  }

  setMetric(name: string, value: number, unit: MetricUnit): void {
    if (this.ended) return;
    const [normalizedName, metric] = normalizeMetric(name, value, unit);
    if (!(normalizedName in this.data.metrics) && Object.keys(this.data.metrics).length >= 20) {
      throw new Error('metrics may contain at most 20 entries.');
    }
    this.data.metrics[normalizedName] = metric;
  }

  protected finishData(options?: CustomSignalEndInput): {
    startedAt: number;
    endedAt: number;
    durationMs: number;
    status: CustomSignalStatus;
    data: CustomSignalData;
  } {
    mergeData(this.data, options);
    const endedAt = Math.max(this.startedAt, Date.now());
    return {
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(0, monotonicNow() - this.startedMonotonic),
      status: options?.status ?? 'ok',
      data: presentData(this.data),
    };
  }
}

class TraceHandleImpl extends TimedHandle implements TraceHandle {
  readonly traceId = createId('trace');
  readonly children = new Set<SpanHandleImpl>();
  readonly context: TelemetryContext | undefined;

  constructor(owner: CustomTelemetryManager | undefined, name: string, data?: CustomSignalInput) {
    super(owner, name, data);
    this.context = owner?.snapshot(this.startedAt);
    if (!owner) this.ended = true;
  }

  startSpan(name: string, data?: CustomSignalInput): SpanHandle {
    if (this.ended || !this.owner) return new SpanHandleImpl(undefined, this, undefined, name);
    const span = new SpanHandleImpl(this.owner, this, undefined, requiredName(name), data);
    this.children.add(span);
    return span;
  }

  span<T>(name: string, callback: (span: SpanHandle) => T, data?: CustomSignalInput): T {
    return runWrapped(this.startSpan(name, data), callback);
  }

  addEvent(name: string, data?: CustomSignalInput): void {
    if (this.ended) return;
    this.owner?.track(name, data, { traceId: this.traceId });
  }

  end(options?: CustomSignalEndInput): void {
    if (this.ended) return;
    for (const child of [...this.children]) child.cancelTree();
    this.ended = true;
    const finished = this.finishData(options);
    this.owner?.emitTimed('trace', this.name, this.context!, { traceId: this.traceId }, finished);
    this.owner?.releaseTrace(this);
  }

  cancelTree(): void {
    this.end({ status: 'cancelled' });
  }
}

class SpanHandleImpl extends TimedHandle implements SpanHandle {
  readonly spanId = createId('span');
  readonly traceId: string;
  readonly children = new Set<SpanHandleImpl>();
  readonly context: TelemetryContext | undefined;

  constructor(
    owner: CustomTelemetryManager | undefined,
    private readonly traceHandle: TraceHandleImpl,
    private readonly parent: SpanHandleImpl | undefined,
    name: string,
    data?: CustomSignalInput,
  ) {
    super(owner, name, data);
    this.traceId = traceHandle.traceId;
    this.context = owner?.snapshot(this.startedAt);
    if (!owner) this.ended = true;
  }

  startSpan(name: string, data?: CustomSignalInput): SpanHandle {
    if (this.ended || !this.owner) {
      return new SpanHandleImpl(undefined, this.traceHandle, this, name);
    }
    const span = new SpanHandleImpl(this.owner, this.traceHandle, this, requiredName(name), data);
    this.children.add(span);
    return span;
  }

  span<T>(name: string, callback: (span: SpanHandle) => T, data?: CustomSignalInput): T {
    return runWrapped(this.startSpan(name, data), callback);
  }

  addEvent(name: string, data?: CustomSignalInput): void {
    if (this.ended) return;
    this.owner?.track(name, data, this.correlation());
  }

  end(options?: CustomSignalEndInput): void {
    if (this.ended) return;
    for (const child of [...this.children]) child.cancelTree();
    this.ended = true;
    const finished = this.finishData(options);
    this.owner?.emitTimed('span', this.name, this.context!, this.correlation(), finished);
    (this.parent?.children ?? this.traceHandle.children).delete(this);
  }

  cancelTree(): void {
    this.end({ status: 'cancelled' });
  }

  private correlation(): CorrelationContext {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parent ? { parentSpanId: this.parent.spanId } : {}),
    };
  }
}

function runWrapped<T, H extends EndableHandle>(handle: H, callback: (handle: H) => T): T {
  try {
    const result = callback(handle);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (value) => {
          handle.end();
          return value;
        },
        (error) => {
          handle.end({ status: 'error' });
          throw error;
        },
      ) as T;
    }
    handle.end();
    return result;
  } catch (error) {
    handle.end({ status: 'error' });
    throw error;
  }
}

export class CustomTelemetryManager implements MonitorModule {
  readonly name = 'custom-telemetry-manager';
  private running = false;
  private unsubscribe: (() => void) | undefined;
  private readonly traces = new Set<TraceHandleImpl>();

  constructor(
    private readonly emitter: TelemetryEmitter,
    private readonly context: ContextManager,
    private readonly signals: SignalSubscriber,
  ) {}

  install(): void {
    this.unsubscribe = this.signals.subscribe('page.lifecycle', (signal) => {
      if (signal.type === 'pagehide') this.cancelOpen();
    });
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.cancelOpen();
    this.running = false;
  }

  destroy(): void {
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  track(name: string, data?: CustomSignalInput, correlation: CorrelationContext = {}): void {
    if (!this.running) return;
    const normalizedName = requiredName(name);
    const normalizedData = normalizeData(data);
    const timestamp = Date.now();
    this.emitter.emit({
      name: normalizedName,
      timestamp,
      correlation,
      payload: {
        type: 'event',
        name: normalizedName,
        source: 'custom',
        ...presentData(normalizedData),
      },
    });
  }

  startTrace(name: string, data?: CustomSignalInput): TraceHandle {
    if (!this.running) return new TraceHandleImpl(undefined, name);
    const trace = new TraceHandleImpl(this, requiredName(name), data);
    this.traces.add(trace);
    return trace;
  }

  trace<T>(name: string, callback: (trace: TraceHandle) => T, data?: CustomSignalInput): T {
    return runWrapped(this.startTrace(name, data), callback);
  }

  snapshot(timestamp: number): TelemetryContext {
    return this.context.snapshotAt(timestamp);
  }

  releaseTrace(trace: TraceHandleImpl): void {
    this.traces.delete(trace);
  }

  emitTimed(
    type: 'trace' | 'span',
    name: string,
    context: TelemetryContext,
    correlation: CorrelationContext,
    finished: {
      startedAt: number;
      endedAt: number;
      durationMs: number;
      status: CustomSignalStatus;
      data: CustomSignalData;
    },
  ): void {
    this.emitter.emit({
      name,
      timestamp: finished.endedAt,
      context,
      correlation,
      payload: {
        type,
        name,
        source: 'custom',
        startedAt: finished.startedAt,
        endedAt: finished.endedAt,
        durationMs: finished.durationMs,
        status: finished.status,
        ...finished.data,
      },
    });
  }

  cancelOpen(): void {
    for (const trace of [...this.traces]) trace.cancelTree();
  }
}
