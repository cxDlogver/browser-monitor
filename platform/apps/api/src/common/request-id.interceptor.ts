import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';

// 请求跟踪拦截器：为每个请求分配/透传 requestId，挂在请求对象上供其它守卫与服务使用，
// 并回写到响应头；请求结束时统一输出一条结构化访问日志（含耗时与状态码）。
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    // 优先复用上游（如网关/反向代理）传入的 x-request-id，长度限制在 128 以内防滥用；否则生成新 UUID
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
    // 记录进入时间，用于计算本次请求耗时
    const startedAt = performance.now();
    (request as FastifyRequest & { requestId: string }).requestId = requestId;
    response.header('x-request-id', requestId);
    return next.handle().pipe(
      finalize(() => {
        // 查询串可能包含重置令牌或看板筛选条件等敏感信息，因此日志里只保留 path、不带 query。
        process.stdout.write(`${JSON.stringify({
          level: response.statusCode >= 500 ? 'error' : 'info',
          message: 'request_completed',
          requestId,
          method: request.method,
          path: request.url.split('?', 1)[0],
          statusCode: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        })}\n`);
      }),
    );
  }
}
