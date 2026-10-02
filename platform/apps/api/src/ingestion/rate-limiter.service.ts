import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@browser-monitor/shared';
import type { Redis } from 'ioredis';

import { API_CONFIG, REDIS } from '../infrastructure/tokens.js';

// 令牌桶限流脚本（Lua，在 Redis 内原子执行）：以 rate 个/秒的恒定速率补充令牌，
// 桶容量上限为 burst；cost 为本次消耗（=本批事件条数）。令牌不足返回 0（拒绝），
// 足够则扣减并返回 1（放行）。每次都重写 updated 并以 60s 过期，空闲键自动回收。
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local current = redis.call('HMGET', key, 'tokens', 'updated')
local tokens = tonumber(current[1]) or burst
local updated = tonumber(current[2]) or now
-- 按距上次更新的时间差补充令牌（不超过桶容量 burst）
tokens = math.min(burst, tokens + math.max(0, now - updated) * rate)
if tokens < cost then
  redis.call('HSET', key, 'tokens', tokens, 'updated', now)
  redis.call('EXPIRE', key, 60)
  return 0
end
tokens = tokens - cost
redis.call('HSET', key, 'tokens', tokens, 'updated', now)
redis.call('EXPIRE', key, 60)
return 1
`;

@Injectable()
export class IngestionRateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  // 双重限流：项目级总配额 + 项目内单 IP 配额，二者都通过才放行（防止单项目被单个客户端打满）。
  // 单 IP 配额取项目配额的约一半，并各自有下限（速率≥10/s、突发≥50）保证可用性。
  async consume(projectId: string, ip: string, eventCount: number): Promise<boolean> {
    const nowSeconds = Date.now() / 1_000;
    const [projectAllowed, ipAllowed] = await Promise.all([
      this.consumeKey(
        `ingest:project:${projectId}`,
        nowSeconds,
        this.config.INGEST_PROJECT_RATE_PER_SECOND,
        this.config.INGEST_PROJECT_BURST,
        eventCount,
      ),
      this.consumeKey(
        `ingest:ip:${projectId}:${ip}`,
        nowSeconds,
        Math.max(10, Math.ceil(this.config.INGEST_PROJECT_RATE_PER_SECOND / 2)),
        Math.max(50, Math.ceil(this.config.INGEST_PROJECT_BURST / 2)),
        eventCount,
      ),
    ]);
    return projectAllowed && ipAllowed;
  }

  // 对单个限流键执行令牌桶脚本；返回 true 表示本次放行
  private async consumeKey(
    key: string,
    now: number,
    rate: number,
    burst: number,
    cost: number,
  ): Promise<boolean> {
    const result = await this.redis.eval(TOKEN_BUCKET_SCRIPT, 1, key, now, rate, burst, cost);
    return Number(result) === 1;
  }
}
