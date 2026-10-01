# Redis 体系源码学习

> **学习目标**：以当前 Browser Monitor 的真实源码为入口，逐步建立能够脱离项目独立使用的 Redis 知识体系。学习顺序不是先背 GET / SET 命令，而是按照“Redis 在系统中的位置 → 数据模型 → 命令执行与原子性 → 典型状态模型 → 缓存一致性 → 持久化与可靠性 → 高可用与性能治理”逐层深入。
>
> **分析范围**：项目事实以 browser-monitor/platform 当前源码为准；Redis 通用知识以 Redis 官方文档为主要依据；Node.js 客户端部分结合 ioredis 当前实现。每一节都按照“项目原文 → 源码执行链路 → 抽象通用知识 → 回到项目判断”的顺序展开。
>
> **与已有文档的关系**：[服务端数据管理源码学习.md](./服务端数据管理源码学习.md) 已经建立 PostgreSQL、Redis 在服务端数据体系中的总体位置。本文专门把 Redis 从“高速状态服务”继续展开成完整体系。

Redis 后续学习不按一串平铺知识点组织，而按下面的依赖关系展开：

~~~text
第一层：Redis 在系统中的位置
Redis Server / Client / Keyspace / Memory / Persistence
            │
            ▼
第二层：Redis 如何组织数据
String / Hash / List / Set / Sorted Set / Stream / TTL
            │
            ▼
第三层：Redis 如何执行一组状态变化
Command / Pipeline / MULTI-EXEC / Lua / Atomicity
            │
            ▼
第四层：Redis 如何形成工程状态模型
Session / Cache / Counter / Rate Limit / Sliding Window
            │
            ▼
第五层：Redis 如何与数据库共同工作
Cache-Aside / Invalidation / Version Key / Consistency
            │
            ▼
第六层：Redis 自身如何可靠运行
RDB / AOF / Memory Policy / Failure / Replication
            │
            ▼
第七层：Redis 如何扩展和治理
Hot Key / Big Key / Pipelining / Sentinel / Cluster / Observability
~~~

当前只进入第一层。

## 1. Redis 首先是独立运行的共享状态服务，而不是应用进程中的一个缓存对象

这一节先不学习 Hash、Sorted Set、Lua 等具体能力，而是先回答：

~~~text
Redis 到底是什么？
        ↓
它运行在哪里？
        ↓
Node.js 为什么能够调用它？
        ↓
为什么 PostgreSQL 已经存在，项目还需要 Redis？
        ↓
当前项目到底把哪些状态放进了 Redis？
~~~

只有先把这些边界建立起来，后面学习 Redis 数据结构时，才知道每一种结构是在解决什么系统问题。

### 【从当前项目的运行拓扑定位 Redis】

#### <u>1. Redis 在项目中首先是一个独立 Redis Server 进程</u>

先看当前项目的部署原文：

[platform/infra/docker-compose.yml](../../../infra/docker-compose.yml)

~~~yaml
redis:
  image: redis:7.4-alpine
  command: ["redis-server", "--appendonly", "yes"]
  volumes:
    - monitor-redis-data:/data
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
~~~

这段代码首先说明了一件最重要的事情：

~~~text
Redis
不是
Node.js 中的一个对象

Redis
首先是
独立运行的 Redis Server
~~~

当前运行环境中至少存在：

~~~text
API Process
Worker Process
PostgreSQL Server
Redis Server
~~~

它们是不同的运行单元。

Redis 容器内部执行：

~~~text
redis-server
~~~

API 和 Worker 并不会直接访问某个 JavaScript Map，而是通过网络连接到 Redis Server。

当前 Compose 中：

~~~yaml
REDIS_URL: redis://redis:6379
~~~

表达的是：

~~~text
redis://
    Redis 协议连接

redis
    Docker Compose 网络中的服务名

6379
    Redis Server 监听端口
~~~

因此当前项目的第一层关系是：

