import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { hashToken } from '@browser-monitor/shared';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { REDIS } from '../infrastructure/tokens.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  sessionId: string;
  csrfToken: string;
}

export type AuthenticatedRequest = FastifyRequest & { auth: AuthenticatedUser; requestId?: string };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies?.bm_session;
    if (!token) throw new UnauthorizedException({ code: 'authentication_required' });

    const session = await this.redis.get(`session:${hashToken(token)}`);
    if (!session) throw new UnauthorizedException({ code: 'session_expired' });
    (request as AuthenticatedRequest).auth = JSON.parse(session) as AuthenticatedUser;
    return true;
  }
}
