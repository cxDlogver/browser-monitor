// 采集入口控制器：公开的 HTTP 边界，不走 SessionGuard/CsrfGuard（浏览器匿名上报没有登录态），
// 调用方身份完全由路径中的 publicKey 决定。控制器本身只做参数提取，协议校验、Origin 白名单、
// 限流、脱敏和事务写入全部在 IngestionService 内完成。
import { Body, Controller, Headers, HttpCode, Ip, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { IngestionResult } from './ingestion.service.js';
import { IngestionService } from './ingestion.service.js';

// 路径带版本号且与协议版本对齐（当前 PROTOCOL_VERSION = '3.0'），便于旧 SDK 升级期共存
@Controller('api/v3/ingest')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  // 完整 DSN 形如 {PUBLIC_BASE_URL}/api/v3/ingest/bm_pk_xxx/envelopes，publicKey 即 DSN 中的 bm_pk_ 公钥，
  // 服务端据此定位项目、写入 key 与用户哈希盐；错误或已停用的 key 会直接 404。
  @Post(':publicKey/envelopes')
  @HttpCode(202) // 202 = 已持久化接收，而非已处理完成：同步链路只保证原始事件与 Outbox 任务同事务落库
  ingestBatch(
    @Param('publicKey') publicKey: string,
    @Body() body: unknown, // 故意用 unknown：可能是 application/json 对象，也可能是 sendBeacon 发出的 text/plain 字符串，统一交给 service 解码
    @Headers('origin') origin: string | undefined, // 用于项目级 Origin 白名单校验，浏览器请求才带该头
    @Ip() ip: string, // 限流维度之一；真实 IP 依赖 main.ts 中 Fastify 的 trustProxy 配置
    @Req() request: FastifyRequest,
  ): Promise<IngestionResult> {
    // 优先复用 RequestIdInterceptor 注入的 requestId，保证与访问日志、错误响应同一个标识；兜底 Fastify 自带 id
    const requestId = (request as FastifyRequest & { requestId?: string }).requestId ?? request.id;
    // 返回值里 accepted/duplicate/rejected 逐条统计，单条 payload 不合法只拒绝该条，不整批失败
    return this.ingestion.ingest(publicKey, body, origin, ip, requestId);
  }
}