~~~text
API Process
    │
    │ Redis Protocol / TCP
    ▼
Redis Server :6379

Worker Process
    │
    │ Redis Protocol / TCP
    ▼
Redis Server :6379
~~~

这与 PostgreSQL 的关系非常相似：

~~~text
API / Worker
     │
     ├──────── PostgreSQL Client ────────► PostgreSQL Server
     │
     └──────── Redis Client ─────────────► Redis Server
~~~

所以 Redis 与 PostgreSQL 首先都是服务端系统中的“独立数据服务”，而不是 NestJS 内部模块。

区别主要在它们擅长保存和操作的数据形态，而不是“一个是服务、一个是库”。

---

#### <u>2. ioredis 是 Node.js 与 Redis Server 之间的客户端实现</u>

项目的 package.json 中声明：

~~~json
"ioredis": "^5.7.0"
~~~

API 并不是自己实现 Redis 网络协议，而是使用 ioredis：

[src/infrastructure/infrastructure.module.ts](../src/infrastructure/infrastructure.module.ts)

~~~ts
import { Redis } from 'ioredis';

new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: false,
})
~~~

这里需要建立第二层关系：

~~~text
业务代码
   ↓
ioredis Client
   ↓
Redis Protocol
   ↓
TCP Connection
   ↓
Redis Server
~~~

例如业务代码写：

~~~ts
await this.redis.get(key);
~~~

从业务视角看只是一个方法调用。

但运行时并不是：

~~~text
JavaScript Object
    ↓
直接读取本地内存
~~~

而是：

~~~text
Node.js
   ↓
ioredis 编码命令
   ↓
网络发送 GET ...
   ↓
Redis Server 执行命令
   ↓
返回结果
   ↓
ioredis 解析响应
   ↓
Promise resolve
~~~

因此下面两个概念不能混淆：

| 概念 | 当前项目中的实体 | 作用 |
|---|---|---|
| Redis Server | redis:7.4-alpine 容器 | 真正保存 Redis 数据并执行命令 |
| Redis Client | ioredis 创建的 Redis 实例 | 让 Node.js 连接并操作 Redis Server |

Redis 官方把 Redis描述为 **data structure server**，也就是“数据结构服务器”，它提供 String、Hash、List、Set、Sorted Set、Stream 等原生数据结构，而不只是一个字符串缓存接口。[Redis Data Types](https://redis.io/docs/latest/develop/data-types/)

ioredis 的配置也体现了“客户端正在维护网络连接”这一事实：

~~~ts
maxRetriesPerRequest: 2
enableReadyCheck: true
lazyConnect: false
~~~

其中：

- maxRetriesPerRequest：连接异常时，一个请求最多容忍多少次重试后失败；
- enableReadyCheck：连接建立后，还会确认 Redis 已完成数据加载并准备好接收命令；
- lazyConnect: false：创建 Redis Client 时就主动连接，而不是等到第一次命令时再连接。

ioredis 对这些选项的定义可以直接查看：[RedisOptions.ts](https://github.com/redis/ioredis/blob/main/lib/redis/RedisOptions.ts)。

这里先不深入断线重连、Offline Queue 和连接池，只建立：

~~~text
Redis Client
≠
Redis Server
~~~

---

#### <u>3. NestJS InfrastructureModule 把一个 Redis Client 作为全局基础设施依赖注入</u>

当前 API 并没有让每个 Service 自己执行：

~~~ts
new Redis(...)
~~~

而是在基础设施模块中统一创建：

~~~ts
{
  provide: REDIS,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): Redis =>
    new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    }),
}
~~~

REDIS 本身定义为：

[src/infrastructure/tokens.ts](../src/infrastructure/tokens.ts)

~~~ts
export const REDIS = Symbol('REDIS');
~~~

InfrastructureModule 又声明：

~~~ts
@Global()
@Module({
  providers: [
    ...
  ],
  exports: [API_CONFIG, DATABASE, REDIS],
})
~~~

