import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { DatabaseHandle } from '@browser-monitor/database';
import type { Redis } from 'ioredis';

import { DATABASE, REDIS } from '../infrastructure/tokens.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await Promise.all([this.database.pool.query('SELECT 1'), this.redis.ping()]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ code: 'not_ready' });
    }
  }
}
