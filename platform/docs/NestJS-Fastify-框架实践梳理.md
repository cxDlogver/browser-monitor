# NestJS + Fastify 框架实践梳理（以 `platform/apps/api` 为准）

> **本文定位**：把 NestJS 的通用概念落到本项目 `browser-monitor/platform/apps/api` 这一份真实代码上，逐层解释「框架怎么用、代码在哪、每个方法为什么存在」。
> 通用概念（NestFactory / Module / Provider / DI / Controller / Lifecycle）的入门说明见 `Full-Stack-AI-NOTES/NestJS快速上手.md`；本文是它的**实践对照篇**，概念编号与那篇保持一致，方便对读。
>
> **事实基准**：`platform/apps/api` 当前代码 + `platform/tsconfig.base.json` + `apps/api/package.json`。文中所有路径、类名、方法名、错误码均可在源码中直接检索验证。

**目录**

| 章  | 内容                                           | 对应「快速上手」 |
| --- | ---------------------------------------------- | ---------------- |
| 1   | 技术栈分层：NestJS 在本项目的位置              | §1               |
| 2   | 启动引导：`main.ts` 逐行                       | §2               |
| 3   | 模块装配：`AppModule` 与模块图                 | §3               |
| 4   | 依赖注入实践：Token / 工厂 / 可见性 / 生命周期 | §4               |
| 5   | 控制器实践：路由与参数装饰器全表               | §5               |
| 6   | 请求生命周期：五个环节在本项目的落地           | §7               |
| 7   | 鉴权链路：Session + CSRF 双守卫                | §7               |
| 8   | 输入校验：为什么用 zod 而不是 ValidationPipe   | —                |
| 9   | 服务层：业务链路与可复用能力                   | §6               |
| 10  | 横切关注点：requestId / 日志 / 指标 / 健康检查 | —                |
| 11  | 工程配置：ESM + 装饰器 + 构建                  | §8               |
| 12  | 测试实践：vitest 如何构造 Nest Provider        | —                |
| 13  | 概念对照表与扩展指南                           | §9               |

---

## 1. 技术栈分层：NestJS 在本项目的位置

一次采集请求进入 API 进程时，实际穿过了这些层：

```text
浏览器 / SDK
  ↓
Caddy 反向代理（infra/Caddyfile）
  ↓
Node.js HTTP Server（app.listen 监听的端口）
  ↓
Fastify（FastifyAdapter 承载：路由、请求解析、body 解析、Cookie、CORS）
  ↓
NestJS（Module 装配 + DI 容器 + 生命周期编排）
  ↓
Controller（把 HTTP 语义翻译成方法调用）
  ↓
Service（业务规则、SQL、事务、Redis）
  ↓
PostgreSQL / TimescaleDB、Redis
```

每层解决的问题不同，本项目在每一层都有明确落点：

| 层次                | 职责                                            | 本项目对应                                                          |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Node.js HTTP Server | 监听端口、收发字节                              | `app.listen(config.API_PORT, '0.0.0.0')`（`src/main.ts`）           |
| Fastify             | 请求解析、body 上限、Cookie、CORS、`request.id` | `FastifyAdapter` 配置 + `app.register(cookie)` + `app.enableCors()` |
| NestJS              | 模块边界、依赖装配、守卫/拦截器编排、优雅关闭   | `AppModule` 及其 5 个业务模块                                       |
| Controller          | HTTP 入口、参数提取、状态码控制                 | `src/*/*.controller.ts`                                             |
| Service             | 业务规则、幂等、事务、缓存                      | `src/*/*.service.ts`                                                |
| Data Access         | 参数化 SQL                                      | 直接使用 `DatabaseHandle.pool`（未引入 Repository 层）              |

一句话概括本项目的框架用法：

> **NestJS 负责「对象怎么来、请求怎么被拦、异常怎么出去」，Fastify 负责「HTTP 怎么被解析」，业务与数据访问全部留在 Service，Controller 里基本只有参数提取和一行转发。**

---

## 2. 启动引导：`main.ts` 逐行

入口文件只有 36 行，但每一行都对应一个服务端必须明确的决策。

```ts
// src/main.ts
import cookie from "@fastify/cookie";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import "reflect-metadata";

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: 256 * 1_024,
    trustProxy: true,
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      bufferLogs: true,
    },
  );
  const config = app.get<ApiConfig>(API_CONFIG);

  await app.register(cookie as never, { secret: config.COOKIE_SECRET });
  app.enableCors({
    /* ... */
  });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, "0.0.0.0");
}
```

### 2.1 为什么必须显式传 `FastifyAdapter`

「快速上手」里的默认写法是 `NestFactory.create(AppModule)`，那会使用 Express 适配器。本项目锁定 Fastify，因此必须传第二个参数。

```text
Nest Application
      ↓
FastifyAdapter          ← 这一层是把 Nest 的抽象接口翻译成 Fastify 调用
      ↓
Fastify 实例
      ↓
Node.js HTTP Server
```

`NestFastifyApplication` 这个泛型参数不能省：它让 `app.register`、`app.getHttpAdapter()` 等 Fastify 专有方法在类型上可见（Express 应用没有 `register`）。

### 2.2 `FastifyAdapter` 三个参数的含义

| 参数         | 值                       | 为什么这么设                                                                                                                  |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `bodyLimit`  | `256 * 1_024`（256 KiB） | 采集请求是公开入口，必须先有硬上限，避免超大 body 撑爆内存。它与协议层的「单批最多 100 条事件」是两道独立防线                 |
| `trustProxy` | `true`                   | 生产部署在 Caddy 之后，真实客户端 IP 在 `X-Forwarded-For` 里。不信任代理时 `@Ip()` 会拿到代理 IP，导致限流把全站算作同一个 IP |
| `logger`     | `false`                  | 关闭 Fastify 自带日志，日志统一由 `RequestIdInterceptor` 以单行 JSON 输出，避免两套日志格式                                   |

### 2.3 `bufferLogs` 与「启动期日志」

```ts
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  adapter,
  { bufferLogs: true },
);
```

`bufferLogs: true` 表示：在应用初始化完成前产生的框架日志先缓存，不直接打印。它通常与自定义 Logger 搭配使用（先把启动日志缓冲，等自定义 logger 就绪后一次性输出，避免启动日志格式与应用日志不一致）。

**本项目当前没有注册自定义 Logger**，因此这一项是为将来接入统一日志预留的开关，不影响当前行为。

### 2.4 `app.get<T>(API_CONFIG)`：绕过构造注入拿依赖

```ts
const config = app.get<ApiConfig>(API_CONFIG);
```

`app.get()` 是 DI 容器的**外部访问入口**：从容器里按 token 取实例，而不是通过构造函数注入。

为什么这里必须用它：`bootstrap()` 是普通函数，不是 Provider，无法使用构造函数注入。而 `cookie` 的密钥、监听端口这些值只有在应用创建之后才需要，所以先建应用、再从容器取配置。

`API_CONFIG` 是一个 `Symbol`（见 `src/infrastructure/tokens.ts`），它的注册方式在 `InfrastructureModule` 中，详见第 4 章。

### 2.5 `app.register(cookie)`：Fastify 生态插件怎么挂

```ts
await app.register(cookie as never, { secret: config.COOKIE_SECRET });
```

这是本项目唯一的「中间件式」全局处理，但它**不是 NestJS 的 Middleware**，而是直接挂到 Fastify 实例上的官方插件。挂上之后有两处效果：

1. 请求侧：`request.cookies` 可用（`SessionGuard`、`AuthController.logout` 都读它）；
2. 响应侧：`reply.setCookie` / `reply.clearCookie` 可用（登录与登出）。

`as never` 是为了绕开 Nest 与 Fastify 插件类型定义之间的不兼容（Nest 期望的插件签名比 Fastify 官方的更宽）。这是类型层面的妥协，运行时行为不受影响。

### 2.6 `enableCors`：为什么 `origin: true` 而不是白名单

```ts
app.enableCors({
  origin: true,
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["content-type", "x-csrf-token", "x-request-id"],
});
```

- `origin: true`：回显请求方的 Origin，等价于「允许任何来源」。
- `credentials: true`：允许携带 Cookie（登录态），因此浏览器端请求必须显式带凭证。

**这里的宽松是安全的，原因是职责分工**：CORS 只保护「管理后台接口」（靠 Session + CSRF 守卫），而公开采集接口 `api/v3/ingest` 防护靠的是**写入键 + Origin 白名单 + 限流**（见 `IngestionService.assertOrigin`），并不依赖 CORS。也就是说，CORS 不是本项目的安全边界。

### 2.7 `enableShutdownHooks()` 与优雅关闭

```ts
app.enableShutdownHooks();
```

开启后 Nest 会在收到 `SIGTERM`/`SIGINT` 时依次调用实现了生命周期接口的 Provider。本项目用它来关闭数据库连接池与 Redis：

