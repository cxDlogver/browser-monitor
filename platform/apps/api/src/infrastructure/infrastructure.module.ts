import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, type DatabaseHandle } from '@browser-monitor/database';
import { loadApiConfig, type ApiConfig } from '@browser-monitor/shared';
import { Redis } from 'ioredis';

import { API_CONFIG, DATABASE, REDIS } from './tokens.js';

class InfrastructureShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.database.close(), this.redis.quit()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      useFactory: (): ApiConfig => loadApiConfig(),
    },
    {
      provide: DATABASE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): DatabaseHandle => createDatabase(config.DATABASE_URL),
    },
    {
      provide: REDIS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): Redis =>
        new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: false,
        }),
    },
    InfrastructureShutdown,
  ],
  exports: [API_CONFIG, DATABASE, REDIS],
})
export class InfrastructureModule {}
