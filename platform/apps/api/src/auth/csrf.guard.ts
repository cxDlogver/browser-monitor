import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedRequest } from './session.guard.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || supplied !== request.auth.csrfToken) {
      throw new ForbiddenException({ code: 'invalid_csrf_token' });
    }
    return true;
  }
}