```ts
// src/infrastructure/infrastructure.module.ts
class InfrastructureShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.database.close(), this.redis.quit()]);
  }
}
```

两个细节值得记住：

- **用 `Promise.allSettled` 而不是 `Promise.all`**：数据库关失败不应该阻止 Redis 也被关闭，关闭阶段的错误需要被逐一吞掉。
- **不实现 `OnModuleDestroy` 而是 `OnApplicationShutdown`**：前者在每个模块销毁时触发，后者在应用收到信号时触发。容器滚动更新靠的是信号，用后者语义更准确。

### 2.8 `listen` 与启动失败处理

```ts
await app.listen(config.API_PORT, "0.0.0.0");
```

绑定 `0.0.0.0` 而不是 `127.0.0.1`，是为了让同一 Docker 网络内的 Caddy 能访问容器。

```ts
bootstrap().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', ... })}\n`);
  process.exitCode = 1;
});
```

启动失败写一行 JSON 到 stderr 并设置非零退出码。**不抛未捕获异常**，因为容器编排只关心退出码；用 `process.exitCode` 而非 `process.exit()` 可以让已排队的输出先 flush。

### 2.9 本项目没有使用 `@nestjs/cli`

`apps/api/package.json` 里没有 `@nestjs/cli`，也没有 `nest-cli.json`：

| 脚本        | 命令                            | 说明                                                               |
| ----------- | ------------------------------- | ------------------------------------------------------------------ |
| `dev`       | `tsx watch src/main.ts`         | 直接跑 TS，不经过编译产物，热重启由 tsx 提供                       |
| `build`     | `tsc -p tsconfig.build.json`    | 纯 `tsc` 编译，装饰器元数据由 `emitDecoratorMetadata` 生成         |
| `start`     | `node dist/main.js`             | 生产入口，容器 `CMD` 即 `pnpm --filter @browser-monitor/api start` |
| `typecheck` | `tsc --noEmit -p tsconfig.json` | 含 `tests/` 的类型检查                                             |
| `test`      | `vitest run`                    | 见第 12 章                                                         |

取舍很清晰：**少了 `nest build` 的 webpack/tsc 包装层，构建链更短、可预测**；代价是不能用 `nest g` 脚手架和 CLI 的插件体系——对这样一个模块数量固定的项目是划算的。

---

## 3. 模块装配：`AppModule` 与模块图

### 3.1 根模块只做装配

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
  controllers: [HealthController, MetricsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }],
})
export class AppModule {}
```

三条约定：

1. **根模块不放业务**，只列装配清单；
2. **`controllers` 里只放「不属于任何业务模块」的控制器**——健康检查与 Prometheus 指标。它们无鉴权需求、也不属于某个业务域，挂在根模块最直观；
3. **全局能力用 `APP_*` 令牌注册**，而不是调用 `app.useGlobalInterceptors()`。区别见 6.3。

### 3.2 五个业务模块的声明对比

| 模块                   | `imports`        | `controllers`         | `providers`                                                  | `exports`                                    |
| ---------------------- | ---------------- | --------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `InfrastructureModule` | —                | —                     | 配置 / DATABASE / REDIS / 关闭钩子                           | `API_CONFIG`、`DATABASE`、`REDIS`            |
| `AuthModule`           | —                | `AuthController`      | `AuthService`、`MailerService`、`SessionGuard`、`CsrfGuard`  | `MailerService`、`SessionGuard`、`CsrfGuard` |
| `ProjectsModule`       | `AuthModule`     | `ProjectsController`  | `ProjectsService`                                            | `ProjectsService`                            |
| `IngestionModule`      | —                | `IngestionController` | `IngestionService`、`IngestionRateLimiter`、`MetricsService` | `MetricsService`                             |
| `AnalyticsModule`      | `ProjectsModule` | `AnalyticsController` | `AnalyticsService`、`CustomSignalsService`                   | —                                            |
| `LabAuditsModule`      | `ProjectsModule` | `LabAuditsController` | `LabAuditsService`                                           | —                                            |

这张表读完，就能回答三个高频问题：

**Q：为什么 `IngestionModule` 要 `exports: [MetricsService]`？**
因为 `MetricsController` 声明在 `AppModule` 上，而 `MetricsService` 由 `IngestionModule` 提供。Nest 的可见性规则是「Provider 只有被 `exports` 后，导入该模块的模块才能注入」。`AppModule` 导入了 `IngestionModule`，因此能拿到被导出的 `MetricsService`。**这保证了整个进程只有一份指标注册表**——Prometheus 计数器跨模块必须是同一实例，否则 `/internal/metrics` 只能看到一部分数据。

**Q：为什么 `AnalyticsModule`、`LabAuditsModule` 要 `imports: [ProjectsModule]`？**
因为两者都需要「校验当前用户是否是该项目的成员」。这个能力由 `ProjectsService.requireAccess()` / `requireOwner()` 提供，而 `ProjectsService` 被 `ProjectsModule` 导出。

**Q：`AuthModule` 只被 `ProjectsModule` 导入，为什么其他模块用了它的守卫却不用导入？**
这是本项目里最容易看错的一处。`ProjectsModule` 导入了 `AuthModule`，但 `AnalyticsModule` / `LabAuditsModule` 的控制器同样用了 `SessionGuard` / `CsrfGuard` 却没导入 —— 它们能正常工作，原因是两种引用遵循不同规则：

| 引用方式                                          | 遵循 `exports` 规则？ | 说明                                                                         |
| ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| 构造函数注入（`private readonly x: SomeService`） | **遵循**              | Provider 必须由本模块提供，或由被导入的模块 `exports`                        |
| 装饰器里的类引用（`@UseGuards(SomeGuard)`）       | **不遵循**            | Nest 会为控制器所在的模块上下文实例化这个类，**不要求在 `providers` 里登记** |
| 参数装饰器（`@CurrentUser()`）                    | 不适用                | 它是工厂函数，只读 `request` 上的字段，本身无依赖                            |

`SessionGuard` 能这样实例化成功，还有一个前提：它唯一的依赖 `REDIS` 来自 `@Global()` 的 `InfrastructureModule`，**任何模块都能解析**。假如它依赖的是某个只在 `AuthModule` 内提供的 Provider，那么 `AnalyticsModule` 就必须显式 `imports: [AuthModule]`（或改用 `@UseGuards` 以外的注入方式）。

**结论**：`ProjectsModule` 导入 `AuthModule`，是为了构造函数里那个 `private readonly mailer: MailerService`（邀请邮件）。守卫的可用性与模块导入无关——这一点是排查「守卫没生效 / 报依赖找不到」时的关键区别。

### 3.3 模块依赖图

```text
                    AppModule
        ┌───────────────┼───────────────┬──────────────┐
        ↓               ↓               ↓              ↓
  Infrastructure   AuthModule    ProjectsModule   IngestionModule
    (@Global)          ↑              ↑                │
        │              │              │                │ exports
        │              └──────────────┤                ↓
        │                             │          MetricsService
        ├──────────── AnalyticsModule ┘           (供 AppModule 的
        │                             │            MetricsController)
        │                             └──── LabAuditsModule
        │
        └─ DATABASE / REDIS / API_CONFIG 对全部模块可见
```

要点：

- **`InfrastructureModule` 带 `@Global()`**，声明一次后所有模块无需 import 即可注入 `DATABASE` / `REDIS` / `API_CONFIG`。底层的连接与配置属于「全应用基础设施」，用 `@Global()` 比在 6 个模块里各写一次 `imports` 更不容易漏。
- **`Worker` 不在本进程**。异步投影、评级、聚合全部在 `apps/worker`（见 `platform/docs/浏览器监控平台-服务端全链路.md` 第 7 章），本 API 只负责接收与查询，因此这里看不到任何消费者代码。

---

## 4. 依赖注入实践

### 4.1 为什么用 Symbol Token 而不是类

```ts
// src/infrastructure/tokens.ts
export const DATABASE = Symbol("DATABASE");
export const REDIS = Symbol("REDIS");
export const API_CONFIG = Symbol("API_CONFIG");
```

`DATABASE` 的真实类型是 `DatabaseHandle`（`@browser-monitor/database` 包的接口），`REDIS` 来自第三方包 `ioredis`，`API_CONFIG` 是一个**普通对象**。

Nest 默认用「类的引用」作为 token，这要求依赖有一个可注入的类。但这里：

- 连接池/客户端是**工厂函数创建出来的实例**，不是某个类的 new；
- 配置是运行时从环境变量解析出的数据，没有类；
- 用 `Symbol` 还避免了「同一个名字在多个包里有不同实现」的歧义。

因此三者统一用 Symbol 做 token，注入处必须显式写 `@Inject(...)`。

### 4.2 `useFactory` + `inject`：把「创建」写成代码

