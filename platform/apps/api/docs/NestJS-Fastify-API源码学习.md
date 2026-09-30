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


## 5. 后续学习顺序

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
