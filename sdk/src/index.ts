export { createMonitor, type Monitor, type MonitorCapabilities } from './core/monitor';
export type {
  CustomSignalEndInput,
  CustomSignalInput,
  SpanHandle,
  TraceHandle,
} from './collectors/event/custom';
export type { MonitorOptions, RouteLocation } from './core/config';
export type {
  AppContextData,
  CorrelationContext,
  CustomEventPayload,
  CustomMetric,
  CustomSignalData,
  CustomSignalKind,
  CustomSignalPayload,
  CustomSignalStatus,
  CustomSpanPayload,
  CustomTracePayload,
  PerformanceCapabilityMap,
  PerformanceMetricName,
  PerformanceMetricRating,
  MetricUnit,
  PerformanceNavigationType,
  PerformancePayload,
  RuntimeContextData,
  TelemetryContext,
  TelemetryEventV3 as TelemetryEnvelope,
  TelemetryPayload,
  UserContextData,
  ViewPayload,
  WebVitalPerformancePayload,
} from '@browser-monitor/protocol';
