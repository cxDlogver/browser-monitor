# NestJS + Fastify API 源码学习

> **学习目标**：从 `browser-monitor/platform/apps/api` 的真实源码出发，循序渐进理解 NestJS + Fastify API 应用。每个知识点统一按照“源码事实 → 执行逻辑 → 通用框架知识 → 设计取舍 → 回到当前项目”的顺序展开，最终形成可以脱离当前项目复用的后端框架知识体系。

> **分析范围**：本文件聚焦 `platform/apps/api`。Worker、Web、Audit Worker 等其他进程只在解释边界时引用，不在本文件展开。

## 1. NestJS + Fastify 共同组成 API 应用，而不是二选一

### 【源码入口表明当前应用同时使用 NestJS 与 Fastify】

当前 API 应用入口位于：

```text
browser-monitor/platform/apps/api/src/main.ts
```

核心代码：

```ts
import cookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 256 * 1_024,
    trustProxy: true,
    logger: false,
  });

  const app =
    await NestFactory.create<NestFastifyApplication>(
      AppModule,
      adapter,
      {
        bufferLogs: true,
      },
    );

  const config = app.get<ApiConfig>(API_CONFIG);

  await app.register(cookie as never, {
    secret: config.COOKIE_SECRET,
  });

  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  app.enableShutdownHooks();

  await app.listen(
    config.API_PORT,
    '0.0.0.0',
  );
}
```

`package.json` 中同时存在：

```json
{
  "@nestjs/common": "^11.1.6",
  "@nestjs/core": "^11.1.6",
  "@nestjs/platform-fastify": "^11.1.6",
  "fastify": "^5.6.1"
}
```

因此当前应用不是：

```text
NestJS
或
Fastify
```

而是：

```text
NestJS
    +
Fastify
```

更准确地说：

```text
NestJS
    → Application Framework

Fastify
    → HTTP Platform / Web Framework
```

### 【当前 API 的整体运行层次】

先忽略具体业务模块，可以得到第一张整体架构图：

```text
                 API Application
                       │
                       ▼
                Node.js Process
                       │
                       ▼
                  Fastify
             HTTP Platform Layer
                       │
                       ▼
              FastifyAdapter
                       │
                       ▼
                   NestJS
            Application Framework
                       │
                       ▼
                  AppModule
                       │
                  Module Graph
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
     Auth          Projects         Ingestion
       │               │                │
       └──────── Analytics / LabAudits ─┘
                       │
                       ▼
              Controller / Provider
                       │
                       ▼
               Database / Redis
```

最重要的第一层认识是：

> **NestJS 和 Fastify 不属于同一层。**

Fastify 更靠近 HTTP 请求处理；NestJS 更靠近应用结构组织。

### 【Fastify 解决 HTTP 层问题，NestJS 解决应用结构问题】

可以先按照职责粗略划分：

| 层 | 主要解决的问题 |
| --- | --- |
| Node.js | 程序如何作为进程运行、I/O 如何执行 |
| Fastify | HTTP 请求如何监听、解析、路由，以及如何通过 Plugin 扩展 |
| NestJS | Module、Provider、Controller、DI、Guard、Interceptor、生命周期如何组织 |
| 业务代码 | Project、采集、分析等具体业务如何实现 |

可以进一步压缩成：

```text
Fastify
    ↓
HTTP 请求怎么进入和被处理？

NestJS
    ↓
请求进入以后，整个应用由哪些模块和对象负责？
```

这两个问题不是一回事。

### 【NestJS 通过 Platform Adapter 复用不同 HTTP Framework】

NestJS 并没有重新实现一整套底层 HTTP Server，而是在上层定义统一应用模型，再通过 Platform Adapter 对接具体 HTTP Framework。

当前项目使用：

```ts
new FastifyAdapter()
```

可以理解成：

```text
Nest Controller Metadata

@Controller()
@Get()
@Post()

        ↓

Nest Framework

        ↓

FastifyAdapter

        ↓

Fastify Route / Hook / Request / Reply

        ↓

Node.js HTTP Server
```

Adapter 的职责就是：

> **把 NestJS 的统一应用抽象映射到底层 Fastify 能执行的 HTTP 模型。**

### 【这里体现的是 Adapter Pattern】

脱离当前项目，如果 NestJS 希望同时支持 Express 和 Fastify，就不能让上层代码直接写死：

```ts
fastify.get(...)
```

或者：

```ts
express.get(...)
```

更合理的结构是：

```text
              NestJS

          统一应用抽象
               │
        ┌──────┴──────┐
        ▼             ▼
 ExpressAdapter   FastifyAdapter
        │             │
        ▼             ▼
    Express        Fastify
```

这就是典型的 Adapter Pattern：

```text
上层依赖稳定抽象
        ↓
Adapter 做协议 / API 转换
        ↓
底层具体实现可以替换
```

它的价值不是“多包一层”，而是降低 Nest Application 对具体 HTTP Framework 的耦合。

### 【FastifyAdapter 在当前项目中的实际作用】

源码：

```ts
const adapter = new FastifyAdapter({
  bodyLimit: 256 * 1_024,
  trustProxy: true,
  logger: false,
});
```

随后：

```ts
const app =
  await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      bufferLogs: true,
    },
  );
```

这里可以拆成两步：

```text
FastifyAdapter
    ↓
确定底层 HTTP Platform

NestFactory.create(...)
    ↓
基于该 HTTP Platform 构建 Nest Application
```

所以 `NestFactory.create()` 本身不是在创建 Fastify；Fastify Platform 已经由 Adapter 指定。

### 【NestFastifyApplication 同时暴露 Nest 能力与 Fastify 特有能力】

当前应用类型写成：

```ts
NestFastifyApplication
```

原因是项目除了需要 Nest Application 的能力，还要直接使用 Fastify 的平台能力。

例如 Nest API：

```ts
app.enableCors();
app.enableShutdownHooks();
```

以及 Fastify Plugin API：

```ts
await app.register(cookie as never, {
  secret: config.COOKIE_SECRET,
});
```

因此可以理解为：

```text
NestFastifyApplication
        =
Nest Application Capability
        +
Fastify Platform Capability
```

NestJS 并没有完全隐藏底层 Fastify，而是允许应用在需要时访问平台特有能力。

### 【当前项目实际同时存在两套扩展机制】

以后阅读源码时，需要始终区分两套机制。

第一套属于 Fastify：

```text
Fastify
────────────────────────
Plugin
Hook
Request
Reply
Parser
Route
```

例如：

```ts
app.register(cookie)
```

属于：

```text
Fastify Plugin System
```

第二套属于 NestJS：

```text
NestJS
────────────────────────
Module
Provider
Controller
Guard
Pipe
Interceptor
Exception Filter
DI
Application Lifecycle
```

例如：

```ts
@Module({
  providers: [...]
})
```

属于：

```text
Nest Module + DI System
```

两者都运行在一个 Node.js API 进程里，但解决的是不同层次的问题。

### 【AppModule 描述 Application 由哪些能力组成】

当前 `src/app.module.ts`：

```ts
@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    ProjectsModule,
    IngestionModule,
    AnalyticsModule,
    LabAuditsModule,
  ],

  controllers: [
    HealthController,
    MetricsController,
  ],

  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestIdInterceptor,
    },
  ],
})
export class AppModule {}
```

这里没有：

```text
listen()
TCP
HTTP Parser
Cookie Parser
```

这些底层 HTTP 启动逻辑。

它描述的是：

```text
Application 由哪些能力组成？
```

即：

```text
Infrastructure
Auth
Projects
Ingestion
Analytics
LabAudits
Health
Metrics
RequestId
```

因此 `AppModule` 可以理解为：

> **API Application 的结构声明和装配入口。**

### 【main.ts 与 AppModule 分别解决运行与结构问题】

`main.ts` 回答：

```text
应用怎样运行起来？
```

包括：

```text
使用哪个 HTTP Platform
Fastify 怎样配置
Cookie Plugin 怎样注册
CORS 怎样配置
Shutdown 怎样处理
监听哪个 Host / Port
```

所以：

```text
main.ts
    =
Runtime Bootstrap
```

而 `AppModule` 回答：

```text
应用由哪些能力组成？
```

包括：

```text
有哪些 Feature Module
有哪些 Controller
有哪些 Provider
有哪些 Application-level Capability
```

所以：

```text
AppModule
    =
Application Composition Root
```

两者通过：

```text
main.ts
    ↓
NestFactory.create(AppModule)
    ↓
AppModule
    ↓
Application Graph
```

连接起来。

### 【NestFactory.create 把静态代码定义转换成运行时 Application】

```ts
await NestFactory.create(
  AppModule,
  adapter,
)
```

不能只理解成“创建一个 app 对象”。

概念上，它会以 Root Module 和 HTTP Platform 为入口：

```text
Root Module
+
HTTP Platform
      ↓
扫描 Module Metadata
      ↓
建立 Module Graph
      ↓
注册 Provider Definitions
      ↓
建立 DI Container
      ↓
解析 Controller / Provider
      ↓
根据 Controller Metadata
映射到底层 HTTP Route
      ↓
形成完整 Nest Application
```

因此：

> **`NestFactory.create()` 是把静态声明转换成运行时应用结构的入口。**

### 【当前 main.ts 的完整启动链路】

把源码按执行逻辑重新串起来：

```text
bootstrap()
    ↓
new FastifyAdapter()
    ↓
确定底层 HTTP Platform
    ↓
NestFactory.create(AppModule, adapter)
    ↓
构建 Nest Application
Module Graph
DI Container
Controllers
Providers
    ↓
app.get(API_CONFIG)
    ↓
从 DI Container 读取配置
    ↓
app.register(cookie)
    ↓
向 Fastify 注册 Cookie Plugin
    ↓
app.enableCors()
    ↓
配置浏览器跨域策略
    ↓
app.enableShutdownHooks()
    ↓
接入 Process Shutdown Lifecycle
    ↓
app.listen()
    ↓
Fastify / Node HTTP Server 绑定端口
    ↓
API Running
```

这就是当前 `main.ts` 的整体职责。

### 【package.json 说明 NestJS 最终仍运行在普通 Node.js 进程中】

当前脚本：

```json
{
  "build": "tsc -p tsconfig.build.json",
  "dev": "tsx watch src/main.ts",
  "start": "node dist/main.js"
}
```

说明最终链路仍然是：

```text
TypeScript Source
      ↓
tsc
      ↓
JavaScript
      ↓
node dist/main.js
      ↓
Node.js Process
```

NestJS 没有创造新的运行时。

完整层次仍然是：

```text
Operating System
      ↓
Node.js Process
      ↓
Fastify HTTP Platform
      ↓
NestJS Application
      ↓
Application Modules
      ↓
Controllers / Providers
      ↓
Business / Data
```

### 【当前目录体现 Feature Module + Cross-cutting Infrastructure 的组织方式】

当前一级目录：

```text
src/
├── main.ts
├── app.module.ts
│
├── infrastructure/
├── auth/
├── projects/
├── ingestion/
├── analytics/
├── lab-audits/
│
├── common/
├── health/
└── observability/
```

第一阶段可以分成三类：

```text
启动与装配
────────────────
main.ts
app.module.ts

业务 Feature
────────────────
auth
projects
ingestion
analytics
lab-audits

横向 / 基础能力
────────────────
infrastructure
common
health
observability
```

这意味着当前 API 不是按照：

```text
controllers/
services/
utils/
```

全局技术类型平铺，而是主要按照 Feature Module 组织业务，再把真正的横向能力单独抽离。

### 【脱离当前项目后可以形成通用的 NestJS + Fastify 五层模型】

以后看到任何 NestJS + Fastify 项目，都可以先按照下面五层分析：

```text
第 1 层 Runtime
──────────────────
Node.js Process

第 2 层 HTTP Platform
──────────────────
Fastify
Route
Request / Reply
Plugin
HTTP Parser

第 3 层 Adapter
──────────────────
FastifyAdapter

把 Nest abstraction
映射到 Fastify

第 4 层 Application Framework
──────────────────
NestJS

Module
DI Container
Controller
Provider
Guard
Interceptor
Pipe
Lifecycle

第 5 层 Business Application
──────────────────
Auth
Project
Order
Ingestion
Analytics
...
```

这个框架可以脱离 Browser Monitor 独立成立。

### 【回到当前项目，NestJS 与 Fastify 分别承担不同复杂度】

当前 API 已经包含：

```text
Auth
Projects
Ingestion
Analytics
LabAudits

Database
Redis
Metrics
RequestId
Health
```

它面临的问题已经不只是：

```text
“怎么注册几个 Route”
```

还包括：

```text
业务模块怎么拆
Provider 怎么共享
依赖怎么注入
权限逻辑怎么复用
请求生命周期怎么统一
数据库和 Redis 怎么进入应用生命周期
日志与指标怎么横切所有请求
应用怎么安全退出
```

如果只使用 Fastify，这些能力仍然可以实现，但：

```text
Module Boundary
DI
Provider Visibility
Lifecycle
Global Guard / Interceptor
```

等应用级结构需要项目自己设计更多规范。

当前项目采用的是：

```text
Fastify
    → HTTP Platform

NestJS
    → Application Architecture
```

也就是：

> **当前 API 是运行在 Node.js 进程中的 NestJS Application，Fastify 是它的底层 HTTP Platform；NestJS 通过 FastifyAdapter 在 Fastify 之上建立 Module、DI、Controller、请求生命周期和应用生命周期等应用级结构。**

## 2. AppModule 与 Module Graph 把独立能力装配成完整 Application

这一层从上一章的：

```text
NestFactory.create(AppModule)
```

继续向下展开。

上一章解决的是：

```text
Nest Application 怎样被启动？
```

这一章解决的是：

```text
AppModule 被交给 Nest 以后，
Nest 看到的整个应用结构到底是什么？
```

核心主线是：

```text
AppModule
    ↓
imports
    ↓
Feature Module / Infrastructure Module
    ↓
providers / controllers / exports
    ↓
Module Graph
    ↓
Provider Visibility
    ↓
为下一层 DI Container 提供解析边界
```

### 【源码中的 AppModule 是应用装配根节点】

当前源码：

```ts
// src/app.module.ts
@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    ProjectsModule,
    IngestionModule,
    AnalyticsModule,
    LabAuditsModule,
  ],
  controllers: [
    HealthController,
    MetricsController,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestIdInterceptor,
    },
  ],
})
export class AppModule {}
```

这里可以先分成三类信息：

```text
imports
    → 应用由哪些 Module 组成

controllers
    → AppModule 自己直接拥有的 HTTP Controller

providers
    → AppModule 自己注册的 Provider / Application-level capability
```

因此 `AppModule` 不是“最大的业务模块”，而是：

> **整个 API Application 的 Composition Root。**

Nest 官方也把 Root Module 定义为构建 Application Graph 的起点；其他 Module 再通过自己的 `imports` 继续展开依赖。  
参考：<https://docs.nestjs.com/modules>

### 【当前 API 的六个 Module 分成基础设施与业务 Feature 两类】

直接读取各个 `*.module.ts` 后，可以得到：

| Module | imports | controllers | providers | exports |
| --- | --- | --- | --- | --- |
| `InfrastructureModule` | — | — | Config / Database / Redis / Shutdown | `API_CONFIG` / `DATABASE` / `REDIS` |
| `AuthModule` | — | `AuthController` | `AuthService` / `MailerService` / `SessionGuard` / `CsrfGuard` | `MailerService` / Guards |
| `ProjectsModule` | `AuthModule` | `ProjectsController` | `ProjectsService` | `ProjectsService` |
| `IngestionModule` | — | `IngestionController` | `IngestionService` / `IngestionRateLimiter` / `MetricsService` | `MetricsService` |
| `AnalyticsModule` | `ProjectsModule` | `AnalyticsController` | `AnalyticsService` / `CustomSignalsService` | — |
| `LabAuditsModule` | `ProjectsModule` | `LabAuditsController` | `LabAuditsService` | — |

第一阶段可以把它们分成：

```text
Infrastructure Module
──────────────────────
InfrastructureModule

Feature Module
──────────────────────
AuthModule
ProjectsModule
IngestionModule
AnalyticsModule
LabAuditsModule
```

这体现了 Nest 常见的 Feature Module 思路：把同一业务域里的 Controller、Service 和相关 Provider 聚合在同一个 Module 中，而不是把所有 Controller 和 Service 全局平铺。

### 【imports 不是文件 import，而是在 Module Graph 中建立依赖边】

例如：

```ts
@Module({
  imports: [ProjectsModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    CustomSignalsService,
  ],
})
export class AnalyticsModule {}
```

这不是简单表示：

```text
加载一下 ProjectsModule 文件
```

真正表达的是：

```text
AnalyticsModule
       ↓ depends on
ProjectsModule
```

为什么需要这条边，可以继续看实际 Service：

```ts
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE)
    private readonly database: DatabaseHandle,

    @Inject(REDIS)
    private readonly redis: Redis,

    private readonly projects: ProjectsService,
  ) {}
}
```

这里真正消费 `ProjectsModule` 公共能力的是：

```text
AnalyticsService
      ↓
ProjectsService
```

所以：

```text
Module Graph

AnalyticsModule
      ↓ imports
ProjectsModule


Provider Object Graph

AnalyticsService
      ↓ inject
ProjectsService
```

两张图不是同一张图。

Module Graph 表达：

```text
谁允许访问谁的能力？
```

Provider Object Graph 表达：

```text
哪个运行时对象真正依赖哪个对象？
```

同样，`LabAuditsModule` 导入 `ProjectsModule`，最终对应：

```ts
@Injectable()
export class LabAuditsService {
  constructor(
    @Inject(DATABASE)
    private readonly database: DatabaseHandle,

    @Inject(API_CONFIG)
    private readonly config: ApiConfig,

    private readonly projects: ProjectsService,
  ) {}
}
```

所以：

```text
LabAuditsModule
      ↓ imports
ProjectsModule

对应

LabAuditsService
      ↓
ProjectsService
```

### 【exports 定义一个 Module 对外真正提供的公共能力】

`ProjectsModule`：

```ts
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
```

这里：

```text
providers: [ProjectsService]
```

表示：

```text
ProjectsService
属于 ProjectsModule 的 Provider
```

而：

```text
exports: [ProjectsService]
```

进一步表示：

```text
ProjectsService
不仅在 ProjectsModule 内部可用
还构成 ProjectsModule 的 Public API
```

因此可以把 Module 看成：

```text
┌───────────────────────────────┐
│ ProjectsModule                │
│                               │
│ Controller                    │
│ Internal Provider             │
│ Internal Implementation       │
│                               │
│ ───── public boundary ──────  │
│ ProjectsService               │
└───────────────┬───────────────┘
                ↓
         importing modules
```

Nest 官方明确说明：Module 默认封装自己的 Provider，被导出的 Provider 才能成为其他导入该 Module 的模块可使用的公共能力。  
参考：<https://docs.nestjs.com/modules>

### 【ProjectsModule 导入 AuthModule 是因为 ProjectsService 真正依赖 MailerService】

源码：

```ts
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
```

继续看 `ProjectsService`：

```ts
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DATABASE)
    private readonly database: DatabaseHandle,

    @Inject(API_CONFIG)
    private readonly config: ApiConfig,

    private readonly mailer: MailerService,
  ) {}
}
```

而 `MailerService` 来自：

```ts
@Module({
  providers: [
    AuthService,
    MailerService,
    SessionGuard,
    CsrfGuard,
  ],
  exports: [
    MailerService,
    SessionGuard,
    CsrfGuard,
  ],
})
export class AuthModule {}
```

于是完整链路：

```text
ProjectsService
    ↓ needs
MailerService
    ↓ belongs to
AuthModule
    ↓ exports
MailerService
    ↑
ProjectsModule imports AuthModule
```

这很好地体现：

> **imports / exports 最终不是为了组织目录，而是为了给 DI Container 建立 Provider 可见性边界。**

### 【IngestionModule 导出 MetricsService 是为了让根模块的 MetricsController 复用同一实例】

当前：

```ts
@Module({
  controllers: [IngestionController],
  providers: [
    IngestionService,
    IngestionRateLimiter,
    MetricsService,
  ],
  exports: [MetricsService],
})
export class IngestionModule {}
```

`IngestionService` 使用：

```ts
constructor(
  ...
  private readonly metrics: MetricsService,
) {}
```

而 `AppModule` 直接拥有：

```ts
controllers: [
  HealthController,
  MetricsController,
]
```

`MetricsController` 又需要：

```ts
constructor(
  private readonly metrics: MetricsService,
  @Inject(DATABASE)
  private readonly database: DatabaseHandle,
) {}
```

因此需要：

```text
IngestionModule
    ↓ exports
MetricsService
    ↓
AppModule imports IngestionModule
    ↓
MetricsController
可以注入同一个 MetricsService
```

这里“同一个”非常重要。

`MetricsService` 内部自己创建：

```ts
readonly registry = new Registry();
```

并把所有 Counter / Histogram / Gauge 注册到：

```text
this.registry
```

所以采集请求写指标：

```text
IngestionService
    ↓
MetricsService
    ↓
Registry
```

指标端点读取：

```text
MetricsController
    ↓
MetricsService
    ↓
同一个 Registry
```

如果在 `AppModule` 又重新：

```ts
providers: [MetricsService]
```

而不是从 `IngestionModule` 导出后复用，就可能得到不同的 Provider 实例和不同的 `Registry`，从而破坏“写指标”和“暴露指标”使用同一注册表的设计。

Nest 的 Shared Module 机制就是为了让导入模块复用被导出的 Provider 实例。  
参考：<https://docs.nestjs.com/modules#shared-modules>

### 【InfrastructureModule 通过 @Global 把基础设施能力提升到应用级可见】

当前源码：

```ts
@Global()
@Module({
  providers: [
    API_CONFIG Provider,
    DATABASE Provider,
    REDIS Provider,
    InfrastructureShutdown,
  ],
  exports: [
    API_CONFIG,
    DATABASE,
    REDIS,
  ],
})
export class InfrastructureModule {}
```

这意味着：

```text
InfrastructureModule
        ↓
      @Global
        ↓
API_CONFIG / DATABASE / REDIS
在整个 Application Graph 中可见
```

于是：

```text
ProjectsService
AnalyticsService
IngestionService
LabAuditsService
SessionGuard
MetricsController
...
```

都可以直接：

