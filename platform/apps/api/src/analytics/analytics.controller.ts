import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard, type AuthenticatedUser } from '../auth/session.guard.js';
import { parseBody } from '../common/http.js';
import { AnalyticsService, type AnalyticsFilters } from './analytics.service.js';

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  environment: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  routeName: z.string().max(160).optional(),
  metric: z.enum(['LCP', 'FCP', 'INP', 'CLS', 'FPS', 'LoAF']).optional(),
});

@Controller('api/v1/projects/:projectId/analytics')
@UseGuards(SessionGuard, CsrfGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.overview(user.id, projectId, this.filters(query));
  }

  @Get('performance')
  performance(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.performance(user.id, projectId, this.filters(query));
  }

  @Get('routes')
  routes(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.routes(user.id, projectId, this.filters(query));
  }

  @Get('events')
  events(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.customEvents(user.id, projectId, this.filters(query));
  }

  @Get('raw-events')
  raw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const filters = this.filters(query);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    return this.analytics.rawEvents(
      user.id,
      projectId,
      filters,
      query.cursor,
      limit,
      query.type,
      query.name,
      query.sessionId,
      query.viewId,
      query.eventId,
    );
  }

  @Get('service-status')
  status(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.analytics.serviceStatus(user.id, projectId);
  }

  private filters(query: unknown): AnalyticsFilters {
    const parsed = parseBody(querySchema, query);
    const to = parsed.to ? new Date(parsed.to) : new Date();
    const from = parsed.from ? new Date(parsed.from) : new Date(to.getTime() - 24 * 60 * 60_000);
    const minimum = new Date(to.getTime() - 180 * 24 * 60 * 60_000);
    return {
      from: from < minimum ? minimum : from,
      to,
      ...(parsed.environment ? { environment: parsed.environment } : {}),
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.routeName ? { routeName: parsed.routeName } : {}),
      ...(parsed.metric ? { metric: parsed.metric } : {}),
    };
  }
}
