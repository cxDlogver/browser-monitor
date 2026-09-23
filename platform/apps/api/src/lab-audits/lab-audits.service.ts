import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DatabaseHandle } from '@browser-monitor/database';
import { decryptValue, encryptValue, type ApiConfig } from '@browser-monitor/shared';

import { API_CONFIG, DATABASE } from '../infrastructure/tokens.js';
import { ProjectsService } from '../projects/projects.service.js';

type AuditDevice = 'mobile' | 'desktop';
interface StoredHeader { name: string; value: string }

const forbiddenHeaders = new Set([
  'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
]);
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

@Injectable()
export class LabAuditsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly projects: ProjectsService,
  ) {}

  async settings(userId: string, projectId: string) {
    const access = await this.projects.requireAccess(userId, projectId);
    const headers = await this.readHeaders(projectId);
    return {
      canManage: access.role === 'owner',
      headers: headers.map(({ name }) => ({ name, maskedValue: '••••••••' })),
    };
  }

  async updateSettings(userId: string, projectId: string, input: StoredHeader[]) {
    await this.projects.requireOwner(userId, projectId);
    const headers = this.validateHeaders(input);
    const encrypted = headers.length > 0
      ? encryptValue(JSON.stringify(headers), this.config.AUDIT_HEADER_ENCRYPTION_KEY)
      : null;
    await this.database.pool.query(
      `INSERT INTO lab_audit_settings(project_id, headers_ciphertext, headers_iv, headers_auth_tag, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id) DO UPDATE SET
         headers_ciphertext = EXCLUDED.headers_ciphertext,
         headers_iv = EXCLUDED.headers_iv,
         headers_auth_tag = EXCLUDED.headers_auth_tag,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [projectId, encrypted?.ciphertext ?? null, encrypted?.iv ?? null, encrypted?.authTag ?? null, userId],
    );
    await this.database.pool.query(
      `INSERT INTO audit_logs(project_id, actor_user_id, action, detail)
       VALUES ($1,$2,'lab.settings.updated',jsonb_build_object('headerNames',$3::jsonb))`,
      [projectId, userId, JSON.stringify(headers.map(({ name }) => name))],
    );
    return { canManage: true, headers: headers.map(({ name }) => ({ name, maskedValue: '••••••••' })) };
  }

  async create(userId: string, projectId: string, rawUrl: string, device: AuditDevice) {
    const access = await this.projects.requireOwner(userId, projectId);
    if (!access.enabled) throw new ConflictException({ code: 'project_disabled', message: '项目已停用。' });
    const targetUrl = this.normalizeUrl(rawUrl);
    const origins = await this.database.pool.query<{ origin: string }>(
      'SELECT origin FROM allowed_origins WHERE project_id = $1',
      [projectId],
    );
    if (!origins.rows.some((row) => row.origin === targetUrl.origin)) {
      throw new BadRequestException({ code: 'audit_origin_not_allowed', message: 'URL 必须属于项目的允许来源。' });
    }
    try {
      const result = await this.database.pool.query(
        `INSERT INTO lab_audits(project_id, created_by, target_url, device, requested_runs)
         VALUES ($1,$2,$3,$4,5)
         RETURNING id, project_id, target_url, device, status, requested_runs, completed_runs,
                   successful_runs, created_at`,
        [projectId, userId, targetUrl.toString(), device],
      );
      await this.database.pool.query(
        `INSERT INTO audit_logs(project_id, actor_user_id, action, detail)
         VALUES ($1,$2,'lab.audit.created',jsonb_build_object('url',$3::text,'device',$4::text))`,
        [projectId, userId, targetUrl.toString(), device],
      );
      return this.mapAudit(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({ code: 'audit_already_running', message: '当前项目已有实验室测试正在运行。' });
      }
      throw error;
    }
  }

  async list(userId: string, projectId: string) {
    await this.projects.requireAccess(userId, projectId);
    const result = await this.database.pool.query(
      `SELECT id, project_id, target_url, device, status, requested_runs, completed_runs,
              successful_runs, lighthouse_version, summary, warning, last_error,
              created_at, started_at, completed_at
       FROM lab_audits WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [projectId],
    );
    return result.rows.map((row) => this.mapAudit(row));
  }

  async detail(userId: string, projectId: string, auditId: string) {
    await this.projects.requireAccess(userId, projectId);
    const [audit, runs] = await Promise.all([
      this.database.pool.query(
        `SELECT id, project_id, target_url, device, status, requested_runs, completed_runs,
                successful_runs, lighthouse_version, chrome_version, environment, summary,
                analysis, warning, last_error, created_at, started_at, completed_at
         FROM lab_audits WHERE id = $1 AND project_id = $2`,
        [auditId, projectId],
      ),
      this.database.pool.query(
        `SELECT id, run_number, status, scores, metrics, diagnostics, error, duration_ms, created_at
         FROM lab_audit_runs WHERE audit_id = $1 ORDER BY run_number`,
        [auditId],
      ),
    ]);
    const row = audit.rows[0];
    if (!row) throw new NotFoundException({ code: 'lab_audit_not_found' });
    return {
      ...this.mapAudit(row),
      runs: runs.rows.map((run) => ({
        id: run.id,
        runNumber: run.run_number,
        status: run.status,
        scores: run.scores,
        metrics: run.metrics,
        diagnostics: run.diagnostics,
        error: run.error,
        durationMs: run.duration_ms,
        createdAt: run.created_at,
      })),
    };
  }

  private async readHeaders(projectId: string): Promise<StoredHeader[]> {
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
    if (!row?.headers_ciphertext || !row.headers_iv || !row.headers_auth_tag) return [];
    return JSON.parse(decryptValue({
      ciphertext: row.headers_ciphertext,
      iv: row.headers_iv,
      authTag: row.headers_auth_tag,
    }, this.config.AUDIT_HEADER_ENCRYPTION_KEY)) as StoredHeader[];
  }

  private validateHeaders(input: StoredHeader[]): StoredHeader[] {
    const seen = new Set<string>();
    return input.map((header) => {
      const name = header.name.trim().toLowerCase();
      if (!headerNamePattern.test(name) || forbiddenHeaders.has(name)) {
        throw new BadRequestException({ code: 'audit_header_not_allowed', message: `不允许使用请求头 ${header.name}。` });
      }
      if (seen.has(name)) throw new BadRequestException({ code: 'duplicate_audit_header', message: `请求头 ${name} 重复。` });
      if (/\r|\n/.test(header.value)) throw new BadRequestException({ code: 'invalid_audit_header', message: '请求头值不能包含换行。' });
      seen.add(name);
      return { name, value: header.value };
    });
  }

  private normalizeUrl(raw: string): URL {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new BadRequestException({ code: 'invalid_audit_url', message: '仅支持不包含账号密码的 HTTP/HTTPS URL。' });
    }
    url.hash = '';
    return url;
  }

  private mapAudit(row: Record<string, unknown>) {
    return {
      id: row.id,
      projectId: row.project_id,
      targetUrl: row.target_url,
      device: row.device,
      status: row.status,
      requestedRuns: row.requested_runs,
      completedRuns: row.completed_runs,
      successfulRuns: row.successful_runs,
      lighthouseVersion: row.lighthouse_version ?? null,
      chromeVersion: row.chrome_version ?? null,
      environment: row.environment ?? {},
      summary: row.summary ?? null,
      analysis: row.analysis ?? null,
      warning: row.warning ?? null,
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
