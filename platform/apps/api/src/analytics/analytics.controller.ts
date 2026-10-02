// 可视化平台的查询侧 API：所有路由都在 /api/v1/projects/:projectId/analytics 下，
// 统一要求登录态（SessionGuard）与 CSRF 令牌（CsrfGuard），且每个方法内部都会通过
// ProjectsService.requireAccess 校验当前用户对 projectId 的访问权限。
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard, type AuthenticatedUser } from '../auth/session.guard.js';
import { parseBody } from '../common/http.js';
import { AnalyticsService, type AnalyticsFilters } from './analytics.service.js';
import { CustomSignalsService } from './custom-signals.service.js';

// 时间窗口 + 维度筛选，所有聚合视图共用这一组条件
const querySchema = z.object({
  from: z.string().datetime().optional(), // ISO 时间字符串；缺省时由 filters() 补成 to-24h
  to: z.string().datetime().optional(), // 缺省时取当前时间
  environment: z.string().max(64).optional(), // 按环境（如 prod/staging）过滤
  version: z.string().max(64).optional(), // 按 SDK 版本过滤
  routeName: z.string().max(160).optional(), // 按页面路由名过滤
  metric: z.enum(['LCP', 'FCP', 'INP', 'CLS', 'FPS', 'LoAF']).optional(), // 核心指标名，用于按指标过滤 metric_samples
});

// 自定义观测项的选择器：先选种类，再选具体名称
const selectionSchema = z.object({
  kind: z.enum(['event', 'trace', 'span']), // 与 CustomSignalsService 的 SignalKind 对齐
  name: z.string().trim().min(1).max(128),
});

// 自定义观测项详情：在 selection 之上追加指标口径（metric/unit/聚合方式）
const detailSchema = selectionSchema.extend({
  metric: z.string().trim().min(1).max(64).optional(), // 自定义指标名（不是核心 Web Vitals）
  unit: z.string().trim().min(1).max(32).regex(/^[a-zA-Z][a-zA-Z0-9_./%-]*$/).optional(), // 单位，首字符必须是字母，避免 SQL 注入
  aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p90', 'p95', 'p99']).optional(),
}).superRefine((selection, context) => {
  // 选了自定义指标就必须带单位；没选指标时只允许 count（其它聚合都没有分母）
  if (selection.metric && !selection.unit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'unit is required when metric is selected' });
  }
  if (!selection.metric && selection.aggregation && selection.aggregation !== 'count') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'count is the only aggregation without a metric' });
  }
});
@Controller('api/v1/projects/:projectId/analytics')
@UseGuards(SessionGuard, CsrfGuard) // 先校验登录态，再校验 CSRF 令牌；按路由局部生效
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly customSignals: CustomSignalsService) {}

  // 总览：会话数、事件数、Top 指标与按评分（good/needs-improvement/bad）分布；超出物化范围时直接读 rollup 表
  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.overview(user.id, projectId, this.filters(query));
  }

  // 性能：核心 Web Vitals 等指标的百分位分布（p50/p75/p90/p95 等），依赖 metric_samples
  @Get('performance')
  performance(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.performance(user.id, projectId, this.filters(query));
  }

  // 路由排行：按 routeName 聚合的访问量与性能概览
  @Get('routes')
  routes(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.analytics.routes(user.id, projectId, this.filters(query));
  }

  // 自定义观测项列表：用户自定义的 event/trace/span 信号清单
  @Get('custom-signals')
  customSignalList(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query() query: unknown,
  ) {
    return this.customSignals.list(user.id, projectId, this.customFilters(query));
  }

  // 自定义观测项详情：按指定 metric/unit/聚合计算时序；未选 metric 时固定用 count，选了则默认 avg
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

  // 自定义观测项原始记录：游标分页的明细样本，limit 限制在 1~100，默认 50
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

  // 单条 trace 的火焰图/span 树：traceId 做长度与空白校验后透传到 service
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

  // 原始事件明细：可叠加 type/name/sessionId/viewId/eventId 精确过滤，游标分页（同 limit 1~100，默认 50）
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

  // 服务状态：采集吞吐、最近写入延迟等运维健康度指标
  @Get('service-status')
  status(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
    return this.analytics.serviceStatus(user.id, projectId);
  }

  // 自定义观测项接口专用的筛选构造：自定义信号不走核心 metric 过滤，所以先抠掉 metric 再交给 filters()
  private customFilters(query: unknown): AnalyticsFilters {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return this.filters(query);
    const { metric: _customMetric, ...rangeQuery } = query as Record<string, unknown>;
    return this.filters(rangeQuery);
  }
  private filters(query: unknown): AnalyticsFilters {
    const parsed = parseBody(querySchema, query);
    const to = parsed.to ? new Date(parsed.to) : new Date();
    // 缺省窗口为最近 24 小时；from 最早不允许早于 to 之前 180 天，避免物化/聚合查询拖垮数据库
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