```ts
@Inject(DATABASE)
@Inject(REDIS)
@Inject(API_CONFIG)
```

而不需要每一个 Module 都写：

```ts
imports: [InfrastructureModule]
```

这正适合数据库、Redis、Config 这类真正的全应用基础设施。

但 `@Global()` 不意味着“所有 Provider 自动暴露”。

仍然只有：

```text
exports
```

里的：

```text
API_CONFIG
DATABASE
REDIS
```

被作为全局公共能力。

`InfrastructureShutdown` 没有 export，因为它只是由 Nest 生命周期系统管理，不需要其他模块注入。

Nest 官方也明确建议 Global Module 只注册一次，并提醒不要把所有能力都做成 Global，否则会削弱显式 `imports` 带来的模块边界。  
参考：<https://docs.nestjs.com/modules#global-modules>

### 【InfrastructureModule 必须被加载，但并不要求排在 imports 数组第一位】

当前 `app.module.ts` 顶部有注释：

```text
InfrastructureModule ... 因此它必须最先注册
```

但 `@Module()` 旁边又写：

```text
注册顺序对 Nest 无影响
```

这两个说法需要区分。

更准确的通用理解是：

```text
InfrastructureModule
    ↓
必须进入整个 Application Graph
    ↓
@Global() 才能让其 exports
成为全局可解析 Provider
```

但是：

```text
imports: [
  InfrastructureModule,
  AuthModule,
  ...
]
```

中的数组位置不是 DI 初始化顺序声明。

Nest 根据 Module Graph 和 Provider Dependency Graph 解析依赖，而不是要求开发者通过数组先后手工安排：

```text
先 Config
再 Database
再 Redis
再 Service
```

因此更准确的描述应该是：

> **InfrastructureModule 必须被 Root Graph 加载一次，但不需要依靠“放在 imports 第一位”保证其他模块能够解析它。**

### 【AppModule 自己也可以拥有 Controller，但应保持 Application-level 语义】

当前：

```ts
controllers: [
  HealthController,
  MetricsController,
]
```

这两个 Controller 没有被塞进：

```text
ProjectsModule
IngestionModule
AnalyticsModule
```

因为它们表达的是应用级能力：

```text
HealthController
    → 整个 API Process 是否存活 / Ready

MetricsController
    → 整个 API Process 的 Prometheus 指标
```

因此当前设计可以理解为：

```text
业务域 HTTP API
    → 放 Feature Module

应用级 HTTP API
    → Root / Infrastructure-oriented Module
```

“Root Module 不放业务”是一条设计约定，而不是 Nest 的语法限制。

随着项目继续扩大，也可以把：

```text
Health
Observability
```

分别拆成独立 Module，再由 AppModule 只保留 imports。当前规模下直接挂 Root Module 是一种较轻量的选择。

### 【APP_INTERCEPTOR 属于应用级 Provider，不等于 Global Module】

当前：

```ts
providers: [
  {
    provide: APP_INTERCEPTOR,
    useClass: RequestIdInterceptor,
  },
]
```

这里又出现一种“全局”，但它和 `@Global()` 完全不同。

```text
@Global()
    ↓
控制 Module 中导出 Provider
是否对所有 Module 可见

APP_INTERCEPTOR
    ↓
控制一个 Interceptor
是否作用于整个 Application 的请求
```

`APP_INTERCEPTOR` 是 Nest 提供的 Application-level Provider Token。

通过 Module Provider 注册：

```ts
{
  provide: APP_INTERCEPTOR,
  useClass: RequestIdInterceptor,
}
```

相比直接在 `main.ts`：

```ts
app.useGlobalInterceptors(
  new RequestIdInterceptor(),
)
```

一个重要区别是它仍然位于 Nest DI Context 中，因此 Interceptor 自己可以正常使用依赖注入。

Nest 官方也明确说明，通过 `APP_INTERCEPTOR` 注册的 Interceptor 无论写在哪个 Module 都是全局生效；如果需要 DI，这是比在 Module 外手工 `new` 一个全局 Interceptor 更合适的方式。  
参考：<https://docs.nestjs.com/interceptors>

### 【当前项目的 Module Graph 可以重新画成两层关系】

只画 Module：

```text
                         AppModule
                             │
          ┌──────────────────┼──────────────────┐
          ↓                  ↓                  ↓
InfrastructureModule     AuthModule       IngestionModule
     @Global                 ↑                  │
          │                  │                  │ exports
          │            ProjectsModule           ↓
          │                  ↑             MetricsService
          │           ┌──────┴──────┐
          │           ↓             ↓
          │     AnalyticsModule  LabAuditsModule
          │
          └── API_CONFIG / DATABASE / REDIS
              对整个 Application Graph 可见
```

如果进一步把真正的 Provider 依赖叠上去：

```text
API_CONFIG
   ├──→ DATABASE
   └──→ REDIS

AuthModule
   └──→ MailerService
              ↑
              │
ProjectsService
   ├──→ DATABASE
   ├──→ API_CONFIG
   └──→ MailerService

AnalyticsService
   ├──→ DATABASE
   ├──→ REDIS
   └──→ ProjectsService

CustomSignalsService
   ├──→ DATABASE
   └──→ ProjectsService

LabAuditsService
   ├──→ DATABASE
   ├──→ API_CONFIG
   └──→ ProjectsService

IngestionService
   ├──→ DATABASE
   ├──→ REDIS
   ├──→ API_CONFIG
   ├──→ IngestionRateLimiter
   └──→ MetricsService

MetricsController
   ├──→ DATABASE
   └──→ MetricsService
```

现在就能清楚看到：

```text
Module Graph
    ↓
描述能力边界与 Provider 可见性

Provider Graph
    ↓
描述运行时对象真正的依赖关系
```

### 【脱离项目后形成通用 Module 装配知识框架】

任何 Nest 应用都可以用下面这套顺序分析：

```text
Root Module
    ↓
有哪些 Feature Module
    ↓
每个 Module providers 什么
    ↓
哪些 Provider exports
    ↓
哪些 Module imports 它
    ↓
形成 Module Graph
    ↓
确定 Provider Visibility
    ↓
DI Container
再根据 Token 构建 Provider Object Graph
```

因此 `@Module()` 中四个字段可以重新理解：

| 字段 | 真正的架构含义 |
| --- | --- |
| `imports` | 我依赖哪些其他能力边界 |
| `controllers` | 哪些 HTTP 入口属于当前能力边界 |
| `providers` | 当前边界内部由 Nest 管理哪些对象 |
| `exports` | 哪些对象构成当前 Module 的公共 API |

最终收敛成一句话：

> **Module Graph 不是目录关系图，而是 NestJS 用 `imports / exports` 建立的能力边界与 Provider 可见性图；Root Module 负责把这些能力装配成完整 Application，DI Container 再在这张图允许的范围内解析具体对象依赖。**


## 3. Provider 与 Dependency Injection 负责把对象创建和依赖关系交给 Nest 管理

这一层继续回答上一章留下的问题：

```text
Module Graph 已经告诉 Nest：
“哪些 Provider 在哪里、对谁可见”

下一步还需要回答：

这些 Provider 到底怎样被识别？
怎样创建？
怎样知道自己依赖谁？
Nest 又怎样把它们连接起来？
```

核心主线是：

```text
Provider
    ↓
Token
    ↓
Provider Definition
    ↓
constructor / inject
    ↓
DI Container
    ↓
Provider Object Graph
```

第一次出现的几个专业术语先统一：

| 术语 | 中文理解 |
| --- | --- |
| Provider | 提供者；交给 Nest 容器管理的对象或能力 |
| Dependency Injection（DI） | 依赖注入；对象只声明自己需要什么，由容器把依赖传进来 |
| DI Container | 依赖注入容器；负责记录、创建、查找和连接 Provider |
| Token | 依赖标识；Nest 在运行时用来定位某个 Provider 的“名字” |
| Provider Definition | Provider 定义；告诉 Nest 一个 Token 对应的实例怎样创建 |
| Provider Object Graph | Provider 对象依赖图；运行时各个 Provider 实例之间的依赖关系 |

### 【Provider 是交给 Nest DI Container 管理的对象或能力】

当前项目里这些对象都属于 Provider：

```text
ProjectsService
AnalyticsService
MetricsService
SessionGuard
API_CONFIG
DATABASE
REDIS
InfrastructureShutdown
```

它们虽然形态不同，但共同点是：

> **都由 Nest 的 DI Container 负责管理，而不是由业务代码在使用处手工创建。**

例如：

```ts
@Injectable()
export class ProjectsService {
  // ...
}
```

注册：

```ts
@Module({
  providers: [ProjectsService],
})
export class ProjectsModule {}
```

可以理解成：

```text
ProjectsService
      ↓
注册到当前 Module 的 DI Context
      ↓
Nest 负责创建实例
      ↓
Nest 负责把实例注入到需要它的对象
```

所以 Provider 不等于 Service。Service 只是最常见的一类 Provider。

### 【Dependency Injection 的核心是“声明依赖”，不是自己创建依赖】

没有 DI 时，一个对象可能自己创建所有依赖：

```ts
const config = loadApiConfig();
const database = createDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL);

const projects = new ProjectsService(database, config, mailer);
const analytics = new AnalyticsService(database, redis, projects);
```

随着依赖变多：

```text
AnalyticsService
    ↓
ProjectsService
    ↓
MailerService

AnalyticsService
    ↓
DATABASE
    ↓
API_CONFIG
```

业务代码就需要知道：

```text
每个对象怎么创建
创建顺序是什么
还要给它传哪些依赖
```

NestJS 的做法是：

```ts
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE)
    private readonly database: DatabaseHandle,

    @Inject(REDIS)
    private readonly redis: Redis,

    private readonly projects: ProjectsService,
  ) {}
}
```

`AnalyticsService` 只表达：

```text
我需要：

DATABASE
REDIS
ProjectsService
```

至于这些对象从哪里来、怎样创建，由 DI Container 负责。

因此 Dependency Injection（依赖注入）可以先理解成：

> **对象只声明“我依赖什么”，容器负责把真正的依赖实例传进来。**

### 【Token 是 Nest 在运行时识别 Provider 的依赖标识】

DI Container 中存在很多 Provider，Nest 必须能够区分：

```text
当前 constructor 要的是哪一个 Provider？
```

这就是 Token（依赖标识）的作用。

可以抽象成：

```text
Token
    ↓
在 DI Container 中查找
    ↓
Provider Definition
    ↓
Provider Instance
```

当前项目里既存在 Class Token（类作为依赖标识），也存在 Symbol Token（Symbol 类型依赖标识）。

### 【Class 本身可以作为 Token，@Injectable() 不是 Token】

例如：

```ts
@Injectable()
export class MetricsService {}
```

Module 中：

```ts
providers: [MetricsService]
```

这里真正作为 Token 的是：

```text
MetricsService 这个 Class 本身
```

因为 JavaScript 运行时中的 Class 仍然是一个真实存在的对象引用，Nest 可以直接把它作为 DI Container 中的 Key。

可以理解成：

```text
Token
MetricsService Class
      ↓
Provider
MetricsService
      ↓
Instance
MetricsService instance
```

因此：

```ts
constructor(
  private readonly metrics: MetricsService,
) {}
```

Nest 可以直接根据 Class Token 找到对应实例。

这里要特别区分：

```text
@Injectable()
    ≠ Provider Token
```

`@Injectable()` 是 Nest 的装饰器，用来标记这个 Class 参与依赖注入，并配合 TypeScript 的装饰器元数据让 Nest 能识别其构造函数依赖。

真正把它注册进 DI Container 的是：

```ts
providers: [MetricsService]
```

而真正作为依赖标识的是：

```text
MetricsService Class
```

所以可以记成：

```text
@Injectable()
    ↓
让 Class 参与 Nest DI，并提供构造函数依赖元数据

providers: [MetricsService]
    ↓
把它注册为 Provider

MetricsService Class
    ↓
作为 Runtime Token（运行时依赖标识）
```

### 【providers: [XXX] 是 useClass 的一种简写，但只在 Token 与 Class 相同时成立】

普通 Provider：

```ts
providers: [MetricsService]
```

可以理解成完整形式：

```ts
providers: [
  {
    provide: MetricsService,
    useClass: MetricsService,
  },
]
```

这里：

```text
provide
    → Provider 使用哪个 Token

useClass
    → Nest 实际实例化哪个 Class
```

因为：

```text
Token = MetricsService
Class = MetricsService
```

两者相同，所以可以简写：

```ts
providers: [MetricsService]
```

但如果：

```ts
{
  provide: PAYMENT_SERVICE,
  useClass: StripePaymentService,
}
```

就不能改成：

```ts
providers: [StripePaymentService]
```

因为两者表达的 Token 已经不同：

```text
原写法：

Token
PAYMENT_SERVICE
    ↓
StripePaymentService instance


简写后：

Token
StripePaymentService
    ↓
StripePaymentService instance
```

因此规则是：

> **只有 `provide` 和 `useClass` 指向同一个 Class 时，才能简写成 `providers: [Class]`。**

当前项目中一个不能简写的真实例子是：

```ts
{
  provide: APP_INTERCEPTOR,
  useClass: RequestIdInterceptor,
}
```

这里：

```text
Token
APP_INTERCEPTOR

实际 Class
RequestIdInterceptor
```

两者不同，所以必须保留完整 Provider Definition（Provider 定义）。

### 【Symbol Token 用于运行时没有合适 Class 作为标识的依赖】

当前项目：

```ts
export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');
export const API_CONFIG = Symbol('API_CONFIG');
```

这里的：

```text
DATABASE
REDIS
API_CONFIG
```

都是 Symbol Token（Symbol 类型依赖标识）。

原因是这些依赖不适合直接使用普通 Class Token：

```text
API_CONFIG
    → loadApiConfig() 返回的普通配置对象

DATABASE
    → createDatabase() 工厂函数创建出的 DatabaseHandle

REDIS
    → 项目希望用显式 REDIS Token 表达基础设施能力
```

这时就要区分：

```text
TypeScript Type
    → 编译阶段描述变量有什么属性和方法

Runtime Token
    → Nest 运行时真正用来查找 Provider
```

例如：

```ts
@Inject(DATABASE)
private readonly database: DatabaseHandle
```

实际同时表达两件事：

```text
DATABASE
    → Runtime Token
    → Nest 运行时通过它查找 Provider

DatabaseHandle
    → TypeScript Type
    → 编译器用它检查 database 的类型
```

因此 `@Inject(DATABASE)` 不是在声明 TypeScript 类型，而是在显式告诉 Nest：

> **这个构造函数参数应该从 Token = DATABASE 的 Provider 中取得。**

### 【Provider Definition 决定一个 Token 对应的实例怎样创建】

只有 Token 还不够。

Nest 还需要知道：

```text
找到这个 Token 以后，
它对应的实例应该怎么产生？
```

这就是 Provider Definition（Provider 定义）。

常见方式可以先建立整体认知：

```text
useClass
    → 通过 Class 创建实例

useValue
    → 直接提供一个现成值

useFactory
    → 调用一个函数创建实例

useExisting
    → 复用另一个已经存在的 Provider
```

当前项目主要使用：

```text
useClass
useFactory
```

其中 `useFactory` 可以理解为：

> **Factory Function（工厂函数）创建方式：Nest 调用这个函数，函数返回什么，就把什么作为这个 Token 对应的 Provider Instance（Provider 实例）。**

### 【当前 API_CONFIG 使用 useFactory 创建普通配置对象】

源码：

```ts
{
  provide: API_CONFIG,
  useFactory: (): ApiConfig =>
    loadApiConfig(),
}
```

可以逐步翻译：

```text
provide: API_CONFIG
    ↓
这个 Provider 的 Token 是 API_CONFIG

useFactory
    ↓
Nest 调用 loadApiConfig()

loadApiConfig()
    ↓
返回一个 ApiConfig 配置对象

最终：

API_CONFIG
    ↓
对应这个配置对象实例
```

因此 `useFactory` 并不是一套新的依赖注入机制，只是 Provider 的一种创建方式。

### 【useClass 通常不需要 inject，因为依赖写在 Class constructor 中】

例如：

```ts
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE)
    private readonly database: DatabaseHandle,

    @Inject(REDIS)
    private readonly redis: Redis,

    private readonly projects: ProjectsService,
  ) {}
}
```

如果它注册成：

```ts
providers: [AnalyticsService]
```

或者完整写成：

```ts
{
  provide: AnalyticsService,
  useClass: AnalyticsService,
}
```

通常都不需要再写：

```ts
inject: [
  DATABASE,
  REDIS,
  ProjectsService,
]
```

因为 Nest 在实例化 `AnalyticsService` 时，会读取 Class constructor（类构造函数）的依赖信息：

```text
AnalyticsService
    ↓
读取 constructor

@Inject(DATABASE)
    ↓
需要 DATABASE

@Inject(REDIS)
    ↓
需要 REDIS

projects: ProjectsService
    ↓
需要 ProjectsService Class Token
```

因此：

```text
useClass
    ↓
依赖主要写在 Class constructor
    ↓
Class 类型 + @Inject(Token)
    ↓
Nest 自动解析
```

这里 `@Injectable()` 与 `@Inject()` 分工不同：

```text
@Injectable()
    → 让当前 Class 参与 Nest DI，并携带可供框架读取的依赖元数据

@Inject(TOKEN)
    → 当某个参数不能只靠 Class Token 表达时，
      显式指定该参数要使用哪个 Runtime Token
```

### 【useFactory 没有 Class constructor，因此通过 inject 显式声明工厂函数依赖】

再看当前项目：

```ts
{
  provide: DATABASE,

  inject: [API_CONFIG],

  useFactory: (
    config: ApiConfig,
  ): DatabaseHandle =>
    createDatabase(
      config.DATABASE_URL,
    ),
}
```

这里的 `inject` 可以理解为：

> **工厂函数依赖列表：告诉 Nest 在执行 `useFactory` 之前，要先解析哪些 Provider。**

执行链：

```text
Nest 准备创建 DATABASE

        ↓

看到 inject: [API_CONFIG]

        ↓

先从 DI Container 解析 API_CONFIG

        ↓

得到配置对象

        ↓

把它作为 useFactory 第一个参数

        ↓

useFactory(config)

        ↓

createDatabase(config.DATABASE_URL)

        ↓

得到 DatabaseHandle

        ↓

把这个实例注册为 DATABASE
```

所以：

```text
inject
    → 声明 useFactory 需要哪些 Provider

useFactory 参数
    → 接收已经解析好的 Provider Instance
```

如果存在多个依赖：

```ts
{
  provide: SOME_PROVIDER,

  inject: [
    API_CONFIG,
    DATABASE,
  ],

  useFactory: (
    config: ApiConfig,
    database: DatabaseHandle,
  ) => {
    // ...
  },
}
```

它们按顺序对应：

```text
inject[0]
API_CONFIG
    ↓
useFactory 第 1 个参数
config

inject[1]
DATABASE
    ↓
useFactory 第 2 个参数
database
```

### 【useClass 与 useFactory 的依赖声明方式不同】

这一点可以直接形成规则：

| Provider 创建方式 | 依赖主要声明在哪里 | 是否通常需要 `inject: []` |
| --- | --- | --- |
| `useClass` | Class constructor（类构造函数） | 通常不需要 |
| `useFactory` | Provider Definition 中的 `inject` | 需要显式声明工厂函数依赖 |

可以压缩成：

```text
useClass
    ↓
Nest 要实例化一个 Class
    ↓
读取 Class constructor
    ↓
通过 Class Token / @Inject(Token)
解析依赖


useFactory
    ↓
Nest 要执行一个普通 Factory Function
    ↓
没有可供 Nest 直接分析的 Class constructor
    ↓
通过 inject: []
明确告诉 Nest 需要哪些依赖
```

这也是为什么当前项目：

```ts
providers: [
  IngestionService,
  IngestionRateLimiter,
  MetricsService,
]
```

不需要给每个 Service 额外写 `inject`，而：

```ts
{
  provide: DATABASE,
  inject: [API_CONFIG],
  useFactory: ...
}
```

需要显式写出 `inject`。

### 【当前项目的 API_CONFIG → DATABASE / REDIS 是一条真实 Provider Dependency Graph】

当前 `InfrastructureModule`：

```ts
{
  provide: API_CONFIG,
  useFactory: (): ApiConfig =>
    loadApiConfig(),
},
{
  provide: DATABASE,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): DatabaseHandle =>
    createDatabase(config.DATABASE_URL),
},
{
  provide: REDIS,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): Redis =>
    new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    }),
},
```

可以直接画成：

```text
loadApiConfig()
      ↓
  API_CONFIG
    ├────→ DATABASE
    └────→ REDIS
```

这里不是通过代码排列顺序表达：

```text
先创建 API_CONFIG
再创建 DATABASE
再创建 REDIS
```

而是通过依赖关系表达：

```text
DATABASE depends on API_CONFIG
REDIS depends on API_CONFIG
```

DI Container 根据 Dependency Graph（依赖图）解析这些关系。

因此 DI 思维的重点是：

```text
Dependency Graph
```

而不是：

```text
Execution List
```

### 【业务 Service 再继续消费基础设施 Provider】

当前 `AnalyticsService`：

```ts
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE)
    private readonly database: DatabaseHandle,

    @Inject(REDIS)
    private readonly redis: Redis,

    private readonly projects: ProjectsService,
  ) {}
}
```

它形成：

```text
DATABASE ───────┐
                │
REDIS ──────────┼──→ AnalyticsService
                │
ProjectsService ┘
```

再把 Infrastructure 层叠进来：

```text
                 API_CONFIG
                 /        \
                ↓          ↓
           DATABASE      REDIS
                \          /
                 \        /
                  ↓      ↓
               AnalyticsService
                     ↑
                     │
               ProjectsService
```

此时已经得到一张真正的 Provider Object Graph（Provider 对象依赖图）。

### 【Module Graph 决定去哪里找，Token 决定找谁】

上一章建立了：

```text
AnalyticsModule
    ↓ imports
ProjectsModule
```

本章建立了：

```text
AnalyticsService
    ↓
ProjectsService
```

两者在 DI Container 中连接起来：

```text
Module Graph
    ↓
决定当前 Provider 可以从哪些 Module 获得依赖

Token
    ↓
决定具体要找哪个 Provider

Provider Definition
    ↓
决定这个 Provider 怎样创建

constructor / inject
    ↓
声明依赖关系

DI Container
    ↓
解析并连接对象

Provider Object Graph
```

