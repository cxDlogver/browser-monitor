import { Inject, Injectable } from "@nestjs/common";
import type { DatabaseHandle } from "@browser-monitor/database";
import type { Redis } from "ioredis";

import { DATABASE, REDIS } from "../infrastructure/tokens.js";
import { ProjectsService } from "../projects/projects.service.js";

export interface AnalyticsFilters {
  from: Date;
  to: Date;
  environment?: string;
  version?: string;
  routeName?: string;
  metric?: string;
}

interface SqlFilter {
  where: string;
  values: unknown[];
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly projects: ProjectsService,
  ) {}

  async overview(userId: string, projectId: string, filters: AnalyticsFilters) {
    await this.projects.requireAccess(userId, projectId);
    if (this.useRollups(filters))
      return this.overviewFromRollups(projectId, filters);
    return this.cached(projectId, "overview", filters, async () => {
      const viewFilter = this.filters("v", "started_at", projectId, filters);
      const eventFilter = this.filters("e", "occurred_at", projectId, filters);
      const metricFilter = this.filters("p", "observed_at", projectId, filters);
      const [views, events, metrics] = await Promise.all([
        this.database.pool.query(
          `SELECT count(*)::bigint AS views, count(DISTINCT session_id)::bigint AS sessions
           FROM view_records v WHERE ${viewFilter.where}`,
          viewFilter.values,
        ),
        this.database.pool.query(
          `SELECT count(*)::bigint AS events FROM telemetry_events e WHERE ${eventFilter.where}`,
          eventFilter.values,
        ),
        this.database.pool.query(
          `SELECT name,
             count(*)::bigint AS count,
             count(DISTINCT session_id)::bigint AS session_count,
             count(DISTINCT view_id)::bigint AS view_count,
             min(value) AS minimum,
             max(value) AS maximum,
             avg(value) AS average,
             percentile_cont(0.50) WITHIN GROUP (ORDER BY value) AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75,
             percentile_cont(0.90) WITHIN GROUP (ORDER BY value) AS p90,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95,
             count(*) FILTER (WHERE server_rating = 'good')::bigint AS good_count,
             count(*) FILTER (WHERE server_rating = 'needs-improvement')::bigint AS needs_improvement_count,
             count(*) FILTER (WHERE server_rating = 'poor')::bigint AS poor_count
           FROM performance_samples p
           WHERE ${metricFilter.where}
           GROUP BY name ORDER BY name`,
          metricFilter.values,
        ),
      ]);
      return {
        views: Number(views.rows[0]?.views ?? 0),
        sessions: Number(views.rows[0]?.sessions ?? 0),
        events: Number(events.rows[0]?.events ?? 0),
        metrics: metrics.rows.map((row) =>
          this.metricRow(row, Number(views.rows[0]?.views ?? 0)),
        ),
      };
    });
  }

  async performance(
    userId: string,
    projectId: string,
    filters: AnalyticsFilters,
  ) {
    await this.projects.requireAccess(userId, projectId);
    if (this.useRollups(filters))
      return this.performanceFromRollups(projectId, filters);
    return this.cached(projectId, "performance", filters, async () => {
      const filter = this.filters("p", "observed_at", projectId, filters);
      const viewFilter = this.filters("v", "started_at", projectId, filters);
      const result = await this.database.pool.query(
        `WITH metric_points AS (
           SELECT time_bucket(INTERVAL '1 minute', observed_at) AS bucket, name,
             count(*)::bigint AS count,
             count(DISTINCT session_id)::bigint AS session_count,
             count(DISTINCT view_id)::bigint AS view_count,
             avg(value) AS average,
             percentile_cont(0.50) WITHIN GROUP (ORDER BY value) AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75,
             percentile_cont(0.90) WITHIN GROUP (ORDER BY value) AS p90,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95,
             count(*) FILTER (WHERE server_rating = 'good')::bigint AS good_count,
             count(*) FILTER (WHERE server_rating = 'needs-improvement')::bigint AS needs_improvement_count,
             count(*) FILTER (WHERE server_rating = 'poor')::bigint AS poor_count,
             sum(CASE WHEN name = 'LoAF' THEN COALESCE((detail->>'blockingDuration')::double precision, 0) ELSE 0 END) AS blocking_duration_total,
             sum(CASE WHEN name = 'LoAF' THEN COALESCE((detail->>'scriptCount')::integer, 0) ELSE 0 END)::bigint AS script_count
           FROM performance_samples p WHERE ${filter.where}
           GROUP BY bucket, name
         ), view_points AS (
           SELECT time_bucket(INTERVAL '1 minute', started_at) AS bucket,
             count(*)::bigint AS page_views
           FROM view_records v WHERE ${viewFilter.where}
           GROUP BY bucket
         )
         SELECT m.*, COALESCE(v.page_views, 0)::bigint AS page_views
         FROM metric_points m LEFT JOIN view_points v USING (bucket)
         ORDER BY m.bucket, m.name`,
        filter.values,
      );
      return result.rows.map((row) => ({
        bucket: row.bucket,
        name: row.name,
        count: Number(row.count),
        average: this.number(row.average),
        p50: this.number(row.p50),
        p75: this.number(row.p75),
        p90: this.number(row.p90),
        p95: this.number(row.p95),
        goodCount: Number(row.good_count),
        needsImprovementCount: Number(row.needs_improvement_count),
        poorCount: Number(row.poor_count),
        sessionCount: Number(row.session_count),
        viewCount: Number(row.view_count),
        sampleCoverage:
          Number(row.page_views) > 0
            ? Number(row.view_count) / Number(row.page_views)
            : 0,
        blockingDurationTotal: this.number(row.blocking_duration_total),
        scriptCount: Number(row.script_count ?? 0),
      }));
    });
  }

  async routes(userId: string, projectId: string, filters: AnalyticsFilters) {
    await this.projects.requireAccess(userId, projectId);
    if (this.useRollups(filters))
      return this.routesFromRollups(projectId, filters);
    return this.cached(projectId, "routes", filters, async () => {
      const { routeName: _routeName, ...withoutRoute } = filters;
      const filter = this.filters("p", "observed_at", projectId, withoutRoute);
      const viewFilter = this.filters(
        "v",
        "started_at",
        projectId,
        withoutRoute,
      );
      const result = await this.database.pool.query(
        `WITH metric_routes AS (
           SELECT route_name, name, count(*)::bigint AS count,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75,
             count(*) FILTER (WHERE server_rating IN ('needs-improvement', 'poor'))::bigint AS abnormal_count
           FROM performance_samples p WHERE ${filter.where}
           GROUP BY route_name, name
         ), route_views AS (
           SELECT route_name, count(*)::bigint AS page_views
           FROM view_records v WHERE ${viewFilter.where}
           GROUP BY route_name
         )
         SELECT m.*, COALESCE(v.page_views, 0)::bigint AS page_views
         FROM metric_routes m LEFT JOIN route_views v USING (route_name)
         ORDER BY m.abnormal_count DESC, m.p75 DESC LIMIT 200`,
        filter.values,
      );
      return result.rows.map((row) => ({
        routeName: row.route_name,
        name: row.name,
        count: Number(row.count),
        p75: this.number(row.p75),
        abnormalCount: Number(row.abnormal_count),
        abnormalRate:
          Number(row.count) > 0
            ? Number(row.abnormal_count) / Number(row.count)
            : 0,
        pageViews: Number(row.page_views),
        loafPerThousandViews:
          row.name === "LoAF" && Number(row.page_views) > 0
            ? (Number(row.count) * 1_000) / Number(row.page_views)
            : null,
      }));
    });
  }

  async customEvents(
    userId: string,
    projectId: string,
    filters: AnalyticsFilters,
  ) {
    await this.projects.requireAccess(userId, projectId);
    if (this.useRollups(filters))
      return this.eventsFromRollups(projectId, filters);
    return this.cached(projectId, "custom-events", filters, async () => {
      const filter = this.filters("c", "occurred_at", projectId, filters);
      const result = await this.database.pool.query(
        `SELECT time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
           name, route_name, count(*)::bigint AS count
         FROM custom_event_samples c
         WHERE ${filter.where}
         GROUP BY bucket, name, route_name
         ORDER BY bucket, count DESC`,
        filter.values,
      );
      return result.rows.map((row) => ({
        bucket: row.bucket,
        name: row.name,
        routeName: row.route_name,
        count: Number(row.count),
      }));
    });
  }

  async rawEvents(
    userId: string,
    projectId: string,
    filters: AnalyticsFilters,
    cursor: string | undefined,
    limit: number,
    type?: string,
    name?: string,
    sessionId?: string,
    viewId?: string,
    eventId?: string,
  ) {
    await this.projects.requireAccess(userId, projectId);
    const filter = this.filters("e", "occurred_at", projectId, filters);
    const conditions = [filter.where];
    const values = [...filter.values];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (type) add("e.type = ?", type);
    if (name) add("e.name = ?", name);
    if (sessionId) add("e.session_id = ?", sessionId);
    if (viewId) add("e.view_id = ?", viewId);
    if (eventId) add("e.event_id = ?", eventId);
    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        ) as [string, string];
        values.push(new Date(decoded[0]), decoded[1]);
        conditions.push(
          `(e.occurred_at, e.event_id) < ($${values.length - 1}, $${values.length})`,
        );
      } catch {
        // Invalid cursors simply start at the first page; they never enter SQL.
      }
    }
    values.push(limit + 1);
    const result = await this.database.pool.query(
      `SELECT event_id, occurred_at, received_at, type, name, environment, app_version,
         session_id, view_id, route_name, event
       FROM telemetry_events e
       WHERE ${conditions.join(" AND ")}
       ORDER BY occurred_at DESC, event_id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        eventId: row.event_id,
        occurredAt: row.occurred_at,
        receivedAt: row.received_at,
        type: row.type,
        name: row.name,
        environment: row.environment,
        version: row.app_version,
        sessionId: row.session_id,
        viewId: row.view_id,
        routeName: row.route_name,
        event: row.event,
      })),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify([last.occurred_at, last.event_id]),
            ).toString("base64url")
          : null,
    };
  }

  async serviceStatus(userId: string, projectId: string) {
    const access = await this.projects.requireAccess(userId, projectId);
    const recentSince = Date.now() - 60_000;
    const [result, ingestionStats, recentRequests, dead] = await Promise.all([
      this.database.pool.query(
        `SELECT
           count(*) FILTER (WHERE status = 'pending')::bigint AS pending,
           count(*) FILTER (WHERE status = 'processing')::bigint AS processing,
           count(*) FILTER (WHERE status = 'failed')::bigint AS failed,
           count(*) FILTER (WHERE status = 'completed' AND completed_at > now() - INTERVAL '1 minute')::bigint AS processed_last_minute
         FROM outbox_tasks WHERE project_id = $1`,
        [projectId],
      ),
      this.redis.hgetall(`ingestion:stats:${projectId}`),
      this.redis.zrangebyscore(
        `ingestion:rate:${projectId}`,
        recentSince,
        "+inf",
      ),
      this.database.pool.query<{
        id: string;
        event_id: string;
        attempts: number;
        last_error: string;
        failed_at: Date;
        total: string;
      }>(
        `SELECT id, event_id, attempts, last_error, failed_at,
           count(*) OVER()::bigint AS total
         FROM dead_letter_tasks WHERE project_id = $1
         ORDER BY failed_at DESC LIMIT 20`,
        [projectId],
      ),
    ]);
    const acceptedLastMinute = recentRequests.reduce((total, value) => {
      try {
        const entry = JSON.parse(value) as [string, number];
        const count = Number(entry[1]);
        return Number.isFinite(count) ? total + count : total;
      } catch {
        return total;
      }
    }, 0);
    return {
      role: access.role,
      pending: Number(result.rows[0]?.pending ?? 0),
      processing: Number(result.rows[0]?.processing ?? 0),
      failed: Number(result.rows[0]?.failed ?? 0),
      processedLastMinute: Number(result.rows[0]?.processed_last_minute ?? 0),
      acceptedLastMinute,
      deadLetters: Number(dead.rows[0]?.total ?? 0),
      accepted: Number(ingestionStats.accepted ?? 0),
      duplicate: Number(ingestionStats.duplicate ?? 0),
      rejected: Number(ingestionStats.rejected ?? 0),
      recentDeadLetters: dead.rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        attempts: row.attempts,
        error: row.last_error,
        failedAt: row.failed_at,
      })),
    };
  }

  private filters(
    alias: string,
    timeColumn: string,
    projectId: string,
    filters: AnalyticsFilters,
  ): SqlFilter {
    const values: unknown[] = [projectId, filters.from, filters.to];
    const conditions = [
      `${alias}.project_id = $1`,
      `${alias}.${timeColumn} >= $2`,
      `${alias}.${timeColumn} < $3`,
    ];
    const add = (column: string, value: string | undefined): void => {
      if (!value) return;
      values.push(value);
      conditions.push(`${alias}.${column} = $${values.length}`);
    };
    add("environment", filters.environment);
    add("app_version", filters.version);
    add("route_name", filters.routeName);
    if (filters.metric && alias === "p") add("name", filters.metric);
    return { where: conditions.join(" AND "), values };
  }

  private useRollups(filters: AnalyticsFilters): boolean {
    return filters.from.getTime() < Date.now() - 29 * 24 * 60 * 60_000;
  }

  private async overviewFromRollups(
    projectId: string,
    filters: AnalyticsFilters,
  ) {
    return this.cached(projectId, "overview-rollup", filters, async () => {
      const viewFilter = this.filters("v", "bucket", projectId, filters);
      const metricFilter = this.filters("p", "bucket", projectId, filters);
      const eventFilter = this.filters("c", "bucket", projectId, filters);
      const [views, metrics, customEvents] = await Promise.all([
        this.database.pool.query(
          `SELECT COALESCE(sum(view_count), 0)::bigint AS views,
             COALESCE(distinct_count(rollup(session_hll)), 0)::bigint AS sessions
           FROM view_rollup_1h v WHERE ${viewFilter.where}`,
          viewFilter.values,
        ),
        this.database.pool.query(
          `SELECT name, sum(sample_count)::bigint AS count,
             distinct_count(rollup(session_hll))::bigint AS session_count,
             distinct_count(rollup(view_hll))::bigint AS view_count,
             min(minimum) AS minimum, max(maximum) AS maximum,
             sum(average * sample_count) / NULLIF(sum(sample_count), 0) AS average,
             approx_percentile(0.50, rollup(value_percentiles)) AS p50,
             approx_percentile(0.75, rollup(value_percentiles)) AS p75,
             approx_percentile(0.90, rollup(value_percentiles)) AS p90,
             approx_percentile(0.95, rollup(value_percentiles)) AS p95,
             sum(good_count)::bigint AS good_count,
             sum(needs_improvement_count)::bigint AS needs_improvement_count,
             sum(poor_count)::bigint AS poor_count
           FROM performance_rollup_1h p WHERE ${metricFilter.where}
           GROUP BY name ORDER BY name`,
          metricFilter.values,
        ),
        this.database.pool.query(
          `SELECT COALESCE(sum(event_count), 0)::bigint AS events
           FROM telemetry_rollup_1h c WHERE ${eventFilter.where}`,
          eventFilter.values,
        ),
      ]);
      const viewCount = Number(views.rows[0]?.views ?? 0);
      return {
        views: viewCount,
        sessions: Number(views.rows[0]?.sessions ?? 0),
        events: Number(customEvents.rows[0]?.events ?? 0),
        metrics: metrics.rows.map((row) => this.metricRow(row, viewCount)),
      };
    });
  }

  private async performanceFromRollups(
    projectId: string,
    filters: AnalyticsFilters,
  ) {
    return this.cached(projectId, "performance-rollup", filters, async () => {
      const filter = this.filters("p", "bucket", projectId, filters);
      const viewFilter = this.filters("v", "bucket", projectId, filters);
      const result = await this.database.pool.query(
        `WITH metric_points AS (
           SELECT bucket, name, sum(sample_count)::bigint AS count,
             distinct_count(rollup(session_hll))::bigint AS session_count,
             distinct_count(rollup(view_hll))::bigint AS view_count,
             sum(average * sample_count) / NULLIF(sum(sample_count), 0) AS average,
             approx_percentile(0.50, rollup(value_percentiles)) AS p50,
             approx_percentile(0.75, rollup(value_percentiles)) AS p75,
             approx_percentile(0.90, rollup(value_percentiles)) AS p90,
             approx_percentile(0.95, rollup(value_percentiles)) AS p95,
             sum(good_count)::bigint AS good_count,
             sum(needs_improvement_count)::bigint AS needs_improvement_count,
             sum(poor_count)::bigint AS poor_count,
             sum(blocking_duration_total) AS blocking_duration_total,
             sum(script_count)::bigint AS script_count
           FROM performance_rollup_1h p WHERE ${filter.where}
           GROUP BY bucket, name
         ), view_points AS (
           SELECT bucket, sum(view_count)::bigint AS page_views
           FROM view_rollup_1h v WHERE ${viewFilter.where}
           GROUP BY bucket
         )
         SELECT m.*, COALESCE(v.page_views, 0)::bigint AS page_views
         FROM metric_points m LEFT JOIN view_points v USING (bucket)
         ORDER BY m.bucket, m.name`,
        filter.values,
      );
      return result.rows.map((row) => ({
        bucket: row.bucket,
        name: row.name,
        count: Number(row.count),
        average: this.number(row.average),
        p50: this.number(row.p50),
        p75: this.number(row.p75),
        p90: this.number(row.p90),
        p95: this.number(row.p95),
        goodCount: Number(row.good_count),
        needsImprovementCount: Number(row.needs_improvement_count),
        poorCount: Number(row.poor_count),
        sessionCount: Number(row.session_count),
        viewCount: Number(row.view_count),
        sampleCoverage:
          Number(row.page_views) > 0
            ? Number(row.view_count) / Number(row.page_views)
            : 0,
        blockingDurationTotal: this.number(row.blocking_duration_total),
        scriptCount: Number(row.script_count ?? 0),
      }));
    });
  }

  private async routesFromRollups(
    projectId: string,
    filters: AnalyticsFilters,
  ) {
    return this.cached(projectId, "routes-rollup", filters, async () => {
      const { routeName: _routeName, ...withoutRoute } = filters;
      const filter = this.filters("p", "bucket", projectId, withoutRoute);
      const viewFilter = this.filters("v", "bucket", projectId, withoutRoute);
      const result = await this.database.pool.query(
        `WITH metric_routes AS (
           SELECT route_name, name, sum(sample_count)::bigint AS count,
             approx_percentile(0.75, rollup(value_percentiles)) AS p75,
             (sum(needs_improvement_count) + sum(poor_count))::bigint AS abnormal_count
           FROM performance_rollup_1h p WHERE ${filter.where}
           GROUP BY route_name, name
         ), route_views AS (
           SELECT route_name, sum(view_count)::bigint AS page_views
           FROM view_rollup_1h v WHERE ${viewFilter.where}
           GROUP BY route_name
         )
         SELECT m.*, COALESCE(v.page_views, 0)::bigint AS page_views
         FROM metric_routes m LEFT JOIN route_views v USING (route_name)
         ORDER BY m.abnormal_count DESC, m.p75 DESC LIMIT 200`,
        filter.values,
      );
      return result.rows.map((row) => ({
        routeName: row.route_name,
        name: row.name,
        count: Number(row.count),
        p75: this.number(row.p75),
        abnormalCount: Number(row.abnormal_count),
        abnormalRate:
          Number(row.count) > 0
            ? Number(row.abnormal_count) / Number(row.count)
            : 0,
        pageViews: Number(row.page_views),
        loafPerThousandViews:
          row.name === "LoAF" && Number(row.page_views) > 0
            ? (Number(row.count) * 1_000) / Number(row.page_views)
            : null,
      }));
    });
  }

  private async eventsFromRollups(
    projectId: string,
    filters: AnalyticsFilters,
  ) {
    return this.cached(projectId, "events-rollup", filters, async () => {
      const filter = this.filters("c", "bucket", projectId, filters);
      const result = await this.database.pool.query(
        `SELECT bucket, name, route_name, sum(event_count)::bigint AS count
         FROM custom_event_rollup_1h c WHERE ${filter.where}
         GROUP BY bucket, name, route_name ORDER BY bucket, count DESC`,
        filter.values,
      );
      return result.rows.map((row) => ({
        bucket: row.bucket,
        name: row.name,
        routeName: row.route_name,
        count: Number(row.count),
      }));
    });
  }

  private async cached<T>(
    projectId: string,
    namespace: string,
    filters: AnalyticsFilters,
    loader: () => Promise<T>,
  ): Promise<T> {
    const version =
      (await this.redis.get(`analytics:version:${projectId}`)) ?? "0";
    const key = `analytics:${projectId}:${version}:${namespace}:${JSON.stringify(filters)}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as T;
    const value = await loader();
    await this.redis.set(key, JSON.stringify(value), "EX", 15);
    return value;
  }

  private metricRow = (row: Record<string, unknown>, totalViews = 0) => ({
    name: row.name,
    count: Number(row.count),
    minimum: this.number(row.minimum),
    maximum: this.number(row.maximum),
    average: this.number(row.average),
    p50: this.number(row.p50),
    p75: this.number(row.p75),
    p90: this.number(row.p90),
    p95: this.number(row.p95),
    goodCount: Number(row.good_count),
    needsImprovementCount: Number(row.needs_improvement_count),
    poorCount: Number(row.poor_count),
    sessionCount: Number(row.session_count ?? 0),
    viewCount: Number(row.view_count ?? 0),
    sampleCoverage:
      totalViews > 0 ? Number(row.view_count ?? 0) / totalViews : 0,
  });

  private number(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
