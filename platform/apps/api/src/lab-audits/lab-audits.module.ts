import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { LabAuditsController } from './lab-audits.controller.js';
import { LabAuditsService } from './lab-audits.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [LabAuditsController],
  providers: [LabAuditsService],
})
export class LabAuditsModule {}
