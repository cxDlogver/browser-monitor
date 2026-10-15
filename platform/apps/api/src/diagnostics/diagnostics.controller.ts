import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.js';
import { SessionGuard, type AuthenticatedUser } from '../auth/session.guard.js';
import { parseBody } from '../common/http.js';
import { DiagnosticsService, type EventFilters } from './diagnostics.service.js';

const time = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const identifier = z.string().trim().min(1).max(256);
const querySchema = z.object({
  from: time.optional(), to: time.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(8192).optional(),
  type: z.enum(['performance', 'view', 'event', 'trace', 'span']).optional(),
  name: z.string().trim().min(1).max(128).optional(),
  environment: z.string().trim().min(1).max(64).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  routeName: z.string().trim().min(1).max(160).optional(),
  sessionId: identifier.optional(), viewId: identifier.optional(), eventId: identifier.optional(),
  includePayload: z.enum(['true', 'false']).optional(),
}).strict();
const identitySchema = z.object({ occurredAt: time.optional(), includePayload: z.enum(['true', 'false']).optional() }).strict();

@Controller('api/v1/projects/:projectId')
@UseGuards(SessionGuard)
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}
  private projectId(value: string) { return parseBody(z.string().uuid(), value); }

  @Get('events')
  events(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    const input = parseBody(querySchema, query);
    const to = input.to ?? new Date().toISOString();
    const from = input.from ?? new Date(new Date(to).getTime() - 86400000).toISOString();
    parseBody(z.object({ from: z.number(), to: z.number() })
      .refine((v) => v.from < v.to, 'from must be before to')
      .refine((v) => v.to - v.from <= 180 * 86400000, 'Maximum query window is 180 days'),
      { from: Date.parse(from), to: Date.parse(to) });
    const { includePayload, ...rest } = input;
    const filters = { ...rest, from, to, limit: input.limit ?? 50, includePayload: includePayload === 'true' } as EventFilters;
    return this.diagnostics.events(user.id, this.projectId(projectId), filters);
  }

  @Get('diagnostics/data')
  data(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.diagnostics.data(user.id, this.projectId(projectId));
  }

  @Get('diagnostics/queue')
  queue(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.diagnostics.queue(user.id, this.projectId(projectId));
  }

  @Get('diagnostics/events/:eventId')
  event(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Param('eventId') eventId: string, @Query() query: unknown) {
    const input = parseBody(identitySchema, query);
    return this.diagnostics.event(user.id, this.projectId(projectId), parseBody(identifier, eventId), input.occurredAt, input.includePayload === 'true');
  }
}
