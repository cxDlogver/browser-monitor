import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard, type AuthenticatedUser } from '../auth/session.guard.js';
import { parseBody } from '../common/http.js';
import { AnalyticsService, type AnalyticsFilters } from './analytics.service.js';
import { CustomSignalsService } from './custom-signals.service.js';

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  environment: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  routeName: z.string().max(160).optional(),
  metric: z.enum(['LCP', 'FCP', 'INP', 'CLS', 'FPS', 'LoAF']).optional(),
});

const selectionSchema = z.object({
  kind: z.enum(['event', 'trace', 'span']),
  name: z.string().trim().min(1).max(128),
});

const detailSchema = selectionSchema.extend({
  metric: z.string().trim().min(1).max(64).optional(),
  unit: z.string().trim().min(1).max(32).regex(/^[a-zA-Z][a-zA-Z0-9_./%-]*$/).optional(),
  aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p90', 'p95', 'p99']).optional(),
}).superRefine((selection, context) => {
  if (selection.metric && !selection.unit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'unit is required when metric is selected' });
  }
  if (!selection.metric && selection.aggregation && selection.aggregation !== 'count') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'count is the only aggregation without a metric' });
  }
});
@Controller('api/v1/projects/:projectId/analytics')
@UseGuards(SessionGuard, CsrfGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly customSignals: CustomSignalsService) {}

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

  @Get('custom-signals')
  customSignalList(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query() query: unknown,
  ) {
    return this.customSignals.list(user.id, projectId, this.customFilters(query));
  }

  @Get('custom-signals/detail')
  customSignalDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query() query: unknown,
  ) {
    const selection = parseBody(detailSchema, query);
    return this.customSignals.detail(user.id, projectId, this.customFilters(query), {
      ...selection,
      aggregation: selection.metric ? (selection.aggregation ?? 'avg') : 'count',
    });
  }

  @Get('custom-signals/records')
  customSignalRecords(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const selection = parseBody(selectionSchema, query);
    const parsedLimit = Number(query.limit);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, Math.floor(parsedLimit))) : 50;
    return this.customSignals.records(
      user.id, projectId, this.customFilters(query), selection, query.cursor, limit,
    );
  }

  @Get('traces/:traceId')
  customTrace(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Param('traceId') traceId: string,
    @Query() query: unknown,
  ) {
    const normalized = parseBody(z.string().trim().min(1).max(256), traceId);
    return this.customSignals.trace(user.id, projectId, normalized, this.customFilters(query));
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

  private customFilters(query: unknown): AnalyticsFilters {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return this.filters(query);
    const { metric: _customMetric, ...rangeQuery } = query as Record<string, unknown>;
    return this.filters(rangeQuery);
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
