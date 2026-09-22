import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
    const startedAt = performance.now();
    (request as FastifyRequest & { requestId: string }).requestId = requestId;
    response.header('x-request-id', requestId);
    return next.handle().pipe(
      finalize(() => {
        // Query strings can contain reset tokens or dashboard filters, so only
        // the path is included in request logs.
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