于是业务 Service 只需要：

~~~ts
constructor(
  @Inject(REDIS) private readonly redis: Redis,
) {}
~~~

完整依赖关系是：

~~~text
App 启动
   ↓
InfrastructureModule
   ↓
读取 REDIS_URL
   ↓
new Redis(...)
   ↓
形成 Redis Client
   ↓
注册到 Nest IoC Container
   ↓
REDIS Token
   ↓
注入 Auth / Analytics / Ingestion / RateLimiter / Health
~~~

这里 Redis 本身解决的是“共享状态存储”，NestJS DI 解决的是“应用代码如何获得 Redis Client”。

二者属于不同层：

~~~text
Redis
    数据基础设施

ioredis
    Redis Client

Nest Provider
    Client 生命周期与依赖组织

Service
    业务状态模型
~~~

这也是阅读后端源码时必须建立的分层。

如果把它们全部统称为“Redis 代码”，就很难继续分析连接管理、状态模型和业务逻辑分别属于哪一层。

---

#### <u>4. API 与 Worker 连接同一个 Redis，让状态跨进程共享</u>

API 使用 InfrastructureModule 创建 Redis Client。

Worker 并不启动 NestJS，而是在自己的 main.ts 中单独创建客户端：

[apps/worker/src/main.ts](../../worker/src/main.ts)

~~~ts
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
});

const worker = new OutboxWorker(database, redis, config);
~~~

因此代码对象虽然不同：

~~~text
API Redis Client
Worker Redis Client
~~~

但是连接目标相同：

~~~text
REDIS_URL
   ↓
同一个 Redis Server
~~~

于是形成：

~~~text
               ┌──────── API Process
               │             │
               │          Redis Client A
               │             │
               ▼             ▼
        ┌──────────────────────────┐
        │       Redis Server       │
        │      Shared State        │
        └──────────────────────────┘
               ▲             ▲
               │             │
               │          Redis Client B
               │             │
               └──────── Worker Process
~~~

这就是 Redis 在分布式服务端系统中的一个核心价值：

> 不同进程可以通过 Redis 访问同一份共享状态。

如果把状态只放在：

~~~ts
const cache = new Map();
~~~

那么：

~~~text
API Process A
    Map A

API Process B
    Map B

Worker Process
    Map C
~~~

三个进程看到的是三份独立内存。

Redis 则把这份状态从应用进程内存中抽离出来：

~~~text
Application Memory
        ↓ 抽离
Redis Server
        ↓
Shared State
~~~

后续 Session、限流、缓存版本为什么可以跨请求甚至跨进程工作，都建立在这个基础上。

### 【从项目源码抽象 Redis 的核心数据模型】

#### <u>1. Redis 的基本模型不是“表和行”，而是 Key 到 Value 的映射</u>

关系型数据库首先建立：

~~~text
Database
  ↓
Table
  ↓
Row
  ↓
Column
~~~

Redis 的基础视角不同：

~~~text
Key
 ↓
Value
~~~

例如当前项目中的 Key：

~~~text
session:<tokenHash>

ingest:project:<projectId>

ingest:ip:<projectId>:<ip>

analytics:version:<projectId>

analytics:<projectId>:<version>:<namespace>:<filters>

ingestion:stats:<projectId>

ingestion:rate:<projectId>
~~~

这些 Key 本身已经携带业务命名空间。

可以先抽象成：

~~~text
namespace
    ↓
entity / scope
    ↓
identifier
    ↓
state
~~~

例如：

~~~text
session
   ↓
tokenHash
   ↓
AuthenticatedUser
~~~

或者：

~~~text
ingestion
   ↓
stats
   ↓
projectId
   ↓
accepted / duplicate / rejected
~~~

Redis 没有要求所有 Key 的 Value 都是相同结构。

Value 可以使用不同原生数据类型。

当前项目已经出现：

