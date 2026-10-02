import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest, AuthenticatedUser } from './session.guard.js';

// 参数装饰器：在控制器方法里用 `@CurrentUser() user` 注入当前登录用户。
// 它直接读取 SessionGuard 在请求对象上挂载的 `auth`（由 Redis 中解析出的会话信息），
// 因此该装饰器必须在 SessionGuard（或 CsrfGuard 等同样依赖它的守卫）生效的路由上才可用。
export const CurrentUser = createParamDecorator(
  // _data 保留参数位（createParamDecorator 的工厂签名要求），这里没有用到自定义数据
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);