```ts
// src/infrastructure/infrastructure.module.ts
providers: [
  { provide: API_CONFIG, useFactory: (): ApiConfig => loadApiConfig() },
  {
    provide: DATABASE,
    inject: [API_CONFIG],
    useFactory: (c: ApiConfig) => createDatabase(c.DATABASE_URL),
  },
  {
    provide: REDIS,
    inject: [API_CONFIG],
    useFactory: (c: ApiConfig) =>
      new Redis(c.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      }),
  },
  InfrastructureShutdown,
];
```

对照「快速上手」的 `providers: [UserService]` 简写形式，这里用的是完整对象形式，三个字段的分工是：

| 字段         | 作用                                                 |
| ------------ | ---------------------------------------------------- |
| `provide`    | token，即「这个依赖叫什么名字」                      |
| `inject`     | 创建它需要哪些其他依赖，由容器先解析好再作为参数传入 |
| `useFactory` | 创建逻辑本身，返回值就是被注入的实例                 |

这就是 DI 的核心思想在配置类依赖上的体现：**`DATABASE` 不关心 `API_CONFIG` 从哪来，只声明「我需要它」；顺序由容器决定**。`API_CONFIG → DATABASE / REDIS` 的依赖链是自动编排的。

`Redis` 三个参数的理由：`maxRetriesPerRequest: 2` 让 Redis 抖动时快速失败（限流、Session、缓存都不应无限等待）；`enableReadyCheck: true` 启动时确认服务端可用；`lazyConnect: false` 让连接在容器创建时就建立，配合 `health/ready` 探针才能真实反映「依赖是否就绪」。

### 4.3 注入的两种写法混用

同一个 Service 里经常同时出现两种注入方式：

```ts
// src/ingestion/ingestion.service.ts
@Injectable()
export class IngestionService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle, // Symbol token → 必须 @Inject
    @Inject(API_CONFIG) private readonly config: ApiConfig, // Symbol token → 必须 @Inject
    @Inject(REDIS) private readonly redis: Redis, // Symbol token → 必须 @Inject
    private readonly limiter: IngestionRateLimiter, // 类 token → 按类型自动注入
    private readonly metrics: MetricsService, // 类 token → 按类型自动注入
  ) {}
}
```

规则一句话：**token 是类就按类型注入，token 是 Symbol/字符串就必须 `@Inject`**。

### 4.4 生命周期钩子也能作为 Provider

`InfrastructureShutdown` 是一个**没有任何业务方法的类**，唯一作用是实现 `onApplicationShutdown`。把它注册进 `providers` 数组，Nest 就会实例化它并在应用关闭时调用钩子（配合 2.7 的 `enableShutdownHooks`）。

```ts
providers: [ /* ... */, InfrastructureShutdown ],
```

它没有被 `exports`，因为没有任何模块需要注入它——它只是「在正确的时机执行代码」的载体。这是生命周期钩子最常见的一种用法：**用一个 Provider 换取一个确定的执行时机**。

### 4.5 依赖解析总结图

```text
loadApiConfig()  ──► API_CONFIG ─┬─► createDatabase(DATABASE_URL) ──► DATABASE ─┐
                                 │                                            ├─► IngestionService
                                 └─► new Redis(REDIS_URL)      ──► REDIS    ──┤   AnalyticsService
                                                                              │   AuthService
                                                          MetricsService ─────┘   ProjectsService
                                                          IngestionRateLimiter ───┘
                                                          InfrastructureShutdown（仅消费生命周期）
```

---

## 5. 控制器实践：路由与参数装饰器全表

### 5.1 全部路由一览

| 控制器                | 类级路径                               | 守卫                           | 方法                                                                                                                                         | 动词 + 路径                                                                                                                                                                                                                                                                                                    | 状态码         |
| --------------------- | -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `IngestionController` | `api/v3/ingest`                        | 无（靠写入键 + Origin + 限流） | `ingestBatch`                                                                                                                                | `POST /:publicKey/envelopes`                                                                                                                                                                                                                                                                                   | 202            |
| `AuthController`      | `api/v1/auth`                          | 方法级                         | `register`                                                                                                                                   | `POST /register`                                                                                                                                                                                                                                                                                               | 202            |
|                       |                                        |                                | `verify`                                                                                                                                     | `POST /verify-email`                                                                                                                                                                                                                                                                                           | 204            |
|                       |                                        | 无                             | `login`                                                                                                                                      | `POST /login`                                                                                                                                                                                                                                                                                                  | 200            |
|                       |                                        | `SessionGuard`                 | `me`                                                                                                                                         | `GET /me`                                                                                                                                                                                                                                                                                                      | 200            |
|                       |                                        | `SessionGuard`+`CsrfGuard`     | `logout`                                                                                                                                     | `POST /logout`                                                                                                                                                                                                                                                                                                 | 204            |
|                       |                                        |                                | `forgot`                                                                                                                                     | `POST /forgot-password`                                                                                                                                                                                                                                                                                        | 202            |
|                       |                                        |                                | `reset`                                                                                                                                      | `POST /reset-password`                                                                                                                                                                                                                                                                                         | 204            |
| `ProjectsController`  | `api/v1`                               | 类级双守卫                     | `list` / `create` / `detail` / `origins` / `rotate` / `thresholds` / `invite` / `accept` / `retryDeadLetter`                                 | `GET /projects`、`POST /projects`、`GET /projects/:projectId`、`PUT /projects/:projectId/origins`、`POST /projects/:projectId/keys/rotate`、`PUT /projects/:projectId/thresholds`、`POST /projects/:projectId/invitations`、`POST /invitations/accept`、`POST /projects/:projectId/dead-letters/:taskId/retry` | 默认 201 / 204 |
| `AnalyticsController` | `api/v1/projects/:projectId/analytics` | 类级双守卫                     | `overview` / `performance` / `routes` / `customSignalList` / `customSignalDetail` / `customSignalRecords` / `customTrace` / `raw` / `status` | 全部 `GET`                                                                                                                                                                                                                                                                                                     | 200            |
| `LabAuditsController` | `api/v1/projects/:projectId`           | 类级双守卫                     | `settings` / `updateSettings` / `create` / `list` / `detail`                                                                                 | `GET /lab-settings`、`PUT /lab-settings`、`POST /lab-audits`、`GET /lab-audits`、`GET /lab-audits/:auditId`                                                                                                                                                                                                    | 201 / 200      |
| `HealthController`    | `health`                               | 无                             | `live` / `ready`                                                                                                                             | `GET /health/live`、`GET /health/ready`                                                                                                                                                                                                                                                                        | 200 / 503      |
| `MetricsController`   | `internal`                             | 无（靠网络隔离）               | `metricsText`                                                                                                                                | `GET /internal/metrics`                                                                                                                                                                                                                                                                                        | 200            |

两个观察：

- **路径前缀写在 `@Controller()` 里，没有用 `app.setGlobalPrefix()`**。原因是本项目的路由前缀不是单一的：采集是 `api/v3`，管理是 `api/v1`，运维是 `health` / `internal`。把版本号交给每个控制器自己写，比用全局前缀 + 例外更直接。
- **同一控制器的多个路径段可以共存**：`AnalyticsController` 的类级路径已含 `:projectId`，方法上再叠 `overview`、`custom-signals/detail`，最终拼成 `/api/v1/projects/:projectId/analytics/custom-signals/detail`。参数在类级与方法级各取一次。

### 5.2 参数装饰器：区分「取什么」和「怎么取」

`IngestionController` 一个方法里用满了 5 种来源：

```ts
@Post(':publicKey/envelopes')
@HttpCode(202)
ingestBatch(
  @Param('publicKey') publicKey: string,     // 路径参数，按名字取
  @Body() body: unknown,                     // 请求体，整体取（不按字段取）
  @Headers('origin') origin: string | undefined,  // 单个请求头
  @Ip() ip: string,                          // 客户端 IP（受 trustProxy 影响）
  @Req() request: FastifyRequest,            // 原始请求对象（这里为了拿 requestId）
): Promise<IngestionResult> { /* ... */ }
```

| 装饰器                        | 取什么       | 本项目用例                                     | 注意点                                                               |
| ----------------------------- | ------------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| `@Param(name)`                | 路径参数     | `publicKey`、`projectId`、`auditId`、`traceId` | 值永远是字符串，**不做类型转换**，所以 `traceId` 还要过一次 zod 校验 |
| `@Body()`                     | 请求体       | 全部写接口                                     | 类型写成 `unknown`，理由见 5.4                                       |
| `@Query()`                    | 查询串       | 全部分析接口                                   | 类型写 `unknown` 或 `Record<string, string \| undefined>`            |
| `@Headers(name)`              | 单个请求头   | `origin`                                       | 拿不到时是 `undefined`，由 Service 决定是拒绝还是放行                |
| `@Ip()`                       | 客户端 IP    | 限流维度                                       | 依赖 `trustProxy`，见 2.2                                            |
| `@Req()`                      | 原始请求对象 | 取 `requestId`、读 `cookies`                   | 与具体 HTTP 实现耦合（这里就是 Fastify 类型）                        |
| `@Res({ passthrough: true })` | 响应对象     | 写/清 Cookie                                   | **`passthrough: true` 是关键**，见 5.3                               |
| `@CurrentUser()`              | 当前登录用户 | 所有需鉴权接口                                 | 自定义装饰器，见 7.3                                                 |

