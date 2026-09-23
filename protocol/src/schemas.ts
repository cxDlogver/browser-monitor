import { z } from 'zod';

import {
  MAX_BATCH_EVENTS,
  MAX_EVENT_NAME_LENGTH,
  MAX_ROUTE_NAME_LENGTH,
  MAX_URL_LENGTH,
  PERFORMANCE_METRICS,
  PROTOCOL_VERSION,
} from './constants';

const finiteNonNegative = z.number().finite().nonnegative();
const timestamp = z.number().finite().int().nonnegative();
const identifier = z.string().trim().min(1).max(256);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(4_096),
    z.array(jsonValueSchema).max(50),
    z.record(z.string().max(128), jsonValueSchema),
  ]),
);

export const propertiesSchema = z.record(z.string().max(128), jsonValueSchema);

export const appContextSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64),
    environment: z.string().trim().min(1).max(64),
  })
  .strict();

export const runtimeContextSchema = z
  .object({
    userAgent: z.string().max(1_024).optional(),
    language: z.string().max(64).optional(),
    platform: z.string().max(128).optional(),
    online: z.boolean().optional(),
    sdk: z
      .object({
        name: z.string().trim().min(1).max(128),
        version: z.string().trim().min(1).max(64),
      })
      .strict(),
  })
  .strict();

export const userContextSchema = z
  .object({
    id: z.string().trim().min(1).max(256).optional(),
    properties: propertiesSchema.optional(),
  })
  .strict();

export const telemetryContextSchema = z
  .object({
    sessionId: identifier,
    viewId: identifier,
    routeName: z.string().trim().min(1).max(MAX_ROUTE_NAME_LENGTH),
    url: z.string().max(MAX_URL_LENGTH),
    runtime: runtimeContextSchema,
    user: userContextSchema.optional(),
  })
  .strict();

export const correlationContextSchema = z
  .object({
    actionId: identifier.optional(),
    requestId: identifier.optional(),
    traceId: identifier.optional(),
    spanId: identifier.optional(),
    parentSpanId: identifier.optional(),
  })
  .strict();

export const performanceMetricNameSchema = z.enum(PERFORMANCE_METRICS);
export const performanceMetricRatingSchema = z.enum(['good', 'needs-improvement', 'poor']);
export const performanceSampleStateSchema = z.enum(['provisional', 'final']);
export const performanceNavigationTypeSchema = z.enum([
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
  'soft-navigation',
]);

const performanceSampleSchema = z.object({
  type: z.literal('performance'),
  sampleId: identifier,
  sequence: z.number().int().nonnegative(),
  state: performanceSampleStateSchema,
  value: finiteNonNegative,
});

function webVitalSchema(
  name: 'LCP' | 'FCP' | 'INP' | 'CLS',
  unit: 'ms' | 'score',
  kind: 'core-web-vital' | 'diagnostic',
) {
  return performanceSampleSchema
    .extend({
      name: z.literal(name),
      unit: z.literal(unit),
      kind: z.literal(kind),
      source: z.literal('web-vitals'),
      delta: finiteNonNegative,
      clientRating: performanceMetricRatingSchema,
      navigationType: performanceNavigationTypeSchema,
      navigationId: z.number().int().nonnegative(),
    })
    .strict();
}

export const lcpPerformancePayloadSchema = webVitalSchema('LCP', 'ms', 'core-web-vital');
export const fcpPerformancePayloadSchema = webVitalSchema('FCP', 'ms', 'diagnostic');
export const inpPerformancePayloadSchema = webVitalSchema('INP', 'ms', 'core-web-vital');
export const clsPerformancePayloadSchema = webVitalSchema('CLS', 'score', 'core-web-vital');

export const fpsPerformancePayloadSchema = performanceSampleSchema
  .extend({
    name: z.literal('FPS'),
    unit: z.literal('fps'),
    kind: z.literal('runtime'),
    source: z.literal('request-animation-frame'),
    detail: z
      .object({
        frameCount: z.number().int().positive(),
        sampleDurationMs: finiteNonNegative,
      })
      .strict(),
  })
  .strict();