所以这一层最终可以收敛成：

> **Module 决定 Provider 在哪里、对谁可见；Token 决定要找哪个 Provider；Provider Definition 决定它怎样创建；Class Provider 的依赖通常从 constructor 与 `@Inject()` 中解析，Factory Provider 的依赖通过 `inject: []` 显式声明；最终由 DI Container 构建完整的 Provider Object Graph。**


### 【这一层可以压缩成六条判断规则】

阅读 Nest Provider 代码时，可以按下面顺序判断：

```text
1. 这个对象有没有注册进 providers？
   ↓
   决定它是否成为当前 Module 的 Provider

2. 它使用什么 Token？
   ↓
   Class / Symbol / String

3. Token 和实现 Class 是否相同？
   ↓
   相同：
   providers: [SomeService]
   可以作为 useClass 的简写

   不同：
   必须保留 provide + useClass

4. 如果是 useClass，依赖写在哪里？
   ↓
   constructor

   普通 Class 参数
   → 直接使用 Class Token

   @Inject(TOKEN)
   → 显式指定 Runtime Token

5. 如果是 useFactory，依赖写在哪里？
   ↓
   inject: [TOKEN]

   Nest 先解析 inject 中的 Provider，
   再按顺序传给 useFactory 参数

6. @Injectable() 做什么？
   ↓
   让 Class 参与 Nest DI 并提供构造函数依赖元数据，
   它本身既不是 Provider 注册动作，也不是 Provider Token
```

最容易混淆的三组概念可以最后再对照一次：

| 容易混淆的概念 | 正确区别 |
| --- | --- |
| `@Injectable()` vs `providers: []` | 前者让 Class 参与 DI；后者真正把它注册为 Provider |
| TypeScript Type vs DI Token | Type 给编译器做类型检查；Token 给 Nest 在运行时查找 Provider |
| `@Inject(TOKEN)` vs `inject: [TOKEN]` | 前者用于 Class constructor 参数；后者用于 Factory Provider 的工厂函数参数 |



## 4. Controller 与 Route Mapping 把 HTTP 请求映射到应用方法

这一层继续回答：

```text
Nest Application 已经完成 Module 与 Provider 装配以后，

一个 HTTP Request（HTTP 请求）进入 Fastify，
NestJS 怎样知道应该调用哪个 Controller 方法？
请求中的 URL、Body、Header 又怎样变成方法参数？
```

核心主线是：

```text
HTTP Request
    ↓
Fastify
    ↓
FastifyAdapter
    ↓
Nest Route Mapping（路由映射）
    ↓
Controller
    ↓
Parameter Decorator（参数装饰器）
提取 Param / Query / Body / Header
    ↓
Controller Method
    ↓
Service
    ↓
HTTP Response
```

### 【Controller 是一组相关 HTTP Endpoint 的入口边界】

当前 `IngestionController`：

```ts
@Controller('api/v3/ingest')
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
  ) {}

  @Post(':publicKey/envelopes')
  @HttpCode(202)
  ingestBatch(
    @Param('publicKey') publicKey: string,
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Ip() ip: string,
    @Req() request: FastifyRequest,
  ): Promise<IngestionResult> {
    const requestId =
      (request as FastifyRequest & {
        requestId?: string
      }).requestId ?? request.id;

    return this.ingestion.ingest(
      publicKey,
      body,
      origin,
      ip,
      requestId,
    );
  }
}
```

这里最先要理解的是：

```ts
@Controller('api/v3/ingest')
```

和：

```ts
@Post(':publicKey/envelopes')
```

两者共同组成最终 Route（路由）：

```text
POST /api/v3/ingest/:publicKey/envelopes
```

例如：

```text
POST /api/v3/ingest/bm_pk_123/envelopes
```

会映射到：

```text
IngestionController.ingestBatch()
```

因此 Controller（控制器）不能只理解成“一个处理请求的 Class”，更准确的是：

> **Controller 是一组相关 HTTP Endpoint（HTTP 接口端点）的入口边界。**

### 【@Controller 定义公共路径，方法装饰器定义具体路由】

`@Controller()` 是 Controller Decorator（控制器装饰器）。

例如：

```ts
@Controller('api/v3/ingest')
```

定义：

```text
Base Path（基础路径）
=
/api/v3/ingest
```

而：

```ts
@Post(':publicKey/envelopes')
```

定义：

```text
HTTP Method（HTTP 方法）
=
POST

Method Path（方法路径）
=
/:publicKey/envelopes
```

最终：

```text
Controller Base Path
+
Method Path

/api/v3/ingest
+
/:publicKey/envelopes

        ↓

POST /api/v3/ingest/:publicKey/envelopes
```

当前 `AnalyticsController` 也是同样逻辑：

```ts
@Controller(
  'api/v1/projects/:projectId/analytics',
)
export class AnalyticsController {
  @Get('overview')
  overview(...) {}

  @Get('performance')
  performance(...) {}

  @Get('routes')
  routes(...) {}
}
```

得到：

```text
GET /api/v1/projects/:projectId/analytics/overview

GET /api/v1/projects/:projectId/analytics/performance

GET /api/v1/projects/:projectId/analytics/routes
```

所以 Controller 的第一层职责是：

```text
把一组具有共同业务语义的 Route
组织在同一个 HTTP 边界中
```

### 【@Get / @Post / @Put 同时声明 HTTP Method 与方法路径】

这些属于 Route Handler Decorator（路由处理方法装饰器）。

例如：

```ts
@Controller('api/v1')
export class ProjectsController {
  @Get('projects')
  list(...) {}

  @Post('projects')
  create(...) {}
}
```

最终是：

```text
GET /api/v1/projects
    → list()

POST /api/v1/projects
    → create()
```

所以同一个 Path（路径）可以根据不同 HTTP Method 映射到不同 Controller Method（控制器方法）。

### 【装饰器通过 Metadata 描述路由，而不是直接调用 Fastify API】

Metadata（元数据）可以理解为：

> **附加在 Class 或 Method 上、供框架在运行时读取的描述信息。**

例如：

```ts
@Controller('api/v1')
```

记录：

```text
Controller Path = /api/v1
```

而：

```ts
@Get('projects')
```

记录：

```text
HTTP Method = GET
Method Path = /projects
```

在启动阶段：

```text
NestFactory.create(AppModule)
        ↓
扫描 Module
        ↓
找到 Controller
        ↓
读取 Controller Metadata
        ↓
读取 Method Metadata
        ↓
形成 Nest Route Definition（Nest 路由定义）
```

可以概念化成：

```text
Method
GET

Path
/api/v1/projects

Handler（请求处理函数）
ProjectsController.list
```

所以：

```text
@Controller / @Get / @Post
```

不是直接调用：

```ts
fastify.get(...)
fastify.post(...)
```

而是先建立 Nest 自己的 Route Metadata（路由元数据）。

### 【FastifyAdapter 再把 Nest Route 映射到底层 Fastify】

这一步与第一章的 FastifyAdapter 正式连接起来：

```text
@Controller / @Get / @Post
        ↓
Nest Route Metadata
        ↓
Nest Routing
        ↓
FastifyAdapter
        ↓
Fastify Route
        ↓
Node.js HTTP Server
```

因此可以理解为：

> **Nest 负责声明和组织 Route，FastifyAdapter 负责把这些 Route 映射到底层 Fastify 能真正执行的 HTTP 路由。**

### 【Parameter Decorator 从 HTTP Request 中提取方法参数】

Route 找到以后，还要解决：

```text
HTTP Request 中的数据
怎样传给 Controller Method？
```

Nest 使用 Parameter Decorator（参数装饰器）完成这件事。

当前项目常见：

| 装饰器 | 中文含义 | 数据来源 |
| --- | --- | --- |
| `@Param()` | 路径参数 | URL Path Parameter |
| `@Query()` | 查询参数 | Query String |
| `@Body()` | 请求体 | Request Body |
| `@Headers()` | 请求头 | HTTP Header |
| `@Ip()` | 客户端 IP | Request IP |
| `@Req()` | 完整请求对象 | FastifyRequest |
| `@Res()` | 完整响应对象 | FastifyReply |

例如 Ingestion：

```ts
ingestBatch(
  @Param('publicKey') publicKey: string,
  @Body() body: unknown,
  @Headers('origin') origin: string | undefined,
  @Ip() ip: string,
  @Req() request: FastifyRequest,
)
```

Nest 会分别从同一个 HTTP Request 中取出不同部分，再传给方法参数。

### 【@Param 从动态 URL 中提取 Path Parameter】

Route：

```ts
@Post(':publicKey/envelopes')
```

其中：

```text
:publicKey
```

是 Path Parameter（路径参数）。

请求：

```text
POST /api/v3/ingest/bm_pk_123/envelopes
```

经过：

```ts
@Param('publicKey')
publicKey: string
```

得到：

```text
publicKey = "bm_pk_123"
```

当前 Analytics 还存在多个路径参数：

```ts
@Controller(
  'api/v1/projects/:projectId/analytics',
)

@Get('traces/:traceId')
```

最终：

```text
GET
/api/v1/projects/:projectId/analytics/traces/:traceId
```

Controller：

```ts
@Param('projectId')
projectId: string,

@Param('traceId')
traceId: string,
```

例如请求：

```text
/api/v1/projects/p123/analytics/traces/t456
```

得到：

```text
projectId = "p123"
traceId   = "t456"
```

### 【@Query 获取 Query String，但获取不等于校验完成】

例如：

```text
GET
/api/v1/projects/p123/analytics/performance
?from=2026-09-01T00:00:00Z
&environment=production
```

Controller：

```ts
@Get('performance')
performance(
  @CurrentUser() user: AuthenticatedUser,
  @Param('projectId') projectId: string,
  @Query() query: unknown,
) {
  return this.analytics.performance(
    user.id,
    projectId,
    this.filters(query),
  );
}
```

`@Query()` 只负责把 Query String（查询字符串）解析后的数据取出来。

它并不代表：

```text
数据已经合法
数据已经满足业务约束
```

当前项目还会继续：

```text
query
    ↓
this.filters(query)
    ↓
Zod Validation（Zod 输入校验）
    ↓
AnalyticsFilters
```

这一部分后续在 Validation（输入校验）章节继续深入。

### 【@Body 获取 Request Body，当前项目用 unknown 表达“不可信输入”】

当前 `ProjectsController`：

```ts
@Post('projects')
create(
  @CurrentUser() user: AuthenticatedUser,
  @Body() body: unknown,
) {
  const input =
    parseBody(createProjectSchema, body);

  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

这里特意写：

```ts
body: unknown
```

而不是直接假设：

```ts
body: CreateProjectInput
```

表达的是：

```text
HTTP Request Body
    ↓
来自外部
    ↓
当前不可信
    ↓
unknown
    ↓
Validation
    ↓
可信业务输入
```

所以：

> **`@Body()` 只负责取得请求体，不代表请求体已经通过业务校验。**

### 【@Req 与 @Res 代表 Controller 开始接触 Fastify 特定 API】

大部分参数装饰器属于 Nest 的高层抽象：

```text
@Param()
@Query()
@Body()
@Headers()
@Ip()
```

而：

```ts
@Req() request: FastifyRequest
```

会直接拿到底层 Fastify Request（Fastify 请求对象）。

当前 IngestionController 使用它，是为了取得：

```ts
request.requestId
request.id
```

因此可以形成一条实践规则：

```text
能使用高层 Parameter Decorator 获取的数据
    ↓
优先使用 @Param / @Query / @Body / @Headers

确实需要底层 Platform 信息
    ↓
再使用 @Req / @Res
```

因为一旦代码直接使用：

```text
FastifyRequest
FastifyReply
```

这个 Controller 就明确知道当前 HTTP Platform 是 Fastify。

### 【@Res({ passthrough: true }) 允许直接修改 Fastify Reply，同时继续由 Nest 返回响应体】

当前 `AuthController.login()`：

```ts
@Post('login')
@HttpCode(200)
async login(
  @Body() body: unknown,

  @Res({ passthrough: true })
  reply: FastifyReply,
) {
  const input = parseBody(loginSchema, body);
  const session =
    await this.auth.login(
      input.email,
      input.password,
    );

  reply.setCookie(
    'bm_session',
    session.token,
    {
      httpOnly: true,
      secure:
        this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    },
  );

  return {
    user: session.user,
    csrfToken: session.user.csrfToken,
  };
}
```

这里同时做了两件事：

```text
FastifyReply
    ↓
setCookie()
    ↓
直接修改 Response Header

同时

return Object
    ↓
Nest 继续生成 Response Body
```

`passthrough: true` 可以理解为：

> **允许 Controller 访问底层 Response 做局部修改，但不完全接管响应，最终返回值仍交给 Nest 处理。**

### 【Controller return value 会继续经过 Nest 与 Fastify 生成 HTTP Response】

例如：

```ts
@Get('live')
live(): { status: 'ok' } {
  return {
    status: 'ok',
  };
}
```

可以理解成：

```text
Controller return value
    ↓
Nest Response Handling（响应处理）
    ↓
FastifyAdapter
    ↓
Fastify Reply
    ↓
HTTP Response
```

异步方法也是一样：

```text
Promise
    ↓
Nest 等待完成
    ↓
取得返回值
    ↓