### 5.3 `@Res({ passthrough: true })`：既要写响应头又要返回业务数据

登录需要「设置 Cookie（改响应）」+「返回用户信息（返回值）」两件事。`@Res()` 默认会接管整个响应，方法返回值就失效了。所以本项目用 `passthrough: true`：

```ts
// src/auth/auth.controller.ts
@Post('login')
@HttpCode(200)
async login(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
  const input = parseBody(loginSchema, body);
  const session = await this.auth.login(input.email, input.password);
  reply.setCookie('bm_session', session.token, {
    httpOnly: true,                                  // JS 读不到，防 XSS 窃取
    secure: this.config.NODE_ENV === 'production',   // 生产必须 HTTPS
    sameSite: 'lax',                                 // 防 CSRF 的第一道
    path: '/',
    expires: session.expiresAt,
  });
  return { user: session.user, csrfToken: session.user.csrfToken };  // 返回值照常参与序列化
}
```

**`passthrough: true` = 我借用响应对象改几个头，但最终响应仍由 Nest 生成。**

对比 `logout`：它只需要清 Cookie、不需要返回体，于是用 `@HttpCode(204)` + `passthrough: true` 返回 `void`，语义完整且不带 body。

### 5.4 为什么 `@Body()` 的类型是 `unknown`

```ts
async register(@Body() body: unknown): Promise<{ message: string }> {
  const input = parseBody(registerSchema, body);
  await this.auth.register(input.email, input.password, input.displayName);
  return { message: 'Verification email sent.' };
}
```

三步分工非常干净：

```text
@Body() body: unknown          ← HTTP 层：我不知道也不假设它是什么
      ↓
parseBody(schema, body)        ← 校验层：不合法就抛 400，合法则产出强类型 input
      ↓
this.auth.register(input.*)    ← 业务层：只接受已经验证过的类型
```

好处是**类型收窄发生在唯一一个地方**，Service 签名里永远不会出现「可能是任意形状的 object」。这也是本项目里 Controller 唯一承担的「有点逻辑」的工作。

### 5.5 控制器的职责边界

对比两个控制器可以看清这条边界：

```ts
// 只有参数提取 + 一行转发（典型）
@Get('overview')
overview(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, @Query() query: unknown) {
  return this.analytics.overview(user.id, projectId, this.filters(query));
}
```

即使 `AnalyticsController` 里有 `filters()`、`customFilters()` 两个私有方法，它们的职责也只是**把 `unknown` 的查询串解析成 `AnalyticsFilters`**——属于 HTTP 边界工作（输入的规范化），不涉及业务规则。真正的业务（时间范围夹取、Rollup 切换、SQL）都在 `AnalyticsService`。

---

## 6. 请求生命周期：五个环节在本项目的落地

「快速上手」给出的通用链路是 Middleware → Guard → Interceptor(before) → Pipe → Controller → Interceptor(after) → Exception Filter。本项目**只用了其中一部分**，哪些用、哪些不用、用什么替代，都值得说清楚：

| 阶段         | Nest 机制                          | 本项目是否使用     | 实际做法                                                                  |
| ------------ | ---------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| 中间件       | `NestMiddleware` / `configure()`   | **不使用**         | 唯一的前置处理是 Fastify 插件 `@fastify/cookie`，直接 `app.register` 挂载 |
| 守卫         | `CanActivate` + `@UseGuards`       | **大量使用**       | `SessionGuard`、`CsrfGuard`                                               |
| 拦截器（前） | `NestInterceptor`                  | **使用**           | `RequestIdInterceptor`：生成/透传 requestId                               |
| 管道         | `PipeTransform` / `ValidationPipe` | **不使用**         | 改用 zod `parseBody()` 在控制器内显式调用（第 8 章）                      |
| 控制器       | `@Controller`                      | 使用               | 第 5 章                                                                   |
| 拦截器（后） | `NestInterceptor` + rxjs           | **使用**           | 同一个拦截器的 `finalize()` 输出访问日志                                  |
| 异常过滤器   | `ExceptionFilter`                  | **不使用自定义的** | 依赖 Nest 内置过滤器 + 抛 `HttpException` 子类（6.5）                     |

### 6.1 请求时序图

```text
HTTP 请求
   │
   ├─① Fastify：解析 body（上限 256 KiB）、填充 request.cookies、分配 request.id
   │
   ├─② Nest 路由匹配：由 @Controller + @Get/@Post 生成的映射表决定调用哪个方法
   │
   ├─③ RequestIdInterceptor（全局，APP_INTERCEPTOR）
   │      生成或透传 x-request-id → 写入 request.requestId 与响应头 → 记录起始时间
   │
   ├─④ SessionGuard.canActivate()    ← 有 @UseGuards 的路由才执行
   │      Cookie 里没有会话 → 401 authentication_required
   │      Redis 里没有会话 → 401 session_expired
   │      命中 → 把会话对象挂到 request.auth
   │
   ├─⑤ CsrfGuard.canActivate()
   │      GET/HEAD/OPTIONS 直接放行；其余比对 x-csrf-token 与会话中的 token
   │
   ├─⑥ 参数装饰器执行：@Param / @Body / @Query / @Headers / @Ip / @CurrentUser
   │
   ├─⑦ Controller 方法体：parseBody 校验 → 调用 Service
   │
   ├─⑧ Service：SQL / 事务 / Redis / 限流，返回普通对象或抛 HttpException
   │
   ├─⑨ 返回值序列化为 JSON，套用 @HttpCode 指定的状态码
   │
   └─⑩ RequestIdInterceptor 的 finalize()：无论成功或异常都写一条访问日志
```

### 6.2 为什么只有 `RequestIdInterceptor` 一个拦截器，却同时做两件事

```ts
intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
  const incoming = request.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
  (request as FastifyRequest & { requestId: string }).requestId = requestId;
  response.header('x-request-id', requestId);
  return next.handle().pipe(finalize(() => { /* 写一行 JSON 日志 */ }));
}
```

逐点解释：

- **`context.switchToHttp()`**：拦截器可以作用于 HTTP、RPC、WebSocket 等不同上下文，`switchToHttp()` 把抽象的 `ExecutionContext` 转成 HTTP 的请求/响应对象。这是拦截器里必须写的一行。
- **透传优先、生成兜底**：上游（Caddy、网关、SDK）带了 `x-request-id` 就沿用，让一条链路可以跨进程串联；没带就自己 `randomUUID()`。长度 `<= 128` 是防头部注入。
- **把 requestId 挂回 `request`**：因为 `IngestionController` 需要把它放进审计信息里（`@Req() request` 正是为此）。
- **`response.header(...)`**：让客户端也能拿到 requestId，便于用户报障时直接提供。
- **`next.handle().pipe(finalize(...))`**：`finalize` 与 `tap`/`map` 的区别是它在**成功、失败、取消三种情况下都会执行**。访问日志必须覆盖「请求失败」的情况才有排查价值，所以这里必须是 `finalize`。
- **日志只记录 `request.url.split('?', 1)[0]`**：查询串可能含重置密码 token 或看板过滤条件，属于敏感/噪声数据，所以只留路径。

### 6.3 `APP_INTERCEPTOR` vs `useGlobalInterceptors()`

```ts
providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }];
```

两种写法都能全局生效，区别在于：

| 写法                                        | 生效时机                | 能否注入其他 Provider           | 推荐度               |
| ------------------------------------------- | ----------------------- | ------------------------------- | -------------------- |
| `app.useGlobalInterceptors(new X())`        | 在 `main.ts` 里手动注册 | **不能**（在容器之外 new 出来） | 仅适合无依赖的拦截器 |
| `{ provide: APP_INTERCEPTOR, useClass: X }` | 声明在模块里            | **能**，走完整 DI               | 本项目采用           |

本项目选后者，理由是可扩展性：将来这个拦截器若要注入 Logger 或配置，声明式写法不用改架构；同时全局能力也留在了模块声明里，「应用装了哪些全局组件」看 `AppModule` 就够，不用去翻 `main.ts`。

### 6.4 为什么没有管道：zod 取代 `ValidationPipe`

Nest 的标准做法是 DTO 类 + `class-validator` 装饰器 + `app.useGlobalPipes(new ValidationPipe())`。本项目完全不用，原因是协作方式：

