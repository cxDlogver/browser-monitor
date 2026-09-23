import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { CustomSignalsService } from './custom-signals.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, CustomSignalsService],
})
export class AnalyticsModule {}

