import type { DatabaseHandle } from '@browser-monitor/database';
import { decryptValue, type AuditWorkerConfig } from '@browser-monitor/shared';
import { randomUUID } from 'node:crypto';

import { aggregateRuns, buildAnalysis } from './analyzer.js';
import { runLighthouseAudit } from './lighthouse-runner.js';
import { assertSafeTarget } from './target-safety.js';
import type { AuditDevice, AuditRunRecord } from './types.js';

interface AuditTask {
  id: string;
  project_id: string;
  target_url: string;
  device: AuditDevice;
  requested_runs: number;
}

interface StoredHeader { name: string; value: string }

export class LabAuditWorker {
  private readonly workerId = `audit-worker-${randomUUID()}`;
  private running = false;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly config: AuditWorkerConfig,
  ) {}

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      const task = await this.claim();
      if (!task) {
        await this.delay(this.config.AUDIT_POLL_INTERVAL_MS);
        continue;
      }
      await this.handle(task);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async claim(): Promise<AuditTask | null> {
    await this.database.pool.query(
      `UPDATE lab_audits SET status = 'failed', completed_at = now(), locked_at = NULL,
         locked_by = NULL, last_error = 'Audit worker stopped repeatedly before completing the task.'
       WHERE status = 'running' AND attempts >= 3 AND locked_at < now() - INTERVAL '45 minutes'`,
    );
    const result = await this.database.pool.query<AuditTask>(
      `WITH candidate AS (
         SELECT id FROM lab_audits
         WHERE attempts < 3 AND (
           status = 'queued' OR (status = 'running' AND locked_at < now() - INTERVAL '45 minutes')
         )
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE lab_audits a SET
         status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1,
         started_at = COALESCE(started_at, now()), last_error = NULL
       FROM candidate c WHERE a.id = c.id
       RETURNING a.id, a.project_id, a.target_url, a.device, a.requested_runs`,
      [this.workerId],
    );
    return result.rows[0] ?? null;
  }

  private async handle(task: AuditTask): Promise<void> {
    try {
      await assertSafeTarget(task.target_url, this.config.AUDIT_ALLOW_PRIVATE_TARGETS);
      const headers = await this.headers(task.project_id);
      await this.database.pool.query('DELETE FROM lab_audit_runs WHERE audit_id = $1', [task.id]);
      await this.database.pool.query(
        `UPDATE lab_audits SET completed_runs = 0, successful_runs = 0, summary = NULL,
         analysis = NULL, warning = NULL WHERE id = $1 AND locked_by = $2`,
        [task.id, this.workerId],
      );

      let lighthouseVersion: string | null = null;
      let chromeVersion: string | null = null;
      let environment: Record<string, unknown> = {};
      for (let runNumber = 1; runNumber <= task.requested_runs; runNumber += 1) {
        const startedAt = Date.now();
        try {
          const result = await runLighthouseAudit(task.target_url, task.device, headers, this.config.AUDIT_CHROME_PATH);
          lighthouseVersion = result.lighthouseVersion;
          chromeVersion = result.chromeVersion;
          environment = result.environment;
          await this.database.pool.query(
            `INSERT INTO lab_audit_runs(audit_id, run_number, status, scores, metrics, diagnostics, duration_ms)
             VALUES ($1,$2,'completed',$3::jsonb,$4::jsonb,$5::jsonb,$6)`,
            [task.id, runNumber, JSON.stringify(result.scores), JSON.stringify(result.metrics), JSON.stringify(result.diagnostics), Date.now() - startedAt],
          );
        } catch (error) {
          await this.database.pool.query(
            `INSERT INTO lab_audit_runs(audit_id, run_number, status, error, duration_ms)
             VALUES ($1,$2,'failed',$3,$4)`,
            [task.id, runNumber, this.errorMessage(error), Date.now() - startedAt],
          );
        }
        await this.database.pool.query(
          `UPDATE lab_audits SET
             completed_runs = $2,
             successful_runs = (SELECT count(*)::integer FROM lab_audit_runs WHERE audit_id = $1 AND status = 'completed'),
             locked_at = now()
           WHERE id = $1 AND locked_by = $3`,
          [task.id, runNumber, this.workerId],
        );
      }

      const completed = await this.database.pool.query<{
        run_number: number;
        scores: AuditRunRecord['scores'];
        metrics: AuditRunRecord['metrics'];
        diagnostics: AuditRunRecord['diagnostics'];
      }>(
        `SELECT run_number, scores, metrics, diagnostics FROM lab_audit_runs
         WHERE audit_id = $1 AND status = 'completed' ORDER BY run_number`,
        [task.id],
      );
      if (completed.rows.length < 3) throw new Error(`Only ${completed.rows.length} of ${task.requested_runs} Lighthouse runs succeeded.`);

      const runs: AuditRunRecord[] = completed.rows.map((row) => ({
        runNumber: row.run_number,
        scores: row.scores,
        metrics: row.metrics,
        diagnostics: row.diagnostics,
        lighthouseVersion: lighthouseVersion ?? 'unknown',
        chromeVersion: chromeVersion ?? 'unknown',
        environment,
      }));
      const summary = aggregateRuns(runs);
      const representative = runs.find((run) => run.runNumber === summary.representativeRun) ?? runs[0]!;
      const analysis = buildAnalysis(summary, representative.diagnostics);
      const warning = runs.length < task.requested_runs
        ? `${task.requested_runs - runs.length} 次运行失败，报告基于 ${runs.length} 次成功结果。`
        : null;
      await this.database.pool.query(
        `UPDATE lab_audits SET status = 'completed', successful_runs = $2,
           lighthouse_version = $3, chrome_version = $4, environment = $5::jsonb,
           summary = $6::jsonb, analysis = $7::jsonb, warning = $8,
           completed_at = now(), locked_at = NULL, locked_by = NULL
         WHERE id = $1 AND locked_by = $9`,
        [task.id, runs.length, lighthouseVersion, chromeVersion, JSON.stringify(environment), JSON.stringify(summary), JSON.stringify(analysis), warning, this.workerId],
      );
    } catch (error) {
      await this.database.pool.query(
        `UPDATE lab_audits SET status = 'failed', last_error = $2, completed_at = now(),
           locked_at = NULL, locked_by = NULL WHERE id = $1 AND locked_by = $3`,
        [task.id, this.errorMessage(error).slice(0, 8_000), this.workerId],
      );
    }
  }

  private async headers(projectId: string): Promise<Record<string, string>> {
    const result = await this.database.pool.query<{
      headers_ciphertext: Buffer | null;
      headers_iv: Buffer | null;
      headers_auth_tag: Buffer | null;
    }>(
      `SELECT headers_ciphertext, headers_iv, headers_auth_tag
       FROM lab_audit_settings WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row?.headers_ciphertext || !row.headers_iv || !row.headers_auth_tag) return {};
    const decoded = JSON.parse(decryptValue({
      ciphertext: row.headers_ciphertext,
      iv: row.headers_iv,
      authTag: row.headers_auth_tag,
    }, this.config.AUDIT_HEADER_ENCRYPTION_KEY)) as StoredHeader[];
    return Object.fromEntries(decoded.map(({ name, value }) => [name, value]));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
