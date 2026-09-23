CREATE TABLE custom_signal_samples (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('event', 'trace', 'span')),
  name varchar(128) NOT NULL,
  status varchar(16) CHECK (status IN ('ok', 'error', 'cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms double precision CHECK (duration_ms >= 0),
  trace_id varchar(256),
  span_id varchar(256),
  parent_span_id varchar(256),
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  route_name varchar(160) NOT NULL,
  session_id varchar(256) NOT NULL,
  view_id varchar(256) NOT NULL,
  user_hash varchar(64),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (project_id, event_id, occurred_at)
);
SELECT create_hypertable('custom_signal_samples', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX custom_signal_project_kind_name_time_idx
  ON custom_signal_samples(project_id, kind, name, occurred_at DESC);
CREATE INDEX custom_signal_project_trace_time_idx
  ON custom_signal_samples(project_id, trace_id, occurred_at) WHERE trace_id IS NOT NULL;

CREATE TABLE custom_metric_samples (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  signal_kind varchar(16) NOT NULL CHECK (signal_kind IN ('event', 'trace', 'span')),
  signal_name varchar(128) NOT NULL,
  metric_name varchar(64) NOT NULL,
  unit varchar(32) NOT NULL,
  value double precision NOT NULL,
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  route_name varchar(160) NOT NULL,
  session_id varchar(256) NOT NULL,
  view_id varchar(256) NOT NULL,
  PRIMARY KEY (project_id, event_id, occurred_at, metric_name, unit)
);
SELECT create_hypertable('custom_metric_samples', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX custom_metric_project_signal_metric_time_idx
  ON custom_metric_samples(project_id, signal_kind, signal_name, metric_name, unit, occurred_at DESC);

CREATE MATERIALIZED VIEW custom_signal_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id,
  kind,
  name,
  environment,
  app_version,
  route_name,
  count(*)::bigint AS signal_count,
  hyperloglog(8192, session_id) AS session_hll,
  hyperloglog(8192, view_id) AS view_hll,
  max(occurred_at) AS latest_at
FROM custom_signal_samples
GROUP BY bucket, project_id, kind, name, environment, app_version, route_name
WITH NO DATA;
CREATE INDEX custom_signal_rollup_1m_project_bucket_idx
  ON custom_signal_rollup_1m(project_id, bucket DESC);

CREATE MATERIALIZED VIEW custom_metric_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id,
  signal_kind,
  signal_name,
  metric_name,
  unit,
  environment,
  app_version,
  route_name,
  count(*)::bigint AS sample_count,
  sum(value) AS total,
  min(value) AS minimum,
  max(value) AS maximum,
  avg(value) AS average,
  percentile_agg(value) AS value_percentiles,
  hyperloglog(8192, session_id) AS session_hll,
  hyperloglog(8192, view_id) AS view_hll,
  max(occurred_at) AS latest_at
FROM custom_metric_samples
GROUP BY bucket, project_id, signal_kind, signal_name, metric_name, unit, environment, app_version, route_name
WITH NO DATA;
CREATE INDEX custom_metric_rollup_1m_project_bucket_idx
  ON custom_metric_rollup_1m(project_id, bucket DESC);

SELECT add_continuous_aggregate_policy(
  'custom_signal_rollup_1m',
  start_offset => INTERVAL '29 days', end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds', if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'custom_metric_rollup_1m',
  start_offset => INTERVAL '29 days', end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds', if_not_exists => TRUE
);
SELECT add_retention_policy('custom_signal_samples', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_metric_samples', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_signal_rollup_1m', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_metric_rollup_1m', INTERVAL '180 days', if_not_exists => TRUE);

ALTER TABLE custom_signal_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,kind,name',
  timescaledb.compress_orderby = 'occurred_at DESC'
);
ALTER TABLE custom_metric_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,signal_kind,signal_name,metric_name,unit',
  timescaledb.compress_orderby = 'occurred_at DESC'
);
SELECT add_compression_policy('custom_signal_samples', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_compression_policy('custom_metric_samples', INTERVAL '24 hours', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW custom_signal_rollup_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW custom_metric_rollup_1m SET (timescaledb.materialized_only = false);
