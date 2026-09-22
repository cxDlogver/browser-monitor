CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  display_name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL UNIQUE,
  csrf_token varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id);

CREATE TABLE account_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL CHECK (purpose IN ('verify-email', 'reset-password')),
  token_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON account_tokens(user_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name varchar(120) NOT NULL,
  app_name varchar(128) NOT NULL,
  user_hash_salt varchar(128) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_app_name_idx ON projects(app_name);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);

CREATE TABLE ingestion_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_key varchar(96) NOT NULL UNIQUE,
  label varchar(80) NOT NULL DEFAULT 'default',
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingestion_keys_project_idx ON ingestion_keys(project_id);

CREATE TABLE allowed_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin varchar(512) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, origin)
);

CREATE TABLE threshold_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  config jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX threshold_versions_global_version_unique
  ON threshold_versions(version) WHERE project_id IS NULL;
CREATE UNIQUE INDEX threshold_versions_project_version_unique
  ON threshold_versions(project_id, version) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX threshold_versions_one_active_global
  ON threshold_versions((active)) WHERE project_id IS NULL AND active;
CREATE UNIQUE INDEX threshold_versions_one_active_project
  ON threshold_versions(project_id) WHERE project_id IS NOT NULL AND active;

INSERT INTO threshold_versions(project_id, version, config, active)
VALUES (
  NULL,
  1,
  '{
    "LCP":{"direction":"lower-is-better","good":2500,"poor":4000},
    "INP":{"direction":"lower-is-better","good":200,"poor":500},
    "CLS":{"direction":"lower-is-better","good":0.1,"poor":0.25},
    "FCP":{"direction":"lower-is-better","good":1800,"poor":3000},
    "FPS":{"direction":"higher-is-better","good":50,"poor":30}
  }'::jsonb,
  true
);

CREATE TABLE project_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  token_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_invitations_email_idx ON project_invitations(email);
CREATE UNIQUE INDEX project_invitations_pending_unique
  ON project_invitations(project_id, email) WHERE accepted_at IS NULL;

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(128) NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_project_time_idx ON audit_logs(project_id, created_at DESC);

CREATE TABLE telemetry_events (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  type varchar(32) NOT NULL,
  name varchar(128) NOT NULL,
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  session_id varchar(256) NOT NULL,
  view_id varchar(256) NOT NULL,
  route_name varchar(160) NOT NULL,
  user_hash varchar(64),
  event jsonb NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (project_id, event_id, occurred_at)
);
SELECT create_hypertable('telemetry_events', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX telemetry_project_time_idx ON telemetry_events(project_id, occurred_at DESC);
CREATE INDEX telemetry_project_type_time_idx ON telemetry_events(project_id, type, occurred_at DESC);

CREATE TABLE outbox_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  event jsonb NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(128),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, event_id, occurred_at)
);
CREATE INDEX outbox_claim_idx ON outbox_tasks(status, available_at) WHERE status IN ('pending', 'processing');

CREATE TABLE dead_letter_tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  event jsonb NOT NULL,
  attempts integer NOT NULL,
  last_error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dead_letter_project_time_idx ON dead_letter_tasks(project_id, failed_at DESC);

CREATE TABLE performance_samples (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sample_id varchar(256) NOT NULL,
  observed_at timestamptz NOT NULL,
  last_updated_at timestamptz NOT NULL,
  name varchar(16) NOT NULL,
  value double precision NOT NULL CHECK (value >= 0),
  unit varchar(16) NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  state varchar(16) NOT NULL CHECK (state IN ('provisional', 'final')),
  server_rating varchar(32),
  client_rating varchar(32),
  threshold_version_id uuid REFERENCES threshold_versions(id) ON DELETE SET NULL,
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  route_name varchar(160) NOT NULL,
  session_id varchar(256) NOT NULL,
  view_id varchar(256) NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (project_id, sample_id, observed_at)
);
SELECT create_hypertable('performance_samples', 'observed_at', if_not_exists => TRUE);
CREATE INDEX performance_sample_lookup_idx ON performance_samples(project_id, sample_id);
CREATE INDEX performance_project_time_idx ON performance_samples(project_id, observed_at DESC);
CREATE INDEX performance_project_route_time_idx ON performance_samples(project_id, route_name, observed_at DESC);

