// 项目域服务：项目的增删查、成员与邀请、写入密钥(ingestion key)轮换、
// 允许来源(Origin)管理、阈值版本管理，以及贯穿全局的资源级鉴权 requireAccess/requireOwner。
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DatabaseHandle } from '@browser-monitor/database';
import {
  createOpaqueToken,
  DEFAULT_THRESHOLDS,
  hashToken,
  mergeThresholds,
  type ApiConfig,
  type MetricThreshold,
  type RatedMetricName,
} from '@browser-monitor/shared';

import { API_CONFIG, DATABASE } from '../infrastructure/tokens.js';
import { MailerService } from '../auth/mailer.service.js';

// 项目内角色：owner 可管理成员/密钥/来源/阈值，member 仅可查看
export type ProjectRole = 'owner' | 'member';

// 项目基本访问信息，由 requireAccess 统一查询并作为鉴权/详情的数据载体
interface ProjectAccess {
  id: string;
  display_name: string;
  app_name: string;
  role: ProjectRole;
  enabled: boolean;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly mailer: MailerService,
  ) {}

  // 列出当前用户所属的全部项目（按创建时间倒序），用于控制台首页
  async list(userId: string) {
    const result = await this.database.pool.query<ProjectAccess>(
      `SELECT p.id, p.display_name, p.app_name, p.enabled, pm.role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1
       ORDER BY p.created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      appName: row.app_name,
      enabled: row.enabled,
      role: row.role,
    }));
  }

  // 创建项目：一次性事务内建项目、把创建者设为 owner、生成首个写入密钥(ingestion key)、
  // 把 PUBLIC_BASE_URL 的来源作为默认允许来源、并写一条审计日志；返回含 DSN 的项目信息
  async create(userId: string, displayName: string, appName: string) {
    const publicKey = createOpaqueToken('bm_pk_');
    const userHashSalt = createOpaqueToken(); // 用户匿名化盐，下发后不可逆还原
    const defaultOrigin = new URL(this.config.PUBLIC_BASE_URL).origin;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects(display_name, app_name, user_hash_salt)
         VALUES ($1, $2, $3) RETURNING id`,
        [displayName.trim(), appName.trim(), userHashSalt],
      );
      const projectId = project.rows[0]!.id;
      await client.query(
        `INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [projectId, userId],
      );
      await client.query(
        `INSERT INTO ingestion_keys(project_id, public_key, label) VALUES ($1, $2, 'default')`,
        [projectId, publicKey],
      );
      await client.query(
        `INSERT INTO allowed_origins(project_id, origin) VALUES ($1, $2)`,
        [projectId, defaultOrigin],
      );
      await client.query(
        `INSERT INTO audit_logs(project_id, actor_user_id, action, detail)
         VALUES ($1, $2, 'project.created', jsonb_build_object('appName', $3::text))`,
        [projectId, userId, appName.trim()],
      );
      await client.query('COMMIT');
      return {
        id: projectId,
        displayName: displayName.trim(),
        appName: appName.trim(),
        role: 'owner' as const,
        dsn: this.toDsn(publicKey),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 项目详情：鉴权后并行汇总 写入密钥、允许来源、成员、当前生效阈值 四部分
  async detail(userId: string, projectId: string) {
    const access = await this.requireAccess(userId, projectId);
    const [keys, origins, members, thresholds] = await Promise.all([
      this.database.pool.query<{ id: string; public_key: string; label: string; active: boolean; expires_at: Date | null; created_at: Date }>(
        `SELECT id, public_key, label, active, expires_at, created_at
         FROM ingestion_keys WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      ),
      this.database.pool.query<{ origin: string }>('SELECT origin FROM allowed_origins WHERE project_id = $1 ORDER BY origin', [projectId]),
      this.database.pool.query<{ id: string; email: string; display_name: string; role: ProjectRole }>(
        `SELECT u.id, u.email, u.display_name, pm.role
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 ORDER BY pm.created_at`,
        [projectId],
      ),
      this.activeThreshold(projectId),
    ]);
    return {
      id: access.id,
      displayName: access.display_name,
      appName: access.app_name,
      enabled: access.enabled,
      role: access.role,
      keys: keys.rows.map((key) => ({
        id: key.id,
        label: key.label,
        active: key.active,
        expiresAt: key.expires_at,
        createdAt: key.created_at,
        dsn: this.toDsn(key.public_key),
      })),
      origins: origins.rows.map((row) => row.origin),
      members: members.rows.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name, role: row.role })),
      thresholds,
    };
  }

  // 整体替换允许来源：仅 owner 可操作；先去重归一化为 origin，至少保留一个；事务内先清后插并记审计
  async replaceOrigins(userId: string, projectId: string, origins: string[]): Promise<string[]> {
    await this.requireOwner(userId, projectId);
    const normalized = [...new Set(origins.map((value) => new URL(value).origin))];
    if (normalized.length === 0) throw new ConflictException({ code: 'at_least_one_origin_required' });
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM allowed_origins WHERE project_id = $1', [projectId]);
      for (const origin of normalized) {
        await client.query('INSERT INTO allowed_origins(project_id, origin) VALUES ($1, $2)', [projectId, origin]);
      }
      await client.query(
        `INSERT INTO audit_logs(project_id, actor_user_id, action, detail)
         VALUES ($1, $2, 'origins.replaced', jsonb_build_object('origins', $3::jsonb))`,
        [projectId, userId, JSON.stringify(normalized)],
      );
      await client.query('COMMIT');
      return normalized;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 轮换写入密钥：仅 owner 可操作；先把当前生效密钥设为 24 小时后过期（平滑过渡），
  // 再插入新密钥并记审计；返回新密钥的 DSN
  async rotateKey(userId: string, projectId: string, label: string) {
    await this.requireOwner(userId, projectId);
    const publicKey = createOpaqueToken('bm_pk_');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ingestion_keys SET expires_at = now() + INTERVAL '24 hours'
         WHERE project_id = $1 AND active AND expires_at IS NULL`,
        [projectId],
      );
      const key = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO ingestion_keys(project_id, public_key, label)
         VALUES ($1, $2, $3) RETURNING id, created_at`,
        [projectId, publicKey, label.trim()],
      );
      await client.query(
        `INSERT INTO audit_logs(project_id, actor_user_id, action, detail)
         VALUES ($1, $2, 'ingestion-key.rotated', jsonb_build_object('keyId', $3::text))`,
        [projectId, userId, key.rows[0]!.id],
      );
      await client.query('COMMIT');
      return { id: key.rows[0]!.id, label: label.trim(), createdAt: key.rows[0]!.created_at, dsn: this.toDsn(publicKey) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateThresholds(
    userId: string,
    projectId: string,
    overrides: Partial<Record<RatedMetricName, Partial<MetricThreshold>>>,
  ) {
    await this.requireOwner(userId, projectId);
    // 以 DEFAULT_THRESHOLDS 为基线，叠加本次覆盖项，得到完整阈值集合
    const config = mergeThresholds(overrides);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE threshold_versions SET active = false WHERE project_id = $1 AND active', [projectId]);
      const result = await client.query<{ id: string; version: number }>(
        `INSERT INTO threshold_versions(project_id, version, config, active, created_by)
         SELECT $1, COALESCE(max(version), 0) + 1, $2::jsonb, true, $3
         FROM threshold_versions WHERE project_id = $1
         RETURNING id, version`,
        [projectId, JSON.stringify(config), userId],
      );
      await client.query('COMMIT');
      return { id: result.rows[0]!.id, version: result.rows[0]!.version, config };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 发起邀请：仅 owner 可操作；写入 7 天有效邀请记录（同邮箱未接受则更新而非重复发），
  // 随后发送邀请邮件；令牌明文只在邮件中给出，库里只存哈希
  async invite(userId: string, projectId: string, emailInput: string, role: ProjectRole): Promise<void> {
    const project = await this.requireOwner(userId, projectId);
    const email = emailInput.trim().toLowerCase();
    const token = createOpaqueToken('bm_invite_');
    try {
      await this.database.pool.query(
        `INSERT INTO project_invitations(project_id, email, role, token_hash, expires_at, invited_by)
         VALUES ($1, $2, $3, $4, now() + INTERVAL '7 days', $5)
         ON CONFLICT (project_id, email) WHERE accepted_at IS NULL
         DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
           expires_at = EXCLUDED.expires_at, invited_by = EXCLUDED.invited_by,
           created_at = now()`,
        [projectId, email, role, hashToken(token), userId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException({ code: 'invitation_exists' });
      throw error;
    }
    await this.mailer.sendInvitation(email, token, project.display_name);
  }

  // 接受邀请：校验令牌有效且未被接受/过期，并确认登录邮箱与邀请邮箱一致，
  // 随后加入成员（已存在则更新角色）、标记邀请已接受，返回项目 id（FOR UPDATE 防止并发重复加入）
  async acceptInvitation(userId: string, userEmail: string, token: string): Promise<string> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const invitation = await client.query<{ id: string; project_id: string; email: string; role: ProjectRole }>(
        `SELECT id, project_id, email, role FROM project_invitations
         WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [hashToken(token)],
      );
      const row = invitation.rows[0];
      if (!row) throw new NotFoundException({ code: 'invalid_or_expired_invitation' });
      if (row.email !== userEmail.toLowerCase()) throw new ForbiddenException({ code: 'invitation_email_mismatch' });
      await client.query(
        `INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [row.project_id, userId, row.role],
      );
      await client.query('UPDATE project_invitations SET accepted_at = now() WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return row.project_id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 重试死信任务：仅 owner 可操作；从 dead_letter_tasks 取出并删除该任务，
  // 把对应 outbox_tasks 复位为 pending（清空锁与错误计数），交由后台 worker 重新投影
  async retryDeadLetter(userId: string, projectId: string, taskId: string): Promise<void> {
    await this.requireOwner(userId, projectId);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const dead = await client.query<{ event_id: string; event: unknown }>(
        `DELETE FROM dead_letter_tasks WHERE id = $1 AND project_id = $2
         RETURNING event_id, event`,
        [taskId, projectId],
      );
      if (!dead.rows[0]) throw new NotFoundException({ code: 'dead_letter_not_found' });
      await client.query(
        `UPDATE outbox_tasks SET status = 'pending', attempts = 0, available_at = now(),
           locked_at = NULL, locked_by = NULL, last_error = NULL
         WHERE id = $1 AND project_id = $2`,
        [taskId, projectId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 资源级鉴权核心：确认 userId 是 projectId 的成员；不是则 404（对外不暴露"项目存在但无权限"）。
  // 几乎所有受保护接口都会先调用它，返回的成员信息也直接用于详情组装
  async requireAccess(userId: string, projectId: string): Promise<ProjectAccess> {
    const result = await this.database.pool.query<ProjectAccess>(
      `SELECT p.id, p.display_name, p.app_name, p.enabled, pm.role
       FROM projects p JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = $1 AND pm.user_id = $2`,
      [projectId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'project_not_found' });
    return row;
  }

  // 在 requireAccess 之上进一步要求 owner 角色，否则 403
  async requireOwner(userId: string, projectId: string): Promise<ProjectAccess> {
    const access = await this.requireAccess(userId, projectId);
    if (access.role !== 'owner') throw new ForbiddenException({ code: 'owner_role_required' });
    return access;
  }

  // 取项目当前生效阈值：优先项目自建且 active 的版本；若不存在则回退到全局默认阈值（project_id IS NULL）
  private async activeThreshold(projectId: string) {
    const result = await this.database.pool.query<{ id: string; version: number; config: Record<string, unknown>; project_id: string | null }>(
      `SELECT id, version, config, project_id
       FROM threshold_versions
       WHERE (project_id = $1 AND active)
          OR (project_id IS NULL AND active AND NOT EXISTS (
            SELECT 1 FROM threshold_versions p WHERE p.project_id = $1 AND p.active
          ))
       ORDER BY project_id NULLS LAST LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ?? { id: null, version: 1, config: DEFAULT_THRESHOLDS, project_id: null };
  }

  // 由写入密钥拼出 SDK 上报入口的完整 DSN（前端/SDK 用它作为采集上报地址）
  private toDsn(publicKey: string): string {
    return new URL(`/api/v3/ingest/${publicKey}/envelopes`, this.config.PUBLIC_BASE_URL).toString();
  }
}
