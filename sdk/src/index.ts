export { createMonitor, type Monitor, type MonitorCapabilities } from './core/monitor';
export type { MonitorOptions, RouteLocation } from './core/config';
export type {
  AppContextData,
  CorrelationContext,
  CustomEventPayload,
  PerformanceCapabilityMap,
  PerformanceMetricName,
  PerformanceMetricRating,
  PerformanceNavigationType,
  PerformancePayload,
  RuntimeContextData,
  TelemetryContext,
  TelemetryEventV2 as TelemetryEnvelope,
  TelemetryPayload,
  UserContextData,
  ViewPayload,
  WebVitalPerformancePayload,
} from '@browser-monitor/protocol';