CREATE TABLE view_records (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  view_id varchar(256) NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  route_name varchar(160) NOT NULL,
  url text NOT NULL,
  source varchar(32) NOT NULL,
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  session_id varchar(256) NOT NULL,
  user_hash varchar(64),
  PRIMARY KEY (project_id, view_id, started_at)
);
SELECT create_hypertable('view_records', 'started_at', if_not_exists => TRUE);
CREATE INDEX view_lookup_idx ON view_records(project_id, view_id);
CREATE INDEX view_project_time_idx ON view_records(project_id, started_at DESC);

CREATE TABLE custom_event_samples (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  name varchar(128) NOT NULL,
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  route_name varchar(160) NOT NULL,
  session_id varchar(256) NOT NULL,
  view_id varchar(256) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (project_id, event_id, occurred_at)
);
SELECT create_hypertable('custom_event_samples', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX custom_event_project_name_time_idx ON custom_event_samples(project_id, name, occurred_at DESC);

CREATE MATERIALIZED VIEW performance_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', observed_at) AS bucket,
  project_id,
  name,
  environment,
  app_version,
  route_name,
  threshold_version_id,
  count(*)::bigint AS sample_count,
  min(value) AS minimum,
  max(value) AS maximum,
  avg(value) AS average,
  percentile_agg(value) AS value_percentiles,
  count(*) FILTER (WHERE server_rating = 'good')::bigint AS good_count,
  count(*) FILTER (WHERE server_rating = 'needs-improvement')::bigint AS needs_improvement_count,
  count(*) FILTER (WHERE server_rating = 'poor')::bigint AS poor_count,
  hyperloglog(8192, session_id) AS session_hll,
  hyperloglog(8192, view_id) AS view_hll,
  sum(CASE WHEN name = 'LoAF' THEN COALESCE((detail->>'blockingDuration')::double precision, 0) ELSE 0 END) AS blocking_duration_total,
  sum(CASE WHEN name = 'LoAF' THEN COALESCE((detail->>'scriptCount')::integer, 0) ELSE 0 END)::bigint AS script_count
FROM performance_samples
GROUP BY bucket, project_id, name, environment, app_version, route_name, threshold_version_id
WITH NO DATA;

CREATE INDEX performance_rollup_project_bucket_idx
  ON performance_rollup_1m(project_id, bucket DESC);

CREATE MATERIALIZED VIEW view_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', started_at) AS bucket,
  project_id,
  environment,
  app_version,
  route_name,
  count(*)::bigint AS view_count,
  hyperloglog(8192, session_id) AS session_hll,
  count(*) FILTER (WHERE ended_at IS NOT NULL)::bigint AS ended_count,
  sum(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000) FILTER (WHERE ended_at IS NOT NULL) AS duration_total_ms
FROM view_records
GROUP BY bucket, project_id, environment, app_version, route_name
WITH NO DATA;

CREATE INDEX view_rollup_project_bucket_idx ON view_rollup_1m(project_id, bucket DESC);

CREATE MATERIALIZED VIEW custom_event_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id,
  name,
  environment,
  app_version,
  route_name,
  count(*)::bigint AS event_count
FROM custom_event_samples
GROUP BY bucket, project_id, name, environment, app_version, route_name
WITH NO DATA;

CREATE INDEX custom_event_rollup_project_bucket_idx ON custom_event_rollup_1m(project_id, bucket DESC);

CREATE MATERIALIZED VIEW telemetry_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id,
  type,
  name,
  environment,
  app_version,
  route_name,
  count(*)::bigint AS event_count
FROM telemetry_events
GROUP BY bucket, project_id, type, name, environment, app_version, route_name
WITH NO DATA;

CREATE INDEX telemetry_rollup_project_bucket_idx ON telemetry_rollup_1m(project_id, bucket DESC);

SELECT add_continuous_aggregate_policy(
  'performance_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'view_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'custom_event_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);

SELECT add_retention_policy('telemetry_events', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('performance_samples', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('view_records', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_event_samples', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('performance_rollup_1m', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('view_rollup_1m', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_event_rollup_1m', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry_rollup_1m', INTERVAL '180 days', if_not_exists => TRUE);

ALTER TABLE telemetry_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,type',
  timescaledb.compress_orderby = 'occurred_at DESC'
);
ALTER TABLE performance_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,name',
  timescaledb.compress_orderby = 'observed_at DESC'
);
ALTER TABLE view_records SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id',
  timescaledb.compress_orderby = 'started_at DESC'
);
ALTER TABLE custom_event_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,name',
  timescaledb.compress_orderby = 'occurred_at DESC'
);

SELECT add_compression_policy('telemetry_events', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_compression_policy('performance_samples', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_compression_policy('view_records', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_compression_policy('custom_event_samples', INTERVAL '24 hours', if_not_exists => TRUE);