- **协议包已经用 zod 定义了一套 Schema**（`@browser-monitor/protocol`），SDK、API、Worker 共用同一份契约。再写一遍 DTO 类等于把同一份约束维护两次。
- zod 的 Schema 是**值**，可以被组合、复用、`extend`、`superRefine`，而 DTO 装饰器是类元数据，组合能力弱。
- 校验失败时的响应体形状可以完全自定义（见 8.2），而 `ValidationPipe` 的输出形状由框架决定。

代价是**校验不再是全局自动的**，每个方法必须显式调用 `parseBody`。这是一种刻意的取舍：**用「必须写一行」换「校验规则只有一处来源」。**

### 6.5 异常处理：不写自定义 Filter 也够用

本项目没有任何 `@Catch()` 过滤器，统一靠「抛 `HttpException` 子类 + Nest 内置异常过滤器」。内置过滤器对异常的响应体规则是：

> **body 直接就是构造异常时传入的对象**，HTTP 状态码由异常类决定。

所以项目里所有错误都是这个形状：

```ts
throw new NotFoundException({ code: 'invalid_ingestion_key' });          // → 404 {"code":"invalid_ingestion_key"}
throw new BadRequestException({ code: 'invalid_request', message: '...', issues: [...] });  // → 400 {...}
throw new HttpException({ code: 'ingestion_rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);  // → 429
```

这种「**所有错误体都带一个稳定的 `code` 字段**」的约定，让 SDK 与前端可以只判断 `code` 而不解析自然语言 message，也让错误可以在文档和排查手册里形成一张表（见 10.4）。若将来需要统一加时间戳、traceId 等字段，再引入一个 `@Catch()` 过滤器即可，当前没有这个必要。

---

## 7. 鉴权链路：Session + CSRF 双守卫

### 7.1 `SessionGuard`：会话状态的唯一来源

```ts
// src/auth/session.guard.ts
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies?.bm_session;
    if (!token)
      throw new UnauthorizedException({ code: "authentication_required" });

    const session = await this.redis.get(`session:${hashToken(token)}`);
    if (!session) throw new UnauthorizedException({ code: "session_expired" });
    (request as AuthenticatedRequest).auth = JSON.parse(
      session,
    ) as AuthenticatedUser;
    return true;
  }
}
```

四个设计点：

1. **`CanActivate` 返回 `true` 或抛异常**。返回 `false` 时 Nest 会抛 403 且不带原因；本项目要给出精确的 `code`，所以**用抛异常代替返回 false**，这是守卫里很常见的实践。
2. **Cookie 里存的是随机 token，Redis 里存的是 `hashToken(token)` 为键的会话**。即使 Redis 数据泄露，也无法反推 Cookie 值；同时支持「服务端主动失效」（删除 Redis key 即登出所有设备）。
3. **`canActivate` 是 async 的**：守卫可以 `await` 任意异步操作，Nest 会等待 Promise 决议，不需要 callback 风格。
4. **把会话写回 `request.auth`**：守卫只负责「确认身份」，把结果挂在请求对象上供后续参数装饰器读取，避免每个 Service 重复查会话。

`AuthenticatedUser` 的类型（`id / email / displayName / sessionId / csrfToken`）与 `AuthenticatedRequest = FastifyRequest & { auth: AuthenticatedUser }` 也定义在这个文件里，供全局复用。

### 7.2 `CsrfGuard`：为什么它必须排在 `SessionGuard` 之后

```ts
// src/auth/csrf.guard.ts
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    const supplied = request.headers["x-csrf-token"];
    if (typeof supplied !== "string" || supplied !== request.auth.csrfToken) {
      throw new ForbiddenException({ code: "invalid_csrf_token" });
    }
    return true;
  }
}
```

- **读取 `request.auth.csrfToken`**，这要求 `SessionGuard` 已经执行过。`@UseGuards(SessionGuard, CsrfGuard)` 的数组顺序即执行顺序，顺序写反会直接抛 `TypeError`。**守卫顺序依赖是必须靠约定维护的一点。**
- **同步方法**：CSRF 比对完全在内存中完成，不查库，所以不需要 async。
- **放行 GET/HEAD/OPTIONS**：这些方法按 HTTP 语义应当是安全的（不改变状态）。这条规则的实际约束因此变成：**所有写操作必须用 POST/PUT/DELETE**，项目里的接口都遵守了。
- **配合 Cookie 的 `sameSite: 'lax'`**（见 5.3）形成两层防护：SameSite 挡住跨站的表单提交，CSRF Token 挡住同站内的伪造请求。

### 7.3 `CurrentUser`：自定义参数装饰器

```ts
// src/auth/current-user.ts
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
```

`createParamDecorator` 是 Nest 提供的「自定义参数来源」机制。它把「从请求对象上取 `auth`」这件事命名化，于是所有控制器里都写成：

```ts
overview(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string, ...)
```

对比不用它的写法 `@Req() req: AuthenticatedRequest` 再 `req.auth`——**参数名即文档**，而且 `user` 的类型是明确的 `AuthenticatedUser`，不需要每处都做类型断言。

`_data` 参数（本例未用）用来支持 `@CurrentUser('id')` 这类「取字段」的用法，本项目不需要，因此用下划线标记未使用。

### 7.4 守卫的三种作用域

本项目三种写法都有，可以对照理解 Nest 的作用域规则：

```ts
// ① 方法级：只有 /me 需要登录态
@Get('me')
@UseGuards(SessionGuard)
me(@CurrentUser() user: AuthenticatedUser) { /* ... */ }

// ② 控制器级：整个项目管理接口都要「登录 + CSRF」
@Controller('api/v1')
@UseGuards(SessionGuard, CsrfGuard)
export class ProjectsController { /* ... */ }

// ③ 全局级：本项目没用守卫，但用了同样机制的全局拦截器
providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }]
```

作用域越大，越容易「顺带保护了不该保护的接口」，也越容易「漏保护新加的接口」。本项目的选择是**默认控制器级、例外方法级**：`AuthController` 的大部分接口本就无需登录，所以它只在 `me`、`logout` 上标注；`Projects` / `Analytics` / `LabAudits` 整个控制器都要求登录，因此标在类上——**新加一个方法会自动获得保护**，这是比逐个标注更安全的方向。

---

## 8. 输入校验：为什么用 zod 而不是 ValidationPipe

### 8.1 Schema 定义在控制器文件顶部

```ts
// src/projects/projects.controller.ts（节选）
const createProjectSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  appName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/),
});
const originsSchema = z.object({
  origins: z.array(z.string().url()).min(1).max(50),
});
const rotateSchema = z.object({
  label: z.string().trim().min(1).max(80).default("rotated"),
});
```

**Schema 放在控制器文件顶部而不是单独的 `dto/` 目录**，理由是「就近原则」：Schema 与使用它的方法在同一个文件，改接口时不会出现「改了方法忘了改 DTO」。当 Schema 需要在多处复用时（如 `detailSchema` 由 `selectionSchema.extend()` 派生），仍然可以组合，只是组合发生在本文件内。

`rotateSchema` 里的 `.default('rotated')` 值得注意：**默认值由 Schema 提供**，因此 `label` 在类型上是 `string` 而不是 `string | undefined`，后续代码不必再处理缺省。

### 8.2 `parseBody`：唯一的校验出口

```ts
// src/common/http.ts
export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      code: "invalid_request",
      message: "Request validation failed.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
```

- 用 `safeParse` 而不是 `parse`：**不把 zod 的 `ZodError` 泄漏到 HTTP 层**，而是转换成 Nest 的 `BadRequestException`，从而复用统一的错误体形状（6.5）。
- `code` 固定为 `invalid_request`，`issues` 数组里带 `path`（点号连接的字段路径），前端可以直接定位到具体字段。
- 泛型 `<T>` 让返回值类型从 Schema 推导，调用处无需断言。

### 8.3 `superRefine`：跨字段一致性校验

`AnalyticsController` 的 `detailSchema` 除了字段级规则，还有两条**字段间依赖**的规则：

```ts
const detailSchema = selectionSchema
  .extend({
    metric: z.string().trim().min(1).max(64).optional(),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[a-zA-Z][a-zA-Z0-9_./%-]*$/)
      .optional(),
    aggregation: z
      .enum([
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "p50",
        "p75",
        "p90",
        "p95",
        "p99",
      ])
      .optional(),
  })
  .superRefine((selection, context) => {
    if (selection.metric && !selection.unit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unit is required when metric is selected",
      });
    }
    if (
      !selection.metric &&
      selection.aggregation &&
      selection.aggregation !== "count"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "count is the only aggregation without a metric",
      });
    }
  });
```

这两条规则是「选指标必须带单位」「不带指标时只能 count」。它们**无法用单字段规则表达**，`superRefine` 正是为这类约束准备的。校验通过后，控制器再做一次默认值决策：

```ts
aggregation: selection.metric ? (selection.aggregation ?? 'avg') : 'count',
```

