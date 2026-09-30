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

## 2. 后续学习顺序

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
