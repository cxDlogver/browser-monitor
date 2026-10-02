// API 进程入口：只负责创建 HTTP 运行时并挂上全局横切能力（Cookie、CORS、优雅退出）。
// 业务装配全部在 AppModule，这里不做任何路由或依赖声明。
import cookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import 'reflect-metadata'; // Nest 的 DI 依赖装饰器元数据，必须在解析装饰器前加载

import type { ApiConfig } from '@browser-monitor/shared';

import { AppModule } from './app.module.js';
import { API_CONFIG } from './infrastructure/tokens.js';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 256 * 1_024, // 256 KiB：一个采集批次最多 100 条事件（MAX_BATCH_EVENTS），足够覆盖同时收紧恶意大包
    trustProxy: true, // 部署在反向代理/网关后：按 X-Forwarded-For 取真实客户端 IP，供限流与审计使用
    logger: false, // 关闭 Fastify 默认日志，访问日志统一由 RequestIdInterceptor 输出结构化 JSON
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true, // 先把 Nest 启动期日志缓冲起来，应用就绪后再刷出，避免与请求日志交错
  });
  const config = app.get<ApiConfig>(API_CONFIG);

  // Cookie 需要签名密钥（配置校验要求至少 32 位），Session 与 CSRF 令牌都通过它下发/校验
  await app.register(cookie as never, { secret: config.COOKIE_SECRET });
  app.enableCors({
    origin: true, // 回显请求方 Origin 而非固定白名单；真正的来源限制由项目级 Origin 白名单在采集链路里执行
    credentials: true, // 允许浏览器携带 HttpOnly Session Cookie
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'], // 与 CsrfGuard、请求 ID 透传保持一致
  });
  app.enableShutdownHooks(); // 收到 SIGTERM/SIGINT 时触发 InfrastructureModule.onApplicationShutdown，关闭 DB 与 Redis 连接
  await app.listen(config.API_PORT, '0.0.0.0'); // 监听所有网卡以便容器/局域网访问，端口来自 API_PORT（默认 3000）
}

// 启动失败必须立刻以非零码退出：让进程编排（Docker/K8s）感知并重启，而不是留下半可用实例
bootstrap().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: 'API bootstrap failed', error: String(error) })}\n`);
  process.exitCode = 1;
});
