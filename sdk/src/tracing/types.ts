import type { CustomSignalEndInput, CustomSignalInput } from '../shared/custom-signal';
import type { MetricUnit } from '@cxdlogver/browser-monitor-protocol';

/** Only immutable identity is propagated; a child never owns its parent handle. */
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface StartSpanOptions extends CustomSignalInput {
  /** Explicit parent wins over the active scope; null starts a new trace. */
  parent?: SpanContext | null;
}

export interface SpanHandle extends SpanContext {
  readonly parentSpanId: string | undefined;
  startSpan(name: string, data?: CustomSignalInput): SpanHandle;
  span<T>(name: string, callback: (span: SpanHandle) => T, data?: CustomSignalInput): T;
  /** Activate this parent for the synchronous callback without ending it. */
  run<T>(callback: (span: SpanHandle) => T): T;
  /** Capture this parent for a later callback, preserving arguments and this. */
  bind<Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result;
  addEvent(name: string, data?: CustomSignalInput): void;
  setAttribute(key: string, value: unknown): void;
  setMetric(name: string, value: number, unit: MetricUnit): void;
  end(options?: CustomSignalEndInput): void;
}

/** A business Trace is a root Span with the same identity and lifecycle contract. */
export type TraceHandle = SpanHandle;
