import type { TelemetryEventV3 } from '@browser-monitor/protocol';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    csrfToken: varchar('csrf_token', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (table) => [uniqueIndex('user_sessions_token_unique').on(table.tokenHash), index('user_sessions_user_idx').on(table.userId)],
);

export const accountTokens = pgTable(
  'account_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [uniqueIndex('account_tokens_hash_unique').on(table.tokenHash), index('account_tokens_user_idx').on(table.userId)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    appName: varchar('app_name', { length: 128 }).notNull(),
    userHashSalt: varchar('user_hash_salt', { length: 128 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('projects_app_name_idx').on(table.appName)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] }), index('project_members_user_idx').on(table.userId)],
);

export const ingestionKeys = pgTable(
  'ingestion_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    publicKey: varchar('public_key', { length: 96 }).notNull(),
    label: varchar('label', { length: 80 }).notNull().default('default'),
    active: boolean('active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [uniqueIndex('ingestion_keys_public_unique').on(table.publicKey), index('ingestion_keys_project_idx').on(table.projectId)],
);

export const allowedOrigins = pgTable(
  'allowed_origins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    origin: varchar('origin', { length: 512 }).notNull(),
    createdAt,
  },
  (table) => [uniqueIndex('allowed_origins_project_origin_unique').on(table.projectId, table.origin)],
);

export const thresholdVersions = pgTable(
  'threshold_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  (table) => [uniqueIndex('threshold_versions_project_version_unique').on(table.projectId, table.version), index('threshold_versions_active_idx').on(table.projectId, table.active)],
);

export const invitations = pgTable(
  'project_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 16 }).notNull().default('member'),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [
    uniqueIndex('project_invitations_token_unique').on(table.tokenHash),
    uniqueIndex('project_invitations_pending_unique')
      .on(table.projectId, table.email)
      .where(sql`${table.acceptedAt} is null`),
    index('project_invitations_email_idx').on(table.email),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 128 }).notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => [index('audit_logs_project_time_idx').on(table.projectId, table.createdAt)],
);

export const telemetryEvents = pgTable(
  'telemetry_events',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 256 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    type: varchar('type', { length: 32 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    environment: varchar('environment', { length: 64 }).notNull(),
    appVersion: varchar('app_version', { length: 64 }).notNull(),
    sessionId: varchar('session_id', { length: 256 }).notNull(),
    viewId: varchar('view_id', { length: 256 }).notNull(),
    routeName: varchar('route_name', { length: 160 }).notNull(),
    userHash: varchar('user_hash', { length: 64 }),
    event: jsonb('event').$type<TelemetryEventV3>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.eventId, table.occurredAt] }),
    index('telemetry_project_time_idx').on(table.projectId, table.occurredAt),
    index('telemetry_project_type_time_idx').on(table.projectId, table.type, table.occurredAt),
  ],
);

export const outboxTasks = pgTable(
  'outbox_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 256 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    event: jsonb('event').$type<TelemetryEventV3>().notNull(),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: varchar('locked_by', { length: 128 }),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [uniqueIndex('outbox_event_unique').on(table.projectId, table.eventId, table.occurredAt), index('outbox_claim_idx').on(table.status, table.availableAt)],
);

export const deadLetterTasks = pgTable(
  'dead_letter_tasks',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 256 }).notNull(),
    event: jsonb('event').$type<TelemetryEventV3>().notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('dead_letter_project_time_idx').on(table.projectId, table.failedAt)],
);

export const performanceSamples = pgTable(
  'performance_samples',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sampleId: varchar('sample_id', { length: 256 }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull(),
    name: varchar('name', { length: 16 }).notNull(),
    value: doublePrecision('value').notNull(),
    unit: varchar('unit', { length: 16 }).notNull(),
    sequence: integer('sequence').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    serverRating: varchar('server_rating', { length: 32 }),
    clientRating: varchar('client_rating', { length: 32 }),
    thresholdVersionId: uuid('threshold_version_id').references(() => thresholdVersions.id, { onDelete: 'set null' }),
    environment: varchar('environment', { length: 64 }).notNull(),
    appVersion: varchar('app_version', { length: 64 }).notNull(),
    routeName: varchar('route_name', { length: 160 }).notNull(),
    sessionId: varchar('session_id', { length: 256 }).notNull(),
    viewId: varchar('view_id', { length: 256 }).notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.sampleId, table.observedAt] }), index('performance_sample_lookup_idx').on(table.projectId, table.sampleId), index('performance_project_time_idx').on(table.projectId, table.observedAt)],
);

