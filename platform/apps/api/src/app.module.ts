import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AnalyticsModule } from './analytics/analytics.module.js';
import { AuthModule } from './auth/auth.module.js';
import { RequestIdInterceptor } from './common/request-id.interceptor.js';
import { HealthController } from './health/health.controller.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { MetricsController } from './observability/metrics.controller.js';
import { ProjectsModule } from './projects/projects.module.js';

@Module({
  imports: [InfrastructureModule, AuthModule, ProjectsModule, IngestionModule, AnalyticsModule],
  controllers: [HealthController, MetricsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }],
})
export class AppModule {}

