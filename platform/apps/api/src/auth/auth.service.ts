import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { DatabaseHandle } from '@browser-monitor/database';
import {
  createOpaqueToken,
  hashPassword,
  hashToken,
  verifyPassword,
  type ApiConfig,
} from '@browser-monitor/shared';
import type { Redis } from 'ioredis';

import { API_CONFIG, DATABASE, REDIS } from '../infrastructure/tokens.js';
import { MailerService } from './mailer.service.js';
import type { AuthenticatedUser } from './session.guard.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  email_verified_at: Date | null;
}

export interface CreatedSession {
  token: string;
  user: AuthenticatedUser;
  expiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly mailer: MailerService,
  ) {}

  async register(emailInput: string, password: string, displayName: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const client = await this.database.pool.connect();
    let token = '';
    try {
      await client.query('BEGIN');
      const created = await client.query<{ id: string }>(
        `INSERT INTO users(email, password_hash, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             display_name = EXCLUDED.display_name,
             updated_at = now()
         WHERE users.email_verified_at IS NULL
         RETURNING id`,
        [email, passwordHash, displayName.trim()],
      );
      const userId = created.rows[0]?.id;
      if (!userId) {
        throw new ConflictException({ code: 'email_already_registered' });
      }

      // Re-registering an unverified account rotates the verification credential instead of
      // leaving several valid links for the same email address.
      await client.query(
        `UPDATE account_tokens
         SET consumed_at = COALESCE(consumed_at, now())
         WHERE user_id = $1 AND purpose = 'verify-email' AND consumed_at IS NULL`,
        [userId],
      );
      token = createOpaqueToken('bm_verify_');
      await client.query(
        `INSERT INTO account_tokens(user_id, purpose, token_hash, expires_at)
         VALUES ($1, 'verify-email', $2, now() + INTERVAL '24 hours')`,
        [userId, hashToken(token)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.mailer.sendVerification(email, token);
  }

  async verifyEmail(token: string): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ user_id: string }>(
        `UPDATE account_tokens
         SET consumed_at = now()
         WHERE token_hash = $1
           AND purpose = 'verify-email'
           AND consumed_at IS NULL
           AND expires_at > now()
         RETURNING user_id`,
        [hashToken(token)],
      );
      const userId = result.rows[0]?.user_id;
      if (!userId) throw new BadRequestException({ code: 'invalid_or_expired_token' });
      await client.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
         WHERE id = $1`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async login(emailInput: string, password: string): Promise<CreatedSession> {
    const result = await this.database.pool.query<UserRow>(
      `SELECT id, email, password_hash, display_name, email_verified_at
       FROM users WHERE email = $1`,
      [emailInput.trim().toLowerCase()],
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new UnauthorizedException({ code: 'invalid_credentials' });
    }
    if (!row.email_verified_at) throw new UnauthorizedException({ code: 'email_not_verified' });

    const token = createOpaqueToken('bm_session_');
    const tokenHash = hashToken(token);
    const csrfToken = createOpaqueToken('bm_csrf_');
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_SECONDS * 1_000);
    const inserted = await this.database.pool.query<{ id: string }>(
      `INSERT INTO user_sessions(user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [row.id, tokenHash, csrfToken, expiresAt],
    );
    const user: AuthenticatedUser = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      sessionId: inserted.rows[0]!.id,
      csrfToken,
    };
    await this.redis.set(`session:${tokenHash}`, JSON.stringify(user), 'EX', this.config.SESSION_TTL_SECONDS);
    return { token, user, expiresAt };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    await Promise.all([
      this.redis.del(`session:${tokenHash}`),
      this.database.pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]),
    ]);
  }

  async forgotPassword(emailInput: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const result = await this.database.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return;
    const token = createOpaqueToken('bm_reset_');
    await this.database.pool.query(
      `INSERT INTO account_tokens(user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'reset-password', $2, now() + INTERVAL '1 hour')`,
      [user.id, hashToken(token)],
    );
    await this.mailer.sendPasswordReset(email, token);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const client = await this.database.pool.connect();
    let sessionHashes: string[] = [];
    try {
      await client.query('BEGIN');
      const tokenResult = await client.query<{ user_id: string }>(
        `UPDATE account_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND purpose = 'reset-password'
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [hashToken(token)],
      );
      const userId = tokenResult.rows[0]?.user_id;
      if (!userId) throw new BadRequestException({ code: 'invalid_or_expired_token' });
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, userId]);
      await client.query(
        `UPDATE account_tokens SET consumed_at = COALESCE(consumed_at, now())
         WHERE user_id = $1 AND purpose = 'reset-password'`,
        [userId],
      );
      const sessions = await client.query<{ token_hash: string }>('DELETE FROM user_sessions WHERE user_id = $1 RETURNING token_hash', [userId]);
      sessionHashes = sessions.rows.map((row) => row.token_hash);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (sessionHashes.length > 0) await this.redis.del(...sessionHashes.map((hash) => `session:${hash}`));
  }
}