生成 HTTP Response
```

因此普通 Controller 不需要自己调用：

```ts
reply.send(...)
```

### 【@HttpCode 与 @Header 负责补充 HTTP Response 语义】

当前项目：

```ts
@Post('register')
@HttpCode(202)
```

表示成功时返回：

```text
202 Accepted
```

而：

```ts
@Post('verify-email')
@HttpCode(204)
```

表示：

```text
204 No Content
```

`MetricsController`：

```ts
@Get('metrics')
@Header(
  'content-type',
  'text/plain; version=0.0.4; charset=utf-8',
)
```

明确把 Prometheus Metrics（Prometheus 指标）的 Content-Type 设置为文本格式。

所以 Controller 还负责一部分 HTTP Semantics（HTTP 语义）：

```text
HTTP Method
Path
Status Code
Response Header
Cookie
```

### 【Controller 的核心职责是把 HTTP World 转换成 Application World】

以创建项目为例：

```ts
@Post('projects')
create(
  @CurrentUser() user: AuthenticatedUser,
  @Body() body: unknown,
) {
  const input =
    parseBody(createProjectSchema, body);

  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

Controller 做的是：

```text
HTTP Request
    ↓
读取 User / Body
    ↓
校验和转换输入
    ↓
得到业务参数
userId / displayName / appName
    ↓
ProjectsService.create(...)
```

因此可以把 Controller 看成：

```text
HTTP World
    ↓
Controller Boundary（控制器边界）
    ↓
Application / Business World
```

Service 不应该再关心：

```text
@Body()
@Param()
FastifyRequest
Query String
```

而应该接收已经转换过的业务参数。

### 【当前项目整体采用 Thin Controller 的设计方向】

Thin Controller（薄控制器）是一种常见设计思想：

> **Controller 主要负责 HTTP 边界处理，不承载复杂业务流程。**

例如：

```ts
return this.ingestion.ingest(
  publicKey,
  body,
  origin,
  ip,
  requestId,
);
```

复杂逻辑继续进入：

```text
IngestionService
    ↓
Protocol Validation
Project Resolution
Origin Check
Rate Limit
Redaction
Database Transaction
Outbox
```

所以当前 Controller 的主要职责保持在：

```text
取 HTTP 数据
    ↓
做必要的输入适配
    ↓
调用 Service
```

`AnalyticsController` 稍微复杂一些，因为它还负责：

```text
Query String
    ↓
默认值
范围限制
格式转换
    ↓
AnalyticsFilters
```

但这仍然属于 HTTP 输入向业务输入模型转换的边界职责，而不是数据库查询或核心业务计算。

### 【@CurrentUser 是项目自定义的 Parameter Decorator】

当前多个 Controller 使用：

```ts
@CurrentUser()
user: AuthenticatedUser
```

它不是 Nest 内置装饰器，而是 Custom Parameter Decorator（自定义参数装饰器）。

它的思想与：

```text
@Body()
@Param()
@Query()
```

相同，都是：

```text
从 Request Context（请求上下文）
取出某一部分数据
```

只是 `@CurrentUser()` 读取的不是 URL 或 Body，而是认证流程提前写入的：

```text
request.auth
```

完整来源将在 SessionGuard（会话守卫）章节继续展开。

### 【@UseGuards 当前先理解为给 Route 附加请求处理规则】

例如：

```ts
@Controller(
  'api/v1/projects/:projectId/analytics',
)
@UseGuards(
  SessionGuard,
  CsrfGuard,
)
export class AnalyticsController {}
```

这里说明 Route Metadata 不只有：

```text
HTTP Method
Path
Handler
```

还可以附加：

```text
Guard
Interceptor
Pipe
...
```

因此 Nest 最终建立的 Route 更接近：

```text
Route
    ↓
HTTP Method
Path
Guard Metadata
Pipe Metadata
Interceptor Metadata
Handler
```

这些组件怎样按顺序执行，将在下一章 Request Lifecycle（请求生命周期）中继续分析。

### 【当前项目的 Controller 可以先分成三类】

第一类是公开接口：

```text
IngestionController
AuthController 中的 register / login 等
```

第二类是登录后的业务接口：

```text
ProjectsController
AnalyticsController
LabAuditsController
```

通常组合：

```text
CurrentUser
+
projectId
+
Body / Query
+
SessionGuard / CsrfGuard
```

第三类是应用级或基础设施接口：

```text
HealthController
MetricsController
```

它们描述的是整个 API Process（API 进程）的健康状态和观测能力，而不是某个具体业务域。

### 【脱离项目后可以用四层模型分析任何 Nest Controller】

以后看到一个 Nest Controller，可以先按四层拆：

```text
第一层：Route Definition（路由定义）
────────────────────
@Controller()
@Get()
@Post()
@Put()

第二层：Request Extraction（请求数据提取）
────────────────────
@Param()
@Query()
@Body()
@Headers()
@Req()

第三层：Cross-cutting Metadata（横向请求规则元数据）
────────────────────
@UseGuards()
@UseInterceptors()
@UsePipes()
...

第四层：Application Call（应用能力调用）
────────────────────
this.someService.xxx()
```

所以 Controller 可以收敛成：

```text
Controller
=
Route 定义
+
HTTP 输入提取
+
请求规则声明
+
Service 调用
```

### 【Controller 到 Fastify 的完整执行链路】

开发阶段：

```ts
@Controller('api/v1')

@Get('projects')

list(...)
```

启动阶段：

```text
NestFactory.create(AppModule)
        ↓
扫描 ProjectsModule
        ↓
发现 ProjectsController
        ↓
读取 @Controller Metadata
        ↓
读取 @Get Metadata
        ↓
形成 Nest Route Definition
        ↓
FastifyAdapter
        ↓
注册为 Fastify Route
```

运行阶段：

```text
GET /api/v1/projects
        ↓
Node.js HTTP Server
        ↓
Fastify
        ↓
Nest Request Lifecycle
        ↓
ProjectsController.list()
        ↓
ProjectsService.list()
        ↓
返回结果
        ↓
Nest Response Handling
        ↓
Fastify Reply
        ↓
HTTP Response
```

因此这一层最终可以收敛成：

> **Controller（控制器）是 NestJS 的 HTTP 边界：`@Controller()` 与 `@Get()` / `@Post()` 等装饰器负责声明 Route（路由），`@Param()` / `@Body()` / `@Query()` 等参数装饰器负责把 HTTP Request 转成方法参数，Controller 再调用 Service；Nest 最终通过 FastifyAdapter 把这些声明映射成 Fastify 真正执行的 HTTP Route。**


## 5. Request Lifecycle 描述一次请求从进入应用到返回响应的完整处理过程

前面已经建立了：

```text
Fastify
    ↓
Route Mapping
    ↓
Controller
    ↓
Service
```

但实际运行时，一个 HTTP Request（HTTP 请求）匹配到 Controller 之后，并不会立刻执行 Controller Method（控制器方法）。

NestJS 会让请求经过一组不同职责的处理阶段。这个整体过程称为 Request Lifecycle（请求生命周期）。

先建立通用主线：

```text
HTTP Request
    ↓
Middleware（中间件）
    ↓
Guard（守卫）
    ↓
Interceptor Before（拦截器前置阶段）
    ↓
Pipe（管道）
    ↓
Controller
    ↓
Service
    ↓
Interceptor After（拦截器后置阶段）
    ↓
Exception Filter（异常过滤器，发生未处理异常时）
    ↓
HTTP Response
```

这些组件并不是几个功能相似的 Hook，而是分别解决不同问题：

| 机制 | 中文理解 | 核心职责 |
| --- | --- | --- |
| Middleware | 中间件 | 请求进入 Nest 路由处理前需要统一做什么 |
| Guard | 守卫 | 当前请求是否允许继续执行 |
| Interceptor | 拦截器 | Controller 执行前后需要统一包裹什么逻辑 |
| Pipe | 管道 | Controller 参数是否合法、是否需要转换 |
| Exception Filter | 异常过滤器 | 未处理异常怎样转换成 HTTP Response |

Nest 官方 Request Lifecycle 文档说明，请求阶段整体按照 Middleware → Guard → Interceptor → Pipe → Controller Handler 的方向进入；Interceptor 在响应阶段以相反方向展开。  
参考：<https://docs.nestjs.com/faq/request-lifecycle>

### 【通用 Nest Request Lifecycle 与当前项目真实链路需要分开理解】

NestJS 框架提供的完整机制包括：

```text
Middleware
Guard
Interceptor
Pipe
Controller
Exception Filter
```

但具体项目不一定会同时使用所有机制。

从当前 `browser-monitor/platform/apps/api` 源码看，主要实际使用的是：

```text
Fastify Plugin
    ↓
Guard
    ↓
Global Interceptor
    ↓
Parameter Decorator
    ↓
Controller
    ↓
手动 Zod Validation
    ↓
Service
    ↓
Global Interceptor 后置逻辑
    ↓
Nest 默认异常处理
```

当前 API 没有看到自己注册的 Nest Pipe（管道）或自定义 Exception Filter（异常过滤器）；输入校验主要通过 Controller 内部调用 `parseBody()` 完成。

因此学习时要始终区分：

```text
NestJS 框架能够提供什么
```

和：

```text
当前 browser-monitor API 实际选择使用了什么
```

### 【先用 POST /api/v1/projects 走一遍当前项目真实请求链】

当前 `ProjectsController`：

```ts
@Controller('api/v1')
@UseGuards(SessionGuard, CsrfGuard)
export class ProjectsController {
  @Post('projects')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    const input = parseBody(
      createProjectSchema,
      body,
    );

    return this.projects.create(
      user.id,
      input.displayName,
      input.appName,
    );
  }
}
```

对于：

```text
POST /api/v1/projects
```

当前项目的主要执行链可以先画成：

```text
POST /api/v1/projects
        ↓
Fastify
        ↓
Nest 已经匹配到 ProjectsController.create()
        ↓
SessionGuard
        ↓
CsrfGuard
        ↓
RequestIdInterceptor 前置逻辑
        ↓
@CurrentUser() / @Body()
解析 Controller 参数
        ↓
ProjectsController.create()
        ↓
parseBody()
        ↓
ProjectsService.create()
        ↓
返回结果
        ↓
RequestIdInterceptor finalize()
        ↓
HTTP Response
```

这条链是理解当前 API Request Lifecycle 的主线。

### 【Guard 决定当前请求能不能继续执行】

Guard（守卫）的核心职责是：

> **根据当前请求上下文决定是否允许继续执行后面的 Controller。**

Nest Guard 通常实现：

```ts
CanActivate
```

当前 `SessionGuard`：

```ts
@Injectable()
export class SessionGuard
  implements CanActivate {

  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
  ) {}

  async canActivate(
    context: ExecutionContext,
  ): Promise<boolean> {
    // ...
  }
}
```

这里第一次出现的 ExecutionContext（执行上下文）可以理解为：

> **Nest 提供给 Guard、Interceptor、Custom Decorator 等框架组件的当前执行环境。**

通过它可以取得：

```text
当前 HTTP Request
当前 HTTP Response
当前 Controller
当前 Handler
```

当前代码：

```ts
const request =
  context
    .switchToHttp()
    .getRequest<FastifyRequest>();
```

可以翻译成：

```text
ExecutionContext
    ↓
切换到 HTTP 执行上下文
    ↓
取得底层 Fastify Request
```

### 【SessionGuard 负责 Authentication，也就是确认“你是谁”】

当前源码：

```ts
@Injectable()
export class SessionGuard
  implements CanActivate {

  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
  ) {}

  async canActivate(
    context: ExecutionContext,
  ): Promise<boolean> {

    const request =
      context
        .switchToHttp()
        .getRequest<FastifyRequest>();

    const token =
      request.cookies?.bm_session;

    if (!token) {
      throw new UnauthorizedException({
        code: 'authentication_required',
      });
    }

    const session =
      await this.redis.get(
        `session:${hashToken(token)}`,
      );

    if (!session) {
      throw new UnauthorizedException({
        code: 'session_expired',
      });
    }

    (
      request as AuthenticatedRequest
    ).auth =
      JSON.parse(session) as AuthenticatedUser;

    return true;
  }
}
```

Authentication（身份认证）解决的是：

```text
这个请求是谁发出的？
```

完整执行链：

```text
Request
    ↓
读取 bm_session Cookie
    ↓
没有 Cookie
    → UnauthorizedException
    → 401
    ↓
存在 Cookie
    ↓
hashToken(token)
    ↓
Redis 查询 Session
    ↓
Session 不存在
    → UnauthorizedException
    → 401
    ↓
Session 存在
    ↓
解析 AuthenticatedUser
    ↓
写入 request.auth
    ↓
return true
    ↓
请求继续
```

这里还没有判断：

```text
这个用户是否有权限操作某个 projectId
```

那属于更具体的 Authorization（授权），当前项目主要在 `ProjectsService.requireAccess()`、`requireOwner()` 等业务方法中处理。

所以：

```text
Authentication
    → 你是谁

Authorization
    → 你是否可以操作这个具体资源
```

需要分开理解。

### 【Guard 不只可以做判断，也可以给 Request Context 补充数据】

SessionGuard 不是只执行：

```ts
return true;
```

它还执行：

```ts
request.auth = ...
```

于是 Request 在生命周期中被补充了新的信息：

```text
原始 Request

{
  cookies,
  headers,
  ...
}

        ↓ SessionGuard

Authenticated Request

{
  cookies,
  headers,
  auth: {
    id,
    email,
    displayName,
    sessionId,
    csrfToken
  }
}
```

这里形成了 Request Context（请求上下文）。

Request Context 可以理解为：

> **一次请求在处理过程中逐步积累、供后续组件共享的上下文信息。**

后面的 CsrfGuard 和 `@CurrentUser()` 都会继续消费这个上下文。

### 【SessionGuard 与 CsrfGuard 存在明确的顺序依赖】

当前：

```ts
@UseGuards(
  SessionGuard,
  CsrfGuard,
)
```

这两个 Guard 不是两个完全独立的检查。

`CsrfGuard`：

```ts
@Injectable()
export class CsrfGuard
  implements CanActivate {

  canActivate(
    context: ExecutionContext,
  ): boolean {

    const request =
      context
        .switchToHttp()
        .getRequest<AuthenticatedRequest>();

    if (
      ['GET', 'HEAD', 'OPTIONS']
        .includes(request.method)
    ) {
      return true;
    }

    const supplied =
      request.headers['x-csrf-token'];

    if (
      typeof supplied !== 'string' ||
      supplied !== request.auth.csrfToken
    ) {
      throw new ForbiddenException({
        code: 'invalid_csrf_token',
      });
    }

    return true;
  }
}
```

它依赖：

```ts
request.auth.csrfToken
```

而：

```text
request.auth
```

是前面的 `SessionGuard` 写进去的。

因此真实关系是：

```text
SessionGuard
    ↓
验证 Session
    ↓
request.auth = AuthenticatedUser
    ↓
CsrfGuard
    ↓
读取 request.auth.csrfToken
    ↓
校验 x-csrf-token
```

如果顺序反过来：

```text
CsrfGuard
    ↓
request.auth 尚未建立
```

后面的逻辑就无法成立。

因此这里形成了一条 Request Context Dependency（请求上下文依赖）：

```text
SessionGuard
    → 生产 request.auth

CsrfGuard
    → 消费 request.auth
```

Nest 对同一级别的 Guard 按绑定顺序执行，所以当前：

```ts
@UseGuards(SessionGuard, CsrfGuard)
```

的顺序本身具有业务意义。

### 【GET 请求同样进入 CsrfGuard，但会根据 Method 直接放行】

因为：

```ts
@UseGuards(
  SessionGuard,
  CsrfGuard,
)
```

声明在整个 Controller 上，所以：

```ts
@Get('projects')
```

也会执行两个 Guard。

但 `CsrfGuard`：

```ts
if (
  ['GET', 'HEAD', 'OPTIONS']
    .includes(request.method)
) {
  return true;
}
```

因此：

```text
GET /projects
    ↓
SessionGuard
    ↓
必须存在合法 Session
    ↓
CsrfGuard
    ↓
发现是 GET
    ↓
直接通过
```

而：

```text
POST /projects
    ↓
SessionGuard
    ↓
必须存在合法 Session
    ↓
CsrfGuard
    ↓
校验 x-csrf-token
```

这里可以看出：

```text
Authentication
    → 所有受保护请求都需要

CSRF Validation
    → 主要保护会产生状态修改的请求
```

### 【Guard 拒绝请求后，后面的正常 Controller 流程不会继续执行】

Guard 的本质是：

```text
Request
    ↓
canActivate()
    ↓
当前请求是否允许继续？
```

当前项目不是简单：

```ts
return false;
```

而是主要直接抛出 HTTP Exception：

```ts
throw new UnauthorizedException(...)
```

或者：

```ts
throw new ForbiddenException(...)
```

此时：

```text
Guard
    ↓
抛异常
    ↓
正常请求链停止
    ↓
后续 Interceptor / Pipe / Controller
不会进入正常执行流程
    ↓
异常进入 Nest Exception Handling
```

这也是为什么 Guard 非常适合：

```text
Authentication
Authorization
请求是否允许继续
```

而不适合承担 Controller 执行后的响应包装逻辑。

### 【RequestIdInterceptor 是 Global Interceptor，但执行位置仍然在 Guard 之后】

当前 `AppModule`：

```ts
providers: [
  {
    provide: APP_INTERCEPTOR,
    useClass: RequestIdInterceptor,
  },
]
```

这里：

```text
APP_INTERCEPTOR
```

是 Nest 的 Application-level Provider Token（应用级 Provider 标识），表示：

```text
RequestIdInterceptor
作为 Global Interceptor（全局拦截器）
作用于整个 Application 的 Controller 请求
```

但是：

```text
Global
```

并不意味着：

```text
一定是 HTTP 请求进入应用后第一个执行的组件
```

Nest Request Lifecycle 中：

```text
Guard
    ↓
Interceptor
```

所以当前受保护业务接口实际是：

```text
SessionGuard
    ↓
CsrfGuard
    ↓
RequestIdInterceptor
```

而不是：

```text
RequestIdInterceptor
    ↓
SessionGuard
    ↓
CsrfGuard
```

这意味着：

> **如果请求在 SessionGuard 或 CsrfGuard 阶段就被拒绝，当前 RequestIdInterceptor 还没有进入执行。**

因此源码注释中：

```text
所有请求生成 / 透传 x-request-id
并在响应完成时打一条日志
```

从严格的 Request Lifecycle 来看，需要增加边界说明。

更准确应该理解成：

```text
所有成功进入 Interceptor 阶段的 Nest Route 请求
会生成 / 透传 requestId，并记录完成日志
```

如果目标要求：

```text
401
403
甚至更早阶段失败的请求

也必须拥有统一 Request ID
```

那么 Request ID 创建逻辑通常需要放到生命周期更靠前的位置，例如：

```text
Fastify Hook
或者
Middleware
```

这不是说明当前实现一定错误，而是说明：

```text
Interceptor 适合 Handler Lifecycle Observability
Middleware / Fastify Hook 更适合更完整的 HTTP Request Observability
```

需要根据目标选择位置。

### 【Interceptor 是包住 Controller 执行过程的横向机制】

Interceptor（拦截器）与 Guard 的思路不同。

Guard 回答：

```text
能不能继续？
```

Interceptor 回答：

```text
Controller 执行前后，我是否需要统一做一些事情？
```

当前：

```ts
@Injectable()
export class RequestIdInterceptor
  implements NestInterceptor {

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    // ...
  }
}
```

这里涉及几个术语。

NestInterceptor（Nest 拦截器接口）表示：

> **这个 Class 可以参与 Controller 前后的请求执行流程。**

CallHandler（调用处理器）可以先理解成：

> **代表“后续 Controller 执行链”的对象。**

最关键的方法：

```ts
next.handle()
```

可以理解为：

```text
继续执行后面的请求处理流程
```

它返回 Observable（可观察流）。

Observable 是 RxJS 提供的异步数据流抽象。当前阶段不需要深入 RxJS，只需要知道：

```text
next.handle()
    ↓
代表后续 Controller / Service 执行产生的异步结果
```

### 【Interceptor 使用“包裹”模型同时执行前置和后置逻辑】

当前源码：

```ts
intercept(
  context: ExecutionContext,
  next: CallHandler,
): Observable<unknown> {

  const startedAt = performance.now();

  // 其他前置逻辑

  return next.handle().pipe(
    finalize(() => {
      // 后置逻辑
    }),
  );
}
```

可以理解成：

```text
Interceptor Before
      ↓
next.handle()
      ↓
Controller
      ↓
Service
      ↓
Controller return
      ↓
Interceptor After
```

因此 Interceptor 不只是：

```text
请求前执行一个 Hook
```

而是：

> **包裹整个 Controller Handler 的执行过程。**

这非常适合：

```text
Logging（日志）
Duration（耗时）
Tracing（链路追踪）
Response Transformation（响应转换）
Caching（缓存）
```

等横向能力。

### 【RequestIdInterceptor 的前置阶段建立 Request ID 和计时上下文】

当前：

```ts
const request =
  context
    .switchToHttp()
    .getRequest<FastifyRequest>();

const response =
  context
    .switchToHttp()
    .getResponse<FastifyReply>();
```

先取得当前：

```text
Fastify Request
Fastify Reply
```

然后：

```ts
const incoming =
  request.headers['x-request-id'];
```

读取客户端可能已经提供的：

```text
x-request-id
```

接着：

```ts
const requestId =
  typeof incoming === 'string' &&
  incoming.length <= 128
    ? incoming
    : randomUUID();
```

逻辑：

```text
客户端传入合法 requestId
    ↓
继续沿用

没有传入或格式不满足要求
    ↓
randomUUID()
    ↓
生成新的 requestId
```

随后：

```ts
(
  request as FastifyRequest & {
    requestId: string
  }
).requestId = requestId;
```

将它放入 Request Context。

再：

```ts
response.header(
  'x-request-id',
  requestId,
);
```

把同一个 Request ID 返回给客户端。

形成：

```text
Incoming Request
x-request-id: abc
        ↓
request.requestId = abc
        ↓
Controller / Service
        ↓
Response
x-request-id: abc
```

这种能力称为 Request Correlation（请求关联）：

> **使用一个统一标识把客户端请求、服务端日志、响应以及可能的下游调用关联起来。**

### 【finalize 在请求执行结束后记录访问日志】

当前：

```ts
return next.handle().pipe(
  finalize(() => {
    process.stdout.write(
      `${JSON.stringify({
        level:
          response.statusCode >= 500
            ? 'error'
            : 'info',
        message: 'request_completed',
        requestId,
        method: request.method,
        path:
          request.url.split('?', 1)[0],
        statusCode: response.statusCode,
        durationMs:
          Math.round(
            (performance.now() - startedAt) * 100,
          ) / 100,
      })}\n`,
    );
  }),
);
```

`finalize()` 来自 RxJS。

当前阶段可以理解为：

> **后续 Observable 结束时执行的收尾逻辑，不论正常完成还是异常终止。**

因此只要请求已经进入这个 Interceptor：

```text
Interceptor Before
    ↓
startedAt
    ↓
next.handle()
    ↓
Controller / Service
    ↓
正常完成或发生异常
    ↓
finalize()
    ↓
记录 request_completed
```

这使它适合记录：

```text
method
path
statusCode
durationMs
requestId
```

### 【请求日志主动去掉 Query String，避免把敏感信息写入日志】

当前源码专门写：

```ts
path:
  request.url.split('?', 1)[0]
```

并注明：

```text
Query strings can contain reset tokens
or dashboard filters
```

例如：

```text
/api/reset-password?token=SECRET
```

如果直接记录完整 URL：

```text
token=SECRET
```

就可能进入日志系统。

当前做法只记录：

```text
/api/reset-password
```

而不记录：

```text
?token=SECRET
```

这里体现一个可以脱离项目复用的原则：

> **Observability（可观测性）不能为了方便排查问题而无条件记录请求中的敏感输入。**

日志设计本身也是安全设计的一部分。

### 【@CurrentUser 在 Guard 之后消费 request.auth】

当前项目定义：

```ts
export const CurrentUser =
  createParamDecorator(
    (
      _data: unknown,
      context: ExecutionContext,
    ): AuthenticatedUser =>
      context
        .switchToHttp()
        .getRequest<AuthenticatedRequest>()
        .auth,
  );
```

`createParamDecorator()` 用来创建 Custom Parameter Decorator（自定义参数装饰器）。

它最终允许 Controller 写：

```ts
@CurrentUser()
user: AuthenticatedUser
```

本质执行：

```text
Request Context
    ↓
request.auth
    ↓
@CurrentUser()
    ↓
Controller 参数 user
```

之所以此时能够取得：

```text
request.auth
```

是因为生命周期前面已经发生：

```text
SessionGuard
    ↓
request.auth = AuthenticatedUser
    ↓
CsrfGuard
    ↓
Interceptor
    ↓
Controller 参数解析
    ↓
@CurrentUser()
读取 request.auth
```

因此：

```text
SessionGuard
    → Request Context Producer（上下文生产者）

@CurrentUser()
    → Request Context Consumer（上下文消费者）
```

这说明 Request Lifecycle 不只是组件按顺序执行，还可能存在上下文数据在不同阶段之间传递。

### 【Nest 通用 Pipe 负责参数校验与转换，但当前项目主要没有采用这一方案】

Nest Request Lifecycle 中还存在 Pipe（管道）。

Pipe 主要解决：

```text
Validation（参数校验）
Transformation（参数转换）
```

典型思想：

```text
原始 HTTP 参数
    ↓
Pipe
    ↓
校验 / 转换
    ↓
Controller Parameter
```

但当前 browser-monitor API 主要采用：

```ts
@Body()
body: unknown
```

然后 Controller 内部：

```ts
const input =
  parseBody(
    createProjectSchema,
    body,
  );
```

`parseBody()`：

```ts
export function parseBody<T>(
  schema: ZodType<T>,
  value: unknown,
): T {
  const parsed =
    schema.safeParse(value);

  if (!parsed.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      message:
        'Request validation failed.',
      issues:
        parsed.error.issues.map(
          (issue) => ({
            path:
              issue.path.join('.'),
            message:
              issue.message,
          }),
        ),
    });
  }

  return parsed.data;
}
```

所以当前真实链路是：

```text
@Body()
    ↓
取得 unknown
    ↓
Controller
    ↓
parseBody()
    ↓
Zod Schema
    ↓
合法数据
```

而不是：

```text
@Body()
    ↓
Nest Validation Pipe
    ↓
Controller
```

这两种方式都可以建立输入校验边界，但架构位置不同。

后续 Validation（输入校验）章节再专门比较。

### 【Controller 与 Service 是生命周期中的核心业务执行阶段】

例如：

```ts
@Post('projects')
create(...) {
  const input = ...;

  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

Controller 主要负责：

```text
HTTP 输入
    ↓
提取
校验
转换
    ↓
业务参数
```

Service 继续负责：

```text
业务规则
权限判断
数据库操作
事务
外部能力调用
```

因此：

```text
Controller
    ↓
Service
```

虽然经常出现在 Request Lifecycle 图中，但要注意：

```text
Controller
    → Nest Framework 的 HTTP Handler

Service
    → 当前应用自己定义的业务 Provider
```

Service 并不是 Nest Request Lifecycle 的一个固定 Hook 类型，而是由 Controller 主动调用的业务层对象。

### 【Exception 可以在 Guard、Validation、Controller、Service 等多个阶段产生】

当前项目已经存在：

Guard：

```ts
throw new UnauthorizedException(...)
```

```ts
throw new ForbiddenException(...)
```

Validation：

```ts
throw new BadRequestException(...)
```

Service 中还会使用：

```text
NotFoundException
ConflictException
UnprocessableEntityException
HttpException
...
```

因此异常来源可以是：

```text
Guard
Validation
Controller
Service
Database
其他 Provider
```

一旦出现没有在业务代码里捕获并处理的异常：

```text
当前正常执行链停止
    ↓
进入 Nest Exception Handling（异常处理）
```

### 【Exception Filter 负责把未处理异常映射成最终 HTTP Response】

Exception Filter（异常过滤器）是 Nest 的异常处理扩展机制。

它解决的是：

```text
发生异常以后
最终应该返回什么 HTTP Status
什么 Response Body
怎样记录或统一格式
```

通用关系：

```text
Guard / Pipe / Controller / Service
        ↓
      throw
        ↓
Exception Handling
        ↓
Exception Filter
        ↓
HTTP Response
```

当前 `browser-monitor/platform/apps/api` 中没有看到自己注册：

```ts
@Catch()
class XxxFilter
```

或者：

```text
APP_FILTER
```

因此当前：

```ts
throw new BadRequestException(...)
throw new ForbiddenException(...)
throw new UnauthorizedException(...)
```

主要交给 Nest 自带的异常处理层。

例如：

```text
UnauthorizedException
    ↓
Nest Exception Handling
    ↓
401 HTTP Response
```

而不会让整个 Node.js Process 因为一次普通业务异常退出。

### 【当前 POST /api/v1/projects 的完整链路可以重新画出来】

结合真实源码：

```text
Browser
   ↓
HTTP Request
   ↓
Fastify
   ↓
@fastify/cookie
Cookie 已经可以从 request.cookies 读取
   ↓
Nest Route Match
   ↓
找到 ProjectsController.create
   ↓
SessionGuard
   │
   ├─ bm_session 不存在
   │      ↓
   │     401
   │
   ├─ Redis Session 不存在
   │      ↓
   │     401
   │
   └─ Session 有效
          ↓
      request.auth = user
          ↓
CsrfGuard
   │
   ├─ x-csrf-token 不正确
   │      ↓
   │     403
   │
   └─ 正确
          ↓
RequestIdInterceptor Before
   ↓
读取 / 生成 requestId
   ↓
response.header('x-request-id', ...)
   ↓
记录 startedAt
   ↓
next.handle()
   ↓
@CurrentUser()
   ↓
读取 request.auth
   ↓
@Body()
   ↓
读取 Request Body
   ↓
ProjectsController.create()
   ↓
parseBody(createProjectSchema, body)
   │
   ├─ Zod 校验失败
   │      ↓
   │     BadRequestException
   │      ↓
   │     400
   │
   └─ 校验成功
          ↓
ProjectsService.create()
   ↓
业务规则 / Database Transaction
   ↓
返回结果
   ↓
RequestIdInterceptor finalize()
   ↓
记录 method / path / statusCode / durationMs
   ↓
Nest Response Handling
   ↓
Fastify Reply
   ↓
HTTP Response
```

这已经非常接近当前 API 一次登录态业务请求的真实处理过程。

### 【Ingestion Route 的 Request Lifecycle 与后台业务 Route 不同】

再看：

```text
POST /api/v3/ingest/:publicKey/envelopes
```

对应：

```ts
@Controller('api/v3/ingest')
export class IngestionController {
  @Post(':publicKey/envelopes')
  @HttpCode(202)
  ingestBatch(...) {
    // ...
  }
}
```

这里没有：

```ts
@UseGuards(
  SessionGuard,
  CsrfGuard,
)
```

因此它不会经过后台管理接口的：

```text
SessionGuard
CsrfGuard
```

主要链路变成：

```text
Browser SDK
    ↓
Fastify
    ↓
Nest Route Match
    ↓
RequestIdInterceptor
    ↓
@Param / @Body / @Headers / @Ip / @Req
    ↓
IngestionController
    ↓
IngestionService
    ↓
Protocol Validation
    ↓
Project Resolution
    ↓
Origin Validation
    ↓
Rate Limit
    ↓
数据处理与写入
    ↓
Response
```

这是因为：

```text
Projects / Analytics / LabAudits
    → 后台登录用户操作

Ingestion
    → Browser SDK 公共采集入口
```

它们采用的安全模型不同。

因此：

> **同一个 Nest Application 中，不同 Route 可以拥有不同的 Request Lifecycle。**

Guard、Interceptor、Pipe 等机制通过 Controller / Route Metadata 灵活组合，而不是要求所有接口使用完全相同的处理链。

### 【Middleware、Guard、Interceptor、Pipe、Exception Filter 要根据职责选择】

这些机制最容易混淆，可以先按照“它在回答什么问题”判断：

```text
需要在路由处理前统一操作 Request / Response
    ↓
Middleware

需要决定“这个请求允许继续吗”
    ↓
Guard

需要包住 Controller 前后
    ↓
Interceptor

需要校验 / 转换某个 Controller 参数
    ↓
Pipe

需要把未处理异常统一变成 Response
    ↓
Exception Filter
```

对应表：

| 机制 | 最适合解决的问题 | 常见例子 |
| --- | --- | --- |
| Middleware | 路由处理前的通用请求预处理 | Request Context、兼容 Express/Fastify 中间件 |
| Guard | 是否允许请求继续 | 登录认证、角色权限 |
| Interceptor | Controller 前后统一逻辑 | 日志、耗时、Trace、响应包装 |
| Pipe | 参数校验与转换 | DTO Validation、字符串转数字 |
| Exception Filter | 异常响应 | 统一错误结构、异常日志 |

关键不是：

```text
这些组件都能写代码，
放在哪里都一样
```

而是：

> **框架把不同职责安排在不同生命周期位置，正确选择位置可以让代码边界更清晰。**

### 【Fastify Plugin 不属于 Nest Request Lifecycle，需要放到更外层理解】

当前：

```ts
app.register(cookie)
```

属于：

```text
Fastify Plugin System
```

而：

```ts
@UseGuards(...)
```

属于：

```text
Nest Request Lifecycle
```

因此完整层次应该是：

```text
HTTP Request
    ↓
Node.js HTTP Server
    ↓
Fastify Platform
    ↓
Fastify Plugin / Hook
例如 Cookie Parsing
    ↓
Nest Application
    ↓
Middleware
    ↓
Guard
    ↓
Interceptor
    ↓
Pipe / Parameter Resolution
    ↓
Controller
    ↓
Service
```

也就是说：

> **Nest Request Lifecycle 是运行在底层 HTTP Platform 之上的应用级生命周期，它并不包含所有 Fastify 自己的 Plugin / Hook 阶段。**

这与第一章建立的：

```text
Fastify
    → HTTP Platform

NestJS
    → Application Framework
```

完全一致。

### 【RequestIdInterceptor 的位置适合 Handler 级观测，但不是最早的请求观测位置】

现在可以更准确地分析当前设计。

`RequestIdInterceptor` 很适合：

```text
Controller / Service 执行耗时
Handler 完成日志
Response Header
Controller 请求链 Trace Context
```

因为：

```text
Interceptor
    ↓
包裹 Controller Handler
```

但是如果目标变成：

```text
任何进入 API 的 HTTP Request
包括：

401
403
Guard 阶段失败
更早阶段失败

都必须拥有 Request ID 和统一日志
```

那么：

```text
Interceptor
```

的位置就偏晚。

更靠前的：

```text
Fastify Hook
或
Middleware
```

通常更适合这一目标。

因此并不是：

```text
Interceptor 一定优于 Middleware
```

或者：

```text
Middleware 一定优于 Interceptor
```

而是要看需要覆盖哪个生命周期范围：

```text
Controller Handler 生命周期
    → Interceptor

更完整的 HTTP Request 生命周期
    → Middleware / Fastify Hook
```

### 【脱离当前项目后形成通用 Request Lifecycle 心智模型】

以后分析任何 NestJS API，都可以先画：

```text
HTTP Platform
    ↓
Middleware
    ↓
Guard
    ↓
Interceptor Before
    ↓
Pipe / Parameter Resolution
    ↓
Controller
    ↓
Business Service
    ↓
Interceptor After
    ↓
Exception Handling
    ↓
Exception Filter
    ↓
HTTP Response
```

然后逐个问题检查：

```text
Middleware
    → 有没有全局请求预处理？

Guard
    → 谁负责认证和授权？

Interceptor
    → 有没有日志、Tracing、响应包装？

Pipe
    → 输入校验在哪里？

Controller
    → HTTP 参数怎样转换成业务参数？

Service
    → 业务规则在哪里？

Exception Filter
    → 错误响应怎样统一？
```

当前 browser-monitor API 实际更接近：

```text
Fastify Plugin
    ↓
SessionGuard
    ↓
CsrfGuard
    ↓
RequestIdInterceptor
    ↓
Custom Parameter Decorator
    ↓
Controller
    ↓
手动 Zod Validation
    ↓
Service
    ↓
RequestIdInterceptor finalize
    ↓
Nest 默认 Exception Handling
```

### 【当前项目最重要的是“请求上下文逐步建立并被后续阶段消费”】

把最关键的上下文关系单独画出来：

```text
SessionGuard
    ↓
验证 Cookie + Redis Session
    ↓
request.auth = user
    ↓
CsrfGuard
    ↓
读取 request.auth.csrfToken
    ↓
RequestIdInterceptor
    ↓
request.requestId = requestId
    ↓
@CurrentUser()
    ↓
读取 request.auth
    ↓
Controller
    ↓
把 userId / body / param 等传给 Service
```

所以 Request Lifecycle 不只是：

```text
一堆组件按照固定顺序执行
```

还可以理解成：

```text
Request
    ↓
逐步验证
    ↓
逐步补充 Context
    ↓
逐步转换输入
    ↓
最后进入业务逻辑
```

这就是当前项目真正体现出来的 Request Lifecycle 设计。

### 【这一层最终形成三个核心认识】

第一：

> **Request Lifecycle（请求生命周期）描述的是一个已经进入 HTTP 应用的请求，在真正完成 Controller / Service 执行和返回 Response 之前，会经过哪些框架阶段。**

第二：

> **Guard 负责“能不能继续”，Interceptor 负责“包裹执行过程”，Pipe 负责“参数是否合法或是否需要转换”，Exception Filter 负责“未处理异常最终怎样转换成响应”。这些机制位置不同、职责也不同。**

第三，结合当前项目：

```text
SessionGuard
    ↓
建立 request.auth

CsrfGuard
    ↓
消费 request.auth

RequestIdInterceptor
    ↓
建立 requestId 和耗时上下文

@CurrentUser()
    ↓
再次消费 request.auth

Controller
    ↓
输入校验 / 业务参数转换

Service
    ↓
真正业务逻辑
```

因此当前 API 的请求处理不能简单理解成：

```text
Request
    ↓
Controller
```

而应该理解成：

```text
Request
    ↓
验证
    ↓
建立 Request Context
    ↓
补充横向能力
    ↓
提取 / 转换参数
    ↓
Controller
    ↓
Service
    ↓
Response
```


## 6. Auth、Session、CSRF 与 Request ID 共同组成用户访问时的身份、安全与追踪链路

这一章在上一章 Request Lifecycle 的基础上，把当前项目真实存在的几条链完整拆开：

```text
Auth / Session
    → 当前用户是谁、是否已经登录

CSRF Token
    → 当前修改请求是否由已经进入应用上下文的客户端主动发起

Authorization
    → 当前用户是否有权访问某个具体 Project / Resource

Request ID
    → 当前这一条 HTTP Request 如何被日志和链路追踪
```

这几条链经常同时出现在一次请求中，但解决的问题完全不同。

先建立最重要的整体关系：

| 能力 | 当前项目中的主要载体 | 核心问题 | 生命周期 |
| --- | --- | --- | --- |
| Authentication（身份认证） | `bm_session` Cookie + Redis Session | 当前用户是谁、是否已经登录 | 一次登录会话 |
| CSRF Protection（跨站请求伪造保护） | `csrfToken` + `x-csrf-token` | 写请求是否具有当前 Session 对应的附加凭证 | 与 Session 绑定 |
| Authorization（资源授权） | `user.id + projectId` 等业务判断 | 已登录用户能否操作具体资源 | 单次业务操作 |
| Request Correlation（请求关联） | `x-request-id` | 当前是哪一条 HTTP 请求 | 单次 HTTP Request |

最重要的一层区分是：

```text
Session Token
    → Authentication Credential（身份认证凭证）

CSRF Token
    → CSRF Protection Credential（CSRF 防护凭证）

sessionId
    → Session Identifier（会话内部标识）

requestId
    → Request Identifier（请求追踪标识）
```

它们名字里虽然都可能出现 Token / ID，但角色完全不同。

---

### 【用户登录之前先完成账号注册与邮箱验证】

当前注册入口：

```text
POST /api/v1/auth/register
```

Controller：

```ts
@Post('register')
@HttpCode(202)
async register(
  @Body() body: unknown,
): Promise<{ message: string }> {
  const input =
    parseBody(registerSchema, body);

  await this.auth.register(
    input.email,
    input.password,
    input.displayName,
  );

  return {
    message:
      'Verification email sent.',
  };
}
```

`AuthService.register()` 会先规范化邮箱并 Hash Password（密码哈希）：

```ts
const email =
  emailInput
    .trim()
    .toLowerCase();

const passwordHash =
  await hashPassword(password);
```

随后把用户写入：

```text
users
```

数据库保存的是：

```text
password_hash
```

而不是原始 Password。

注册后还会生成：

```ts
token =
  createOpaqueToken(
    'bm_verify_',
  );
```

也就是 Email Verification Token（邮箱验证令牌）。

数据库同样不保存原始 Token，而是：

```ts
hashToken(token)
```

然后原始 Token 通过邮件发送给用户。

验证入口：

```text
POST /api/v1/auth/verify-email
```

服务端：

```text
原始 verify token
    ↓
hashToken()
    ↓
查询 account_tokens
    ↓
校验：
purpose = verify-email
未 consumed
未 expired
    ↓
标记 consumed_at
    ↓
users.email_verified_at = now()
```

所以用户登录前的账号状态链是：

```text
Register
    ↓
Password Hash
    ↓
users
    ↓
Verification Token
    ↓
Email
    ↓
Verify Email
    ↓
email_verified_at
    ↓
允许 Login
```

这一阶段主要属于账号身份体系，还没有进入 Session / CSRF / Request ID 的核心流程。

---

### 【登录成功时同时创建 Session Token、Session Record 和 CSRF Token】

用户登录：

```text
POST /api/v1/auth/login
```

Controller：

```ts
@Post('login')
@HttpCode(200)
async login(
  @Body() body: unknown,
  @Res({ passthrough: true })
  reply: FastifyReply,
) {
  const input =
    parseBody(loginSchema, body);

  const session =
    await this.auth.login(
      input.email,
      input.password,
    );

  // ...
}
```

`AuthService.login()` 首先查询：

```text
email
    ↓
users
    ↓
password_hash
```

再调用：

```ts
verifyPassword(
  password,
  row.password_hash,
)
```

并检查：

```ts
row.email_verified_at
```

只有账号存在、密码正确、邮箱已验证，才会进入 Session 创建阶段。

随后同时产生：

```ts
const token =
  createOpaqueToken(
    'bm_session_',
  );

const tokenHash =
  hashToken(token);

const csrfToken =
  createOpaqueToken(
    'bm_csrf_',
  );

const expiresAt =
  new Date(
    Date.now()
      + this.config
          .SESSION_TTL_SECONDS
          * 1_000,
  );
```

因此一次登录真正产生了：

```text
Session Token
    → bm_session_xxx

Session Token Hash
    → hash(session token)

CSRF Token
    → bm_csrf_xxx

Session Expiration
    → expiresAt
```

同时数据库：

```sql
INSERT INTO user_sessions(
  user_id,
  token_hash,
  csrf_token,
  expires_at
)
VALUES (...)
RETURNING id
```

会再产生一个：

```text
sessionId
```

所以：

```text
一次登录会话
├── sessionId
├── userId
├── Session Token
├── Session Token Hash
├── CSRF Token
└── expiresAt
```

这些字段虽然属于同一 Session，但角色不同。

---

### 【Session Token 是真正的登录 Credential，sessionId 只是内部 Identifier】

当前项目没有把：

```text
user_sessions.id
```

直接作为浏览器登录凭证。

而是额外生成：

```text
bm_session_xxx
```

作为 Session Token。

核心区别：

```text
Credential（凭证）
    → 持有它就可以证明某种身份或权限

Identifier（标识符）
    → 主要用于识别某个对象或记录
```

在当前设计中：

```text
Session Token
    → Credential

sessionId
    → Identifier
```

所以：

```text
Browser
    ↓
保存原始 Session Token

Server
    ↓
保存 token_hash
    ↓
Session 内部还有 sessionId
```

服务端数据库不需要保存原始 Session Token。

这形成：

```text
Browser

bm_session_secret_ABC
        ↓
        │ hash
        ↓

Database / Redis lookup key

hash(ABC)
```

如果数据库只泄漏：

```text
token_hash
```

攻击者不能直接把这个 Hash 当成 Cookie 原始 Session Token 使用，因为服务端收到 Cookie 后还会再执行：

```ts
hashToken(cookieToken)
```

所以：

```text
hash(originalToken)
≠
hash(tokenHash)
```

这里体现的是：

> **数据库只保存认证凭证的派生值，而不是原始会话凭证。**

---

### 【sessionId 技术上也可以放进 Cookie，但前提是它本身承担 Session Credential 角色】

这里需要区分“字段名字”和“安全角色”。

完全可以设计：

```text
Browser Cookie
    ↓
随机、高熵、不可预测的 Session ID
    ↓
Server Session Store
```

很多传统 Server-side Session Framework（服务端会话框架）就是这样实现的。

如果 Cookie 中的 Session ID：

```text
高熵
随机
不可预测
必须保密
拿到后即可恢复登录态
```

那么它在安全模型中实际上已经是：

```text
Session Credential
```

即使变量名仍然叫：

```text
sessionId
```

因此真正应该判断的不是：

```text
Session ID 还是 Token？
```

而是：

```text
这个值是不是认证凭证？

是否高熵随机？
是否不可预测？
是否必须保密？
拿到它是否可以直接认证？
服务端是否只保存 Hash？
是否可撤销？
是否有过期时间？
```

当前项目进一步把：

```text
内部 sessionId
```

和：

```text
外部 Session Credential
```

拆开，职责更加明确。

sessionId 可以继续用于：

```text
会话记录标识
安全审计
Session 管理
未来设备管理
撤销某次登录
```

而不需要把真正的原始登录凭证暴露给这些内部业务逻辑。

---

### 【登录后的 Session Context 同时写入 Database 和 Redis】

数据库创建 Session 后，当前代码建立：

```ts
const user:
  AuthenticatedUser = {
    id: row.id,
    email: row.email,
    displayName:
      row.display_name,
    sessionId:
      inserted.rows[0]!.id,
    csrfToken,
  };
```

然后写 Redis：

```ts
await this.redis.set(
  `session:${tokenHash}`,
  JSON.stringify(user),
  'EX',
  this.config
    .SESSION_TTL_SECONDS,
);
```

因此 Redis 中大致形成：

```text
Key

session:<session-token-hash>


Value

{
  id,
  email,
  displayName,
  sessionId,
  csrfToken
}
```

后续登录态请求主要不需要每次重新查询完整 users 表，而是：

```text
Session Cookie
    ↓
hashToken()
    ↓
Redis Session
    ↓
AuthenticatedUser
```

这里 Redis 承担的是：

```text
在线 Session Store（在线会话存储）
```

而 PostgreSQL 的 `user_sessions` 则保留持久 Session Record。

---

### 【Session Token 与 CSRF Token 通过不同渠道交给浏览器】

登录完成后：

```ts
reply.setCookie(
  'bm_session',
  session.token,
  {
    httpOnly: true,
    secure:
      this.config.NODE_ENV
        === 'production',
    sameSite: 'lax',
    path: '/',
    expires:
      session.expiresAt,
  },
);
```

Session Token 进入：

```text
HttpOnly Cookie

bm_session=<session-token>
```

其中：

```text
HttpOnly = true
```

意味着普通页面 JavaScript 无法通过：

```js
document.cookie
```

读取这个 Cookie 的值。

与此同时 Controller Response Body 返回：

```ts
return {
  user: session.user,
  csrfToken:
    session.user.csrfToken,
};
```

所以浏览器端收到两种不同凭证：

```text
Session Token
    ↓
HttpOnly Cookie
    ↓
JavaScript 不直接读取
    ↓
Browser 自动携带


CSRF Token
    ↓
Response Body
    ↓
JavaScript 可以读取
    ↓
由应用主动放进请求 Header
```

这两个 Token 的存储方式不同，是当前安全设计的核心之一。

---

### 【Web 前端把 CSRF Token 放入 sessionStorage】

当前 Web：

```ts
let csrfToken =
  sessionStorage.getItem(
    'browser-monitor-csrf',
  ) ?? '';
```

登录成功后：

```ts
setCsrfToken(
  result.csrfToken,
);
```

实现：

```ts
export function setCsrfToken(
  value: string,
): void {
  csrfToken = value;

  sessionStorage.setItem(
    'browser-monitor-csrf',
    value,
  );
}
```

所以浏览器中形成：

```text
Cookie
────────────────────
bm_session

HttpOnly
JavaScript 不可直接读取
Browser 自动发送


sessionStorage
────────────────────
browser-monitor-csrf

JavaScript 可读取
由前端主动放入 Header
```

这也是后面理解 CSRF 与 XSS 区别的关键。

---

### 【所有前端 API 请求通过 credentials: include 自动携带 Session Cookie】

当前 Web API Client：

```ts
const response =
  await fetch(path, {
    ...init,

    credentials: 'include',

    headers: {
      // ...
    },
  });
```

因此前端业务代码不需要：

```ts
const sessionToken = ...
```

也不需要：

```text
Authorization:
Bearer <token>
```

浏览器会按照 Cookie 规则自动携带：

```text
bm_session
```

所以当前项目采用的是：

```text
Cookie-based Server Session
（基于 Cookie 的服务端 Session）
```

而不是：

```text
Bearer Access Token
```

模式。

---

### 【SessionGuard 根据 Cookie 恢复当前用户身份】

受保护 Controller：

```ts
@Controller('api/v1')
@UseGuards(
  SessionGuard,
  CsrfGuard,
)
export class ProjectsController {
  // ...
}
```

请求进入后先由：

```text
SessionGuard
```

处理。

核心源码：

```ts
const token =
  request.cookies?.bm_session;

if (!token) {
  throw new UnauthorizedException({
    code:
      'authentication_required',
  });
}
```

没有 Cookie：

```text
Request
    ↓
没有 bm_session
    ↓
401 Unauthorized
```

存在 Cookie：

```ts
const session =
  await this.redis.get(
    `session:${hashToken(token)}`,
  );
```

链路：

```text
bm_session Cookie
        ↓
原始 Session Token
        ↓
hashToken()
        ↓
session:<token-hash>
        ↓
Redis
        ↓
AuthenticatedUser
```

Redis 查不到：

```text
Session invalid / expired
    ↓
401
```

查到后：

```ts
(
  request
    as AuthenticatedRequest
).auth =
  JSON.parse(session)
    as AuthenticatedUser;
```

于是原始 Request 被补充：

```text
request
├── cookies
├── headers
├── ...
└── auth
     ├── id
     ├── email
     ├── displayName
     ├── sessionId
     └── csrfToken
```

因此 Auth / Session 这一层完成的是：

> **把一个匿名 HTTP Request，通过 Session Cookie 恢复成带有明确用户身份的 Authenticated Request（已认证请求）。**

---

### 【@CurrentUser 只是读取 SessionGuard 已经建立好的 request.auth】

当前：

```ts
export const CurrentUser =
  createParamDecorator(
    (
      _data: unknown,
      context:
        ExecutionContext,
    ):
      AuthenticatedUser =>
      context
        .switchToHttp()
        .getRequest<
          AuthenticatedRequest
        >()
        .auth,
  );
```

所以：

```text
SessionGuard
    ↓
request.auth = user
    ↓
@CurrentUser()
    ↓
Controller 参数 user
```

Controller 不需要再次：

```text
解析 Cookie
查询 Redis
恢复 Session
```

身份恢复已经在 Guard 阶段完成。

---

### 【CSRF Protection 解决的是 Cookie 自动携带带来的跨站伪造问题】

Cookie 的便利之处在于：

```text
Browser
    ↓
自动携带符合条件的 Cookie
```

但这也形成 CSRF（Cross-Site Request Forgery，跨站请求伪造）的基础风险模型。

可以概念化为：

```text
用户已经登录 monitor.example.com
    ↓
Browser 中有 bm_session Cookie
    ↓
用户访问 evil.example
    ↓
攻击页面尝试诱导 Browser
向 monitor.example.com 发请求
    ↓
Browser 可能按照 Cookie 规则
自动携带 monitor.example.com 的 Cookie
```

所以单独验证：

```text
bm_session
```

只能证明：

```text
浏览器拥有合法登录 Session
```

不能单独证明：

```text
这个写请求确实是当前应用前端主动构造的
```

因此当前项目增加第二份：

```text
CSRF Token
```

作为修改类请求的附加验证条件。

---

### 【前端只对修改类请求主动增加 x-csrf-token】

当前 `api()`：

```ts
const method =
  init.method
    ?.toUpperCase()
  ?? 'GET';

headers: {
  ...(
    init.body
      ? {
          'content-type':
            'application/json',
        }
      : {}
  ),

  ...(
    ![
      'GET',
      'HEAD',
      'OPTIONS',
    ].includes(method)
    && csrfToken
      ? {
          'x-csrf-token':
            csrfToken,
        }
      : {}
  ),

  ...init.headers,
}
```

因此普通读取请求：

```text
GET /api/v1/projects

Cookie:
bm_session=...
```

而修改类请求：

```text
POST /api/v1/projects

Cookie:
bm_session=...

x-csrf-token:
bm_csrf_xxx
```

也就是说写请求携带两份不同来源的凭证：

```text
bm_session
    ↓
Browser 自动携带


x-csrf-token
    ↓
Web JavaScript 主动读取 CSRF Token 后添加
```

---

### 【CsrfGuard 对比 Header Token 与当前 Session 内保存的 CSRF Token】

因为 Controller：

```ts
@UseGuards(
  SessionGuard,
  CsrfGuard,
)
```

所以先：

```text
SessionGuard
    ↓
恢复 request.auth
```

再：

```text
CsrfGuard
```

核心代码：

```ts
const supplied =
  request.headers[
    'x-csrf-token'
  ];

if (
  typeof supplied !== 'string'
  ||
  supplied
    !== request.auth.csrfToken
) {
  throw new ForbiddenException({
    code:
      'invalid_csrf_token',
  });
}
```

因此比对的是：

```text
Request Header

x-csrf-token
        ↓
客户端提交的 CSRF Token


request.auth.csrfToken
        ↓
Redis Session 中保存的 CSRF Token
```

只有：

```text
Header CSRF Token
        ==
Current Session CSRF Token
```

才继续执行。

否则：

```text
403 Forbidden
```

这也是为什么 `SessionGuard` 必须先于 `CsrfGuard`：

```text
SessionGuard
    ↓
建立 request.auth

CsrfGuard
    ↓
读取 request.auth.csrfToken
```

---

### 【GET / HEAD / OPTIONS 不要求 CSRF Token，但仍然可以要求 Session】

当前：

```ts
if (
  ['GET', 'HEAD', 'OPTIONS']
    .includes(request.method)
) {
  return true;
}
```

因此：

```text
GET /api/v1/projects
    ↓
SessionGuard
    ↓
必须已经登录
    ↓
CsrfGuard
    ↓
发现 GET
    ↓
直接通过
```

而：

```text
POST /api/v1/projects
    ↓
SessionGuard
    ↓
验证 Session
    ↓
CsrfGuard
    ↓
验证 x-csrf-token
```

所以：

```text
Authentication
    → 受保护读取和写入请求都可能需要

CSRF Validation
    → 当前项目主要保护会产生状态修改的请求
```

---

### 【页面刷新后可以通过 /auth/me 恢复 User 与 CSRF Token】

当前 `AuthProvider`：

```ts
const session =
  useQuery({
    queryKey: ['session'],

    queryFn: async () => {
      const response =
        await api<{
          user: User;
          csrfToken: string;
        }>(
          '/api/v1/auth/me',
        );

      setCsrfToken(
        response.csrfToken,
      );

      return response.user;
    },

    retry: false,
    staleTime: 60_000,
  });
```

`/auth/me`：

```ts
@Get('me')
@UseGuards(SessionGuard)
me(
  @CurrentUser()
  user: AuthenticatedUser,
): {
  user: AuthenticatedUser;
  csrfToken: string;
} {
  return {
    user,
    csrfToken:
      user.csrfToken,
  };
}
```

所以用户刷新页面后：

```text
Browser
    ↓
GET /api/v1/auth/me
    ↓
credentials: include
    ↓
自动携带 bm_session
    ↓
SessionGuard
    ↓
Redis Session
    ↓
request.auth
    ↓
@CurrentUser()
    ↓
返回 user + csrfToken
    ↓
Web
    ↓
setCsrfToken()
    ↓
恢复 sessionStorage
```

因此 Session Cookie 是恢复登录态的根凭证，而 CSRF Token 可以从当前有效 Session 重新获取。

---

### 【Auth 与 Authorization 不是一回事】

例如：

```text
GET
/api/v1/projects/project-123
```

SessionGuard 只能证明：

```text
当前请求来自 user-001
```

但它不能证明：

```text
user-001 是否属于 project-123
```

Controller：

```ts
return this.projects.detail(
  user.id,
  projectId,
);
```

继续把：

```text
user.id
+
projectId
```

交给 `ProjectsService`。

后续 Service 中的：

```text
requireAccess()
requireOwner()
项目成员关系检查
```

才属于 Authorization（资源授权）。

因此当前安全链应该分成：

```text
第一层
Authentication
────────────────────
SessionGuard

回答：
你是谁？


第二层
CSRF Protection
────────────────────
CsrfGuard

回答：
这个修改请求是否具有
当前 Session 对应的附加凭证？


第三层
Authorization
────────────────────
ProjectsService 等业务 Service

回答：
你是否可以操作
这个 Project / Resource？
```

---

### 【Request ID 完全不属于身份认证体系】

当前 `RequestIdInterceptor`：

```ts
const incoming =
  request.headers[
    'x-request-id'
  ];

const requestId =
  typeof incoming === 'string'
  && incoming.length <= 128
    ? incoming
    : randomUUID();
```

Request ID 的作用不是：

```text
证明用户身份
验证 Session
验证 CSRF
判断 Project 权限
```

它只是在回答：

```text
当前是哪一条 HTTP Request？
```

所以：

```text
User
    ≠ Request ID

Session
    ≠ Request ID

CSRF Token
    ≠ Request ID

单次 Request
    → Request ID
```

当前 Web Client 没有主动生成 `x-request-id`，因此普通 Web 请求通常会：

```text
Request
    ↓
没有 incoming x-request-id
    ↓
RequestIdInterceptor
    ↓
randomUUID()
```

如果未来上游主动传：

```http
x-request-id: abc123
```

且满足当前长度判断，则服务端会继续沿用。

---

### 【Request ID 同时写入 Request Context、Response Header 和日志】

当前：

```ts
request.requestId =
  requestId;

response.header(
  'x-request-id',
  requestId,
);
```

最后：

```ts
process.stdout.write(
  JSON.stringify({
    message:
      'request_completed',
    requestId,
    method:
      request.method,
    path:
      request.url
        .split('?', 1)[0],
    statusCode:
      response.statusCode,
    durationMs:
      ...
  }),
);
```

所以：

```text
Request ID
    ├──→ request.requestId
    │
    ├──→ Response x-request-id
    │
    └──→ request_completed Log
```

最终可以形成：

```text
用户或前端拿到 requestId
    ↓
日志平台搜索 requestId
    ↓
找到：
method
path
statusCode
durationMs
相关 Trace / downstream log
```

这属于 Observability（可观测性），而不是 Authentication。

---

### 【当前 RequestIdInterceptor 无法覆盖在 Guard 阶段直接失败的请求】

这一点与上一章 Request Lifecycle 直接相关。

Nest 生命周期：

```text
Guard
    ↓
Interceptor
```

当前受保护接口：

```text
SessionGuard
    ↓
CsrfGuard
    ↓
RequestIdInterceptor
```

因此如果：

```text
SessionGuard
    → 401

或者

CsrfGuard
    → 403
```

请求会在进入 Interceptor 之前结束。

所以当前 `RequestIdInterceptor` 不能严格覆盖：

```text
所有进入 HTTP Server 的请求
```

它覆盖的是：

```text
成功进入 Nest Interceptor 阶段的 Route 请求
```

如果设计目标要求：

```text
401
403
Guard Failure
甚至更早错误
```

也必须有统一 Request ID，则 Request ID 建立逻辑应考虑放到：

```text
Fastify Hook
或
Middleware
```

更靠前的位置。

---

### 【Access Token + Refresh Token 并不会因为是“双 Token”就自动解决 CSRF】

这里进入通用安全分析，不是当前项目源码事实。

常见“双 Token”通常指：

```text
Access Token
+
Refresh Token
```

它主要解决：

```text
Access Token
    → 短期访问凭证

Refresh Token
    → 用于延长登录状态 / 获取新的 Access Token
```

核心问题是：

```text
Token 生命周期
登录续期
凭证泄漏后的影响窗口
```

它本身并不是 CSRF Protection。

如果：

```text
Access Token
Refresh Token
```

都放进浏览器自动携带的 Cookie：

```text
Cross-Site Request
    ↓
Browser 仍可能自动发送认证 Cookie
```

传统 CSRF 风险仍然存在。

所以：

> **CSRF 是否成立，关键不是“有几个 Token”，而是认证凭证是否会被 Browser 自动携带。**

---

### 【Authorization Header 模式降低传统 CSRF 风险，是因为认证 Header 需要 JavaScript 主动添加】

另一种常见方案：

```text
Access Token
    ↓
JavaScript Memory / Storage
    ↓
请求时主动添加

Authorization:
Bearer <access-token>
```

Browser 不会因为访问某个 Origin 自动添加：

```http
Authorization:
Bearer ...
```

因此攻击站点无法仅依靠：

```text
诱导 Browser 发送请求
```

就获得合法 Authorization Header。

这也是为什么：

```text
Authorization Header Token
```

通常不像 Cookie Session 一样依赖传统 CSRF Token。

但代价是：

```text
如果 Access Token 暴露给 JavaScript
    ↓
XSS 成功时
    ↓
Token 可能直接被读取和窃取
```

所以这只是安全模型的变化，不是“天然更安全”。

---

### 【Access Token + Refresh Token 可以降低普通业务 API 的 CSRF 攻击面，但不是当前项目的优先选择】

前面需要进一步修正一个容易过度简化的判断：

```text
“Access Token + Refresh Token
不能解决 CSRF”
```

这个说法不够准确。

如果采用的是：

```text
Access Token
    ↓
不放 Cookie
    ↓
由 JavaScript 主动放入
Authorization Header

Refresh Token
    ↓
HttpOnly Cookie
```

那么普通业务 API 的确可以显著降低传统 Cookie-based CSRF（基于 Cookie 的跨站请求伪造）攻击面。

原因不是：

```text
系统有两个 Token
```

而是：

```text
Access Token
不会被 Browser 自动携带
```

例如：

```http
Authorization:
Bearer <access-token>
```

这个 Header 需要当前应用 JavaScript 主动设置。

攻击站点不能仅仅依赖：

```text
诱导 Browser 发请求
```

就获得合法 Authorization Header。

所以更准确的关系是：

```text
Cookie Session

认证 Credential
由 Browser 自动发送
        ↓
存在传统 CSRF 攻击面
        ↓
需要 SameSite / CSRF Token
等额外防护


Authorization Header Access Token

认证 Credential
由 JavaScript 主动发送
        ↓
普通业务 API
通常不再依赖传统 CSRF Token
```

因此：

> **双 Token 方案能够降低普通业务接口的传统 CSRF 风险，但关键原因是 Access Token 使用 Authorization Header，而不是“两个 Token”本身。**

---

### 【Access + Refresh 真正增加的是 Token Lifecycle 管理复杂度】

如果当前项目改成：

```text
Access Token
+
Refresh Token
```

就不只是把：

```text
Session Token + CSRF Token
```

替换成两个新的 Token。

还要引入完整的 Token Lifecycle（令牌生命周期）管理。

例如：

```text
Access Token
    ↓
短时间有效
    ↓
过期
    ↓
客户端发现 401 / expired
    ↓
调用 /refresh
    ↓
Refresh Token
    ↓
生成新的 Access Token
    ↓
重试原请求
```

如果同时存在多个并发请求：

```text
Request A
Request B
Request C
```

都发现 Access Token 过期，就可能变成：

```text
A → refresh
B → refresh
C → refresh
```

实际客户端通常还要额外实现：

```text
Refresh Lock
Single Flight
Pending Request Queue
Retry
```

避免重复刷新和状态竞争。

多 Tab 页面还需要继续考虑：

```text
不同 Tab
是否共享 Access Token
谁负责 Refresh
Refresh 结果怎样同步
Token 过期怎样协调
```

所以 Access + Refresh 解决了一部分认证问题，也会引入新的客户端状态管理复杂度。

---

### 【安全的 Refresh Token 方案通常还需要 Rotation 与 Reuse Detection】

Refresh Token 如果只是：

```text
一个长期 Token
一直用到过期
```

一旦泄漏，风险窗口会很长。

因此成熟方案通常会引入 Refresh Token Rotation（刷新令牌轮换）：

```text
Refresh Token A
    ↓ refresh
A 失效
    ↓
Refresh Token B
    ↓ refresh
B 失效
    ↓
Refresh Token C
```

随后又需要服务端保存或识别：

```text
Refresh Token Hash
Token Family
Current Token
Revoked Token
ExpiresAt
Rotation State
```

如果：

```text
已经使用过的 Refresh Token A
再次出现
```

可能意味着：

```text
Token 被复制 / 被盗
```

于是还可能需要 Reuse Detection（重复使用检测）：

```text
检测旧 Refresh Token 再次出现
        ↓
认为 Token Family 可能泄漏
        ↓
撤销整个 Refresh Session
```

这时服务端最终仍然需要：

```text
Redis / Database
```

维护一套 Refresh Session State（刷新会话状态）。

相对当前：

```text
Session Token
    ↓
Redis Session
```

体系会明显更复杂。

---

### 【Server-side Session 的一个直接优势是可以立即撤销】

当前：

```text
bm_session
    ↓
hashToken()
    ↓
Redis Session
```

如果服务端需要让某个 Session 立即失效：

```text
redis.del(session)
```

下一次请求就无法通过：

```text
SessionGuard
```

因此以下场景非常直接：

```text
Logout
Password Reset
管理员强制下线
账号安全事件
撤销某个设备 Session
```

而自包含 Access Token 如果已经签发出去，通常只需要验证：

```text
Signature
Expiration
Claims
```

那么：

```text
Logout
```

并不会天然让已经签发的 Access Token 立即失效。

例如 Access Token TTL 为：

```text
15 minutes
```

即使 Refresh Token 已经被撤销，当前 Access Token 仍可能继续使用到过期。

如果希望即时撤销，就又要增加：

```text
Token Blacklist
Token Version
Session State Lookup
```

等机制。

如果最后每次 Access Token 请求仍然需要：

```text
Redis Lookup
```

那么 JWT / Self-contained Token（自包含 Token）的部分优势也会被削弱。

---

### 【Access Token 更适合解决多客户端和多服务身份传递问题】

Access Token 的价值通常在下面这些架构中更明显：

```text
Web
Mobile
CLI
Third-party Client
        ↓
      API
```

或者：

```text
              API Gateway
                  ↓
        ┌─────────┼─────────┐
        ↓         ↓         ↓
    Service A Service B Service C
```

如果 Access Token 包含：

```text
sub
roles
scope
exp
aud
```

各个服务可以根据：

```text
Token Signature
+
Claims
```

独立完成身份校验或权限判断，而不一定每次都查询同一个 Session Store。

因此：

```text
Mobile App
CLI
OAuth / OIDC
Third-party API
多个独立 Resource Server
跨服务身份传播
```

通常更适合 Access Token 模型。

---

### 【当前 Browser Monitor 的业务形态并没有强烈要求 Access + Refresh】

当前系统主要是：

```text
React Web
    ↓
Nest API
    ↓
Redis + PostgreSQL
```

主要使用方是：

```text
Browser Web App
```

而不是：

```text
Web
+
iOS
+
Android
+
CLI
+
Third-party API
+
多个独立 Resource Server
```

所以当前核心需求只是：

```text
用户登录 Web
    ↓
稳定保持 Session
    ↓
访问同一个 API
    ↓
服务端能够快速撤销 Session
```

并且项目本来已经存在：

```text
Redis
```

因此：

```text
Cookie
    ↓
Session Token
    ↓
Redis Session
    ↓
AuthenticatedUser
```

是一条非常直接的认证链路。

如果只是为了减少：

```text
CSRF Token
```

而改成：

```text
Access Token
Refresh Token
Refresh Endpoint
Rotation
Reuse Detection
Concurrent Refresh
Retry
Token Revocation
多 Tab 协调
```

当前项目未必能获得足够大的架构收益。

---

### 【Access + Refresh 并没有让整个认证体系完全不存在 CSRF 问题】

假设：

```text
Access Token
    → JavaScript Memory

Refresh Token
    → HttpOnly Cookie
```

那么普通业务 API：

```text
Authorization Header
```

确实不再依赖 Browser 自动发送 Cookie 认证，因此传统 CSRF 攻击面明显降低。

但是：

```text
POST /auth/refresh
```

如果仍然依赖：

```text
HttpOnly Refresh Token Cookie
```

那么 Refresh Endpoint 本身仍然是：

```text
Cookie-based Credential Endpoint
```

仍需要认真考虑：

```text
SameSite
Origin / Referer Validation
CORS
Refresh Rotation
是否需要额外 CSRF Protection
```

具体防护方式取决于 Refresh Endpoint 的实现。

因此更准确的说法是：

> **Access Token 使用 Authorization Header 后，普通业务 API 可以脱离传统 Cookie CSRF 模型；但依赖 HttpOnly Cookie 的 Refresh Endpoint 仍需要单独设计安全边界。**

---

### 【两种方案都不能单独解决 XSS，但 XSS 下的 Credential 暴露程度不同】

两种认证模型都不能把：

```text
XSS
```

本身解决掉。

但不能简单理解成：

```text
XSS 面前两种方案完全一样
```

当前方案：

```text
Session Token
    → HttpOnly Cookie

CSRF Token
    → JavaScript 可读
```

如果发生 XSS：

```text
恶意 JavaScript
    ↓
可以读取 CSRF Token
    ↓
可以调用同源 API
    ↓
Browser 自动使用 Session Cookie
```

因此 XSS 可以：

```text
借用当前受害者 Session
```

但通常不能直接：

```text
读取原始 Session Credential
```

而 Access Token 方案如果：

```text
Access Token
    → JavaScript Memory / sessionStorage / localStorage
```

那么 XSS 除了可以借用当前页面身份，还可能：

```text
直接读取 Access Token
    ↓
上传到攻击服务器
    ↓
脱离受害者当前浏览器
继续调用 API
```

尤其：

```text
localStorage
sessionStorage
```

中的 Token 对 XSS 是直接可读的。

如果 Access Token：

```text
短 TTL
+
只存在 Memory
```

可以缩短凭证被盗后的影响时间，但它仍然需要进入 JavaScript Runtime 才能主动放进 Authorization Header。

因此两者在 XSS 下的区别更准确地说是：

```text
HttpOnly Session Token

XSS 可以借用 Session
但更难直接窃取认证 Secret


JavaScript-readable Access Token

XSS 可以借用当前身份
同时也可能直接窃取 Access Credential
```

所以：

> **HttpOnly 不能解决 XSS，但仍然能够降低“认证凭证本身被直接窃取并带离浏览器”的风险。**

---

### 【当前方案的一个重要设计目标是让真正认证 Secret 不进入 JavaScript Runtime】

当前 Browser Monitor 的凭证边界可以画成：

```text
              JavaScript Runtime
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
     User Data    CSRF Token     API Logic

────────────────────────────────────────
       JavaScript 可以访问
────────────────────────────────────────
       JavaScript 不直接访问

                     ↓
               bm_session
             HttpOnly Cookie
```

真正代表用户登录状态的：

```text
Session Credential
```

被放在：

```text
HttpOnly Cookie
```

中，不进入 JavaScript Runtime。

而常见 Authorization Header Access Token：

```text
Access Token
    ↓
必须进入 JavaScript Runtime
    ↓
JS 主动构造：
Authorization: Bearer ...
```

这是两种模型非常核心的安全取舍。

---

### 【当前项目没有选择双 Token 的主要原因是架构收益不足以覆盖复杂度】

因此，对于当前 Browser Monitor，更准确的结论不是：

```text
Access + Refresh 不能解决 CSRF
所以不用
```

而是：

```text
当前项目条件

单一 Web Client
+
单一 Nest API
+
已有 Redis
+
希望 Session 可立即撤销
+
希望真正认证凭证不进入 JavaScript Runtime
```

在这些条件下：

```text
Server-side Session
+
HttpOnly Cookie
+
SameSite
+
CSRF Token
```

已经能够提供：

```text
简单登录态管理
立即 Session Revocation
HttpOnly Credential Isolation
清晰的服务端 Session State
明确的 CSRF Protection
```

而改成：

```text
Access Token
+
Refresh Token
```

虽然可以让普通业务 API 使用：

```text
Authorization Header
```

从而显著降低传统 CSRF 攻击面，但同时会引入：

```text
Access Token TTL
Refresh Token TTL
Refresh Endpoint
Refresh Rotation
Reuse Detection
Concurrent Refresh
Retry
Multi-tab Coordination
Token Revocation
Token Storage Strategy
```

当前架构暂时没有：

```text
多客户端
多 Resource Server
OAuth
CLI
Mobile
跨服务身份传播
```

等明显收益点，因此没有必要仅仅为了减少 CSRF Token 而引入完整的双 Token 生命周期体系。

---

### 【两种方案的选择可以用业务场景判断，而不是用“哪种更先进”判断】

可以形成下面的通用判断：

| 项目特点 | Session + CSRF | Access + Refresh |
| --- | --- | --- |
| 单一 Web 管理后台 | 很适合 | 可用，但复杂度更高 |
| 已有 Redis Session Store | 很适合 | Token 自包含优势降低 |
| 需要立即撤销 Session | 直接删除 Session 即可 | 需要额外撤销机制 |
| 不希望认证 Secret 进入 JS | 很适合 | Access Token 通常需要进入 JS |
| Mobile App | 一般 | 更自然 |
| CLI / Third-party API | 不方便 | 更自然 |
| 多个独立 API Service | 需要共享 Session State | Access Token 更有优势 |
| OAuth / OIDC | 不适合作为主要模型 | 更自然 |
| 跨服务传递身份 Claims | 一般 | 更有优势 |
| 普通业务 API 避免传统 CSRF | 需要 CSRF Protection | Authorization Header 模型更有优势 |

最终应该根据：

```text
Client 类型
Service 数量
Session Revocation 要求
Credential 是否允许进入 JS
是否需要跨服务 Claims
是否已经有 Session Store
实现与运维复杂度
```

决定认证模型，而不是简单比较：

```text
一个 Token
vs
两个 Token
```


### 【当前 HttpOnly Session Cookie + CSRF Token 是一组配套设计】

当前 Session Token：

```text
HttpOnly Cookie
```

带来的好处：

```text
普通 JavaScript
不能直接读取 Session Credential
```

但代价是：

```text
Browser 自动携带 Cookie
    ↓
需要考虑 CSRF
```

所以增加：

```text
CSRF Token
```

形成：

```text
HttpOnly Session Cookie
        +
CSRF Token
```

这两部分不是重复，而是互相补足：

```text
HttpOnly
    → 降低 Session Token 被 JavaScript 直接读取的风险

CSRF Token
    → 弥补 Cookie 自动发送带来的跨站请求伪造风险
```

---

### 【当前 Web + Nest API + Redis 场景下，Server-side Session 是自然选择】

当前系统主要是：

```text
React Web
    ↓
Nest API
    ↓
Redis + PostgreSQL
```

并不是一个主要面向：

```text
大量第三方 API Client
多个独立 Mobile Client
OAuth Consumer
跨组织 API 使用方
```

的认证平台。

而当前基础设施已经存在：

```text
Redis
```

因此：

```text
Cookie
    ↓
Session Token
    ↓
Redis
    ↓
AuthenticatedUser
```

是一条简单直接的 Server-side Session 模型。

如果改成：

```text
Access Token
+
Refresh Token Rotation
```

则还需要额外设计：

```text
Access Token TTL
Refresh Token TTL
Refresh Endpoint
Refresh Rotation
Reuse Detection
并发刷新
多 Tab 刷新竞争
Token Revocation
Token Storage
```

是否值得引入这些复杂度，需要由客户端类型、跨服务架构、Token 自包含需求等实际业务目标决定，而不能只因为“双 Token”听起来更现代。

---

### 【CSRF Token 可以被 XSS 获取，因此 CSRF Protection 不等于 XSS Protection】

当前 Web 把 CSRF Token 放在：

```text
sessionStorage
```

所以正常 JavaScript 可以：

```js
sessionStorage.getItem(
  'browser-monitor-csrf',
)
```

读取。

如果攻击者通过 XSS（Cross-Site Scripting，跨站脚本攻击）成功让恶意 JavaScript 在当前应用 Origin 内执行，那么恶意脚本与正常 React 代码拥有相同的页面 JavaScript 权限。

因此它同样可能读取：

```text
browser-monitor-csrf
```

所以：

```text
正常 App JavaScript 能读取
        ↓
同 Origin 的 XSS JavaScript
通常也能读取
```

这说明：

> **CSRF Token 主要用来防跨站请求伪造，并不是用来防 XSS。**

---

### 【HttpOnly 能阻止 XSS 直接读取 Session Token，但不能阻止恶意脚本借用当前 Session】

由于：

```text
bm_session
    → HttpOnly
```

XSS JavaScript 通常不能：

```js
document.cookie
```

直接得到原始：

```text
bm_session=<secret>
```

但是：

```text
不能读取 Cookie
≠
不能使用 Cookie
```

只要恶意脚本已经运行在当前应用 Origin，它仍然可以：

```js
fetch(
  '/api/v1/projects',
  {
    credentials: 'include',
  },
)
```

Browser 会正常附带：

```text
bm_session
```

因此：

```text
XSS
    ↓
无法直接读取 Session Token
    ↓
但可以借 Browser
使用当前 Session
```

这就是为什么 HttpOnly 的价值应该理解为：

```text
Credential Theft Protection
（降低凭证直接被盗风险）
```

而不是：

```text
让 XSS 无法执行任何登录态操作
```

---

### 【XSS 可以读取同源 API Response，也可以执行用户权限范围内的写操作】

如果 XSS 已经运行在：

```text
monitor.example.com
```

那么它向：

```text
monitor.example.com/api/...
```

发请求，本身就是 Same-Origin Request（同源请求）。

例如：

```js
const response =
  await fetch(
    '/api/v1/projects',
    {
      credentials: 'include',
    },
  );

const data =
  await response.json();
```

只要 Session 有效：

```text
XSS
    ↓
Browser 自动带 Session Cookie
    ↓
SessionGuard 通过
    ↓
API 返回数据
    ↓
XSS 可以读取 Response
```

对于写操作，XSS 还能读取：

```text
sessionStorage 中的 CSRF Token
```

并主动添加：

```http
x-csrf-token: ...
```

例如概念上：

```text
XSS
    ↓
读取 csrfToken
    ↓
POST /api/v1/projects
    ↓
Browser 自动携带 bm_session
    ↓
JS 主动添加 x-csrf-token
    ↓
SessionGuard 通过
    ↓
CsrfGuard 通过
    ↓
Controller / Service
```

服务端无法仅从这两个凭证判断：

```text
请求来自正常 React 代码
还是
同 Origin 中已经执行成功的 XSS 代码
```

因为两者处于相同的浏览器安全上下文。

---

### 【CSRF 与 XSS 的安全边界不同】

可以把两类攻击区别画成：

```text
CSRF
────────────────────
攻击代码在站外

evil.example
    ↓
试图借用户 Browser
自动携带 monitor.example Cookie
    ↓
通常拿不到当前应用中的 CSRF Token
    ↓
CSRF Token 可以发挥作用
```

而：

```text
XSS
────────────────────
攻击代码已经进入站内

monitor.example
    ↓
恶意 JavaScript 与正常 App
处于同 Origin
    ↓
可以读取 JS 可访问的数据
    ↓
可以调用同源 API
    ↓
可以读取同源 Response
```

所以：

> **CSRF 的攻击者通常在应用 Origin 外部，而 XSS 的攻击代码已经进入应用 Origin 内部。**

这也是为什么：

```text
CSRF Token
SameSite
CORS
```

都不能被当作主要 XSS 防线。

---

### 【SameSite 与 CORS 可以辅助限制跨站行为，但不能解决当前 Origin 内的 XSS】

当前 Session Cookie：

```ts
sameSite: 'lax'
```

可以进一步约束某些 Cross-Site Cookie 行为，因此属于 CSRF 防御的一部分。

但是 XSS 已经运行在：

```text
当前 Site / Origin
```

所以：

```text
SameSite
```

不能阻止它使用当前站点 Session。

同理 CORS（Cross-Origin Resource Sharing，跨源资源共享）主要约束浏览器对跨 Origin 请求 / Response 的访问。

如果恶意脚本已经运行在：

```text
当前 Origin
```

那么：

```text
Same-Origin API
```

本身就不受 CORS 跨源限制。

因此：

```text
CORS
    ≠ XSS Protection

SameSite
    ≠ XSS Protection

CSRF Token
    ≠ XSS Protection
```

---

### 【XSS 需要由独立的前端内容执行安全体系防御】

XSS 的核心问题是：

```text
攻击者 JavaScript
能否进入并执行在当前应用 Origin
```

所以需要从另外一套安全边界处理。

React 默认文本渲染：

```tsx
<div>{userInput}</div>
```

会对普通文本做转义。

需要重点警惕：

```tsx
dangerouslySetInnerHTML={{
  __html: userInput,
}}
```

以及：

```js
element.innerHTML =
  userInput;
```

这类把不可信 HTML 直接送入 DOM 的路径。

如果业务确实需要渲染 HTML，则需要：

```text
HTML Sanitization
（HTML 内容净化）
```

另外可以通过 CSP（Content Security Policy，内容安全策略）进一步限制：

```text
哪些 Script 可以执行
是否允许 Inline Script
是否允许 eval
允许连接哪些数据目标
允许加载哪些第三方资源
```

例如安全方向上通常会避免宽松的：

```text
'unsafe-inline'
'unsafe-eval'
```

复杂高安全场景还可以进一步使用：

```text
Trusted Types
```

约束：

```text
innerHTML
insertAdjacentHTML
等 DOM XSS Sink
```

同时需要关注：

```text
第三方 Script
npm Dependency
CDN
供应链依赖
```

因为 XSS / Script Injection 不一定只来自业务表单输入。

---

### 【当前安全体系可以拆成四个相互独立的防线】

最终可以把 Browser Monitor 的 Web 安全模型整理成：

```text
第一层
Authentication
────────────────────────
Session Token
HttpOnly Cookie
Redis Session

回答：
你是谁？


第二层
CSRF Protection
────────────────────────
SameSite Cookie
+
CSRF Token
+
x-csrf-token

回答：
其他站点能否仅利用
Browser 自动 Cookie
伪造修改请求？


第三层
XSS Protection
────────────────────────
React Output Escaping
HTML Sanitization
CSP
Trusted Types
Dependency Security

回答：
攻击者 JavaScript
能否进入当前 Origin 执行？


第四层
Authorization
────────────────────────
ProjectsService
requireAccess()
requireOwner()
业务资源权限判断

回答：
即使已经登录，
当前用户可以访问哪些具体资源？
```

Request ID 则是另一条横向能力：

```text
Observability
────────────────────────
Request ID
Request Log
Duration
Status Code

回答：
这一条 HTTP Request
在系统里发生了什么？
```

所以 Request ID 不属于上面的四层安全授权体系。

---

### 【用户从打开页面到执行写操作的完整链路】

把当前所有逻辑最终串成一条真实用户访问链：

```text
用户打开 Browser Monitor
        ↓
React AuthProvider
        ↓
GET /api/v1/auth/me
        ↓
credentials: include
        ↓
Browser 自动携带 bm_session
        ↓
SessionGuard
        ↓
hashToken(session token)
        ↓
Redis Session
        ↓
request.auth = user
        ↓
@CurrentUser()
        ↓
返回 user + csrfToken
        ↓
Web setCsrfToken()
        ↓
sessionStorage 保存 csrfToken
        ↓
用户进入 Projects 页面
        ↓
GET /api/v1/projects
        ↓
Browser 自动携带 bm_session
        ↓
SessionGuard
        ↓
恢复 request.auth
        ↓
CsrfGuard
        ↓
GET 直接通过
        ↓
RequestIdInterceptor
        ↓
建立 requestId
        ↓
Controller
        ↓
ProjectsService
        ↓
Authorization / Database
        ↓
Response
        ↓
Request Log
```

如果用户执行写操作：

```text
用户点击“创建项目”
        ↓
POST /api/v1/projects
        ↓
api()
        ↓
credentials: include
        ↓
Browser 自动携带 bm_session
        +
前端主动加入 x-csrf-token
        ↓
SessionGuard
        ↓
恢复 request.auth
        ↓
CsrfGuard
        ↓
Header CSRF Token
        ==
Session CSRF Token ?
        ↓
通过
        ↓
RequestIdInterceptor
        ↓
requestId / startedAt
        ↓
@CurrentUser + @Body
        ↓
Controller
        ↓
Zod Validation
        ↓
ProjectsService
        ↓
Authorization
        ↓
Database / Transaction
        ↓
Response
        ↓
RequestIdInterceptor finalize
        ↓
Request Log
```

这就是当前项目从用户访问层看到的完整认证、安全、业务授权和请求追踪链。

---

### 【Logout 同时销毁服务端 Session、Cookie 与前端 CSRF 状态】

当前 Web：

```ts
await api(
  '/api/v1/auth/logout',
  {
    method: 'POST',
  },
);

clearCsrfToken();

queryClient.clear();
```

因为 Logout 是 POST，所以前端会发送：

```text
bm_session
+
x-csrf-token
```

服务端先：

```text
SessionGuard
    ↓
CsrfGuard
```

通过后：

```ts
await this.auth.logout(
  request.cookies
    ?.bm_session,
);
```

`AuthService.logout()`：

```text
Session Token
    ↓
hashToken()
    ↓
Redis DEL
        +
DELETE user_sessions
```

Controller 再：

```ts
reply.clearCookie(
  'bm_session',
  {
    path: '/',
  },
);
```

前端：

```text
clearCsrfToken()
    ↓
sessionStorage 删除
browser-monitor-csrf
```

所以完整 Logout：

```text
Server Redis Session 删除
+
Database Session Record 删除
+
Browser Session Cookie 清除
+
Browser CSRF Token 清除
```

---

### 【这一层最终形成的统一判断框架】

以后遇到 Session / Token / ID 设计，不要先从名字判断，而是依次问：

```text
这个值是谁生成的？

它存在哪里？

Browser 会不会自动发送？

JavaScript 能不能读取？

它是 Identifier 还是 Credential？

拿到它是否可以直接认证？

服务端保存原值还是 Hash？

有效期由谁控制？

如何撤销？

它防的是 Authentication、
CSRF、XSS、Authorization
还是只做 Observability？
```

当前项目可以最终压缩成：

```text
bm_session
    → Authentication Credential
    → HttpOnly Cookie
    → Browser 自动发送
    → Redis Session 恢复用户身份

csrfToken
    → CSRF Protection Credential
    → sessionStorage
    → JS 主动发送 x-csrf-token
    → 与当前 Session 中 csrfToken 比对

sessionId
    → Session 内部 Identifier
    → 不直接承担 Browser Authentication

requestId
    → Request Observability Identifier
    → 不参与 Authentication / Authorization

ProjectsService 等
    → Resource Authorization

CSP / Sanitization / React Escaping 等
    → XSS Protection
```

因此当前项目最重要的安全边界不是“用了几个 Token”，而是：

> **认证凭证由谁持有、Browser 是否自动发送、JavaScript 是否能够读取、服务端怎样恢复身份、写请求如何防跨站伪造，以及即使身份合法后如何继续做资源授权。CSRF Token 解决不了 XSS；HttpOnly 能降低 Session Credential 被直接窃取的风险，但也不能阻止已经运行在当前 Origin 中的恶意 JavaScript 借用当前 Session 调用同源 API。**


## 7. Zod Validation 把不可信 HTTP 输入转换成业务代码可以使用的数据

这一节继续沿着前面的 Request Lifecycle 往下走。

前面已经建立：

```text
HTTP Request
    ↓
Guard
    ↓
Interceptor
    ↓
Parameter Extraction
    ↓
Controller
    ↓
Service
```

但这里还有一个非常重要的问题：

```text
HTTP 请求里的数据
真的符合 Controller 假设的类型吗？
```

答案是：

```text
不能直接相信
```

因为 HTTP Request 来自 Runtime（运行时）的外部世界，而 TypeScript Type（TypeScript 类型）只能约束开发和编译阶段的代码。

因此当前项目建立了：

```text
HTTP Input
    ↓
unknown
    ↓
Zod Schema
    ↓
safeParse()
    ↓
Validation + Normalization
    ↓
Typed Data
    ↓
Controller
    ↓
Service
```

这条边界可以理解成：

```text
Untrusted Input
    ↓
Validation Boundary
    ↓
Trusted Application Input
```

### 【HTTP 输入先使用 unknown，是因为 TypeScript 无法证明运行时输入真实合法】

当前 `ProjectsController`：

```ts
@Post('projects')
create(
  @CurrentUser()
  user: AuthenticatedUser,

  @Body()
  body: unknown,
) {
  const input =
    parseBody(
      createProjectSchema,
      body,
    );

  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

这里没有直接写：

```ts
@Body()
body: CreateProjectInput
```

而是：

```ts
@Body()
body: unknown
```

这是一个重要的安全和类型边界。

客户端真实发送的数据可能是：

```json
{
  "displayName": 123,
  "appName": null
}
```

也可能是：

```json
[]
```

甚至：

```json
{
  "displayName": "",
  "appName": "!!!!!"
}
```

如果 Controller 直接声明：

```ts
body: CreateProjectInput
```

TypeScript 只是在开发阶段告诉代码：

```text
“把 body 当成 CreateProjectInput 使用”
```

它不会在 Node.js Runtime 自动检查：

```text
body 真的是 object 吗？
displayName 真的是 string 吗？
字段长度合法吗？
appName 是否符合格式？
```

因此外部输入更准确的类型应该先是：

```ts
unknown
```

它表达的是：

> **这个值已经进入程序，但当前还没有被证明符合应用的数据契约。**

### 【TypeScript Type 与 Runtime Validation 分别解决编译阶段和运行阶段的问题】

例如：

```ts
interface UserInput {
  email: string;
}
```

TypeScript 可以约束：

```ts
function foo(
  input: UserInput,
) {
  input.email.toLowerCase();
}
```

但如果 HTTP Client 实际发送：

```json
{
  "email": 123
}
```

TypeScript 无法阻止这个 Runtime Value（运行时值）进入服务端。

因为运行 Node.js 时执行的是编译后的 JavaScript。

因此：

```text
TypeScript Type
────────────────────────
开发 / 编译阶段

解决：
程序代码应该如何使用这个数据？


Runtime Validation
────────────────────────
运行阶段

解决：
外部真正传进来的数据
是否符合这个结构？
```

这也是 Zod 在服务端最核心的价值之一。

### 【当前项目通过 parseBody 统一执行 Zod Runtime Validation】

当前公共方法：

```ts
export function parseBody<T>(
  schema: ZodType<T>,
  value: unknown,
): T {
  const parsed =
    schema.safeParse(value);

  if (!parsed.success) {
    throw new BadRequestException({
      code:
        'invalid_request',
      message:
        'Request validation failed.',
      issues:
        parsed.error.issues.map(
          (issue) => ({
            path:
              issue.path.join('.'),
            message:
              issue.message,
          }),
        ),
    });
  }

  return parsed.data;
}
```

可以拆成：

```text
unknown
    ↓
Schema
    ↓
safeParse()
    ↓
success ?

否
    ↓
BadRequestException
    ↓
HTTP 400

是
    ↓
parsed.data
    ↓
进入业务代码
```

所以 `parseBody()` 实际承担两类职责：

```text
1. Runtime Validation
   判断输入是否满足 Schema

2. Error Adaptation
   把 Zod Error 转成当前 API 的 HTTP Error Contract
```

### 【Schema 是运行时数据契约，而不只是 TypeScript 类型声明】

当前：

```ts
const createProjectSchema =
  z.object({
    displayName:
      z.string()
        .trim()
        .min(1)
        .max(120),

    appName:
      z.string()
        .trim()
        .min(1)
        .max(128)
        .regex(
          /^[a-zA-Z0-9._-]+$/,
        ),
  });
```

这个 Schema 描述的不只是：

```text
displayName 是 string
appName 是 string
```

还包括：

```text
displayName
    → string
    → trim
    → 至少 1 个字符
    → 最多 120 个字符

appName
    → string
    → trim
    → 至少 1 个字符
    → 最多 128 个字符
    → 只能包含：
       字母
       数字
       .
       _
       -
```

所以 Schema 是：

```text
Type
+
Format
+
Constraint
+
Normalization
```

组成的 Runtime Contract（运行时契约）。

### 【safeParse 真正执行运行时校验】

当前：

```ts
const parsed =
  schema.safeParse(value);
```

成功时可以概念化为：

```text
{
  success: true,
  data: ...
}
```

失败时：

```text
{
  success: false,
  error: ...
}
```

因此：

```ts
if (!parsed.success) {
  ...
}
```

就是：

```text
输入不符合当前 Schema
```

而：

```ts
return parsed.data;
```

表示：

```text
这个数据已经经过当前 Schema 校验
可以继续进入应用代码
```

这里形成了一个明显的 Trust Boundary（可信边界）：

```text
External Input
    ↓
unknown
    ↓
Schema.safeParse()
    ↓
Validated Data
```

### 【Zod 不只做 Validation，也可以执行 Normalization】

例如：

```ts
z.string().trim()
```

输入：

```text
"  Browser Monitor  "
```

解析后：

```text
"Browser Monitor"
```

因此实际流程是：

```text
Raw Input
    ↓
Validation
+
Normalization
    ↓
Application Input
```

当前 `displayName`：

```ts
z.string()
  .trim()
  .min(1)
  .max(120)
```

同时完成：

```text
类型检查
+
去除首尾空格
+
非空检查
+
长度约束
```

### 【optional 与 default 描述的是不同的输入语义】

当前：

```ts
environment:
  z.string()
    .max(64)
    .optional()
```

表示：

```text
这个字段可以不存在
```

解析后仍可能：

```ts
environment === undefined
```

而：

```ts
label:
  z.string()
    .trim()
    .min(1)
    .max(80)
    .default('rotated')
```

表示：

```text
如果字段没有提供
    ↓
Schema 自动补默认值
```

所以：

```text
optional
    → 允许没有

default
    → 没有时生成默认值
```

当前 `rotateSchema` 已经给 `label` 设置：

```text
rotated
```

但 Controller 后续仍写：

```ts
input.label ?? 'rotated'
```

从当前 Schema 语义看，这是额外的一层兜底，存在一定重复。

### 【enum 用来限制输入只能来自明确集合】

例如：

```ts
role:
  z.enum([
    'owner',
    'member',
  ])
```

表示：

```text
owner
    → valid

member
    → valid

admin
    → invalid
```

当前项目中还有：

```ts
device:
  z.enum([
    'mobile',
    'desktop',
  ])
```

以及：

```ts
metric:
  z.enum([
    'LCP',
    'FCP',
    'INP',
    'CLS',
    'FPS',
    'LoAF',
  ])
```

这些 Schema 实际上也是 API Contract（API 契约）的一部分。

### 【Schema 可以通过 superRefine 表达字段之间的组合规则】

简单 Schema 主要检查单字段规则。

但很多输入存在：

```text
字段 A 出现
    ↓
字段 B 必须同时存在
```

当前：

```ts
const detailSchema =
  selectionSchema
    .extend({
      metric:
        z.string()
          .trim()
          .min(1)
          .max(64)
          .optional(),

      unit:
        z.string()
          .trim()
          .min(1)
          .max(32)
          .regex(
            /^[a-zA-Z][a-zA-Z0-9_./%-]*$/,
          )
          .optional(),

      aggregation:
        z.enum([
          'count',
          'sum',
          'avg',
          'min',
          'max',
          'p50',
          'p75',
          'p90',
          'p95',
          'p99',
        ])
        .optional(),
    })
    .superRefine(
      (
        selection,
        context,
      ) => {
        if (
          selection.metric
          &&
          !selection.unit
        ) {
          context.addIssue({
            code:
              z.ZodIssueCode.custom,
            message:
              'unit is required when metric is selected',
          });
        }

        if (
          !selection.metric
          &&
          selection.aggregation
          &&
          selection.aggregation
            !== 'count'
        ) {
          context.addIssue({
            code:
              z.ZodIssueCode.custom,
            message:
              'count is the only aggregation without a metric',
          });
        }
      },
    );
```

这里第一条规则：

```text
metric 存在
    ↓
unit 必须存在
```

第二条：

```text
metric 不存在
    ↓
aggregation 如果存在
只能是 count
```

所以 Schema 不只是：

```text
字段类型列表
```

还可以表达：

```text
多个字段之间的输入一致性规则
```

### 【当前 parseBody 实际不仅验证 Body，也验证 Query 和 Param】

虽然函数名叫：

```text
parseBody
```

但当前 `AnalyticsController`：

```ts
private filters(
  query: unknown,
): AnalyticsFilters {
  const parsed =
    parseBody(
      querySchema,
      query,
    );

  // ...
}
```

这里校验的是：

```text
@Query()
```

另外：

```ts
const normalized =
  parseBody(
    z.string()
      .trim()
      .min(1)
      .max(256),
    traceId,
  );
```

这里验证的是：

```text
@Param('traceId')
```

因此从实际职责看：

```text
parseBody()
```

更接近：

```text
parseInput()
parseWithSchema()
validateInput()
```

因为它处理的是：

```text
Body
Query
Param
其他 unknown Runtime Value
```

而不是只处理 HTTP Body。

### 【parseBody 把第三方 Zod Error 转换成当前 API 的错误契约】

当前失败后：

```ts
throw new BadRequestException({
  code:
    'invalid_request',
  message:
    'Request validation failed.',
  issues:
    parsed.error.issues.map(
      (issue) => ({
        path:
          issue.path.join('.'),
        message:
          issue.message,
      }),
    ),
});
```

最终对外重点暴露：

```text
code
message
issues[].path
issues[].message
```

而没有直接把：

```text
ZodError
```

完整结构暴露给客户端。

这里体现的是：

```text
Third-party Validation Error
    ↓
Adapter
    ↓
Application Error Contract
```

这个边界很重要：

> **第三方库的数据结构尽量不要直接成为应用对外 API Contract。**

否则未来更换 Validator 或升级库时，前端 API Contract 也可能被第三方实现细节绑定。

### 【Input Validation 与 Business Validation 必须分开】

例如：

```ts
createProjectSchema
```

能够判断：

```text
displayName 是否是合法 string
appName 是否满足格式要求
```

但它不能判断：

```text
用户是否有权执行当前操作？
appName 是否已经存在？
项目是否处于允许修改状态？
当前账号是否达到某种业务限制？
```

因为这些规则通常依赖：

```text
Current User
Database
Project State
Business State
```

因此：

```text
Input / Structural Validation
────────────────────────
输入本身是否符合接口契约？


Business / Domain Validation
────────────────────────
在当前业务状态下，
这个操作是否合法？
```

必须分层。

结合前一章：

```text
Request
    ↓
SessionGuard
    ↓
Authentication
你是谁？
    ↓
CsrfGuard
    ↓
CSRF Protection
写请求是否具有合法附加凭证？
    ↓
Input Validation
    ↓
输入格式是否满足 Contract？
    ↓
Service
    ↓
Authorization
能否访问当前 Resource？
    ↓
Business Rules
操作本身是否合法？
```

所以：

```text
Validation 成功
```

不等于：

```text
请求已经通过所有安全和业务判断
```

### 【当前普通后台接口采用 Controller 内显式 Zod Validation】

当前真实实现是：

```text
@Body / @Query / @Param
    ↓
Controller Method 开始执行
    ↓
unknown
    ↓
parseBody()
    ↓
Zod Schema
    ↓
Validated Data
    ↓
Service
```

例如：

```ts
@Post('projects')
create(
  @CurrentUser()
  user: AuthenticatedUser,

  @Body()
  body: unknown,
) {
  const input =
    parseBody(
      createProjectSchema,
      body,
    );

  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

这种设计的优势是：

```text
HTTP Input
    ↓
哪个 Schema 校验
    ↓
校验后调用哪个 Service
```

全部直接出现在 Controller 中，阅读非常直观。

但它也有一个明显代价：

```text
Validation 依赖开发者主动调用 parseBody()
```

如果某个 Controller 忘记调用：

```ts
@Post(...)
foo(
  @Body()
  body: unknown,
) {
  return this.service.foo(body);
}
```

那么：

```text
Untrusted Input
    ↓
可能直接进入 Service
```

因此当前方案依赖明确的代码规范：

> **所有外部不可信输入，在进入业务层之前必须显式经过对应 Schema。**

项目规模增大以后，这种人工约束可能出现遗漏。

### 【Nest Pipe 可以把 Validation 从 Controller Implementation 前移到 Request Lifecycle】

NestJS 的 Pipe（管道）本身就用于：

```text
Validation
Transformation
```

如果使用 Pipe，链路会从：

```text
当前实现

@Body()
    ↓
body: unknown
    ↓
Controller 已经开始执行
    ↓
parseBody()
    ↓
Zod
    ↓
input
    ↓
Service
```

变成：

```text
Pipe 实现

@Body()
    ↓
Pipe
    ↓
Zod Schema
    ↓
Validated Input
    ↓
Controller 才开始执行
    ↓
Service
```

所以本质区别是：

> **当前实现把 Validation 放在 Controller Implementation（控制器实现）内部；Pipe 方案把 Validation 提升为 Nest Request Lifecycle（请求生命周期）的一部分。**

### 【使用自定义 ZodValidationPipe 可以直接复用当前 parseBody 的逻辑】

如果不依赖 Nest 新的 Schema Pipe，可以把当前 `parseBody()` 几乎原样改造成：

```ts
import {
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import type {
  ZodType,
} from 'zod';

@Injectable()
export class ZodValidationPipe<T>
  implements PipeTransform<
    unknown,
    T
  > {

  constructor(
    private readonly schema:
      ZodType<T>,
  ) {}

  transform(
    value: unknown,
  ): T {
    const parsed =
      this.schema.safeParse(
        value,
      );

    if (!parsed.success) {
      throw new BadRequestException({
        code:
          'invalid_request',
        message:
          'Request validation failed.',
        issues:
          parsed.error.issues.map(
            (issue) => ({
              path:
                issue.path.join('.'),
              message:
                issue.message,
            }),
          ),
      });
    }

    return parsed.data;
  }
}
```

本质上只是把：

```ts
parseBody(
  schema,
  value,
)
```

变成：

```ts
pipe.transform(
  value,
)
```

### 【createProject 使用自定义 Pipe 后可以直接接收已校验输入】

Schema：

```ts
const createProjectSchema =
  z.object({
    displayName:
      z.string()
        .trim()
        .min(1)
        .max(120),

    appName:
      z.string()
        .trim()
        .min(1)
        .max(128)
        .regex(
          /^[a-zA-Z0-9._-]+$/,
        ),
  });

type CreateProjectInput =
  z.infer<
    typeof createProjectSchema
  >;
```

Controller 可以变成：

```ts
@Post('projects')
create(
  @CurrentUser()
  user: AuthenticatedUser,

  @Body(
    new ZodValidationPipe(
      createProjectSchema,
    ),
  )
  input: CreateProjectInput,
) {
  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

于是执行链：

```text
HTTP Body
    ↓
ZodValidationPipe
    ↓
createProjectSchema
    ↓
Validation
    ↓
成功
    ↓
CreateProjectInput
    ↓
Controller
    ↓
Service
```

如果校验失败：

```text
Pipe
    ↓
BadRequestException
    ↓
400
```

Controller Method 不会开始正常执行。

### 【当前 Nest 版本还可以使用官方 StandardSchemaValidationPipe】

当前项目依赖：

```text
@nestjs/common      ^11.1.6
@nestjs/core        ^11.1.6
@nestjs/platform-fastify ^11.1.6
zod                ^3.24.2
```

当前 Nest 官方提供：

```text
StandardSchemaValidationPipe
```

用于验证实现 Standard Schema 规范的 Schema。

官方文档明确说明：

```text
StandardSchemaValidationPipe
可以使用 Zod、Valibot、ArkType
等 Standard Schema compatible library
```

Standard Schema 官方兼容列表中，Zod 从：

```text
3.24.0+
```

开始实现 Standard Schema。

因此当前项目声明的：

```text
zod ^3.24.2
```

已经位于该兼容范围内。

这里属于**可选改造方案**，当前源码还没有实际使用 `StandardSchemaValidationPipe`。

### 【StandardSchemaValidationPipe 可以全局注册，但只处理声明了 schema 的参数】

概念改造：

```ts
import {
  StandardSchemaValidationPipe,
} from '@nestjs/common';

async function bootstrap() {
  const app =
    await NestFactory.create<
      NestFastifyApplication
    >(
      AppModule,
      adapter,
      {
        bufferLogs: true,
      },
    );

  app.useGlobalPipes(
    new StandardSchemaValidationPipe(),
  );

  // ...
}
```

虽然 Pipe 注册为 Global Pipe（全局管道），但官方行为是：

```text
只有参数显式声明 schema
    ↓
才执行 Standard Schema Validation

没有 schema 的参数
    ↓
原样通过
```

因此可以渐进式改造，不需要一次性把所有 Controller 全部修改。

### 【使用官方 StandardSchemaValidationPipe 后 Controller 可以进一步简化】

Schema 和 Type：

```ts
const createProjectSchema =
  z.object({
    displayName:
      z.string()
        .trim()
        .min(1)
        .max(120),

    appName:
      z.string()
        .trim()
        .min(1)
        .max(128)
        .regex(
          /^[a-zA-Z0-9._-]+$/,
        ),
  });

type CreateProjectInput =
  z.infer<
    typeof createProjectSchema
  >;
```

Controller 可以写成：

```ts
@Post('projects')
create(
  @CurrentUser()
  user: AuthenticatedUser,

  @Body({
    schema:
      createProjectSchema,
  })
  input: CreateProjectInput,
) {
  return this.projects.create(
    user.id,
    input.displayName,
    input.appName,
  );
}
```

此时：

```text
@Body({ schema })
    ↓
StandardSchemaValidationPipe
    ↓
Zod Schema
    ↓
Validated / Normalized Data
    ↓
Controller
```

Controller 不再自己调用：

```text
parseBody()
```

也不再直接接触：

```text
unknown
```

### 【Schema 的 transform / default / trim 结果会成为 Controller 实际收到的数据】

Pipe 最终应该把 Schema 的 Output（输出）交给 Controller。

例如：

```json
{
  "displayName":
    "  Browser Monitor  ",
  "appName":
    " monitor-web "
}
```

当前 Schema：

```ts
z.string().trim()
```

会产生：

```json
{
  "displayName":
    "Browser Monitor",
  "appName":
    "monitor-web"
}
```

所以 Controller 需要接收的是：

```text
Parsed / Normalized Schema Output
```

而不是原始 HTTP Input。

这与当前：

```ts
return parsed.data;
```

的设计思想一致。

### 【Query 也可以直接进入 Schema Pipe】

当前：

```ts
@Get('performance')
performance(
  @CurrentUser()
  user: AuthenticatedUser,

  @Param('projectId')
  projectId: string,

  @Query()
  query: unknown,
) {
  return this.analytics
    .performance(
      user.id,
      projectId,
      this.filters(query),
    );
}
```

然后：

```ts
private filters(
  query: unknown,
): AnalyticsFilters {
  const parsed =
    parseBody(
      querySchema,
      query,
    );

  // ...
}
```

可以改成：

```ts
type AnalyticsQuery =
  z.infer<
    typeof querySchema
  >;

@Get('performance')
performance(
  @CurrentUser()
  user: AuthenticatedUser,

  @Param('projectId')
  projectId: string,

  @Query({
    schema:
      querySchema,
  })
  query: AnalyticsQuery,
) {
  // query 已经通过 Schema
}
```

形成：

```text
Query String
    ↓
Nest @Query()
    ↓
querySchema
    ↓
StandardSchemaValidationPipe
    ↓
AnalyticsQuery
    ↓
Controller
```

### 【单个 Path Param 也可以绑定 Schema】

例如当前：

```ts
@Param('traceId')
traceId: string
```

后面再手动：

```ts
const normalized =
  parseBody(
    z.string()
      .trim()
      .min(1)
      .max(256),
    traceId,
  );
```

Pipe 方案可以把 Schema 直接放到参数上：

```ts
const traceIdSchema =
  z.string()
    .trim()
    .min(1)
    .max(256);

@Get('traces/:traceId')
trace(
  @Param(
    'traceId',
    {
      schema:
        traceIdSchema,
    },
  )
  traceId: string,
) {
  // traceId 已经 trim + validate
}
```

Nest 官方目前支持：

```text
@Body()
@Query()
@Param()
```

声明 `schema`。

### 【改成官方 Pipe 时需要保留当前 API Error Contract】

当前 `parseBody()` 的一个重要职责是返回统一错误：

```json
{
  "code":
    "invalid_request",
  "message":
    "Request validation failed.",
  "issues": [
    {
      "path":
        "displayName",
      "message":
        "..."
    }
  ]
}
```

如果直接使用默认：

```ts
new StandardSchemaValidationPipe()
```

错误结构会采用 Nest 默认 Schema Validation Error 表达。

如果改造后仍希望保持现有 API Contract，需要使用：

```text
exceptionFactory
```

进行 Error Adaptation。

例如：

```ts
app.useGlobalPipes(
  new StandardSchemaValidationPipe({
    exceptionFactory:
      (issues) =>
        new BadRequestException({
          code:
            'invalid_request',

          message:
            'Request validation failed.',

          issues:
            issues.map(
              (issue) => ({
                path:
                  issue.path
                    ?.map(
                      (segment) =>
                        typeof segment
                          === 'object'
                          ? segment.key
                          : segment,
                    )
                    .join('.')
                  ?? '',

                message:
                  issue.message,
              }),
            ),
        }),
  }),
);
```

于是：

```text
Standard Schema Issue
    ↓
exceptionFactory
    ↓
当前项目 Error Contract
    ↓
BadRequestException
    ↓
HTTP 400
```

这样可以把现有 `parseBody()` 的：

```text
Validation
+
Error Format Adaptation
```

一起移动到 Pipe。

### 【当前普通后台 API 适合逐步迁移到 Pipe】

这些 Controller：

```text
AuthController
ProjectsController
AnalyticsController
LabAuditsController
```

大量采用：

```text
@Body / @Query / @Param
    ↓
parseBody()
    ↓
Zod
```

属于高度重复的 Request Input Validation。

因此它们很适合逐步改成：

```text
@Body({ schema })
@Query({ schema })
@Param(..., { schema })
    ↓
StandardSchemaValidationPipe
    ↓
Controller
```

优点：

```text
Validation 进入 Request Lifecycle
Controller 更薄
Schema 与参数绑定更明确
减少忘记调用 parseBody 的风险
统一 Error Mapping
```

### 【Ingestion 不适合机械地把全部 Validation 搬进 Pipe】

当前 `IngestionService.ingest()` 明显比普通后台 CRUD Validation 更复杂。

第一步：

```ts
let decodedBody = body;

if (
  typeof body === 'string'
) {
  try {
    decodedBody =
      JSON.parse(body)
        as unknown;
  } catch {
    decodedBody = null;
  }
}
```

这是 Transport Decoding（传输解码）。

原因是：

```text
sendBeacon
可能以 text/plain
发送 JSON Document
```

所以：

```text
Transport Representation
    ↓
string / object
    ↓
Decode
    ↓
统一 Runtime Value
```

第二步先检查：

```text
protocolVersion
```

不支持时：

```text
unsupported_protocol
    ↓
422
```

第三步：

```ts
const header =
  telemetryBatchHeaderV3Schema
    .safeParse(decodedBody);
```

验证整个 Batch。

如果 Batch 本身非法：

```text
invalid_batch
    ↓
整个 Request 失败
```

第四步对每个 Event：

```ts
header.data.events
  .forEach(
    (
      candidate,
      index,
    ) => {
      const parsed =
        telemetryEventV3Schema
          .safeParse(
            candidate,
          );

      if (!parsed.success) {
        rejections.push({
          index,
          code:
            'invalid_event',
        });

        return;
      }

      // ...
    },
  );
```

这里某一个 Event 失败：

```text
不会直接让整个 Batch 失败
```

而是：

```text
Event 0
    → accepted

Event 1
    → rejected

Event 2
    → accepted
```

最终返回：

```text
accepted
duplicate
rejected
rejections[]
```

这是 Partial Acceptance（部分接受）策略。

### 【Ingestion 中 Schema 合法也不代表 Event 最终会被接受】

例如：

```ts
if (
  parsed.data.app.name
  !== project.app_name
) {
  rejections.push({
    index,
    code:
      'app_name_mismatch',
  });

  return;
}
```

这里：

```text
telemetryEventV3Schema
    ↓
已经成功
```

但：

```text
Event.app.name
        !=
Project.app_name
```

所以仍然拒绝。

另外：

```ts
if (
  parsed.data.occurredAt
    > now + 5 * 60_000
  ||
  parsed.data.occurredAt
    < now
      - 30 * 24
        * 60 * 60_000
) {
  rejections.push({
    index,
    code:
      'event_time_out_of_range',
  });

  return;
}
```

也是：

```text
Structural Validation
    ↓
成功

Domain Validation
    ↓
失败
```

因此不能把所有业务判断都塞进一个 HTTP Pipe。

### 【Validation 可以分成四个层次理解】

结合当前项目，可以形成：

```text
第一层
Transport Validation / Decoding
────────────────────────
HTTP Body 是否能解析
text/plain JSON 是否能 decode


第二层
Structural Validation
────────────────────────
Zod Schema

类型
字段
长度
格式
enum
字段组合
默认值
Normalization


第三层
Security / Identity Validation
────────────────────────
Session
CSRF
Origin
Public Key
Rate Limit 等


第四层
Business / Domain Validation
────────────────────────
Project access
app_name 是否匹配
Event 时间是否合理
资源当前状态
业务约束
Partial Acceptance Policy
```

不同层解决的问题不同。

### 【Pipe 最适合承担 Controller 参数契约，而不是所有业务校验】

Pipe 最适合回答：

```text
“这个 Controller Parameter
在进入 Handler 前
应该是什么结构？”
```

例如：

```text
Body Schema
Query Schema
Param Schema
UUID
Integer
Enum
String Format
Coercion
Normalization
```

而 Service 更适合回答：

```text
“这个数据虽然格式合法，
但在当前业务状态下，
是否应该接受？”
```

例如：

```text
用户是否有 Project 权限
Project 是否存在
Origin 是否在白名单
Event app_name 是否匹配
Event 时间是否有效
是否超过 Rate Limit
是否需要部分拒绝
```

所以可以建立：

```text
Pipe
    → Request / Input Contract

Service
    → Domain / Business Contract
```

### 【当前项目更合理的改造方式是普通 API 使用 Pipe，Ingestion 保留分层业务校验】

普通后台接口可以逐步改成：

```text
HTTP Request
    ↓
Guard
    ↓
Interceptor
    ↓
StandardSchemaValidationPipe
    ↓
Zod Schema
    ↓
Validated / Normalized Input
    ↓
Controller
    ↓
Service
    ↓
Business Validation
    ↓
Database
```

而 Ingestion：

```text
HTTP Request
    ↓
Transport Decode
    ↓
Protocol Version
    ↓
Batch Schema
    ↓
Project / Origin / Rate Limit
    ↓
Event-by-event Schema
    ↓
Domain Validation
    ↓
Partial Acceptance
    ↓
Transaction / Outbox
```

不要因为引入 Pipe，就把：

```text
所有 Validation
```

都搬到 Controller Parameter 阶段。

### 【当前实现与 Pipe 方案的最终对比】

当前实现：

```text
@Body()
    ↓
body: unknown
    ↓
Controller 开始执行
    ↓
parseBody()
    ↓
Zod
    ↓
Validated Input
    ↓
Service
```

优点：

```text
显式
容易阅读
实现简单
当前代码已经可用
```

代价：

```text
Controller 有重复 Validation 代码
依赖开发者记得调用 parseBody()
Validation 不属于框架 Lifecycle 阶段
```

Pipe 方案：

```text
@Body({ schema })
    ↓
StandardSchemaValidationPipe
    ↓
Zod
    ↓
Validated Input
    ↓
Controller
    ↓
Service
```

优点：

```text
Validation 前移
Controller 更薄
减少遗漏
Schema 与参数绑定
错误处理可以统一
更符合 Nest Request Lifecycle
```

代价：

```text
部分行为隐藏在全局 Pipe 中
需要理解 Pipe / Schema Metadata
迁移时要保持现有 Error Contract
复杂业务 Validation 仍不能全部搬入 Pipe
```

所以对于当前项目：

> **普通 Auth / Projects / Analytics / LabAudits 输入校验可以逐步迁移到 StandardSchemaValidationPipe；Ingestion 中的 Protocol、Batch、Event、Domain Rule 和 Partial Acceptance 仍应保持分层处理，不应该机械地统一成一个 Pipe。**

### 【这一节最终建立的 Validation 心智模型】

最终可以把当前项目的输入处理理解成：

```text
External HTTP Input
    ↓
unknown
    ↓
Runtime Schema
    ↓
Validation / Normalization
    ↓
Typed Application Input
    ↓
Controller
    ↓
Service
    ↓
Authorization
    ↓
Business / Domain Validation
    ↓
Persistence
```

核心结论：

> **TypeScript Type 只能帮助开发阶段正确使用数据；Zod Schema 才能在 Runtime 验证外部输入。当前项目通过 `parseBody()` 显式建立这一边界；在当前 Nest 版本下，也可以把普通接口逐步迁移到 `StandardSchemaValidationPipe`，让 Validation 正式进入 Request Lifecycle。但 Pipe 只适合承担 Request Input Contract，不能替代 Service 中依赖数据库、权限、状态和部分接受策略的 Domain Validation。**

### 【参考资料】

NestJS, *Validation*, 官方文档：<https://docs.nestjs.com/application/validation>

NestJS, *Pipes*, 官方文档：<https://docs.nestjs.com/pipes>

Standard Schema, *What schema libraries implement the spec?*：<https://standardschema.dev/schema>

Zod, *TypeScript-first schema validation with static type inference*：<https://zod.dev/>


## 8. 后续学习顺序

在当前整体框架基础上，后续按以下顺序继续深入：

```text
整体 Application
    ↓
AppModule 与 Module Graph
    ↓
Provider / DI Container
    ↓
Controller 与 Route 映射
    ↓
Request Lifecycle
    ↓
Auth / Session / CSRF / RequestId
    ↓
Zod Validation
    ↓
Service 与业务编排
    ↓
Database / Redis / Transaction
    ↓
Ingestion 数据写入链路
    ↓
Analytics 查询链路
    ↓
Health / Metrics / Observability
    ↓
Application Lifecycle / Shutdown
```

每一层继续保持：

```text
源码
    ↓
执行逻辑
    ↓
通用框架知识
    ↓
设计取舍
    ↓
回到当前项目
```

的分析方式。
