ALTER MATERIALIZED VIEW performance_rollup_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW view_rollup_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW custom_event_rollup_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_rollup_1m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW performance_rollup_1h SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW view_rollup_1h SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW custom_event_rollup_1h SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW telemetry_rollup_1h SET (timescaledb.materialized_only = false);
