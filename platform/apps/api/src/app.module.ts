// 应用根模块：只负责装配，不放业务逻辑。
// 数据链路上的四个模块（Projects → Ingestion → Analytics，外加 LabAudits）都通过
// InfrastructureModule 暴露的 DATABASE / REDIS / API_CONFIG 访问依赖，因此它必须最先注册。
// 注意：Worker 是独立进程，不复用本模块，异步投影逻辑不在本应用里。
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AnalyticsModule } from './analytics/analytics.module.js'; // 查询侧：总览、性能、页面排名、原始事件、自定义观测项、服务状态
import { AuthModule } from './auth/auth.module.js'; // 账号注册登录、Session 与 CSRF 守卫
import { RequestIdInterceptor } from './common/request-id.interceptor.js'; // 全局：requestId 透传与访问日志
import { HealthController } from './health/health.controller.js'; // 探针：/health/live、/health/ready
import { InfrastructureModule } from './infrastructure/infrastructure.module.js'; // @Global：配置 + Postgres/TimescaleDB + Redis
import { IngestionModule } from './ingestion/ingestion.module.js'; // 采集侧：协议校验、脱敏、原始事件与 Outbox 事务写入
import { LabAuditsModule } from './lab-audits/lab-audits.module.js'; // 实验室测试：Lighthouse 任务创建、报告与鉴权请求头
import { MetricsController } from './observability/metrics.controller.js'; // Prometheus 指标：/internal/metrics
import { ProjectsModule } from './projects/projects.module.js'; // 项目、成员、写入 key、Origin 白名单、阈值配置

@Module({
  // 注册顺序对 Nest 无影响；InfrastructureModule 因 @Global() 可被其余模块直接注入
  imports: [InfrastructureModule, AuthModule, ProjectsModule, IngestionModule, AnalyticsModule, LabAuditsModule],
  // 不属于任何业务模块的控制器：健康检查与指标暴露（无需鉴权，通常不对外网开放）
  controllers: [HealthController, MetricsController],
  // APP_INTERCEPTOR 表示全局生效：所有请求生成/透传 x-request-id，并在响应完成时打一条日志
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }],
})
export class AppModule {}
