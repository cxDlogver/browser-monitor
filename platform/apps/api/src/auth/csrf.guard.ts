import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedRequest } from './session.guard.js';

// 同源 CSRF 防护守卫：仅对会触发状态变更的非安全方法（POST/PUT/PATCH/DELETE 等）校验
// 请求头中的 x-csrf-token，需与会话里下发的 csrfToken 完全一致。
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // GET/HEAD/OPTIONS 属于幂等的安全方法，不携带副作用，直接放行（也避免页面内普通 GET 被拦）
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const supplied = request.headers['x-csrf-token'];
    // 请求头缺失 token 或与其会话中的 csrfToken 不匹配时拒绝，返回 403
    if (typeof supplied !== 'string' || supplied !== request.auth.csrfToken) {
      throw new ForbiddenException({ code: 'invalid_csrf_token' });
    }
    return true;
  }
}

