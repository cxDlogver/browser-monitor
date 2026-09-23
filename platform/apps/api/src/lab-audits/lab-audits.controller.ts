import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard, type AuthenticatedUser } from '../auth/session.guard.js';
import { parseBody } from '../common/http.js';
import { LabAuditsService } from './lab-audits.service.js';

const createAuditSchema = z.object({
  url: z.string().trim().url().max(2_048),
  device: z.enum(['mobile', 'desktop']),
});

const headersSchema = z.object({
  headers: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    value: z.string().max(4_096),
  })).max(20),
});

@Controller('api/v1/projects/:projectId')
@UseGuards(SessionGuard, CsrfGuard)
export class LabAuditsController {
  constructor(private readonly audits: LabAuditsService) {}

  @Get('lab-settings')
  settings(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.audits.settings(user.id, projectId);
  }

  @Put('lab-settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.audits.updateSettings(user.id, projectId, parseBody(headersSchema, body).headers);
  }

  @Post('lab-audits')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(createAuditSchema, body);
    return this.audits.create(user.id, projectId, input.url, input.device);
  }

  @Get('lab-audits')
  list(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.audits.list(user.id, projectId);
  }

  @Get('lab-audits/:auditId')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Param('auditId') auditId: string,
  ) {
    return this.audits.detail(user.id, projectId, auditId);
  }
}