**注意这里的分工**：Schema 负责「什么组合是非法的」，控制器负责「合法组合下的默认值」——校验与业务默认值不混在一起。

### 8.4 `@Query()` 的边界处理写在控制器里

```ts
const parsedLimit = Number(query.limit);
const limit = Number.isFinite(parsedLimit)
  ? Math.min(100, Math.max(1, Math.floor(parsedLimit)))
  : 50;
```

查询串里的一切都是字符串，`limit` 需要「解析 → 判 NaN → 夹到 1..100 → 兜底 50」。这类**取值范围约束**没有写进 zod Schema，而是写成一行表达式。取舍是：这类约束的语义偏「业务上限」（一次最多 100 条），放在控制器里比藏进 Schema 更容易被发现。

---

## 9. 服务层：业务链路与可复用能力

### 9.1 `IngestionService.ingest()`：一次采集请求的完整决策链

这是全项目最长的 Service 方法，恰好可以作为「Service 承载业务规则」的样板。它的执行顺序是固定的，**每一步失败都不写库**：

| 步骤 | 代码位置                                                                                         | 动作                                                       | 失败结果                                     |
| ---- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------- |
| 0    | `const stopTimer = this.metrics.ingestionDuration.startTimer()`                                  | 开始计时（Prometheus Histogram）                           | —                                            |
| 1    | `typeof body === 'string'` 时 `JSON.parse`                                                       | 兼容 `sendBeacon` 的 `text/plain`                          | 解析失败置 `null`，交给下一步                |
| 2    | 检查 `protocolVersion !== PROTOCOL_VERSION`                                                      | 协议版本闸门                                               | 422 `unsupported_protocol`                   |
| 3    | `telemetryBatchHeaderV3Schema.safeParse`                                                         | 批次头结构校验（`.strict()`）                              | 422 `invalid_batch` + issues                 |
| 4    | `await this.resolveProject(publicKey)`                                                           | 写入键 → 项目，顺带校验 key 状态与项目启用状态             | 404 `invalid_ingestion_key`                  |
| 5    | `await this.assertOrigin(project.project_id, origin)`                                            | Origin 白名单                                              | 403 `origin_required` / `origin_not_allowed` |
| 6    | `await this.limiter.consume(projectId, ip, events.length)`                                       | Redis 双令牌桶，按**事件数**扣减                           | 429 `ingestion_rate_limited`                 |
| 7    | `header.data.events.forEach(...)` 逐条                                                           | 事件级校验：Schema → `app.name` 一致 → 时间范围 → 二次脱敏 | **单条**进 `rejections`，不影响整批          |
| 8    | `new Set()` 过滤                                                                                 | 请求内 `eventId` 去重                                      | 计入 `duplicate`                             |
| 9    | `pg_advisory_xact_lock` + `SELECT ... GROUP BY`                                                  | 跨请求幂等：先按 ID 排序取咨询锁防死锁，再查已存在 ID      | 计入 `duplicate`                             |
| 10   | 单条 CTE：`INSERT telemetry_events ... ON CONFLICT DO NOTHING RETURNING` → `INSERT outbox_tasks` | **同事务写入原始事件与待处理任务**（Transactional Outbox） | 事务回滚                                     |
| 11   | `UPDATE ingestion_keys SET last_used_at = now()`                                                 | 写入键使用时间（用于轮换判断）                             | 事务回滚                                     |
| 12   | `metrics.ingestionEvents.inc({ result }, n)` + Redis 统计                                        | 指标与看板计数                                             | **失败不影响已提交的事务**（见下方注释）     |

几处值得单独记住的设计：

**① 两类失败策略的分界**

```text
整批拒绝（抛异常，什么都不写）：协议版本、批次结构、身份、Origin、限流
单条拒绝（写入 rejections 数组）：事件 Schema、app.name 不一致、时间越界
```

分界线是「这个错误是否只关乎某一条数据」。身份类错误代表整个请求不可信，必须整批拒绝；单条字段错误不应该让另外 99 条好数据一起丢掉。

**② 为什么时间范围校验是双边的**

```ts
if (
  parsed.data.occurredAt > now + 5 * 60_000 ||
  parsed.data.occurredAt < now - 30 * 24 * 60 * 60_000
) {
  rejections.push({ index, code: "event_time_out_of_range" });
  return;
}
```

允许未来 5 分钟（容忍客户端时钟轻微超前），不允许早于 30 天（那是明细保留期，早于它的数据即使入库也会立刻超出查询范围）。**校验规则与数据保留策略对齐**，这是两者之间一个容易被忽略的耦合点。

**③ 幂等为什么要「锁 + 查 + 冲突兜底」三件套**

```ts
const eventIds = uniqueValid.map((event) => event.eventId).sort(); // 排序是关键
await client.query(
  `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || ids.event_id, 0))
   FROM unnest($2::text[]) AS ids(event_id) ORDER BY ids.event_id`,
  [`ingest:${project.project_id}`, eventIds],
);
```

- **必须先取锁再查重**：两个并发的重叠批次如果各自「先查、都没查到、再插入」，就会双双重复写入。
- **必须排序**：两个批次包含相同 ID 集合但顺序不同时，不排序会出现 A 等 B、B 等 A 的死锁。
- **锁的粒度带项目前缀**（`ingest:${projectId}:${eventId}`）：不同项目的相同 eventId 不应互相阻塞。
- 最后 `ON CONFLICT DO NOTHING` 是**第三层兜底**：即使前两层都因故未命中，数据库仍不会写入重复行。三层叠加才敢承诺「重复上报不会重复计数」。

**④ 第 12 步为什么必须放在事务之外且失败不影响结果**

```ts
// Dashboard counters live in Redis because rejected events intentionally
// never enter the telemetry tables. A statistics failure must not turn a
// successfully committed ingestion request into a retryable SDK error.
```

数据已经落库并返回 202 了，此时如果因为 Redis 抖动而抛错，SDK 会认为上报失败并重试——**用一次成功的写入换来一次无意义的重试**。所以统计类操作一律「尽力而为」。

### 9.2 `AnalyticsService`：查询侧的服务层

查询侧 Service 的方法结构高度一致：`assertAccess → 构造 filters → 选择数据源 → 执行 SQL → 组装响应`。两个私有方法体现了它的业务规则位置：

```ts
private useRollups(filters: AnalyticsFilters): boolean {
  return filters.from.getTime() < Date.now() - 29 * 24 * 60 * 60_000;
}
```

**「查明细还是查 Rollup」这个决策写在 Service 里，而不是控制器里**——因为它是数据层的可行性约束（明细只保留 30 天），属于纯业务知识。控制器不需要知道这个 29 天的存在。

另外注意 `AnalyticsService` 的构造函数（`{ DATABASE, REDIS, ProjectsService }`）：**授权是通过注入 `ProjectsService` 并调用 `requireAccess` 完成的**，而不是靠守卫。方法的第一行几乎固定是：

```ts
async overview(userId: string, projectId: string, filters: AnalyticsFilters) {
  await this.projects.requireAccess(userId, projectId);
  // ...
}
```

这个写法能成立的前提，就是 `ProjectsModule` 导出了 `ProjectsService`、`AnalyticsModule` 导入了 `ProjectsModule`（第 3 章那张表的实际用途）。

### 9.3 `ProjectsService`：被导出的「可复用业务能力」

```ts
async requireAccess(userId: string, projectId: string): Promise<ProjectAccess> {
  const result = await this.database.pool.query<ProjectAccess>(
    `SELECT p.id, p.display_name, p.app_name, p.enabled, pm.role
     FROM projects p JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = $1 AND pm.user_id = $2`,
    [projectId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundException({ code: 'project_not_found' });
  return row;
}

async requireOwner(userId: string, projectId: string): Promise<ProjectAccess> {
  const access = await this.requireAccess(userId, projectId);
  if (access.role !== 'owner') throw new ForbiddenException({ code: 'owner_role_required' });
  return access;
}
```

这是「**授权不是守卫的专利**」的典型例子：

```text
SessionGuard     → 「你是谁」（认证 / Authentication）
CsrfGuard        → 「请求来源可信吗」（防伪造）
requireAccess    → 「你能不能看这个项目」（授权 / Authorization）
requireOwner     → 「你能不能改这个项目」（授权 + 角色）
```

为什么授权放在 Service 而不是做成 `ProjectGuard`：`projectId` 来自路径参数，而「谁能访问」的规则需要查库；把它做成守卫虽然可行，但会让「查库」这个动作分散在两个地方，且 `ProjectsService` 已经在查同一张表，**复用它就是零成本**。

这两个方法被 `AnalyticsService`、`CustomSignalsService`、`LabAuditsService` 共同调用，因此 `ProjectsModule` 必须 `exports: [ProjectsService]`，而使用方必须 `imports: [ProjectsModule]`——第 3 章那张表的由来就在这里。

### 9.4 Service 拿到依赖的方式

