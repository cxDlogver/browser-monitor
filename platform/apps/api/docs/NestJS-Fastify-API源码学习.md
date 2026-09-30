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


## 6. 后续学习顺序

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
Guard / Session / CSRF
    ↓
Interceptor / RequestId / Logging
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