export const viewRecords = pgTable(
  'view_records',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    viewId: varchar('view_id', { length: 256 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    routeName: varchar('route_name', { length: 160 }).notNull(),
    url: text('url').notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    environment: varchar('environment', { length: 64 }).notNull(),
    appVersion: varchar('app_version', { length: 64 }).notNull(),
    sessionId: varchar('session_id', { length: 256 }).notNull(),
    userHash: varchar('user_hash', { length: 64 }),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.viewId, table.startedAt] }), index('view_lookup_idx').on(table.projectId, table.viewId), index('view_project_time_idx').on(table.projectId, table.startedAt)],
);

export const customEventSamples = pgTable(
  'custom_event_samples',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 256 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    environment: varchar('environment', { length: 64 }).notNull(),
    appVersion: varchar('app_version', { length: 64 }).notNull(),
    routeName: varchar('route_name', { length: 160 }).notNull(),
    sessionId: varchar('session_id', { length: 256 }).notNull(),
    viewId: varchar('view_id', { length: 256 }).notNull(),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.eventId, table.occurredAt] }), index('custom_event_project_name_time_idx').on(table.projectId, table.name, table.occurredAt)],
);

export const customSignalSamples = pgTable(
  'custom_signal_samples',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 256 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    status: varchar('status', { length: 16 }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: doublePrecision('duration_ms'),
    traceId: varchar('trace_id', { length: 256 }),
    spanId: varchar('span_id', { length: 256 }),
    parentSpanId: varchar('parent_span_id', { length: 256 }),
    environment: varchar('environment', { length: 64 }).notNull(),
    appVersion: varchar('app_version', { length: 64 }).notNull(),
    routeName: varchar('route_name', { length: 160 }).notNull(),
    sessionId: varchar('session_id', { length: 256 }).notNull(),
    viewId: varchar('view_id', { length: 256 }).notNull(),
    userHash: varchar('user_hash', { length: 64 }),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.eventId, table.occurredAt] }),
    index('custom_signal_project_kind_name_time_idx').on(table.projectId, table.kind, table.name, table.occurredAt),
    index('custom_signal_project_trace_time_idx').on(table.projectId, table.traceId, table.occurredAt),
  ],
);

export const customMetricSamples = pgTable(
  'custom_metric_samples',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 256 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    signalKind: varchar('signal_kind', { length: 16 }).notNull(),
    signalName: varchar('signal_name', { length: 128 }).notNull(),
    metricName: varchar('metric_name', { length: 64 }).notNull(),
    unit: varchar('unit', { length: 32 }).notNull(),
    value: doublePrecision('value').notNull(),
    environment: varchar('environment', { length: 64 }).notNull(),
    appVersion: varchar('app_version', { length: 64 }).notNull(),
    routeName: varchar('route_name', { length: 160 }).notNull(),
    sessionId: varchar('session_id', { length: 256 }).notNull(),
    viewId: varchar('view_id', { length: 256 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.eventId, table.occurredAt, table.metricName, table.unit] }),
    index('custom_metric_project_signal_metric_time_idx').on(
      table.projectId,
      table.signalKind,
      table.signalName,
      table.metricName,
      table.unit,
      table.occurredAt,
    ),
  ],
);
export const labAuditSettings = pgTable('lab_audit_settings', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  headersCiphertext: bytea('headers_ciphertext'),
  headersIv: bytea('headers_iv'),
  headersAuthTag: bytea('headers_auth_tag'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const labAudits = pgTable(
  'lab_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    targetUrl: text('target_url').notNull(),
    device: varchar('device', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    requestedRuns: integer('requested_runs').notNull().default(5),
    completedRuns: integer('completed_runs').notNull().default(0),
    successfulRuns: integer('successful_runs').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lighthouseVersion: varchar('lighthouse_version', { length: 64 }),
    chromeVersion: varchar('chrome_version', { length: 128 }),
    environment: jsonb('environment').$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb('summary').$type<Record<string, unknown>>(),
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    warning: text('warning'),
    lastError: text('last_error'),
    lockedBy: varchar('locked_by', { length: 128 }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [index('lab_audits_project_created_idx').on(table.projectId, table.createdAt)],
);

export const labAuditRuns = pgTable(
  'lab_audit_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auditId: uuid('audit_id').notNull().references(() => labAudits.id, { onDelete: 'cascade' }),
    runNumber: integer('run_number').notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    scores: jsonb('scores').$type<Record<string, number | null>>(),
    metrics: jsonb('metrics').$type<Record<string, number | null>>(),
    diagnostics: jsonb('diagnostics').$type<Array<Record<string, unknown>>>(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt,
  },
  (table) => [uniqueIndex('lab_audit_runs_unique').on(table.auditId, table.runNumber), index('lab_audit_runs_audit_idx').on(table.auditId, table.runNumber)],
);