| Service            | 注入的依赖                                                                                     | 说明                                            |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `IngestionService` | `DATABASE` / `API_CONFIG` / `REDIS`（Symbol）+ `IngestionRateLimiter` / `MetricsService`（类） | 采集路径要限流与指标                            |
| `AnalyticsService` | `DATABASE` / `REDIS` / `ProjectsService`                                                       | 查询结果走 Redis 缓存；授权靠 `ProjectsService` |
| `ProjectsService`  | `DATABASE`                                                                                     | 只要库                                          |
| `AuthService`      | `DATABASE` / `REDIS` / `API_CONFIG`                                                            | 会话存 Redis，密码与令牌用共享包的函数          |
| `LabAuditsService` | `DATABASE` / `API_CONFIG` / `ProjectsService`                                                  | 见 `src/lab-audits/lab-audits.service.ts`       |

规律是：**Service 只声明自己真正用到的依赖**，没有「统一注入一个 AppContext」的写法。这依赖 Symbol token 的清晰命名，也是本项目能一眼看出「哪个 Service 会访问 Redis」的原因。

---

## 10. 横切关注点

### 10.1 requestId 的三个落点

```text
① 请求侧：request.headers['x-request-id'] → 校验长度 → 复用或生成
② 请求对象：request.requestId（供 Controller 传给 Service，最终写入审计/日志字段）
③ 响应侧：response.header('x-request-id', requestId)
```

采集结果里的 `requestId` 就来自第 ② 项，SDK 与平台因此可以对齐同一次请求的记录。

### 10.2 日志：单行 JSON 到 stdout

```ts
process.stdout.write(
  `${JSON.stringify({
    level: response.statusCode >= 500 ? "error" : "info",
    message: "request_completed",
    requestId,
    method: request.method,
    path: request.url.split("?", 1)[0],
    statusCode: response.statusCode,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  })}\n`,
);
```

约定：**一行一个 JSON、写到 stdout**，容器日志采集器可以直接解析；不使用 `console.log`（避免格式化开销与多参数输出）也不使用 `@nestjs/logger`（当前未注册自定义 Logger，见 2.3）。`level` 由状态码推导（≥500 记 error），不用业务代码手动指定。

### 10.3 Prometheus 指标：一个服务、一个注册表

```ts
// src/observability/metrics.service.ts
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly ingestionEvents = new Counter({
    name: "browser_monitor_ingestion_events_total",
    labelNames: ["result"],
    registers: [this.registry],
  });
  readonly ingestionDuration = new Histogram({
    name: "browser_monitor_ingestion_duration_seconds",
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });
  readonly outboxTasks = new Gauge({
    name: "browser_monitor_outbox_tasks",
    labelNames: ["status"],
    registers: [this.registry],
  });
  readonly deadLetterTasks = new Gauge({
    name: "browser_monitor_dead_letter_tasks",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: "browser_monitor_api_",
    });
  }
}
```

- **指标定义在字段上**（构造期即注册），而不是在请求里 `new Counter()`。Prometheus 客户端要求指标对象在进程内唯一，字段初始化正好满足这一点。
- **`collectDefaultMetrics`** 自动补充 event loop 延迟、内存、GC 等运行时指标，前缀区分来源。
- **`MetricsController` 负责「拉」而不是 Service 负责「推」**：

```ts
// src/observability/metrics.controller.ts
@Get('metrics')
@Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
async metricsText(): Promise<string> {
  const [outbox, deadLetters] = await Promise.all([ /* 查 outbox 状态分布、死信总数 */ ]);
  for (const status of ['pending', 'processing', 'failed']) { /* 更新 Gauge */ }
  this.metrics.deadLetterTasks.set(Number(deadLetters.rows[0]?.count ?? 0));
  return this.metrics.registry.metrics();
}
```

这里体现的是「**指标采集发生在被拉取时**」：那些需要查库才能得到的数字（Outbox 各状态数量、死信数）不做定时任务，而是在 `/internal/metrics` 被访问时顺手查一次。`@Header()` 装饰器直接声明响应头，不需要手写 `@Res`。

**注意这个控制器无守卫**，安全依赖 `infra/Caddyfile` 只允许私有网络访问 `/internal/metrics`——**网络隔离也是一种访问控制**，但必须在部署层实现。

### 10.4 错误码总表

所有错误体都带 `code`，全项目取值如下（可用于排查与 SDK 判断）：

| HTTP                      | `code`                                                                                                                        | 触发位置                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 400                       | `invalid_request`                                                                                                             | `common/http.ts` `parseBody`            |
| 400                       | `invalid_or_expired_token`                                                                                                    | `auth.service.ts` 邮箱验证 / 重置密码   |
| 400                       | `audit_origin_not_allowed`、`audit_header_not_allowed`、`duplicate_audit_header`、`invalid_audit_header`、`invalid_audit_url` | `lab-audits.service.ts`                 |
| 401                       | `authentication_required`、`session_expired`                                                                                  | `session.guard.ts`                      |
| 401                       | `invalid_credentials`、`email_not_verified`                                                                                   | `auth.service.ts` 登录                  |
| 403                       | `invalid_csrf_token`                                                                                                          | `csrf.guard.ts`                         |
| 403                       | `origin_required`、`origin_not_allowed`                                                                                       | `ingestion.service.ts` `assertOrigin`   |
| 403                       | `owner_role_required`、`invitation_email_mismatch`                                                                            | `projects.service.ts`                   |
| 404                       | `invalid_ingestion_key`                                                                                                       | `ingestion.service.ts` `resolveProject` |
| 404                       | `project_not_found`、`dead_letter_not_found`、`invalid_or_expired_invitation`、`lab_audit_not_found`                          | 各 Service                              |
| 409                       | `email_already_registered`、`at_least_one_origin_required`、`invitation_exists`、`project_disabled`、`audit_already_running`  | 各 Service                              |
| 422                       | `unsupported_protocol`、`invalid_batch`                                                                                       | `ingestion.service.ts`                  |
| 429                       | `ingestion_rate_limited`                                                                                                      | `ingestion.service.ts`                  |
| 503                       | `not_ready`                                                                                                                   | `health.controller.ts`                  |
| —（在 `rejections[]` 中） | `invalid_event`、`app_name_mismatch`、`event_time_out_of_range`                                                               | 事件级拒绝，**不改变 HTTP 状态码**      |

最后一行是关键区别：**采集接口的「部分成功」必须返回 202，只在响应体里报告被拒的条目**。把部分失败当整体失败，会让 SDK 重试整批，而其中 99 条是重复的。

### 10.5 健康检查：live 与 ready 的区别

```ts
@Controller("health")
export class HealthController {
  @Get("live") live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ok" }> {
    try {
      await Promise.all([
        this.database.pool.query("SELECT 1"),
        this.redis.ping(),
      ]);
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException({ code: "not_ready" });
    }
  }
}
```

| 接口            | 依赖           | 用途                                         |
| --------------- | -------------- | -------------------------------------------- |
| `/health/live`  | 无             | 进程是否活着。**重启能不能解决**的判断依据   |
| `/health/ready` | 数据库 + Redis | 是否可接流量。编排用它决定是否把请求路由进来 |

`live` 故意不查依赖：数据库暂时不可用时重启 API 进程毫无意义，反而会造成雪崩。`ready` 用 `Promise.all` 并发探测两个依赖，任一失败即 503。

---

## 11. 工程配置：ESM + 装饰器 + 构建

### 11.1 `tsconfig.base.json` 里的关键项

```json
{
  "target": "ES2022",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true,
  "useDefineForClassFields": false
}
```

每一项都不是可选项，缺任何一条都会直接出问题：

