import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard, type AuthenticatedUser } from '../auth/session.guard.js';
import { parseBody } from '../common/http.js';
import { ProjectsService } from './projects.service.js';

const createProjectSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  appName: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
});
const originsSchema = z.object({ origins: z.array(z.string().url()).min(1).max(50) });
const rotateSchema = z.object({ label: z.string().trim().min(1).max(80).default('rotated') });
const metricThresholdSchema = z.object({
  direction: z.enum(['lower-is-better', 'higher-is-better']).optional(),
  good: z.number().finite().nonnegative().optional(),
  poor: z.number().finite().nonnegative().optional(),
});
const thresholdsSchema = z.object({
  LCP: metricThresholdSchema.optional(),
  INP: metricThresholdSchema.optional(),
  CLS: metricThresholdSchema.optional(),
  FCP: metricThresholdSchema.optional(),
  FPS: metricThresholdSchema.optional(),
});
const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['owner', 'member']).default('member') });

@Controller('api/v1')
@UseGuards(SessionGuard, CsrfGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('projects')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.list(user.id);
  }

  @Post('projects')
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(createProjectSchema, body);
    return this.projects.create(user.id, input.displayName, input.appName);
  }

  @Get('projects/:projectId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.projects.detail(user.id, projectId);
  }

  @Put('projects/:projectId/origins')
  async origins(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = parseBody(originsSchema, body);
    return { origins: await this.projects.replaceOrigins(user.id, projectId, input.origins) };
  }

  @Post('projects/:projectId/keys/rotate')
  rotate(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = parseBody(rotateSchema, body);
    return this.projects.rotateKey(user.id, projectId, input.label ?? 'rotated');
  }

  @Put('projects/:projectId/thresholds')
  thresholds(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Body() body: unknown) {
    const parsed = parseBody(thresholdsSchema, body);
    const overrides = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, NonNullable<(typeof parsed)[keyof typeof parsed]>] => entry[1] !== undefined),
    );
    return this.projects.updateThresholds(user.id, projectId, overrides);
  }

  @Post('projects/:projectId/invitations')
  @HttpCode(202)
  async invite(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = parseBody(inviteSchema, body);
    await this.projects.invite(user.id, projectId, input.email, input.role ?? 'member');
    return { message: 'Invitation sent.' };
  }

  @Post('invitations/accept')
  async accept(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parseBody(z.object({ token: z.string().min(16) }), body);
    return { projectId: await this.projects.acceptInvitation(user.id, user.email, input.token) };
  }

  @Post('projects/:projectId/dead-letters/:taskId/retry')
  @HttpCode(204)
  retryDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.projects.retryDeadLetter(user.id, projectId, taskId);
  }
}