export const loafPerformancePayloadSchema = performanceSampleSchema
  .extend({
    name: z.literal('LoAF'),
    unit: z.literal('ms'),
    kind: z.literal('diagnostic'),
    source: z.literal('performance-observer'),
    detail: z
      .object({
        startTime: finiteNonNegative,
        blockingDuration: finiteNonNegative,
        renderStart: finiteNonNegative,
        styleAndLayoutStart: finiteNonNegative,
        scriptCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const performancePayloadSchema = z.discriminatedUnion('name', [
  lcpPerformancePayloadSchema,
  fcpPerformancePayloadSchema,
  inpPerformancePayloadSchema,
  clsPerformancePayloadSchema,
  fpsPerformancePayloadSchema,
  loafPerformancePayloadSchema,
]);

export const viewPayloadSchema = z
  .object({
    type: z.literal('view'),
    name: z.enum(['view.start', 'view.end']),
    viewId: identifier,
    routeName: z.string().trim().min(1).max(MAX_ROUTE_NAME_LENGTH),
    url: z.string().max(MAX_URL_LENGTH),
    startedAt: timestamp,
    endedAt: timestamp.optional(),
    source: z.enum(['initial', 'history', 'popstate', 'hashchange', 'bfcache']),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.name === 'view.end' && payload.endedAt === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'view.end requires endedAt' });
    }
    if (payload.endedAt !== undefined && payload.endedAt < payload.startedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'endedAt precedes startedAt' });
    }
  });

export const metricUnitSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z][a-zA-Z0-9_./%-]*$/);

export const customMetricSchema = z
  .object({
    value: z.number().finite(),
    unit: metricUnitSchema,
  })
  .strict();

const metricNameSchema = z.string().trim().min(1).max(64);
export const customMetricsSchema = z
  .record(metricNameSchema, customMetricSchema)
  .superRefine((metrics, context) => {
    if (Object.keys(metrics).length > 20) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'metrics may contain at most 20 entries' });
    }
    if ('duration' in metrics) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'duration is a reserved metric name' });
    }
  });

const customSignalFields = {
  name: z.string().trim().min(1).max(MAX_EVENT_NAME_LENGTH),
  source: z.literal('custom'),
  attributes: propertiesSchema.optional(),
  metrics: customMetricsSchema.optional(),
};

export const customEventPayloadSchema = z
  .object({ type: z.literal('event'), ...customSignalFields })
  .strict();

const timedSignalFields = {
  ...customSignalFields,
  startedAt: timestamp,
  endedAt: timestamp,
  durationMs: finiteNonNegative,
  status: z.enum(['ok', 'error', 'cancelled']),
};

function validateTimedSignal(
  payload: { startedAt: number; endedAt: number },
  context: z.RefinementCtx,
): void {
  if (payload.endedAt < payload.startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'endedAt precedes startedAt' });
  }
}

export const customTracePayloadSchema = z
  .object({ type: z.literal('trace'), ...timedSignalFields })
  .strict()
  .superRefine(validateTimedSignal);

export const customSpanPayloadSchema = z
  .object({ type: z.literal('span'), ...timedSignalFields })
  .strict()
  .superRefine(validateTimedSignal);

export const telemetryPayloadSchema = z.union([
  performancePayloadSchema,
  viewPayloadSchema,
  customEventPayloadSchema,
  customTracePayloadSchema,
  customSpanPayloadSchema,
]);

