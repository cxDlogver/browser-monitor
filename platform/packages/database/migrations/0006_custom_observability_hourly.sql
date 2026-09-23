-- Hierarchical aggregates require the minute aggregate migration to commit first.
CREATE MATERIALIZED VIEW custom_signal_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id,
  kind,
  name,
  environment,
  app_version,
  route_name,
  sum(signal_count)::bigint AS signal_count,
  rollup(session_hll) AS session_hll,
  rollup(view_hll) AS view_hll,
  max(latest_at) AS latest_at
FROM custom_signal_rollup_1m
GROUP BY 1, 2, 3, 4, 5, 6, 7
WITH NO DATA;
CREATE INDEX custom_signal_rollup_1h_project_bucket_idx
  ON custom_signal_rollup_1h(project_id, bucket DESC);

CREATE MATERIALIZED VIEW custom_metric_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id,
  signal_kind,
  signal_name,
  metric_name,
  unit,
  environment,
  app_version,
  route_name,
  sum(sample_count)::bigint AS sample_count,
  sum(total) AS total,
  min(minimum) AS minimum,
  max(maximum) AS maximum,
  sum(average * sample_count) / NULLIF(sum(sample_count), 0) AS average,
  rollup(value_percentiles) AS value_percentiles,
  rollup(session_hll) AS session_hll,
  rollup(view_hll) AS view_hll,
  max(latest_at) AS latest_at
FROM custom_metric_rollup_1m
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
WITH NO DATA;
CREATE INDEX custom_metric_rollup_1h_project_bucket_idx
  ON custom_metric_rollup_1h(project_id, bucket DESC);

SELECT add_continuous_aggregate_policy(
  'custom_signal_rollup_1h',
  start_offset => INTERVAL '179 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'custom_metric_rollup_1h',
  start_offset => INTERVAL '179 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE
);

SELECT add_retention_policy('custom_signal_rollup_1h', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('custom_metric_rollup_1h', INTERVAL '180 days', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW custom_signal_rollup_1h SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW custom_metric_rollup_1h SET (timescaledb.materialized_only = false);
