import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService],
})
export class DiagnosticsModule {}