export const telemetryEventV3Schema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    eventId: identifier,
    type: z.enum(['performance', 'view', 'event', 'trace', 'span']),
    name: z.string().trim().min(1).max(MAX_EVENT_NAME_LENGTH),
    occurredAt: timestamp,
    app: appContextSchema,
    context: telemetryContextSchema,
    correlation: correlationContextSchema,
    payload: telemetryPayloadSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.type !== event.payload.type) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'event.type must match payload.type',
        path: ['type'],
      });
    }
    if (event.name !== event.payload.name) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'event.name must match payload.name',
        path: ['name'],
      });
    }
    if (event.payload.type === 'trace' &&
      (!event.correlation.traceId || event.correlation.spanId || event.correlation.parentSpanId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'trace requires traceId only', path: ['correlation'] });
    }
    if (event.payload.type === 'span' &&
      (!event.correlation.traceId || !event.correlation.spanId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'span requires traceId and spanId', path: ['correlation'] });
    }
    if (event.payload.type === 'event' && event.correlation.spanId && !event.correlation.traceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'spanId requires traceId', path: ['correlation'] });
    }
    if (event.correlation.parentSpanId && !event.correlation.spanId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'parentSpanId requires spanId', path: ['correlation'] });
    }
    if (event.payload.type === 'view' && event.context.viewId !== event.payload.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'context.viewId must match payload.viewId',
        path: ['context', 'viewId'],
      });
    }
  });

/** Validates the immutable batch metadata while allowing event-level partial acceptance. */
export const telemetryBatchHeaderV3Schema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    sentAt: timestamp,
    sdk: z
      .object({
        name: z.string().trim().min(1).max(128),
        version: z.string().trim().min(1).max(64),
      })
      .strict(),
    events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS),
  })
  .strict();

export const telemetryBatchV3Schema = telemetryBatchHeaderV3Schema.extend({
  events: z.array(telemetryEventV3Schema).min(1).max(MAX_BATCH_EVENTS),
});

export type AppContextData = z.infer<typeof appContextSchema>;
export type RuntimeContextData = z.infer<typeof runtimeContextSchema>;
export type UserContextData = z.infer<typeof userContextSchema>;
export type TelemetryContext = z.infer<typeof telemetryContextSchema>;
export type CorrelationContext = z.infer<typeof correlationContextSchema>;
export type PerformanceMetricName = z.infer<typeof performanceMetricNameSchema>;
export type PerformanceMetricRating = z.infer<typeof performanceMetricRatingSchema>;
export type PerformanceSampleState = z.infer<typeof performanceSampleStateSchema>;
export type PerformanceNavigationType = z.infer<typeof performanceNavigationTypeSchema>;
export type LCPPerformancePayload = z.infer<typeof lcpPerformancePayloadSchema>;
export type FCPPerformancePayload = z.infer<typeof fcpPerformancePayloadSchema>;
export type INPPerformancePayload = z.infer<typeof inpPerformancePayloadSchema>;
export type CLSPerformancePayload = z.infer<typeof clsPerformancePayloadSchema>;
export type FPSPerformancePayload = z.infer<typeof fpsPerformancePayloadSchema>;
export type LoAFPerformancePayload = z.infer<typeof loafPerformancePayloadSchema>;
export type WebVitalPerformancePayload =
  | LCPPerformancePayload
  | FCPPerformancePayload
  | INPPerformancePayload
  | CLSPerformancePayload;
export type PerformancePayload = z.infer<typeof performancePayloadSchema>;
export type ViewPayload = z.infer<typeof viewPayloadSchema>;
export type CustomEventPayload = z.infer<typeof customEventPayloadSchema>;
export type CustomTracePayload = z.infer<typeof customTracePayloadSchema>;
export type CustomSpanPayload = z.infer<typeof customSpanPayloadSchema>;
export type CustomSignalPayload = CustomEventPayload | CustomTracePayload | CustomSpanPayload;
export type CustomSignalData = Pick<CustomEventPayload, 'attributes' | 'metrics'>;
export type CustomSignalStatus = CustomTracePayload['status'];
export type CustomSignalKind = CustomSignalPayload['type'];
export type CustomMetric = z.infer<typeof customMetricSchema>;
export type MetricUnit = z.infer<typeof metricUnitSchema>;
export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;
export type TelemetryEventV3 = z.infer<typeof telemetryEventV3Schema>;
export type TelemetryBatchV3 = z.infer<typeof telemetryBatchV3Schema>;

export type PerformanceCapabilityMap = Readonly<Record<PerformanceMetricName, boolean>>;

