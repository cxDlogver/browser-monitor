import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { DatabaseHandle } from "@browser-monitor/database";
import {
  PROTOCOL_VERSION,
  telemetryBatchHeaderV2Schema,
  telemetryEventV2Schema,
  type JsonValue,
  type TelemetryEventV2,
} from "@browser-monitor/protocol";
import {
  hashUserId,
  redactProperties,
  sanitizeUrl,
  type ApiConfig,
} from "@browser-monitor/shared";
import type { Redis } from "ioredis";

import { API_CONFIG, DATABASE, REDIS } from "../infrastructure/tokens.js";
import { MetricsService } from "../observability/metrics.service.js";
import { IngestionRateLimiter } from "./rate-limiter.service.js";

interface IngestionProject {
  project_id: string;
  app_name: string;
  user_hash_salt: string;
}

export interface IngestionResult {
  accepted: number;
  duplicate: number;
  rejected: number;
  requestId: string;
  rejections: Array<{ index: number; code: string }>;
}

@Injectable()
export class IngestionService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly limiter: IngestionRateLimiter,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(
    publicKey: string,
    body: unknown,
    origin: string | undefined,
    ip: string,
    requestId: string,
  ): Promise<IngestionResult> {
    const stopTimer = this.metrics.ingestionDuration.startTimer();
    try {
      // sendBeacon commonly transmits a string as text/plain. Accept the same
      // JSON document in that representation so page-unload delivery follows
      // the identical validation path as fetch(application/json).
      let decodedBody = body;
      if (typeof body === "string") {
        try {
          decodedBody = JSON.parse(body) as unknown;
        } catch {
          decodedBody = null;
        }
      }
      if (
        typeof decodedBody !== "object" ||
        decodedBody === null ||
        !("protocolVersion" in decodedBody) ||
        (decodedBody as { protocolVersion?: unknown }).protocolVersion !==
          PROTOCOL_VERSION
      ) {
        throw new UnprocessableEntityException({
          code: "unsupported_protocol",
          supported: [PROTOCOL_VERSION],
        });
      }

      const header = telemetryBatchHeaderV2Schema.safeParse(decodedBody);
      if (!header.success) {
        throw new UnprocessableEntityException({
          code: "invalid_batch",
          issues: header.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      const project = await this.resolveProject(publicKey);
      await this.assertOrigin(project.project_id, origin);
      if (
        !(await this.limiter.consume(
          project.project_id,
          ip,
          header.data.events.length,
        ))
      ) {
        throw new HttpException(
          { code: "ingestion_rate_limited" },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const valid: TelemetryEventV2[] = [];
      const rejections: Array<{ index: number; code: string }> = [];
      const now = Date.now();
      header.data.events.forEach((candidate, index) => {
        const parsed = telemetryEventV2Schema.safeParse(candidate);
        if (!parsed.success) {
          rejections.push({ index, code: "invalid_event" });
          return;
        }
        if (parsed.data.app.name !== project.app_name) {
          rejections.push({ index, code: "app_name_mismatch" });
          return;
        }
        if (
          parsed.data.occurredAt > now + 5 * 60_000 ||
          parsed.data.occurredAt < now - 30 * 24 * 60 * 60_000
        ) {
          rejections.push({ index, code: "event_time_out_of_range" });
          return;
        }
        valid.push(this.sanitizeEvent(parsed.data, project));
      });

      // Count repeated IDs inside the same request before touching the database.
      const seenEventIds = new Set<string>();
      const uniqueValid = valid.filter((event) => {
        if (seenEventIds.has(event.eventId)) return false;
        seenEventIds.add(event.eventId);
        return true;
      });
      const client = await this.database.pool.connect();
      let accepted = 0;
      let duplicate = valid.length - uniqueValid.length;
      try {
        await client.query("BEGIN");
        if (uniqueValid.length > 0) {
          // Timescale unique indexes must include the partitioning timestamp,
          // while protocol idempotency is defined by eventId alone. Serialize
          // all IDs in a deterministic order so overlapping batches cannot
          // deadlock and different occurredAt values still deduplicate.
          const eventIds = uniqueValid.map((event) => event.eventId).sort();
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || ids.event_id, 0))
             FROM unnest($2::text[]) AS ids(event_id) ORDER BY ids.event_id`,
            [`ingest:${project.project_id}`, eventIds],
          );
          const existing = await client.query<{ event_id: string }>(
            `SELECT event_id FROM telemetry_events
             WHERE project_id = $1 AND event_id = ANY($2::text[])
             GROUP BY event_id`,
            [project.project_id, eventIds],
          );
          const existingIds = new Set(existing.rows.map((row) => row.event_id));
          duplicate += existingIds.size;
          const pending = uniqueValid.filter(
            (event) => !existingIds.has(event.eventId),
          );

          const rows = pending.map((event) => ({
            event_id: event.eventId,
            occurred_at: new Date(event.occurredAt).toISOString(),
            type: event.type,
            name: event.name,
            environment: event.app.environment,
            app_version: event.app.version,
            session_id: event.context.sessionId,
            view_id: event.context.viewId,
            route_name: event.context.routeName,
            user_hash: event.context.user?.id ?? null,
            event,
          }));

          if (rows.length > 0) {
            const inserted = await client.query(
              `WITH input AS (
                 SELECT * FROM jsonb_to_recordset($2::jsonb) AS row(
                   event_id text, occurred_at timestamptz, type text, name text,
                   environment text, app_version text, session_id text, view_id text,
                   route_name text, user_hash text, event jsonb
                 )
               ), inserted_events AS (
                 INSERT INTO telemetry_events(
                   project_id, event_id, occurred_at, type, name, environment, app_version,
                   session_id, view_id, route_name, user_hash, event
                 )
                 SELECT $1, event_id, occurred_at, type, name, environment, app_version,
                   session_id, view_id, route_name, user_hash, event
                 FROM input ON CONFLICT DO NOTHING
                 RETURNING event_id, occurred_at, event
               )
               INSERT INTO outbox_tasks(project_id, event_id, occurred_at, event)
               SELECT $1, event_id, occurred_at, event FROM inserted_events
              RETURNING event_id`,
              [project.project_id, JSON.stringify(rows)],
            );
            const insertedCount = inserted.rowCount ?? 0;
            accepted += insertedCount;
            duplicate += rows.length - insertedCount;
          }
        }
        await client.query(
          "UPDATE ingestion_keys SET last_used_at = now() WHERE public_key = $1",
          [publicKey],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      this.metrics.ingestionEvents.inc({ result: "accepted" }, accepted);
      this.metrics.ingestionEvents.inc({ result: "duplicate" }, duplicate);
      this.metrics.ingestionEvents.inc(
        { result: "rejected" },
        rejections.length,
      );
      // Dashboard counters live in Redis because rejected events intentionally
      // never enter the telemetry tables. A statistics failure must not turn a
      // successfully committed ingestion request into a retryable SDK error.
      const statisticsKey = `ingestion:stats:${project.project_id}`;
      const recentRateKey = `ingestion:rate:${project.project_id}`;
      const recordedAt = Date.now();
      await this.redis
        .multi()
        .hincrby(statisticsKey, "accepted", accepted)
        .hincrby(statisticsKey, "duplicate", duplicate)
        .hincrby(statisticsKey, "rejected", rejections.length)
        .expire(statisticsKey, 180 * 24 * 60 * 60)
        // One sorted-set member represents one ingestion request. Keeping only
        // a short window provides the service page with a rolling receive rate
        // without scanning the raw Timescale hypertable by received_at.
        .zadd(recentRateKey, recordedAt, JSON.stringify([requestId, accepted]))
        .zremrangebyscore(recentRateKey, 0, recordedAt - 60_000)
        .expire(recentRateKey, 120)
        .exec()
        .catch(() => undefined);
      return {
        accepted,
        duplicate,
        rejected: rejections.length,
        requestId,
        rejections,
      };
    } finally {
      stopTimer();
    }
  }

  private async resolveProject(publicKey: string): Promise<IngestionProject> {
    const result = await this.database.pool.query<IngestionProject>(
      `SELECT p.id AS project_id, p.app_name, p.user_hash_salt
       FROM ingestion_keys k JOIN projects p ON p.id = k.project_id
       WHERE k.public_key = $1 AND k.active AND p.enabled
         AND (k.expires_at IS NULL OR k.expires_at > now())`,
      [publicKey],
    );
    const project = result.rows[0];
    if (!project)
      throw new NotFoundException({ code: "invalid_ingestion_key" });
    return project;
  }

  private async assertOrigin(
    projectId: string,
    origin: string | undefined,
  ): Promise<void> {
    if (!origin) {
      if (this.config.ALLOW_ORIGINLESS_INGEST) return;
      throw new ForbiddenException({ code: "origin_required" });
    }
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new ForbiddenException({ code: "origin_not_allowed" });
    }
    const result = await this.database.pool.query(
      "SELECT 1 FROM allowed_origins WHERE project_id = $1 AND origin = $2",
      [projectId, normalized],
    );
    if (result.rowCount !== 1)
      throw new ForbiddenException({ code: "origin_not_allowed" });
  }

  private sanitizeEvent(
    event: TelemetryEventV2,
    project: IngestionProject,
  ): TelemetryEventV2 {
    const user = event.context.user;
    const sanitizedUser = user
      ? {
          ...(user.id
            ? {
                id: hashUserId(
                  project.user_hash_salt,
                  user.id,
                  this.config.USER_HASH_SECRET,
                ),
              }
            : {}),
          ...(user.properties
            ? {
                properties: redactProperties(user.properties) as Record<
                  string,
                  JsonValue
                >,
              }
            : {}),
        }
      : undefined;
    const payload =
      event.payload.type === "event" && event.payload.properties
        ? {
            ...event.payload,
            properties: redactProperties(event.payload.properties) as Record<
              string,
              JsonValue
            >,
          }
        : event.payload;
    return {
      ...event,
      context: {
        ...event.context,
        url: sanitizeUrl(event.context.url),
        ...(sanitizedUser ? { user: sanitizedUser } : {}),
      },
      payload,
    } as TelemetryEventV2;
  }
}
