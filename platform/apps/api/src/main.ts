import cookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import 'reflect-metadata';

import type { ApiConfig } from '@browser-monitor/shared';

import { AppModule } from './app.module.js';
import { API_CONFIG } from './infrastructure/tokens.js';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 256 * 1_024,
    trustProxy: true,
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const config = app.get<ApiConfig>(API_CONFIG);

  await app.register(cookie as never, { secret: config.COOKIE_SECRET });
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: 'API bootstrap failed', error: String(error) })}\n`);
  process.exitCode = 1;
});
