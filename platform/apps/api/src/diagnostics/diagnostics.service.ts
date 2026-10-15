import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { DatabaseHandle, PoolClient } from '@browser-monitor/database';
import { COMPLETED_TASK_RETENTION_DAYS, OUTBOX_LOCK_TIMEOUT_SECONDS } from '@browser-monitor/shared';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { DATABASE, REDIS } from '../infrastructure/tokens.js';
import { ProjectsService } from '../projects/projects.service.js';

export interface EventFilters {
  from: string;
  to: string;
  limit: number;
  cursor?: string;
  type?: string;
  name?: string;
  environment?: string;
  version?: string;
  routeName?: string;
  sessionId?: string;
  viewId?: string;
  eventId?: string;
  includePayload?: boolean;
}
type Row = Record<string, any>;

export function safeDiagnosticError(value: unknown): string | null {
  if (value == null) return null;
  return String(value).slice(0, 8000)
    .replace(/\b(?:postgres(?:ql)?|redis):\/\/\S+/gi, '[redacted connection]')
    .replace(/\b(password|cookie|csrf(?:token)?|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function date(value: unknown): string | null {
  if (value == null) return null;
  const time = new Date(value as string | number | Date);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function count(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid database count.');
  return number;
}

@Injectable()
export class DiagnosticsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly projects: ProjectsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private async snapshot<T>(userId: string, projectId: string, read: (client: PoolClient, asOf: string) => Promise<T>): Promise<T> {
    await this.projects.requireAccess(userId, projectId);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const time = await client.query('SELECT transaction_timestamp() AS as_of');
      const asOf = date(time.rows[0]?.as_of);
      if (!asOf) throw new Error('Missing database snapshot time.');
      const result = await read(client, asOf);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async retention(client: PoolClient) {
    const relation = await client.query("SELECT to_regclass('timescaledb_information.jobs') AS relation");
    let raw: Record<string, unknown> = { state: 'unknown', reason: 'Retention policy metadata unavailable.' };
    if (relation.rows[0]?.relation) {
      const jobs = await client.query(
        "SELECT config, scheduled FROM timescaledb_information.jobs WHERE hypertable_name = 'telemetry_events' AND proc_name = 'policy_retention'",
      );
      if (jobs.rows.length === 1 && jobs.rows[0].config?.drop_after) {
        raw = { state: 'configured', dropAfter: jobs.rows[0].config.drop_after, scheduled: jobs.rows[0].scheduled, source: 'timescaledb_information.jobs' };
      } else raw = { state: 'unknown', reason: 'No unique retention job; absence does not prove an unlimited policy.' };
    }
    return { raw, completedTasks: { days: COMPLETED_TASK_RETENTION_DAYS, source: 'worker_housekeeping_policy' } };
  }

  async data(userId: string, projectId: string) {
    return this.snapshot(userId, projectId, async (client, asOf) => {
      const result = await client.query(
        'SELECT count(*)::text AS count, max(received_at) AS latest FROM telemetry_events WHERE project_id = $1',
        [projectId],
      );
      return {
        projectId, retainedRawEventCount: count(result.rows[0]?.count),
        latestReceivedAt: date(result.rows[0]?.latest),
        retentionPolicy: await this.retention(client), asOf, source: 'database',
      };
    });
  }

  async events(userId: string, projectId: string, filters: EventFilters) {
    return this.snapshot(userId, projectId, async (client, asOf) => {
      const values: unknown[] = [projectId, new Date(filters.from), new Date(filters.to)];
      const conditions = ['project_id = $1', 'occurred_at >= $2', 'occurred_at < $3'];
      const columns: Record<string, string> = {
        type: 'type', name: 'name', environment: 'environment', version: 'app_version',
        routeName: 'route_name', sessionId: 'session_id', viewId: 'view_id', eventId: 'event_id',
      };
      const scope: Record<string, unknown> = { projectId, from: filters.from, to: filters.to };
      for (const [key, column] of Object.entries(columns)) {
        const value = filters[key as keyof EventFilters];
        if (value !== undefined) {
          scope[key] = value; values.push(value);
          conditions.push(column + ' = $' + values.length);
        }
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
      if (filters.cursor) {
        try {
          if (filters.cursor.length > 8192) throw new Error();
          const cursor = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8'));
          if (cursor.version !== 1 || cursor.fingerprint !== fingerprint ||
              typeof cursor.eventId !== 'string' || !cursor.eventId || cursor.eventId.length > 256 ||
              typeof cursor.occurredAt !== 'string' || date(cursor.occurredAt) !== cursor.occurredAt) throw new Error();
          values.push(new Date(cursor.occurredAt), cursor.eventId);
          conditions.push('(occurred_at, event_id) < ($' + (values.length - 1) + ', $' + values.length + ')');
        } catch {
          throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Cursor is invalid or belongs to different query conditions.' });
        }
      }
      values.push(filters.limit + 1);
      const result = await client.query(
        'SELECT event_id, occurred_at, received_at, type, name, environment, app_version, session_id, view_id, route_name, event ' +
        'FROM telemetry_events WHERE ' + conditions.join(' AND ') +
        ' ORDER BY occurred_at DESC, event_id DESC LIMIT $' + values.length, values,
      );
      const rows = result.rows.slice(0, filters.limit);
      const last = rows.at(-1);
      const hasMore = result.rows.length > filters.limit;
      return {
        items: rows.map((row: Row) => ({
          eventId: row.event_id, occurredAt: date(row.occurred_at), receivedAt: date(row.received_at),
          type: row.type, name: row.name, environment: row.environment, version: row.app_version,
          sessionId: row.session_id, viewId: row.view_id, routeName: row.route_name,
          correlation: row.event?.correlation ?? null,
          ...(filters.includePayload ? { event: row.event } : {}),
        })),
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({
          version: 1, fingerprint, occurredAt: date(last.occurred_at), eventId: last.event_id,
        })).toString('base64url') : null,
        hasMore, range: { from: filters.from, to: filters.to }, asOf, source: 'database',
        limitations: ['Keyset pagination is not a snapshot across separate page requests.'],
      };
    });
  }

  async event(userId: string, projectId: string, eventId: string, occurredAt?: string, includePayload = false) {
    return this.snapshot(userId, projectId, async (client, asOf) => {
      const candidates = await client.query(
        'SELECT occurred_at FROM telemetry_events WHERE project_id = $1 AND event_id = $2 ' +
        'UNION SELECT occurred_at FROM outbox_tasks WHERE project_id = $1 AND event_id = $2 ORDER BY occurred_at DESC LIMIT 101',
        [projectId, eventId],
      );
      const times = candidates.rows.map((row: Row) => date(row.occurred_at)).filter(Boolean);
      if (!occurredAt && times.length > 1) {
        throw new BadRequestException({ code: 'AMBIGUOUS_EVENT', message: 'Specify occurredAt to disambiguate.',
          candidates: times.slice(0, 20), candidatesTruncated: times.length > 20 });
      }
      const selectedTime = occurredAt ?? times[0] ?? null;
      const values = selectedTime ? [projectId, eventId, new Date(selectedTime)] : [projectId, eventId];
      const timeSql = selectedTime ? ' AND occurred_at = $3' : '';
      const raw = (await client.query(
        'SELECT event, occurred_at, received_at, processed_at, type, name FROM telemetry_events ' +
        'WHERE project_id = $1 AND event_id = $2' + timeSql + ' ORDER BY occurred_at DESC LIMIT 1', values,
      )).rows[0] as Row | undefined;
      const task = (await client.query(
        'SELECT * FROM outbox_tasks WHERE project_id = $1 AND event_id = $2' + timeSql +
        ' ORDER BY occurred_at DESC LIMIT 1', values,
      )).rows[0] as Row | undefined;
      const envelope = raw?.event ?? task?.event;
      const projection = await this.projection(client, projectId, envelope);
      const limitations: string[] = [];
      if (!raw) limitations.push('Raw record missing: never received, retention cleanup and deletion cannot be distinguished.');
      if (!task) limitations.push('Task record missing: historical completion cannot be inferred; completed tasks are retained by worker policy.');
      return {
        projectId,
        event: {
          eventId, occurredAt: date(raw?.occurred_at ?? task?.occurred_at ?? selectedTime),
          receivedAt: date(raw?.received_at), type: raw?.type ?? envelope?.payload?.type ?? null,
          name: raw?.name ?? envelope?.name ?? null,
          ...(includePayload && envelope ? { payload: envelope } : {}),
        },
        raw: { recordState: raw ? 'present' : 'missing' },
        processing: { state: raw ? (raw.processed_at ? 'committed' : 'notObserved') : 'unknown',
          processedAt: date(raw?.processed_at), evidence: raw?.processed_at ? 'telemetry_events.processed_at' : null },
        task: task ? {
          recordState: 'present', taskId: task.id, status: task.status, attempts: task.attempts,
          availableAt: date(task.available_at), lockedAt: date(task.locked_at),
          completedAt: date(task.completed_at), lastFailedAt: date(task.last_failed_at),
          lastError: safeDiagnosticError(task.last_error),
        } : { recordState: 'missing', status: null },
        projection, history: { limitations, completedTaskRetentionDays: COMPLETED_TASK_RETENTION_DAYS },
        asOf, source: 'database',
      };
    });
  }

  private async projection(client: PoolClient, projectId: string, event: any) {
    if (!event?.payload || !event?.context) return { visibility: 'unknown', eventEffect: 'unknown', identity: null };
    let rows: Row[];
    let identity: Record<string, unknown>;
    if (event.payload.type === 'performance' && typeof event.payload.sampleId === 'string') {
      identity = { kind: 'performance', sampleId: event.payload.sampleId };
      rows = (await client.query(
        'SELECT sample_id, sequence, state FROM performance_samples WHERE project_id = $1 AND sample_id = $2 ORDER BY observed_at DESC LIMIT 1',
        [projectId, event.payload.sampleId],
      )).rows;
    } else if (event.payload.type === 'view' && typeof event.payload.viewId === 'string') {
      identity = { kind: 'view', viewId: event.payload.viewId };
      rows = (await client.query(
        'SELECT view_id, started_at, ended_at FROM view_records WHERE project_id = $1 AND view_id = $2 ORDER BY started_at DESC LIMIT 1',
        [projectId, event.payload.viewId],
      )).rows;
    } else if (['event', 'trace', 'span'].includes(event.payload.type) && typeof event.eventId === 'string' && Number.isFinite(event.occurredAt)) {
      identity = { kind: 'custom_signal', eventId: event.eventId, occurredAt: date(event.occurredAt) };
      rows = (await client.query(
        'SELECT event_id, kind, trace_id, span_id FROM custom_signal_samples WHERE project_id = $1 AND event_id = $2 AND occurred_at = $3',
        [projectId, event.eventId, new Date(event.occurredAt)],
      )).rows;
    } else return { visibility: 'unknown', eventEffect: 'unknown', identity: null };
    return { visibility: rows.length ? 'visible' : 'missing', eventEffect: 'unknown', identity,
      currentEntity: rows[0] ?? null, limitation: 'Current entity visibility does not prove this event changed it; a committed no-op is valid.' };
  }

  async queue(userId: string, projectId: string) {
    const core = await this.snapshot(userId, projectId, async (client, asOf) => {
      const rows = await client.query(
        "SELECT count(*) FILTER (WHERE status='pending')::text AS pending_total, " +
        "count(*) FILTER (WHERE status='pending' AND isfinite(available_at) AND available_at <= $2)::text AS ready_pending, " +
        "count(*) FILTER (WHERE status='pending' AND isfinite(available_at) AND available_at > $2)::text AS delayed_pending, " +
        "count(*) FILTER (WHERE status='pending' AND (available_at IS NULL OR NOT isfinite(available_at)))::text AS pending_unclassified, " +
        "count(*) FILTER (WHERE status='processing')::text AS processing_total, " +
        "count(*) FILTER (WHERE status='processing' AND isfinite(locked_at) AND locked_at >= $2::timestamptz - ($3 * INTERVAL '1 second'))::text AS processing_active, " +
        "count(*) FILTER (WHERE status='processing' AND isfinite(locked_at) AND locked_at < $2::timestamptz - ($3 * INTERVAL '1 second'))::text AS processing_stale, " +
        "count(*) FILTER (WHERE status='processing' AND (locked_at IS NULL OR NOT isfinite(locked_at)))::text AS processing_unclassified, " +
        "count(*) FILTER (WHERE status='failed')::text AS failed, " +
        "count(*) FILTER (WHERE status='completed' AND completed_at > $2::timestamptz - INTERVAL '1 minute' AND completed_at <= $2)::text AS processed_last_minute " +
        'FROM outbox_tasks WHERE project_id=$1', [projectId, new Date(asOf), OUTBOX_LOCK_TIMEOUT_SECONDS],
      );
      const row = rows.rows[0]!;
      const dead = await client.query(
        "SELECT count(*)::text AS total, count(*) FILTER (WHERE o.status='failed')::text AS overlapping_failed " +
        'FROM dead_letter_tasks d LEFT JOIN outbox_tasks o ON o.id=d.id AND o.project_id=d.project_id WHERE d.project_id=$1', [projectId],
      );
      const failures = await client.query(
        'SELECT id, event_id, occurred_at, status, attempts, available_at, last_error, last_failed_at, created_at FROM outbox_tasks ' +
        'WHERE project_id=$1 AND last_error IS NOT NULL ORDER BY last_failed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 21', [projectId],
      );
      const other = await client.query(
        "SELECT status, count(*)::text AS count FROM lab_audits WHERE project_id=$1 GROUP BY status", [projectId],
      );
      return {
        projectId, pendingTotal: count(row.pending_total), readyPending: count(row.ready_pending),
        delayedPending: count(row.delayed_pending), pendingUnclassified: count(row.pending_unclassified),
        processingTotal: count(row.processing_total), processingActive: count(row.processing_active),
        processingStale: count(row.processing_stale), processingUnclassified: count(row.processing_unclassified),
        failed: count(row.failed), processedLastMinute: count(row.processed_last_minute),
        deadLetters: count(dead.rows[0]?.total), deadLettersOverlappingFailed: count(dead.rows[0]?.overlapping_failed),
        recentFailures: failures.rows.slice(0, 20).map((r: Row) => ({
          taskId: r.id, eventId: r.event_id, occurredAt: date(r.occurred_at), status: r.status,
          attempts: r.attempts, availableAt: date(r.available_at), failedAt: date(r.last_failed_at),
          createdAt: date(r.created_at), error: safeDiagnosticError(r.last_error),
        })),
        recentFailuresLimit: 20, recentFailuresHasMore: failures.rows.length > 20,
        lockTimeoutSeconds: OUTBOX_LOCK_TIMEOUT_SECONDS, lockTimeoutSource: 'shared_worker_policy',
        otherQueues: { labAudits: { source: 'database', asOf, counts: Object.fromEntries(other.rows.map((r: Row) => [r.status, count(r.count)])) } },
        asOf, source: 'database', scope: { projectId, taskType: 'telemetry', environment: null },
        limitations: [
          'Active lock is not a worker heartbeat.',
          'Failed tasks and dead letters may overlap and must not be added.',
          'Historical failure timestamps are unknown; those rows sort after dated failures by task creation time.',
        ],
      };
    });
    let ingestion: Record<string, unknown>;
    try {
      const requestedAt = new Date().toISOString();
      const stats = await this.redis.hgetall('ingestion:stats:' + projectId);
      ingestion = { source: 'redis', scope: { projectId }, requestedAt, asOf: null,
        accepted: stats.accepted === undefined ? null : count(stats.accepted),
        duplicate: stats.duplicate === undefined ? null : count(stats.duplicate),
        rejected: stats.rejected === undefined ? null : count(stats.rejected),
        limitation: 'Counters can expire; missing values are unknown. They are not retained raw row counts or part of the database snapshot.' };
    } catch {
      ingestion = { source: 'redis', asOf: null, state: 'unknown', limitation: 'Ingestion counters could not be read.' };
    }
    return { ...core, ingestion };
  }
}
