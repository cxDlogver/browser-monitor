import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@browser-monitor/shared';
import type { Redis } from 'ioredis';

import { API_CONFIG, REDIS } from '../infrastructure/tokens.js';

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local current = redis.call('HMGET', key, 'tokens', 'updated')
local tokens = tonumber(current[1]) or burst
local updated = tonumber(current[2]) or now
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