| 配置                             | 不设会怎样                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experimentalDecorators: true`   | `@Controller()`、`@Injectable()` 这些装饰器语法无法使用                                                                                                    |
| `emitDecoratorMetadata: true`    | **构造函数类型注入失效**。Nest 依赖 `design:paramtypes` 元数据知道「这个参数是什么类」；关掉后只能全部手写 `@Inject`                                       |
| `useDefineForClassFields: false` | ES2022 的类字段语义会用 `Object.defineProperty` 覆盖属性，**破坏 Nest 在实例化后对属性的赋值**，同时会干扰 `MetricsService` 那类「字段初始化即注册」的写法 |
| `module: NodeNext`               | 与 `package.json` 的 `"type": "module"` 配合，决定产物是 ESM                                                                                               |
| `noUncheckedIndexedAccess`       | 数组/对象下标访问会变成 `T \| undefined`，逼出 `result.rows[0]` 的存在性判断（项目里到处都是这类检查）                                                     |
| `exactOptionalPropertyTypes`     | 区分「属性缺失」与「属性为 undefined」，对可选的查询参数很关键                                                                                             |

### 11.2 为什么相对导入要写 `.js`

```ts
import { AppModule } from "./app.module.js"; // 源文件是 app.module.ts
import { API_CONFIG } from "../infrastructure/tokens.js";
```

这是 ESM 的硬要求：Node 的 ESM 解析器不做「扩展名补全」，必须给出真实的运行时文件路径。编译后 `app.module.ts` 变成 `app.module.js`，所以源码里就写 `.js`。**这是本项目所有 `import` 相对路径都带 `.js` 的唯一原因**，不是笔误。

同一个原因也解释了 `main.ts` 里的 `import 'reflect-metadata'`：它必须在任何装饰器元数据被读取之前执行，因此放在入口文件的最顶部导入。

### 11.3 与 Nest 官方脚手架的差异清单

| 官方默认                             | 本项目                           | 原因                                                             |
| ------------------------------------ | -------------------------------- | ---------------------------------------------------------------- |
| Express 适配器                       | Fastify                          | 吞吐与 schema 序列化能力，见 2.1                                 |
| `@nestjs/cli` + `nest build`         | `tsc` + `tsx watch`              | 构建链更短，见 2.9                                               |
| CommonJS                             | ESM（`type: module`）            | 与 workspace 其他包统一，见 11.2                                 |
| `class-validator` + `ValidationPipe` | zod + `parseBody`                | 契约单一来源，见 6.4                                             |
| `@nestjs/config`                     | `loadApiConfig()` + Symbol token | 校验逻辑集中在 `@browser-monitor/shared`，SDK 与 Worker 也能复用 |
| `Logger` / `LoggerModule`            | `process.stdout.write` 单行 JSON | 容器日志采集友好，见 10.2                                        |
| `nest test`（Jest）                  | `vitest`                         | 与 workspace 统一，见 12                                         |

---

## 12. 测试实践：vitest 如何构造 Nest Provider

本项目 `apps/api/tests/` 下有 4 个测试文件：`ingestion.service.spec.ts`、`custom-signals.controller.spec.ts`、`custom-signals.service.spec.ts`、`lab-audits.service.spec.ts`。它们的共同做法是**不启动 Nest 容器，直接 `new` 出被测对象并塞入假依赖**：

```ts
// tests/ingestion.service.spec.ts（节选）
const service = new IngestionService(
  { pool } as never, // DATABASE
  { ALLOW_ORIGINLESS_INGEST: false, USER_HASH_SECRET: "x".repeat(32) } as never, // API_CONFIG
  redis as never, // REDIS
  limiter as never, // IngestionRateLimiter
  metrics as never, // MetricsService
);
```

这样做的理由：

- **Service 的依赖就是构造函数的 5 个参数**——这正是 DI 让代码可测的直接体现。用 `@Inject(Symbol)` 注入的依赖在测试里只是一个对象字面量。
- **不需要 `Test.createTestingModule`**：容器会引入模块解析、Provider 覆盖等额外复杂度，而这里要验的是「给定这样的数据库响应，Service 做出什么决定」。
- **假对象按 SQL 内容分流**：

```ts
query: vi.fn(async (sql: string) => {
  if (sql.includes("SELECT event_id FROM telemetry_events")) {
    /* 模拟已存在/不存在 */
  }
  if (sql.includes("INSERT INTO telemetry_events")) {
    /* 模拟插入 */
  }
  return { rowCount: 1, rows: [] };
});
```

配合 `@browser-monitor/protocol/fixtures` 提供的 `createBatchFixture()`、`createPerformanceEventFixture()`、`invalidProtocolFixture()`，**测试数据与协议包同源**，协议变更时 fixture 会一起更新。

何时应该改用 `Test.createTestingModule`：当被测对象**依赖 Nest 的执行管线**时（守卫是否放行、装饰器取到什么值、拦截器顺序），构造式测试无法覆盖。本项目把这类逻辑做得足够薄（守卫是 10 行纯函数式判断），因此用更直接的方式验证 Service 层。

---

## 13. 概念对照表与扩展指南

### 13.1 「快速上手」概念 → 本项目文件

| 概念                            | 本项目落点                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `NestFactory.create` / 应用启动 | `src/main.ts` `bootstrap()`                                                          |
| FastifyAdapter                  | `src/main.ts`（`bodyLimit` / `trustProxy` / `logger`）                               |
| Root Module                     | `src/app.module.ts`                                                                  |
| 业务模块                        | `auth/`、`projects/`、`ingestion/`、`analytics/`、`lab-audits/` 各自的 `*.module.ts` |
| 全局基础设施模块                | `src/infrastructure/infrastructure.module.ts`（`@Global`）                           |
| Provider 注册（类简写）         | 各模块 `providers: [XxxService]`                                                     |
| Provider 注册（工厂 + token）   | `InfrastructureModule` 的三个 `useFactory`                                           |
| Dependency Injection            | 各 Service 构造函数                                                                  |
| Controller                      | `src/*/*.controller.ts`                                                              |
| 参数装饰器                      | `@Param` / `@Body` / `@Query` / `@Headers` / `@Ip` / `@Req` / `@Res`                 |
| 自定义参数装饰器                | `src/auth/current-user.ts` `@CurrentUser()`                                          |
| Guard                           | `src/auth/session.guard.ts`、`src/auth/csrf.guard.ts`                                |
| Interceptor                     | `src/common/request-id.interceptor.ts`                                               |
| 全局组件注册                    | `APP_INTERCEPTOR`（`app.module.ts`）                                                 |
| Pipe                            | **未使用**，替代品 `src/common/http.ts` `parseBody()`                                |
| Exception Filter                | **未自定义**，依赖内置过滤器 + `HttpException` 子类                                  |
| 生命周期钩子                    | `InfrastructureShutdown implements OnApplicationShutdown`                            |
| DTO                             | **不使用类**，用 zod Schema（定义在控制器文件顶部）                                  |
| 数据访问层                      | 直接 `DatabaseHandle.pool`（无 Repository 层）                                       |

### 13.2 加一个新接口要动哪些文件

以「给项目加一个 `GET /api/v1/projects/:projectId/summary`」为例，按依赖顺序：

```text
1. src/projects/projects.service.ts
   加 async summary(userId: string, projectId: string) { await this.requireAccess(userId, projectId); /* SQL */ }

2. src/projects/projects.controller.ts
   加 @Get('projects/:projectId/summary')
      summary(@CurrentUser() user: AuthenticatedUser, @Param('projectId') projectId: string) {
        return this.projects.summary(user.id, projectId);
      }
   （若带查询参数，另加 zod Schema + parseBody）

3. 无需改 *.module.ts —— 新方法在既有类上，Provider 与 Controller 都已注册
```

若新接口属于**新业务域**，则额外：新建 `xxx/xxx.module.ts`、`xxx/xxx.controller.ts`、`xxx/xxx.service.ts`，并在 `AppModule.imports` 里登记；若需要项目成员校验，再 `imports: [ProjectsModule]`。

**注意第 3 条**：因为守卫标在控制器类上（7.4），新接口会自动获得鉴权，不需要再写 `@UseGuards`。这正是「默认控制器级」这一选择带来的收益。

### 13.3 阅读本项目的推荐顺序

```text
main.ts                          → 应用怎么起来、装了什么全局件
app.module.ts                    → 有哪几个业务域
infrastructure.module.ts         → 依赖怎么创建、token 是什么
auth/session.guard.ts + csrf.guard.ts  → 请求怎么被拦
common/request-id.interceptor.ts → 请求怎么被包裹与记录
ingestion/ingestion.controller.ts → 最简单的控制器样板
ingestion/ingestion.service.ts    → 最完整的服务层样板
analytics/analytics.controller.ts → 参数校验与私有辅助方法的样板
```

---

## 附：一页速记

```text
启动：   NestFactory.create(AppModule, new FastifyAdapter({ bodyLimit, trustProxy, logger }))
         → app.get(API_CONFIG) → register(cookie) → enableCors → enableShutdownHooks → listen

装配：   AppModule.imports = [Infrastructure(@Global), Auth, Projects, Ingestion, Analytics, LabAudits]
         全局拦截器用 { provide: APP_INTERCEPTOR, useClass: X }

依赖：   Symbol token（DATABASE / REDIS / API_CONFIG）必须 @Inject；
         类 token 按类型自动注入；
         创建逻辑写在 useFactory + inject 里；
         关闭逻辑写在 OnApplicationShutdown 里

请求：   Fastify 解析 → 路由 → Interceptor/before → [SessionGuard → CsrfGuard] → 参数装饰器
         → Controller(parseBody 校验 → 调 Service) → Service(SQL/事务/缓存)
         → 返回值序列化 → Interceptor/finalize 记日志 → 异常走内置过滤器输出 { code }

校验：   zod Schema 定义在控制器文件顶部；parseBody 抛 400 invalid_request；
         跨字段规则用 superRefine

授权：   守卫管「你是谁 / 来源可信吗」；Service 的 requireAccess / requireOwner 管「能不能看/改这个项目」
```
