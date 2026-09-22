-- Hierarchical continuous aggregates are created after the minute source
-- aggregates commit so TimescaleDB can validate their bucket metadata.
-- Hierarchical hourly aggregates keep 180-day queries bounded while minute
-- aggregates continue to serve the near-real-time dashboard.
CREATE MATERIALIZED VIEW performance_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id,
  name,
  environment,
  app_version,
  route_name,
  threshold_version_id,
  sum(sample_count)::bigint AS sample_count,
  min(minimum) AS minimum,
  max(maximum) AS maximum,
  sum(average * sample_count) / NULLIF(sum(sample_count), 0) AS average,
  rollup(value_percentiles) AS value_percentiles,
  sum(good_count)::bigint AS good_count,
  sum(needs_improvement_count)::bigint AS needs_improvement_count,
  sum(poor_count)::bigint AS poor_count,
  rollup(session_hll) AS session_hll,
  rollup(view_hll) AS view_hll,
  sum(blocking_duration_total) AS blocking_duration_total,
  sum(script_count)::bigint AS script_count
FROM performance_rollup_1m
GROUP BY 1, 2, 3, 4, 5, 6, 7
WITH NO DATA;

CREATE INDEX performance_rollup_1h_project_bucket_idx ON performance_rollup_1h(project_id, bucket DESC);

CREATE MATERIALIZED VIEW view_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id,
  environment,
  app_version,
  route_name,
  sum(view_count)::bigint AS view_count,
  rollup(session_hll) AS session_hll,
  sum(ended_count)::bigint AS ended_count,
  sum(duration_total_ms) AS duration_total_ms
FROM view_rollup_1m
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

CREATE INDEX view_rollup_1h_project_bucket_idx ON view_rollup_1h(project_id, bucket DESC);

CREATE MATERIALIZED VIEW custom_event_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id,
  name,
  environment,
  app_version,
  route_name,
  sum(event_count)::bigint AS event_count
FROM custom_event_rollup_1m
GROUP BY 1, 2, 3, 4, 5, 6
WITH NO DATA;

CREATE INDEX custom_event_rollup_1h_project_bucket_idx ON custom_event_rollup_1h(project_id, bucket DESC);

CREATE MATERIALIZED VIEW telemetry_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id,
  type,
  name,
  environment,
  app_version,
  route_name,
  sum(event_count)::bigint AS event_count
FROM telemetry_rollup_1m
GROUP BY 1, 2, 3, 4, 5, 6, 7
WITH NO DATA;

CREATE INDEX telemetry_rollup_1h_project_bucket_idx ON telemetry_rollup_1h(project_id, bucket DESC);

SELECT add_continuous_aggregate_policy(
  'performance_rollup_1h',
  start_offset => INTERVAL '179 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'view_rollup_1h',
  start_offset => INTERVAL '179 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'custom_event_rollup_1h',
  start_offset => INTERVAL '179 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1h',
  start_offset => INTERVAL '179 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);

SELECT add_retention_policy('performance_rollup_1h', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('view_rollup_1h', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_event_rollup_1h', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry_rollup_1h', INTERVAL '180 days', if_not_exists => TRUE);
