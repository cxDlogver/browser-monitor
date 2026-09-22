import { Module } from '@nestjs/common';

import { MetricsService } from '../observability/metrics.service.js';
import { IngestionController } from './ingestion.controller.js';
import { IngestionRateLimiter } from './rate-limiter.service.js';
import { IngestionService } from './ingestion.service.js';

@Module({
  controllers: [IngestionController],
  providers: [IngestionService, IngestionRateLimiter, MetricsService],
  exports: [MetricsService],
})
export class IngestionModule {}