| 项目状态 | Redis 数据类型 | 主要命令 |
|---|---|---|
| Session | String | SET / GET / DEL |
| Token Bucket | Hash | HMGET / HSET |
| Analytics Cache Version | String / Integer | GET / INCR |
| Analytics Query Cache | String | GET / SET EX |
| Ingestion Statistics | Hash | HINCRBY / HGETALL |
| Recent Ingestion Rate | Sorted Set | ZADD / ZRANGEBYSCORE / ZREMRANGEBYSCORE |

这说明 Redis 的正确理解不是：

~~~text
Redis = GET / SET
~~~

而应该是：

~~~text
Redis
  ↓
Keyspace
  ↓
每个 Key 关联一种数据结构
  ↓
围绕数据结构执行原子命令
  ↓
组合成业务状态模型
~~~

下一节会专门从这一点进入 Redis 数据结构体系。

---

#### <u>2. TTL 让“状态应该存在多久”成为数据模型的一部分</u>

Redis 还有一个非常重要的维度：

~~~text
Key
 ↓
Value
 +
TTL
~~~

Redis 官方对 Key Expiration 的定义是：可以为 Key 设置 Time To Live，TTL 到期后 Key 会自动删除。[Keys and values](https://redis.io/docs/latest/develop/use/keyspace/)

当前项目大量状态都不是永久事实。

例如 Session：

[src/auth/auth.service.ts](../src/auth/auth.service.ts)

~~~ts
await this.redis.set(
  \`session:\${tokenHash}\`,
  JSON.stringify(user),
  'EX',
  this.config.SESSION_TTL_SECONDS,
);
~~~

这里同时写入：

~~~text
Value
AuthenticatedUser

TTL
SESSION_TTL_SECONDS
~~~

Analytics Cache：

[src/analytics/analytics.service.ts](../src/analytics/analytics.service.ts)

~~~ts
await this.redis.set(
  key,
  JSON.stringify(value),
  "EX",
  15,
);
~~~

只保留 15 秒。

Token Bucket：

[src/ingestion/rate-limiter.service.ts](../src/ingestion/rate-limiter.service.ts)

~~~lua
redis.call('EXPIRE', key, 60)
~~~

Ingestion Rate：

~~~ts
.expire(recentRateKey, 120)
~~~

因此在 Redis 中设计状态时，不只要问：

~~~text
这个 Key 保存什么？
~~~

还必须问：

~~~text
这个状态应该活多久？
到期以后能不能自动消失？
Redis 重启以后是否必须恢复？
~~~

这也是 Redis 与普通进程内 Map 相比非常关键的工程能力。

---

#### <u>3. Redis 以内存为主要工作数据集，但“内存数据库”不等于“重启一定全部丢失”</u>

Redis 常被简单描述成：

~~~text
内存数据库
~~~

这个说法容易产生误解：

~~~text
数据只存在内存
   ↓
Redis 一重启
   ↓
所有数据一定消失
~~~

实际 Redis 支持持久化机制。

Redis 官方当前提供的主要持久化方式包括：

~~~text
RDB
    周期性生成数据集快照

AOF
    记录写命令，并在重启时重放

RDB + AOF

No Persistence
~~~

参考：[Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)

当前项目已经显式启用：

~~~yaml
command: ["redis-server", "--appendonly", "yes"]
~~~

并挂载：

~~~yaml
volumes:
  - monitor-redis-data:/data
~~~

因此当前 Redis 不是完全无持久化运行。

可以先建立下面的概念边界：

~~~text
Redis 的主要读写工作集
        ↓
Memory

Redis 可选的恢复机制
        ↓
RDB / AOF
        ↓
Disk
~~~

但是：

> Redis 开启 AOF 并不意味着应该把所有核心业务事实都从 PostgreSQL 迁移进 Redis。

“Redis 能持久化”和“某份数据应该由 Redis 作为权威数据源”是两个完全不同的问题。

这一点会在后面的 Redis 与数据库一致性章节继续展开。

### 【当前项目用 Redis 保存的是高频状态、派生状态和短生命周期状态】

现在回到整个项目，不按文件看，而按“状态职责”重新整理。

#### <u>1. Session 使用 Redis 把认证状态放到共享高速状态层</u>

登录完成后，项目同时写入 PostgreSQL 和 Redis：

~~~text
Login
  ↓
验证账号密码
  ↓
PostgreSQL
INSERT user_sessions
  ↓
Redis
SET session:<tokenHash>
  ↓
Response Cookie
~~~

核心源码：

~~~ts
await this.redis.set(
  \`session:\${tokenHash}\`,
  JSON.stringify(user),
  'EX',
  this.config.SESSION_TTL_SECONDS,
);
~~~

后续请求经过 SessionGuard 时：

[src/auth/session.guard.ts](../src/auth/session.guard.ts)

~~~ts
const session = await this.redis.get(
  \`session:\${hashToken(token)}\`
);

if (!session) {
  throw new UnauthorizedException({
    code: 'session_expired',
  });
}
~~~

于是认证热路径变成：

~~~text
每个需要登录的请求
      ↓
Cookie
      ↓
Hash Token
      ↓
Redis GET
      ↓
AuthenticatedUser
~~~

而不是每个请求都去 PostgreSQL 查询 user_sessions。

这里 Redis 承担的是：

~~~text
高频读取
+
带 TTL 的 Session 状态
+
跨 API 实例共享认证状态
~~~

---

#### <u>2. Rate Limit 使用 Redis 保存多个请求共同修改的并发状态</u>

采集接口必须限制：

~~~text
某个 Project 每秒能接收多少事件

某个 Project + IP 每秒能接收多少事件
~~~

这类状态具有几个特点：

~~~text
更新频率高
多个请求同时竞争修改
状态生命周期短
需要共享
不能只存在单个 API 进程内
~~~

项目因此把 Token Bucket 状态放在 Redis：

~~~text
ingest:project:<projectId>

ingest:ip:<projectId>:<ip>
~~~

Value 使用 Hash：

~~~text
tokens
updated
~~~

然后通过 Lua 一次完成：

~~~text
读取 tokens / updated
       ↓
计算补充 token
       ↓
判断是否够消费
       ↓
更新 tokens / updated
       ↓
刷新 TTL
~~~

这个设计后面会引出 Redis 最重要的一类知识：

~~~text
并发状态
   ↓
Read-Modify-Write
   ↓
为什么多条独立命令可能产生竞争条件
   ↓
为什么 Lua 可以把逻辑放到 Redis Server 内原子执行
~~~

当前第一节只定位问题，原子性会在后续章节单独展开。

---

#### <u>3. Analytics 使用 Redis 保存可重新计算的查询结果</u>

Analytics 查询本质上依赖 PostgreSQL / TimescaleDB：

~~~text
Analytics API
    ↓
SQL
    ↓
Raw / Aggregate Data
    ↓
计算结果
~~~

但是同一个 Dashboard 可能在短时间内重复发出相同查询。

项目增加：

~~~text
Redis Cache
~~~

源码：

~~~ts
const version =
  (await this.redis.get(
    \`analytics:version:\${projectId}\`
  )) ?? "0";

const key =
  \`analytics:\${projectId}:\${version}:\${namespace}:\${JSON.stringify(filters)}\`;

const cached = await this.redis.get(key);

if (cached) {
  return JSON.parse(cached);
}

const value = await loader();

await this.redis.set(
  key,
  JSON.stringify(value),
  "EX",
  15,
);
~~~

因此数据链路变成：

~~~text
Request
   ↓
Redis GET
   │
   ├── Hit
   │     ↓
   │   Response
   │
   └── Miss
         ↓
      PostgreSQL / TimescaleDB
         ↓
      Compute
         ↓
      Redis SET EX 15
         ↓
      Response
~~~

Redis 中的查询结果不是权威事实。

它满足：

~~~text
删除以后
    ↓
可以重新从数据库计算
~~~

所以这是典型的：

~~~text
Derived State
可派生状态
~~~

后续缓存章节会进一步分析 Cache-Aside、TTL、失效和缓存穿透等问题。

---

#### <u>4. Worker 用版本 Key 连接异步写路径和 API 查询缓存</u>

Redis 不只连接 API 请求，还连接 Worker。

Worker 处理一条 Outbox Task 后：

[apps/worker/src/outbox-worker.ts](../../worker/src/outbox-worker.ts)

~~~ts
await this.redis.incr(
  \`analytics:version:\${task.project_id}\`
);
~~~

API 查询缓存时先读取同一个 Version：

~~~ts
const version =
  (await this.redis.get(
    \`analytics:version:\${projectId}\`
  )) ?? "0";
~~~

于是形成：

~~~text
Worker
   ↓
数据发生变化
   ↓
INCR analytics:version:<projectId>
   ↓
Version: 8 → 9

                    API 下一次查询
                           ↓
                    读取 Version 9
                           ↓
生成新的 Cache Key
                           ↓
旧 Version 8 缓存自然失去命中机会
~~~

这是一个非常重要的工程设计：

~~~text
不需要逐个寻找并删除所有旧查询 Key

而是
改变 Namespace Version
        ↓
让新请求自动进入新的缓存命名空间
~~~

这一模式后面会归入：

~~~text
Cache Invalidation
缓存失效

Versioned Cache Key
版本化缓存键
~~~

目前只需要知道：

> Redis 在这里承担了 API 与 Worker 之间的轻量共享协调状态。

---

#### <u>5. Ingestion Statistics 使用 Redis 保存“数据库不完整覆盖”的运行统计</u>

采集请求可能产生：

~~~text
accepted
duplicate
rejected
~~~

其中 rejected Event 不会进入 telemetry_events。

源码注释直接说明：

~~~ts
// Dashboard counters live in Redis because rejected events intentionally
// never enter the telemetry tables.
~~~

因此项目用：

~~~text
ingestion:stats:<projectId>
~~~

保存：

~~~text
accepted
duplicate
rejected
~~~

并通过 Hash 的 HINCRBY 累加。

同时：

~~~text
ingestion:rate:<projectId>
~~~

使用 Sorted Set 保存短时间窗口内的采集请求。

于是 Redis 又承担两类不同状态：

~~~text
累计计数
    Hash

时间窗口
    Sorted Set
~~~

这正是为什么 Redis 被称为 Data Structure Server：不同业务问题可以直接映射到不同原生数据结构。

### 【Redis 与 PostgreSQL 的边界来自数据职责，而不是单纯的速度差异】

#### <u>1. 当前项目没有把 Redis 当成“更快的 PostgreSQL”</u>

可以把当前项目中的数据分成两组。

第一组是业务事实：

~~~text
User
Project
Project Member
Telemetry Event
Performance Sample
Outbox Task
User Session Record
~~~

这些主要进入 PostgreSQL / TimescaleDB。

第二组是运行状态和派生状态：

~~~text
Session Hot State
Rate Limit Bucket
Analytics Cache
Analytics Cache Version
Ingestion Counters
Recent Ingestion Window
~~~

这些进入 Redis。

所以更准确的区分不是：

~~~text
PostgreSQL
    慢

Redis
    快
~~~

而是：

~~~text
PostgreSQL
    主要保存长期业务事实和关系

Redis
    主要保存需要高频访问、短生命周期、
    原子状态变化或快速派生的数据
~~~

速度很重要，但它不是唯一原因。

真正的工程问题是：

~~~text
这份数据是不是系统最终事实？

丢失以后能不能重建？

是否需要 TTL？

是否需要极高频的原子增减？

是否被多个进程共同访问？

是否值得为了读取速度保存副本？
~~~

这些问题共同决定数据应该放在哪里。

---

#### <u>2. 同一个 Redis Server 中不同 Key 可以拥有完全不同的数据可靠性要求</u>

虽然当前项目只有一个 Redis Server，但里面的状态语义并不相同。

例如：

~~~text
Session
    影响用户是否保持登录

Rate Limit
    影响采集是否允许通过

Analytics Cache
    丢失后可以重新计算

Ingestion Statistics
    用于 Dashboard 统计

Analytics Version
    影响缓存是否及时失效
~~~

这说明：

~~~text
同一个 Redis
≠
所有 Redis Key 都只是 Cache
~~~

因此后续分析 Redis 时，需要始终区分：

~~~text
Cache
    丢失后可重建

Ephemeral State
    本来就只应该短期存在

Coordination State
    多个进程共同使用的协调状态

Authoritative State
    系统真正的权威事实
~~~

当前项目绝大部分 Redis Key 属于前三类。

核心长期业务事实仍然主要由 PostgreSQL / TimescaleDB 承担。

### 【第一节回到源码形成完整 Redis 架构图】

把前面的源码重新收束，可以得到当前项目的 Redis 全景：

~~~text
                         Docker Compose
                              │
                              ▼
                     Redis Server :6379
                              │
             ┌────────────────┴────────────────┐
             │                                 │
             ▼                                 ▼
        API Redis Client                  Worker Redis Client
           ioredis                           ioredis
             │                                 │
             │                                 └─ INCR analytics:version
             │
             ├─ AuthService
             │    └─ Session String + TTL
             │
             ├─ SessionGuard
             │    └─ Session GET
             │
             ├─ IngestionRateLimiter
             │    └─ Hash + Lua + TTL
             │
             ├─ AnalyticsService
             │    ├─ Query Cache String + TTL
             │    ├─ Version String / INCR
             │    ├─ HGETALL Statistics
             │    └─ ZRANGEBYSCORE Recent Rate
             │
             ├─ IngestionService
             │    ├─ Hash Counters
             │    └─ Sorted Set Sliding Window
             │
             └─ HealthController
                  └─ PING Readiness
~~~

从知识体系角度，对应：

~~~text
Redis Server
   ↓
Client / Server
   ↓
Shared Keyspace
   ↓
Data Type
   ↓
Command
   ↓
TTL
   ↓
Atomic State Change
   ↓
Business State Model
~~~

这就是后续所有 Redis 知识的父级框架。

## 2. 下一节从 Keyspace 与数据结构进入 Redis 的数据组织体系

第一节已经建立：

~~~text
Redis 不是 NestJS 内部对象

Redis 是独立 Redis Server

ioredis 是 Node.js Client

NestJS DI 负责管理和注入 Client

API 与 Worker 通过 Redis 共享状态

Redis 的基础模型是 Key → Typed Value + TTL

当前项目同时使用
String / Hash / Sorted Set

不同 Redis Key 分别承担
Session / Rate Limit / Cache / Counter / Coordination
~~~

下一节再从：

~~~text
Key
 ↓
Value Type
 ↓
Command Semantics
 ↓
适用的数据模型
~~~

展开完整的数据结构体系，并逐个映射当前源码中的：

~~~text
String
Hash
Sorted Set
TTL
~~~

不会一开始把所有 Redis 命令平铺出来。

## 参考资料

[1] Redis. Redis Data Types. https://redis.io/docs/latest/develop/data-types/

[2] Redis. Keys and values / Key expiration. https://redis.io/docs/latest/develop/use/keyspace/

[3] Redis. Redis Persistence. https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/

[4] Redis. Scripting with Lua. https://redis.io/docs/latest/develop/programmability/eval-intro/

[5] Redis/ioredis. RedisOptions.ts. https://github.com/redis/ioredis/blob/main/lib/redis/RedisOptions.ts

[6] Redis/ioredis. README and connection behavior. https://github.com/redis/ioredis
