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
  `session:${tokenHash}`,
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
  `session:${tokenHash}`,
  JSON.stringify(user),
  'EX',
  this.config.SESSION_TTL_SECONDS,
);
~~~

后续请求经过 SessionGuard 时：

[src/auth/session.guard.ts](../src/auth/session.guard.ts)

~~~ts
const session = await this.redis.get(
  `session:${hashToken(token)}`
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
    `analytics:version:${projectId}`
  )) ?? "0";

const key =
  `analytics:${projectId}:${version}:${namespace}:${JSON.stringify(filters)}`;

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
  `analytics:version:${task.project_id}`
);
~~~

API 查询缓存时先读取同一个 Version：

~~~ts
const version =
  (await this.redis.get(
    `analytics:version:${projectId}`
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

## 2. Redis 通过 Keyspace、数据类型与命令语义组织共享状态

第一节已经回答了 Redis 在系统中的位置：

~~~text
Application
    ↓
Redis Client
    ↓
Redis Server
    ↓
Shared State
~~~

这一节继续向 Redis Server 内部走一层，回答：

> **Redis Server 中的状态究竟怎样被组织，以及为什么不同业务状态要选择不同的数据结构和命令。**

当前项目已经出现：

~~~text
session:<tokenHash>

ingest:project:<projectId>

ingest:ip:<projectId>:<ip>

analytics:version:<projectId>

analytics:<projectId>:<version>:<namespace>:<filters>

ingestion:stats:<projectId>

ingestion:rate:<projectId>
~~~

如果只把 Redis 理解成：

~~~text
Key → Value
~~~

仍然不够。

更完整的数据组织模型应该建立为：

~~~text
Redis Server
      ↓
Keyspace
      ↓
Key
      ↓
Value Type
      ↓
Commands
      ↓
Expiration
      ↓
Business State Model
~~~

每一层回答不同的问题：

| 层次 | 回答的问题 |
|---|---|
| Keyspace | Redis 中有哪些状态对象 |
| Key | 这一份状态属于谁 |
| Value Type | 这一份状态内部怎样组织 |
| Commands | 允许怎样读取和修改状态 |
| Expiration | 状态应该存在多久 |
| Business State Model | 这些能力最终解决什么业务问题 |

因此这一节不会把 String、Hash、Sorted Set 当成几个互不相关的 API 集合，而是沿着“业务状态怎样映射为 Redis 数据模型”这一条主线展开。

### 【Keyspace 负责组织 Redis Server 中全部状态对象】

#### <u>1. Redis 不通过 Table 和 Row 组织核心数据</u>

PostgreSQL 的基础数据组织模型是：

~~~text
Database
   ↓
Table
   ↓
Row
   ↓
Column
~~~

Redis 的核心模型不同。对于当前项目使用的 Redis 7.4，可以先建立：

~~~text
Redis Database
      ↓
Keyspace
      ↓
Key
      ↓
Typed Value
~~~

Keyspace 可以理解为当前 Redis Database 中所有 Key 共同组成的逻辑空间。

Monitor 运行以后，Redis 中可能同时存在：

~~~text
session:8b31...
session:91ac...

ingest:project:p001
ingest:project:p002

ingest:ip:p001:192.168.1.10
ingest:ip:p001:192.168.1.11

analytics:version:p001

analytics:p001:3:overview:{...}
analytics:p001:3:performance:{...}

ingestion:stats:p001
ingestion:rate:p001
~~~

这些对象在 Redis 看来首先都是 Keyspace 中的 Key。

Redis 并不知道：

~~~text
session 是一张表
analytics 是一张表
ingestion 是一张表
~~~

它看到的是一组独立 Key：

~~~text
session:8b31...
analytics:version:p001
ingestion:stats:p001
~~~

所以 Redis 的数据组织首先不是关系模型，而是：

~~~text
Key Identity
     +
Typed Value
~~~

Redis 官方将 Redis 定位为 Data Structure Server，核心原因就在这里：一个 Key 对应的 Value 不只是普通字符串，还可以直接使用 Hash、List、Set、Sorted Set、Stream 等数据结构。

---

#### <u>2. 冒号只是应用层 Key 命名约定，不会创建 Redis 目录</u>

当前源码使用的 Key 可以抽象为：

~~~text
session:<tokenHash>

ingest:project:<projectId>

ingest:ip:<projectId>:<ip>

analytics:version:<projectId>
~~~

在人脑中，可以把：

~~~text
analytics:version:p001
~~~

解释成：

~~~text
analytics
   ↓
version
   ↓
p001
~~~

但 Redis 内部并不存在：

~~~text
analytics/
    version/
        p001
~~~

这样的目录结构。

Redis 实际保存的仍然只是一个完整 Key：

~~~text
analytics:version:p001
~~~

所以冒号只是 Key Naming Convention。

常见 Key 设计可以抽象为：

~~~text
<domain>:<state-type>:<scope-id>:<sub-id>
~~~

当前项目中的：

~~~text
session:<tokenHash>

ingestion:stats:<projectId>

ingest:ip:<projectId>:<ip>
~~~

都符合这种思路。

这种命名方式同时解决：

~~~text
机器层面
    唯一标识一份状态

人类层面
    从 Key 名称理解业务作用和作用域
~~~

---

#### <u>3. Key 的真正作用是定义共享状态的身份和隔离范围</u>

分析 Redis 设计时，第一个问题不应该立即是：

~~~text
使用 String 还是 Hash？
~~~

而应该先问：

~~~text
这份状态属于谁？

什么条件决定两个请求
访问的是同一份状态？
~~~

例如 Project 级限流使用：

~~~text
ingest:project:<projectId>
~~~

如果 projectId 为 p001，那么所有属于 p001 的采集请求都会访问：

~~~text
ingest:project:p001
~~~

于是：

~~~text
Request A ─┐
Request B ─┼──► ingest:project:p001
Request C ─┘
~~~

这些请求共享同一个 Token Bucket。

而 IP 级限流使用：

~~~text
ingest:ip:<projectId>:<ip>
~~~

于是：

~~~text
Project p001 + IP A
        ↓
ingest:ip:p001:A

Project p001 + IP B
        ↓
ingest:ip:p001:B
~~~

不同 IP 被隔离成不同状态。

因此 Key 设计可以抽象成：

~~~text
Business State
      ↓
确定 Scope
      ↓
确定 Identity
      ↓
生成 Redis Key
~~~

当前项目可以得到：

| 状态 | Scope | Key |
|---|---|---|
| Session | Token | session:<tokenHash> |
| Project Rate Limit | Project | ingest:project:<projectId> |
| IP Rate Limit | Project + IP | ingest:ip:<projectId>:<ip> |
| Analytics Version | Project | analytics:version:<projectId> |
| Ingestion Statistics | Project | ingestion:stats:<projectId> |
| Recent Ingestion Rate | Project | ingestion:rate:<projectId> |

Key 解决“哪一份状态”的问题以后，才进入下一层：

~~~text
这份状态内部应该怎样组织？
~~~

### 【Redis 数据类型决定一份状态内部能够怎样被操作】

Redis 官方当前的数据类型已经非常丰富，但当前项目运行的是 Redis 7.4，并且源码实际使用的是经典核心结构中的：

~~~text
String
Hash
Sorted Set
~~~

为了建立完整基础框架，还需要知道：

~~~text
List
Set
Stream
~~~

的位置。

这一节先按访问模式建立它们之间的关系：

~~~text
一份整体值
    ↓
String

一个对象包含多个可独立操作字段
    ↓
Hash

强调元素左右顺序
    ↓
List

只关心唯一成员和集合关系
    ↓
Set

成员需要附带排序分值
    ↓
Sorted Set

持续追加并被消费者读取的记录流
    ↓
Stream
~~~

Redis 数据结构选择的核心原则是：

> **不要只看数据长什么样，要看业务需要对数据执行什么操作。**

Redis 官方的 Compare data types 也采用类似思路：String 更适合整体数据或简单 Counter；Hash 更适合频繁访问独立字段；Sorted Set 更适合带 Score 的有序集合。

### 【String 适合把一份状态作为整体进行读取、覆盖和计数】

#### <u>1. String 的逻辑模型是一条 Key 到一段字节序列的映射</u>

String 是 Redis 最基础的数据类型：

~~~text
Key
 ↓
String Value
~~~

Redis String 不只表示普通文本，它可以承载：

~~~text
普通文本
JSON 序列化结果
整数形式数据
二进制数据
~~~

当前项目主要使用：

~~~text
JSON State
Integer Counter
~~~

分别对应：

~~~text
Session / Analytics Cache
Analytics Version
~~~

---

#### <u>2. SET 写入或覆盖完整 String Value</u>

SET 的基础语义是：

~~~text
SET key value
~~~

如果 Key 不存在，就创建；如果已经存在，就把该 Key 的 String Value 替换成新值。

项目登录逻辑位于：

[src/auth/auth.service.ts](../src/auth/auth.service.ts)

原始逻辑是：

~~~ts
await this.redis.set(
  "session:<tokenHash>",
  JSON.stringify(user),
  "EX",
  this.config.SESSION_TTL_SECONDS,
);
~~~

这里为了突出 Redis 语义，把实际模板 Key 记为 session:<tokenHash>。

完整变化：

~~~text
AuthenticatedUser
      ↓
JSON.stringify
      ↓
String Value
      ↓
SET session:<tokenHash>
~~~

Redis 并不知道这个 String 内部有哪些 user 字段。

对于 Redis 来说：

~~~text
Key
    session:<tokenHash>

Value
    一整段 JSON String
~~~

当前 Session 的访问模式是：

~~~text
登录
    整体写入 User

认证
    整体读取 User

退出
    整体删除 Session
~~~

没有明显的字段级修改需求，因此整个对象序列化成 String 很自然。

---

#### <u>3. GET 读取完整 String，应用负责反序列化</u>

SessionGuard 的源码逻辑位于：

[src/auth/session.guard.ts](../src/auth/session.guard.ts)

核心过程：

~~~ts
const session = await this.redis.get(
  "session:<hashToken(token)>"
);

if (!session) {
  throw new UnauthorizedException({
    code: "session_expired",
  });
}

request.auth = JSON.parse(session);
~~~

运行链路：

~~~text
Cookie Token
     ↓
hashToken
     ↓
构造 Redis Key
     ↓
GET session:<hash>
     ↓
String | null
     ↓
JSON.parse
     ↓
AuthenticatedUser
~~~

因此：

~~~text
Redis String
负责
保存完整字节值

Application
负责
理解内部 JSON 结构
~~~

如果 JSON 内部某个字段发生变化，Redis 本身不会知道具体变更了哪个 JSON Field。

---

#### <u>4. SET ... EX 把生命周期和写入一起定义</u>

当前 Session 使用：

~~~text
SET key value EX seconds
~~~

EX 表示以秒为单位同时设置 Key 的过期时间。

所以一次 SET 实际确定：

~~~text
session:<tokenHash>
│
├── Type = String
├── Value = AuthenticatedUser JSON
└── TTL = SESSION_TTL_SECONDS
~~~

认证热路径于是变成：

~~~text
Key 存在
    ↓
可以读取 Session

Key 不存在
    ↓
session_expired
~~~

数据库中的 user_sessions 仍然承担持久化 Session 记录；Redis String + TTL 解决的是高频认证状态读取。

---

#### <u>5. DEL 删除整个 Key，而不是 String 内部字段</u>

Logout 中执行：

~~~text
DEL session:<tokenHash>
~~~

DEL 是通用 Key 命令，不只作用于 String。

语义是：

~~~text
删除整个 Key
      ↓
Value 和 TTL 一起消失
~~~

于是 Session 生命周期形成：

~~~text
Login
  ↓
SET + EX

Request
  ↓
GET

Logout
  ↓
DEL

TTL 到期
  ↓
Key 自动失效
~~~

---

#### <u>6. INCR 把 String 用作整数 Counter</u>

Worker 处理任务完成以后会执行：

[apps/worker/src/outbox-worker.ts](../../worker/src/outbox-worker.ts)

~~~text
INCR analytics:version:<projectId>
~~~

假设：

~~~text
analytics:version:p001
        ↓
8
~~~

执行 INCR 后：

~~~text
analytics:version:p001
        ↓
9
~~~

如果 Key 不存在，INCR 会把初始值视为 0，再增加到 1。

这里 Value Type 仍然是 String，只是 Redis 把这份 String 解释成整数并执行计数操作。

因此当前项目中的 String 已经形成两类模型：

~~~text
String
│
├── 整体数据
│     ├── Session JSON
│     └── Analytics Query Result JSON
│
└── Integer Counter
      └── Analytics Version
~~~

---

#### <u>7. Analytics Query Cache 同样属于整体 String 模型</u>

AnalyticsService 的核心源码位于：

[src/analytics/analytics.service.ts](../src/analytics/analytics.service.ts)

逻辑可以还原为：

~~~ts
const version =
  (await this.redis.get(
    "analytics:version:<projectId>"
  )) ?? "0";

const cached = await this.redis.get(cacheKey);

if (cached) {
  return JSON.parse(cached);
}

const value = await loader();

await this.redis.set(
  cacheKey,
  JSON.stringify(value),
  "EX",
  15,
);
~~~

因此查询链路是：

~~~text
构造 Cache Key
      ↓
GET
      ↓
  ┌── Hit
  │     ↓
  │  JSON.parse
  │     ↓
  │  Response
  │
  └── Miss
        ↓
      loader()
        ↓
PostgreSQL / TimescaleDB
        ↓
   Query Result
        ↓
 JSON.stringify
        ↓
 SET ... EX 15
        ↓
     Response
~~~

查询结果主要是整体读取和整体替换，因此仍然适合 String。

String 可以先收束成：

~~~text
整体读写
    ↓
String

简单整数计数
    ↓
String + INCR
~~~

### 【Hash 适合一个 Key 下保存多个可以独立读取或修改的字段】

#### <u>1. Hash 的逻辑模型是 Key → Field → Value</u>

String：

~~~text
Key
 ↓
Value
~~~

Hash：

~~~text
Key
 ↓
Field
 ↓
Value
~~~

例如：

~~~text
ingestion:stats:p001
│
├── accepted  → 100
├── duplicate → 20
└── rejected  → 5
~~~

其中：

~~~text
ingestion:stats:p001
    Redis Key

accepted / duplicate / rejected
    Hash Field

100 / 20 / 5
    Field Value
~~~

Hash 可以理解为一个 Redis Key 下组织多个 Field-Value Pair。

它与关系数据库的一行数据在视觉上有相似之处，但不能直接理解成 SQL Row，因为 Hash 没有 Schema、Foreign Key、JOIN 等关系数据库能力。

---

#### <u>2. HSET 写入一个或多个 Hash Field</u>

基础语义：

~~~text
HSET key field value
~~~

例如：

~~~text
HSET user:123 name Tom
~~~

逻辑结果：

~~~text
user:123
└── name → Tom
~~~

当前 Token Bucket Lua 中会执行：

~~~text
HSET <bucket-key>
     tokens <newTokens>
     updated <now>
~~~

于是：

~~~text
<rate-limit-key>
│
├── tokens  → 当前剩余令牌数
└── updated → 上一次更新时间
~~~

这里不是把整个 Bucket JSON.stringify 后 SET，而是直接保存两个可以独立访问的状态字段。

---

#### <u>3. HMGET 一次读取同一个 Hash 中多个指定 Field</u>

Token Bucket 中：

~~~text
HMGET <bucket-key> tokens updated
~~~

语义：

~~~text
定位 Hash Key
     ↓
读取 tokens
     ↓
读取 updated
     ↓
按请求顺序返回两个 Value
~~~

如果使用 JSON String：

~~~text
GET 整个 JSON
    ↓
JSON.parse
    ↓
读取 tokens / updated
~~~

Hash 则可以直接进行 Field 级读取。

---

#### <u>4. HGETALL 读取一个 Hash 当前全部 Field</u>

AnalyticsService 查询服务状态时执行：

~~~text
HGETALL ingestion:stats:<projectId>
~~~

如果当前：

~~~text
ingestion:stats:p001
│
├── accepted  → 100
├── duplicate → 20
└── rejected  → 5
~~~

HGETALL 会返回整组 Field / Value。

因此这个 Hash 的访问模式是：

~~~text
写入
    单独修改 Field

读取
    一次读取整个统计对象
~~~

---

#### <u>5. HINCRBY 直接对某个 Field 做整数增量</u>

项目中的采集统计源码位于：

[src/ingestion/ingestion.service.ts](../src/ingestion/ingestion.service.ts)

当前逻辑：

~~~ts
.hincrby(
  statisticsKey,
  "accepted",
  accepted,
)
.hincrby(
  statisticsKey,
  "duplicate",
  duplicate,
)
.hincrby(
  statisticsKey,
  "rejected",
  rejections.length,
)
~~~

HINCRBY 命令模型：

~~~text
HINCRBY key field increment
~~~

例如：

~~~text
ingestion:stats:p001

accepted  = 100
duplicate = 20
rejected  = 5
~~~

本次请求 accepted = 8：

~~~text
HINCRBY ingestion:stats:p001 accepted 8
~~~

执行后：

~~~text
accepted  = 108
duplicate = 20
rejected  = 5
~~~

从状态变化角度可以理解为：

~~~text
定位 Key
   ↓
定位 Field
   ↓
对该 Field 当前整数值增加 increment
   ↓
保存新值
   ↓
返回增加后的值
~~~

如果用 JSON String 实现同样逻辑，应用可能需要：

~~~text
GET
 ↓
JSON.parse
 ↓
accepted += 8
 ↓
JSON.stringify
 ↓
SET
~~~

Hash + HINCRBY 则把“字段级整数累加”直接表达成一条 Redis 命令。

这里暂时不展开“为什么两个并发 HINCRBY 不会产生普通 Read-Modify-Write 覆盖”，因为那属于下一节的命令原子性。

---

#### <u>6. Ingestion Statistics 是典型的 Hash Counter Model</u>

当前源码先构造：

~~~text
statisticsKey
    =
ingestion:stats:<projectId>
~~~

然后：

~~~text
一次 Ingestion Request
      ↓
得到

accepted
duplicate
rejected
      ↓
分别 HINCRBY
      ↓
同一个 Project Statistics Hash
~~~

完整设计推导：

~~~text
业务状态
    Project 采集统计

Scope
    Project

Key
    ingestion:stats:<projectId>

内部结构
    多个独立 Counter

访问模式
    高频字段累加
    Dashboard 整体读取

Value Type
    Hash

Commands
    HINCRBY
    HGETALL
~~~

---

#### <u>7. Token Bucket 同样使用 Hash，但访问模式不同</u>

RateLimiter 中：

~~~text
Key
ingest:project:<projectId>

Hash
│
├── tokens
└── updated
~~~

以及：

~~~text
Key
ingest:ip:<projectId>:<ip>

Hash
│
├── tokens
└── updated
~~~

读取：

~~~text
HMGET key tokens updated
~~~

修改：

~~~text
HSET key tokens <newTokens> updated <now>
~~~

因此同样使用 Hash，并不意味着业务模型相同。

Ingestion Statistics：

~~~text
Field = Counter
操作 = HINCRBY
~~~

Token Bucket：

~~~text
Field = Algorithm State
操作 = HMGET + 计算 + HSET
~~~

真正决定 Redis 数据结构和命令组合的是 Access Pattern。

### 【Sorted Set 通过 Member + Score 表达需要排序和范围查询的集合】

#### <u>1. Sorted Set 同时具有唯一 Member 和排序 Score</u>

Sorted Set 为每一个 Member 关联一个 Score：

~~~text
Member
  +
Score
~~~

例如：

~~~text
request-A → 1000
request-B → 1020
request-C → 1050
~~~

Redis 按照 Score 维护顺序：

~~~text
Sorted Set Key
      ↓
Member A ── Score
Member B ── Score
Member C ── Score
      ↓
按照 Score 排序
~~~

Sorted Set 中 Member 是唯一的；同一个 Member 再次 ZADD 时，默认会更新它的 Score。不同 Member 可以拥有相同 Score。

因此它适合：

~~~text
排行榜
优先级
时间排序
时间窗口
带评分的唯一成员集合
~~~

当前 Monitor 使用的是“时间窗口”。

---

#### <u>2. ZADD 写入 Score + Member，并由 Redis 维护排序关系</u>

基础语义：

~~~text
ZADD key score member
~~~

当前源码：

[src/ingestion/ingestion.service.ts](../src/ingestion/ingestion.service.ts)

~~~ts
.zadd(
  recentRateKey,
  recordedAt,
  JSON.stringify([requestId, accepted]),
)
~~~

这里映射为：

~~~text
Key
    ingestion:rate:<projectId>

Score
    recordedAt

Member
    [requestId, accepted]
~~~

例如：

~~~text
recordedAt = 1760000001000
requestId  = req-001
accepted   = 20
~~~

逻辑写入：

~~~text
ZADD
ingestion:rate:p001
1760000001000
["req-001",20]
~~~

继续收到请求后：

~~~text
1760000001000 → ["req-001",20]
1760000003500 → ["req-002",18]
1760000007200 → ["req-003",25]
~~~

Redis 不需要查询时再临时排序，因为 Score 就是 Sorted Set 数据模型的一部分。

所以：

~~~text
timestamp
   ↓
Score
   ↓
天然得到时间顺序
~~~

---

#### <u>3. ZADD 对已存在 Member 的默认行为是更新 Score</u>

如果：

~~~text
ZADD ranking 100 user-A
~~~

然后再次：

~~~text
ZADD ranking 120 user-A
~~~

最终不是两个 user-A，而是：

~~~text
user-A → 120
~~~

所以 Sorted Set 的核心约束是：

~~~text
Member 唯一
Score 可更新
~~~

当前项目使用包含 requestId 的 Member，因此正常情况下每个采集请求形成一个独立成员。

---

#### <u>4. ZRANGEBYSCORE 按 Score 范围读取 Member</u>

AnalyticsService 查询最近采集请求时：

~~~ts
this.redis.zrangebyscore(
  "ingestion:rate:<projectId>",
  recentSince,
  "+inf",
)
~~~

命令模型：

~~~text
ZRANGEBYSCORE key min max
~~~

这里：

~~~text
min = recentSince
max = +inf
~~~

所以条件是：

~~~text
score >= recentSince
~~~

由于 Score = recordedAt：

~~~text
score 范围查询
        ↓
时间范围查询
~~~

例如：

~~~text
当前时间
10:01:00

recentSince
10:00:00
~~~

则：

~~~text
ZRANGEBYSCORE
      ↓
返回最近一分钟窗口中的请求
~~~

Redis 6.2 以后也提供 ZRANGE ... BYSCORE 统一语法；当前项目使用的 ZRANGEBYSCORE 在 Redis 7.4 中仍然可用，因此本文按源码保持原命令理解。

---

#### <u>5. ZREMRANGEBYSCORE 按 Score 范围删除旧 Member</u>

写入当前请求后，源码继续执行：

~~~ts
.zremrangebyscore(
  recentRateKey,
  0,
  recordedAt - 60_000,
)
~~~

含义：

~~~text
删除 Score 位于

0
到
recordedAt - 60_000

之间的 Member
~~~

因为 Score = timestamp，所以：

~~~text
recordedAt - 60_000
        ↓
当前时间 - 60 秒
~~~

业务语义就是：

~~~text
删除一分钟窗口以前的数据
~~~

Redis 自身并不知道“一分钟窗口”是什么。

它只提供：

~~~text
按 Score 范围删除
~~~

应用把时间映射成 Score 后，通用命令才获得业务含义。

---

#### <u>6. ZADD、ZREMRANGEBYSCORE、ZRANGEBYSCORE 共同形成滑动时间窗口</u>

当前项目真正的数据模型不是单独一条 ZADD，而是三类操作组合。

写入：

~~~text
ZADD
    当前请求进入窗口
~~~

清理：

~~~text
ZREMRANGEBYSCORE
    删除窗口以前的请求
~~~

读取：

~~~text
ZRANGEBYSCORE
    读取窗口中的请求
~~~

完整链路：

~~~text
Request 到达
    ↓
recordedAt = Date.now()
    ↓
ZADD(score = recordedAt)
    ↓
加入当前请求
    ↓
ZREMRANGEBYSCORE
    ↓
删除 60 秒以前 Member
    ↓
EXPIRE 120
~~~

Dashboard 查询：

~~~text
recentSince
    ↓
ZRANGEBYSCORE recentSince +inf
    ↓
得到最近窗口中的请求
    ↓
根据 Member 中 accepted
计算接收速率
~~~

抽象以后：

~~~text
Event / Request
       ↓
Member

Timestamp
       ↓
Score

Sorted Set
       ↓
Range Query
       ↓
Sliding Time Window
~~~

这种结构还可以迁移到滑动窗口限流、最近访问记录、最近错误等场景，但这些只是通用能力，不代表当前项目已经全部实现。

### 【TTL 属于 Key 生命周期能力，而不是一种 Value Type】

#### <u>1. String、Hash、Sorted Set 描述结构，TTL 描述 Key 能活多久</u>

容易出现一个错误框架：

~~~text
Redis 数据类型

String
Hash
Sorted Set
TTL
~~~

TTL 实际不属于 Value Type。

更准确的是：

~~~text
Redis Key
│
├── Value Type
│     ├── String
│     ├── Hash
│     └── Sorted Set
│
└── Expiration
      TTL
~~~

例如：

~~~text
session:abc
│
├── Type = String
├── Value = User JSON
└── TTL = SESSION_TTL_SECONDS
~~~

Token Bucket：

~~~text
ingest:project:p001
│
├── Type = Hash
├── Value
│     ├── tokens
│     └── updated
└── TTL = 60s
~~~

Recent Rate：

~~~text
ingestion:rate:p001
│
├── Type = Sorted Set
├── Member + Score
└── TTL = 120s
~~~

所以 Redis 状态建模必须同时包含：

~~~text
Structure
+
Lifecycle
~~~

---

#### <u>2. EXPIRE 给已经存在的 Key 设置过期时间</u>

Token Bucket Lua 中：

~~~text
EXPIRE <bucket-key> 60
~~~

表示这个 Bucket 如果后续不再活跃，不需要永久留在 Keyspace。

Ingestion Statistics：

~~~text
EXPIRE ingestion:stats:<projectId> 180days
~~~

Recent Rate：

~~~text
EXPIRE ingestion:rate:<projectId> 120s
~~~

因此 TTL 真正回答的是：

~~~text
这份状态什么时候已经没有继续存在的价值？
~~~

而不只是“怎么省内存”。

---

#### <u>3. Sorted Set 中删除旧 Member 和 Key TTL 解决的是两个层次的问题</u>

Recent Rate 同时存在：

~~~text
ZREMRANGEBYSCORE
+
EXPIRE
~~~

二者不能混为一谈。

ZREMRANGEBYSCORE：

~~~text
控制 Key 内部
保留哪些 Member
~~~

EXPIRE：

~~~text
控制整个 Key
还能存在多久
~~~

所以：

~~~text
ingestion:rate:p001
│
├── ZREMRANGEBYSCORE
│      维持最近 60 秒 Member
│
└── EXPIRE 120
       如果 Project 长时间没有新请求
       让整个 Key 自动消失
~~~

最终形成：

~~~text
Member Lifecycle
       ↓
范围删除

Key Lifecycle
       ↓
TTL
~~~

### 【List、Set 与 Stream 需要建立知识位置，但当前项目没有作为主链路使用】

为了形成能够脱离项目的 Redis 数据结构框架，还需要知道另外三种核心结构的位置。

这里必须严格区分：

~~~text
Redis 能做什么
        ≠
当前 Browser Monitor 已经这样做
~~~

#### <u>1. List 表达强调左右顺序的一串元素</u>

逻辑模型：

~~~text
Left
 ↓
A
B
C
D
 ↓
Right
~~~

典型操作：

~~~text
LPUSH / RPUSH
    从左侧或右侧加入

LPOP / RPOP
    从左侧或右侧取出
~~~

因此 List 很容易表达简单 Queue。

但是当前项目的异步任务链路是：

~~~text
PostgreSQL
outbox_tasks
    ↓
Worker Polling
~~~

而不是 Redis List Queue。

---

#### <u>2. Set 表达唯一成员集合和集合关系</u>

逻辑模型：

~~~text
Set
├── A
├── B
└── C

成员不重复
~~~

典型操作：

~~~text
SADD
SREM
SISMEMBER
SINTER
SUNION
SDIFF
~~~

因此 Set 更适合唯一成员、Membership 和集合关系运算。

当前 Browser Monitor Redis 主链路没有使用 Set。

---

#### <u>3. Stream 表达持续追加的事件记录和消费者模型</u>

Stream 更接近：

~~~text
Append-only Log

Entry 1
Entry 2
Entry 3
...
~~~

每个 Entry 拥有：

~~~text
ID
+
Field / Value
~~~

并支持 Consumer Group 等消息消费能力。

当前 Browser Monitor 的核心事件异步处理是：

~~~text
telemetry_events
+
outbox_tasks
        ↓
Worker
~~~

而不是 Redis Stream + Consumer Group。

因此这一阶段只需要知道 Stream 在 Redis 数据体系中的位置，不提前深入消息确认、Pending Entries 等机制。

### 【数据结构选择的核心依据是访问模式，而不是数据外观】

重新看一个对象：

~~~json
{
  "accepted": 100,
  "duplicate": 20,
  "rejected": 5
}
~~~

如果业务始终只需要：

~~~text
整体 SET
整体 GET
~~~

那么 String + JSON 可能更简单。

只有当业务需要：

~~~text
accepted 独立增加
duplicate 独立增加
rejected 独立增加
~~~

Hash + HINCRBY 才体现明显价值。

因此：

~~~text
Data Shape
    数据长什么样

不是唯一依据

真正关键的是

Access Pattern
    数据怎样被访问和修改
~~~

基础选择框架：

| 访问模式 | 优先考虑 |
|---|---|
| 整体读取、整体覆盖 | String |
| 简单整数计数 | String + INCR / INCRBY |
| 一个对象多个字段独立访问 | Hash |
| 多个字段分别累加 | Hash + HINCRBY |
| 强调元素左右顺序 | List |
| 唯一成员和集合关系 | Set |
| 唯一成员 + Score 排序 | Sorted Set |
| 按 Score 范围查询 | Sorted Set |
| 持续追加事件并由消费者读取 | Stream |

这是一套入门阶段建模框架，不是绝对规则。后续还要继续考虑命令复杂度、内存占用、并发修改、过期策略、数据规模和可靠性要求。

### 【第二节回到源码形成完整 Redis 状态建模图】

当前项目可以重新画成：

~~~text
Redis Keyspace
│
├── session:<tokenHash>
│      ├── Type: String
│      ├── Value: AuthenticatedUser JSON
│      ├── Commands: SET / GET / DEL
│      └── TTL: SESSION_TTL_SECONDS
│
├── analytics:version:<projectId>
│      ├── Type: String Integer
│      └── Commands: GET / INCR
│
├── analytics:<projectId>:<version>:<namespace>:<filters>
│      ├── Type: String
│      ├── Value: Query Result JSON
│      ├── Commands: GET / SET
│      └── TTL: 15s
│
├── ingestion:stats:<projectId>
│      ├── Type: Hash
│      ├── Fields: accepted / duplicate / rejected
│      ├── Commands: HINCRBY / HGETALL
│      └── TTL: 180 days
│
├── ingest:project:<projectId>
│      ├── Type: Hash
│      ├── Fields: tokens / updated
│      ├── Commands: HMGET / HSET
│      └── TTL: 60s
│
├── ingest:ip:<projectId>:<ip>
│      └── 与 Project Bucket 相同结构
│
└── ingestion:rate:<projectId>
       ├── Type: Sorted Set
       ├── Score: recordedAt
       ├── Member: [requestId, accepted]
       ├── Commands:
       │     ZADD
       │     ZRANGEBYSCORE
       │     ZREMRANGEBYSCORE
       └── TTL: 120s
~~~

这张图已经能够回答：

~~~text
项目里有哪些 Redis State？

每份 State 的 Scope 是什么？

为什么有些使用 String？

为什么统计使用 Hash？

为什么时间窗口使用 Sorted Set？

命令怎样改变这些状态？

为什么还需要 TTL？
~~~

### 【第二节最终收敛为一套可迁移的 Redis 状态建模方法】

以后遇到新的 Redis 需求，不应该先从命令表中找 API，而应该按下面顺序推导：

~~~text
第一步
识别 Business State
    ↓
这份状态是什么？

第二步
确定 Scope
    ↓
状态属于 User / Project / IP / Request 中的谁？

第三步
设计 Key Identity
    ↓
怎样唯一定位这份状态？

第四步
分析 Access Pattern
    ↓
整体读写？
字段读写？
计数？
排序？
集合关系？
事件流？

第五步
选择 Value Type
    ↓
String / Hash / List / Set / Sorted Set / Stream

第六步
选择 Command Semantics
    ↓
GET / SET
HSET / HINCRBY
ZADD / ZRANGEBYSCORE ...

第七步
设计 Lifecycle
    ↓
是否需要 TTL？
成员是否也需要清理？

第八步
再进入并发和可靠性
    ↓
这些命令组合执行时是否安全？
失败以后状态是否一致？
~~~

当前第二节完成的是数据组织和命令语义。

下一节进入第八步。

## 3. Redis 通过命令原子性、事务与 Lua 控制并发状态修改

第二节已经建立：

~~~text
Business State
      ↓
Key
      ↓
Value Type
      ↓
Command
      ↓
TTL
~~~

这一节继续进入 Redis 的执行层，回答：

> **当多个请求同时修改同一份 Redis State 时，怎样避免状态被并发覆盖，以及 Redis Transaction、Pipeline、WATCH、Lua 分别解决什么问题。**

当前 Browser Monitor 已经同时出现：

~~~text
HINCRBY

multi()
  .hincrby(...)
  .zadd(...)
  .expire(...)
  .exec()

EVAL TOKEN_BUCKET_SCRIPT
~~~

它们不是三个平级 API，而是不同执行层级：

~~~text
Redis Command Execution
        │
        ├── 单条 Command
        │      ↓
        │   Command Atomicity
        │
        ├── 多条已确定 Command
        │      │
        │      ├── Pipeline
        │      │      ↓
        │      │   Network Optimization
        │      │
        │      └── MULTI / EXEC
        │             ↓
        │          Transaction
        │
        └── Read → Compute → Conditional Write
               │
               ├── WATCH + MULTI / EXEC
               │      ↓
               │   Optimistic Lock
               │
               └── Lua / EVAL
                      ↓
                Server-side Atomic Logic
~~~

这一节的重点不是记住命令名称，而是建立判断：

~~~text
一个业务状态变化
到底应该使用

单条原子命令
Pipeline
MULTI / EXEC
WATCH
还是 Lua
~~~

### 【并发问题产生于一个业务操作被拆成多条独立 Command】

#### <u>1. 一次业务操作不一定等于一条 Redis Command</u>

第二节中的 HINCRBY 已经可以在一条 Redis Command 中完成：

~~~text
读取 Field 当前整数值
      ↓
增加 increment
      ↓
保存新值
~~~

但是 Token Bucket 一次限流判断需要：

~~~text
读取 tokens / updated
      ↓
计算经过时间
      ↓
补充 token
      ↓
判断 token 是否足够
      ↓
如果足够则扣除
      ↓
写回 tokens / updated
~~~

如果完全使用普通 Redis 命令，会被拆成：

~~~text
HMGET
  ↓
Node.js Compute
  ↓
HSET
  ↓
EXPIRE
~~~

所以必须区分：

~~~text
Business Operation
        ≠
Redis Command
~~~

一个业务操作需要多条 Command 才能完成时，就必须继续分析这些 Command 之间是否存在并发竞争。

#### <u>2. GET → Compute → SET 会产生 Lost Update</u>

假设：

~~~text
counter = 10
~~~

两个请求同时执行：

~~~text
GET counter
     ↓
value + 1
     ↓
SET counter
~~~

可能发生：

~~~text
Request A                  Request B

GET counter
    ↓
   10

                           GET counter
                               ↓
                              10

10 + 1 → 11               10 + 1 → 11

SET 11                     SET 11
~~~

最终 counter = 11，但实际发生了两次 +1，正确结果应该是 12。

问题不是 Redis 算错，而是：

~~~text
Read
 ↓
Compute
 ↓
Write
~~~

被拆成多个独立步骤后，其他 Client 可以在中间修改同一份状态。

### 【单条 Redis Command 是最基础的原子执行边界】

#### <u>1. HINCRBY 把字段级 Read-Modify-Write 收进一条 Command</u>

当前采集统计：

[src/ingestion/ingestion.service.ts](../src/ingestion/ingestion.service.ts)

~~~ts
.hincrby(
  statisticsKey,
  "accepted",
  accepted,
)
~~~

逻辑上它完成：

~~~text
读取 accepted
      ↓
accepted += increment
      ↓
写回 accepted
~~~

但应用没有自己执行 HGET → JavaScript 计算 → HSET，而是发送一条 HINCRBY。

所以两个客户端同时执行：

~~~text
A: HINCRBY accepted 5
B: HINCRBY accepted 8
~~~

结果只能按某个顺序完成：

~~~text
100 → 105 → 113
~~~

或者：

~~~text
100 → 108 → 113
~~~

不会出现两个 Client 都读到 100 后互相覆盖。

因此 HINCRBY 的价值不仅是少写代码，而是：

> **把字段级整数 Read-Modify-Write 表达成 Redis Server 能直接原子执行的一条 Command。**

#### <u>2. INCR 同样是 Counter 的单命令原子更新</u>

Worker：

[apps/worker/src/outbox-worker.ts](../../worker/src/outbox-worker.ts)

~~~ts
await this.redis.incr(
  "analytics:version:<projectId>"
);
~~~

逻辑上虽然可以理解为 GET version → version + 1 → SET version，但真正发给 Redis 的是一条 INCR。

所以多个 Worker 同时增加同一 Project 的 version，也不会产生普通 GET / SET 的 Lost Update。

#### <u>3. Command 顺序执行模型是单命令原子性的基础</u>

不能简单理解成“Redis 整个程序只有一个线程”。现代 Redis 可以使用后台线程和 I/O Threads 处理部分工作。

但从 Command Execution 角度，可以建立：

~~~text
多个 Client
     ↓
Command Requests
     ↓
Redis Command Execution
     ↓
一条 Command 完整执行后
再进入下一条 Command
~~~

核心边界是：

~~~text
一条普通 Redis Command
执行过程中
不会被另一条普通 Command
插入到一半
~~~

所以：

~~~text
Single Command
      ↓
Natural Atomic Execution Boundary
~~~

但这只能保证一条 Command，不能自动保证多条独立 Command 组成的整个业务流程。

### 【Pipeline 只解决网络往返成本，不提供事务原子性】

Redis 是 Client / Server Request-Response 模型。

普通连续命令：

~~~text
Client → Command A → Redis → Response A
Client → Command B → Redis → Response B
Client → Command C → Redis → Response C
~~~

每轮都需要 Round Trip Time。

Pipeline 则变成：

~~~text
Client

Command A
Command B
Command C
Command D
    ↓
连续发送
    ↓
Redis
    ↓
依次处理
    ↓
Responses
    ↓
Client 批量读取
~~~

它减少的是：

~~~text
RTT
+
Socket I/O Overhead
~~~

因此 Pipeline 首先属于 Performance Optimization。

它并没有表达：

~~~text
A1
A2
A3

必须形成一个事务边界
其他 Client 不能在中间执行
~~~

所以必须固定：

~~~text
Pipeline
解决 Network Efficiency

MULTI / EXEC
解决 Transaction Execution Boundary
~~~

### 【MULTI / EXEC 把预先确定的多条 Command 组成不可穿插的事务执行单元】

#### <u>1. MULTI 进入事务队列模式，EXEC 才真正执行命令</u>

Redis Transaction 的基本过程：

~~~text
MULTI
   ↓
进入 Transaction Context
   ↓
Command A
   ↓
QUEUED
Command B
   ↓
QUEUED
Command C
   ↓
QUEUED
   ↓
EXEC
   ↓
依次真正执行
A
B
C
~~~

所以在 MULTI 之后、EXEC 之前，Command 主要处于 Queue 中。

真正的数据修改在 EXEC 触发以后发生。

#### <u>2. EXEC 执行事务期间不会插入其他 Client 的 Command</u>

假设：

~~~text
Client A

MULTI
A1
A2
A3
EXEC
~~~

另一个 Client：

~~~text
Client B

B1
~~~

事务执行阶段不会变成：

~~~text
A1
B1
A2
A3
~~~

而会是事务整体在前或在后。

因此 Redis Transaction 的一个核心保证是：

~~~text
Transaction Commands
       ↓
Serialized
       ↓
Sequential
       ↓
No Other Client Interleaving
~~~

#### <u>3. 当前 Ingestion Statistics 使用的就是 MULTI / EXEC</u>

项目源码：

[src/ingestion/ingestion.service.ts](../src/ingestion/ingestion.service.ts)

~~~ts
await this.redis
  .multi()
  .hincrby(statisticsKey, "accepted", accepted)
  .hincrby(statisticsKey, "duplicate", duplicate)
  .hincrby(statisticsKey, "rejected", rejections.length)
  .expire(statisticsKey, 180 * 24 * 60 * 60)
  .zadd(
    recentRateKey,
    recordedAt,
    JSON.stringify([requestId, accepted]),
  )
  .zremrangebyscore(
    recentRateKey,
    0,
    recordedAt - 60_000,
  )
  .expire(recentRateKey, 120)
  .exec()
  .catch(() => undefined);
~~~

一次 Ingestion Request 同时更新：

~~~text
Project Statistics
│
├── accepted
├── duplicate
├── rejected
└── TTL

Recent Rate
│
├── ZADD Current Request
├── Remove Old Members
└── TTL
~~~

这些值在事务开始之前已经全部知道。

所以业务过程可以提前准备成：

~~~text
HINCRBY
HINCRBY
HINCRBY
EXPIRE
ZADD
ZREMRANGEBYSCORE
EXPIRE
~~~

然后：

~~~text
MULTI
    ↓
Queue
    ↓
EXEC
    ↓
连续执行
~~~

这正是 MULTI / EXEC 适合的场景。

#### <u>4. ioredis 的 multi() 与 Pipeline 有联系，但事务保证来自 MULTI / EXEC</u>

ioredis 的 multi() 支持链式收集命令，并利用客户端 Pipeline 机制组织发送。

因此当前源码同时存在两个不同层次：

~~~text
ioredis Client
     ↓
Command Buffering / Pipeline
     ↓
减少发送和 RTT 开销
~~~

以及：

~~~text
Redis Server
     ↓
MULTI / EXEC
     ↓
Transaction Execution Boundary
~~~

不能因为 ioredis multi() 内部使用 Pipeline，就得出：

~~~text
Pipeline = Transaction
~~~

正确关系是：

~~~text
Pipeline
是发送和性能机制

MULTI / EXEC
才提供 Redis Transaction 语义
~~~

### 【MULTI / EXEC 不适合直接完成需要中途读取结果再决定写入的逻辑】

#### <u>1. MULTI 后的读取命令先进入队列，Node.js 拿不到真正数据</u>

重新看 Token Bucket。

假设尝试：

~~~text
MULTI

HMGET bucket tokens updated

HSET bucket tokens ??? updated ???

EXEC
~~~

关键问题是：

~~~text
???
~~~

到底是什么。

MULTI 以后发送：

~~~text
HMGET bucket tokens updated
~~~

Redis 此时不会立刻把 tokens 和 updated 的真实值作为普通查询结果交给 Node.js。

它先返回：

~~~text
QUEUED
~~~

因为 HMGET 真正执行要等到 EXEC。

所以 Node.js 在 EXEC 之前并不知道：

~~~text
tokens
updated
~~~

也就无法执行：

~~~text
elapsed = now - updated

refill = elapsed × rate

newTokens = min(
  burst,
  tokens + refill
)

allowed =
  newTokens >= cost
~~~

因此 MULTI / EXEC 更适合：

~~~text
我要执行哪些 Command
在事务提交之前已经全部确定
~~~

而不适合直接表达：

~~~text
先读取 Redis 当前值
      ↓
根据读取结果计算
      ↓
再决定后面到底执行什么
~~~

#### <u>2. 在 MULTI 外先读取再写回会重新产生 Race Condition</u>

另一种写法：

~~~text
HMGET
  ↓
Node.js 拿到 tokens / updated
  ↓
Compute
  ↓
MULTI
HSET
EXPIRE
EXEC
~~~

功能上可以写出来，但读取和写事务之间存在并发窗口。

假设：

~~~text
tokens = 10

Request A cost = 7
Request B cost = 7
~~~

可能发生：

~~~text
A HMGET → 10

B HMGET → 10

A 判断 10 >= 7
Allowed

B 判断 10 >= 7
Allowed

A HSET tokens = 3

B HSET tokens = 3
~~~

最终：

~~~text
tokens = 3
~~~

但两个请求都被允许，相当于实际消耗了 14 Token，Redis 状态却只体现一次 7 Token 的消耗。

所以只要：

~~~text
Read
和
Write
~~~

不是同一个受保护的并发执行过程，就仍然可能产生状态覆盖。

### 【WATCH 通过乐观锁保护客户端 Read-Modify-Write】

当前项目没有使用 WATCH，但完整 Redis 并发框架需要知道它的位置。

基本过程：

~~~text
WATCH bucket
      ↓
HMGET bucket
      ↓
Node.js Compute
      ↓
MULTI
HSET ...
EXPIRE ...
EXEC
~~~

Redis 会监测：

~~~text
WATCH 以后
到 EXEC 之前

bucket 是否被修改
~~~

如果没有变化：

~~~text
EXEC
   ↓
执行事务
~~~

如果被其他操作修改：

~~~text
EXEC
   ↓
Abort
~~~

客户端再：

~~~text
重新读取
重新计算
重新尝试
~~~

所以 WATCH 是：

~~~text
Optimistic Lock
~~~

它不是：

~~~text
真正锁住 Key
不允许别人修改
~~~

而是：

~~~text
允许别人修改

如果发生修改
我的事务就不再基于旧状态执行
~~~

### 【Lua 把 Read → Compute → Conditional Write 整体移动到 Redis Server 内部】

当前 Token Bucket 没有使用 WATCH，而是使用：

[src/ingestion/rate-limiter.service.ts](../src/ingestion/rate-limiter.service.ts)

~~~ts
await this.redis.eval(
  TOKEN_BUCKET_SCRIPT,
  1,
  key,
  now,
  rate,
  burst,
  cost,
);
~~~

它对应第三种并发控制模型：

~~~text
Server-side Script
~~~

#### <u>1. EVAL 把 Lua 代码和参数交给 Redis Server 执行</u>

当前调用可以映射为：

~~~text
Script
    TOKEN_BUCKET_SCRIPT

Number of Keys
    1

KEYS[1]
    key

ARGV[1]
    now

ARGV[2]
    rate

ARGV[3]
    burst

ARGV[4]
    cost
~~~

所以 Lua：

~~~lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
~~~

是在读取 EVAL 传入的 Key 和参数。

脚本内部通过：

~~~text
redis.call(...)
~~~

直接调用 Redis Command。

#### <u>2. Token Bucket 先读取当前 Bucket State</u>

源码：

~~~lua
local current =
  redis.call(
    'HMGET',
    key,
    'tokens',
    'updated'
  )
~~~

得到：

~~~text
tokens
updated
~~~

如果 Key 第一次出现：

~~~lua
local tokens =
  tonumber(current[1]) or burst

local updated =
  tonumber(current[2]) or now
~~~

初始状态就是：

~~~text
tokens = burst
updated = now
~~~

也就是新 Bucket 默认装满 Token。

#### <u>3. 根据经过时间补充 Token</u>

核心计算：

~~~lua
tokens =
  math.min(
    burst,
    tokens +
      math.max(0, now - updated) * rate
  )
~~~

拆开以后：

~~~text
elapsed
    =
now - updated

refill
    =
elapsed × rate

tokens
    =
min(
  burst,
  oldTokens + refill
)
~~~

所以 Token 永远不会超过 burst。

#### <u>4. 根据当前 Token 决定允许还是拒绝</u>

如果：

~~~text
tokens < cost
~~~

脚本：

~~~text
保存 tokens
更新 updated
刷新 TTL
return 0
~~~

业务含义：

~~~text
Rejected
~~~

如果 Token 足够：

~~~text
tokens = tokens - cost
~~~

然后：

~~~text
保存 tokens
更新 updated
刷新 TTL
return 1
~~~

业务含义：

~~~text
Allowed
~~~

完整过程：

~~~text
HMGET
  ↓
Read State
  ↓
Refill
  ↓
Enough?
 ┌────┴────┐
 │         │
No        Yes
 │         │
 ↓         ↓
Save      Deduct
 │         │
TTL       Save
 │         │
0         TTL
           │
           1
~~~

### 【Lua 解决原子性问题的关键是整个脚本执行期间不可被其他 Client 穿插】

#### <u>1. Node.js Read-Compute-Write 会暴露并发窗口</u>

如果 Token Bucket 写在 Node.js：

~~~text
Node.js
  ↓
HMGET

Redis
  ↓
tokens / updated

Node.js
  ↓
Compute
  ↓
Decision
  ↓
HSET

Redis
~~~

HMGET 和 HSET 之间可能出现另一个请求。

例如：

~~~text
tokens = 10
cost = 7

Request A
HMGET → 10

Request B
HMGET → 10

A 允许
B 允许

A HSET 3
B HSET 3
~~~

于是两个请求都通过，发生状态竞争。

#### <u>2. Lua 把读取、计算、判断和写入收进 Redis 内部的一次执行</u>

Lua 后变成：

~~~text
Node.js
   ↓
EVAL
   ↓
Redis Server

┌─────────────────────────┐
│ HMGET                   │
│ Compute                 │
│ Conditional Decision    │
│ HSET                    │
│ EXPIRE                  │
│ return                  │
└─────────────────────────┘
~~~

Redis 保证脚本执行期间不会让其他客户端活动穿插进这个脚本。

所以两个请求不会变成：

~~~text
A HMGET
B HMGET
A HSET
B HSET
~~~

而会更接近：

~~~text
Request A Lua

HMGET
 ↓
10
 ↓
Compute
 ↓
Allow
 ↓
HSET 3
 ↓
return 1

──────── A 完整结束 ────────

Request B Lua

HMGET
 ↓
3
 ↓
Compute
 ↓
Reject
 ↓
return 0
~~~

因此 Lua 的真正价值不是：

~~~text
Lua 比 TypeScript 更适合写数学逻辑
~~~

而是：

> **把 Read + Compute + Conditional Write 组合成 Redis Server 内部不可被其他 Client 穿插的执行单元。**

#### <u>3. Lua 原子执行也意味着脚本必须保持短小</u>

Lua 执行期间其他命令不能正常穿插，所以：

~~~text
长时间循环
复杂 CPU 计算
大量数据扫描
~~~

都会延长其他 Client 的等待。

适合 Lua 的逻辑通常应该：

~~~text
短
确定
围绕 Redis State
执行时间可控
~~~

当前 Token Bucket 只包含：

~~~text
HMGET
简单数学运算
条件判断
HSET
EXPIRE
~~~

属于典型适用场景。

### 【WATCH 与 Lua 都能保护 Read-Modify-Write，但执行模型不同】

WATCH：

~~~text
Client
  ↓
WATCH
  ↓
GET / HMGET
  ↓
Client Compute
  ↓
MULTI
  ↓
Write Commands
  ↓
EXEC

如果 Key 期间变化
    ↓
Abort
    ↓
Retry
~~~

Lua：

~~~text
Client
  ↓
EVAL
  ↓
Redis Server

Read
 ↓
Compute
 ↓
Decision
 ↓
Write
~~~

可以整理：

| 维度 | WATCH + MULTI/EXEC | Lua / EVAL |
|---|---|---|
| 计算位置 | Client | Redis Server |
| 是否先把数据返回 Client | 是 | 否 |
| 冲突策略 | 发现变化后 Abort | 执行期间不允许其他 Command 穿插 |
| 是否可能需要 Retry | 是 | 通常不因并发冲突而重试 |
| 适合逻辑 | Client 计算复杂、难搬入 Redis | 短小且围绕 Redis State 的逻辑 |
| 当前项目 | 未使用 | Token Bucket |

### 【Redis 的 Atomic Execution 与 SQL ACID Atomicity 不是同一个层次】

#### <u>1. 原子性不要求多条操作在物理时间上同时发生</u>

无论 Redis 还是 SQL，都不要求：

~~~text
Command A
和
Command B

在同一个 CPU 时刻
同时完成
~~~

所谓原子边界讨论的是：

~~~text
这一组操作
在系统语义上
能不能被拆开观察
或者
能不能被拆开作为最终结果提交
~~~

#### <u>2. SQL ACID Atomicity 强调事务结果 All-or-Nothing</u>

例如转账：

~~~text
A -= 100
B += 100
~~~

数据库内部完全可以先改 A 再改 B。

但如果第二步失败，ACID Atomicity 要求：

~~~text
A 的修改也不能作为最终事务结果留下
~~~

最终只能是：

~~~text
成功
    ↓
A -100
B +100
全部 COMMIT
~~~

或者：

~~~text
失败
    ↓
A 不变
B 不变
ROLLBACK
~~~

所以 SQL Atomicity 主要强调：

~~~text
Failure Atomicity
      ↓
事务最终结果
要么全部提交
要么全部不提交
~~~

#### <u>3. Redis MULTI/EXEC 和 Lua 更强调不可穿插执行边界</u>

Redis Transaction 的关键执行保证：

~~~text
Command A
Command B
Command C

在 EXEC 阶段
连续执行
~~~

Lua 的关键执行保证：

~~~text
Read
Compute
Conditional Write

在 Script 中
连续执行
~~~

其他 Client 不会插入事务或脚本执行到一半。

因此 Redis 文档会使用 atomic / isolated operation 描述这些执行语义。

但是：

~~~text
不可穿插执行
~~~

并不自动等于：

~~~text
执行中任意一步报错
前面所有修改自动 Rollback
~~~

这两个概念必须分开。

### 【MULTI / EXEC 没有 SQL 式 Rollback】

#### <u>1. 排队阶段错误和 EXEC 运行阶段错误不同</u>

如果在 MULTI 阶段就出现：

~~~text
未知 Command
参数数量明显错误
~~~

Redis 可以在真正执行事务前发现 Queue Error。

这种情况下，事务不会按正常 EXEC 流程提交这些命令。

#### <u>2. EXEC 阶段才发现的运行时错误不会撤销前面已经成功的 Command</u>

例如：

~~~text
MULTI

SET foo "abc"

INCR foo

SET bar "ok"

EXEC
~~~

第一条：

~~~text
SET foo "abc"
~~~

成功。

INCR foo 执行时才发现：

~~~text
foo 不是可增量整数
~~~

这一条发生运行时错误。

Redis 不会撤销：

~~~text
SET foo "abc"
~~~

其他合法命令也会继续执行。

所以可能得到：

~~~text
foo = "abc"

INCR foo
失败

bar = "ok"
~~~

即：

~~~text
Command A ✓
Command B ✗
Command C ✓
~~~

而不是 SQL 式：

~~~text
Command B 失败
      ↓
A / B / C 全部恢复
~~~

#### <u>3. Redis 不提供通用 Rollback 是事务模型的设计选择</u>

如果 Redis 要支持 SQL 式自动 Rollback，每次修改都需要额外维护足够的信息，例如：

~~~text
修改前的 String

修改前的 Hash Field

被删除的 Sorted Set Member

原来的 Score

原来的 TTL
...
~~~

然后失败时：

~~~text
读取 Undo Information
      ↓
逐步恢复
~~~

这会增加：

~~~text
额外内存
额外 CPU
事务实现复杂度
执行成本
~~~

Redis 官方事务文档明确说明 Redis Transaction 不支持 Rollback，并把简单性和性能作为这一模型的重要设计取舍。

因此 Redis 的基础事务更接近：

~~~text
应用先准备好
一组预期合法、确定的 Command
        ↓
MULTI
        ↓
Queue
        ↓
EXEC
        ↓
不可穿插地连续执行
~~~

而不是依赖执行失败后的通用 Undo / Rollback。

### 【Lua 同样不等于 SQL 式 Rollback】

Lua 的 Atomic Execution 表示：

~~~text
脚本执行期间
其他 Client Command
不能穿插
~~~

它并不意味着：

~~~text
脚本中途运行时报错
Redis 会自动恢复脚本已经产生的所有修改
~~~

使用 redis.call() 时，如果内部 Redis Command 产生运行时错误，错误会中止脚本并返回给调用方；在错误发生前已经成功产生的数据修改并不会获得 SQL 式通用 Rollback。

所以：

~~~text
Lua Atomic
~~~

不能理解成：

~~~text
SQL Transaction Rollback
~~~

Lua 解决 Token Bucket 的核心是：

~~~text
Concurrency Atomicity
      ↓
Read
Compute
Conditional Write

整个过程
不被其他请求穿插
~~~

而不是失败回滚。

### 【Redis 不等于不需要一致性，而是复杂业务不变量更多由数据模型和应用保证】

这里还需要避免另一个错误结论：

~~~text
Redis 没有 SQL 式 Rollback
      ↓
Redis 不需要 Consistency
~~~

这并不成立。

Token Bucket 本身就有业务不变量：

~~~text
tokens <= burst

一次允许请求
必须正确扣减 Token

tokens 和 updated
必须共同描述最新 Bucket State
~~~

Lua 就是在帮助维持这些状态关系。

不同的是：

~~~text
PostgreSQL
通常通过

Schema
CHECK
UNIQUE
FOREIGN KEY
Transaction
Isolation
Rollback

提供更丰富的声明式约束
~~~

而 Redis 更多依赖：

~~~text
Key Design
Data Type
Atomic Command
MULTI / EXEC
WATCH
Lua
Application Logic
~~~

共同维护状态正确性。

所以不是：

~~~text
SQL 需要一致性
Redis 不需要一致性
~~~

而是：

~~~text
两者都需要正确状态

但是
提供的约束机制
和承担的系统职责
不同
~~~

### 【当前 Browser Monitor 中 PostgreSQL 与 Redis 的职责差异解释了事务强度选择】

当前 IngestionService 源码明确写道：

~~~text
Dashboard counters live in Redis because rejected events intentionally
never enter the telemetry tables.

A statistics failure must not turn a successfully committed ingestion
request into a retryable SDK error.
~~~

对应代码：

~~~ts
await this.redis
  .multi()
  ...
  .exec()
  .catch(() => undefined);
~~~

这里反映的架构边界是：

~~~text
核心 Ingestion 数据
      ↓
PostgreSQL / TimescaleDB
      ↓
Primary / Authoritative Data

Dashboard Statistics
Recent Rate
      ↓
Redis
      ↓
Runtime / Derived State
~~~

所以 Redis Statistics 写失败时，项目明确选择：

~~~text
不要把已经成功提交的 Ingestion
重新告诉 SDK 是失败
~~~

这不是：

~~~text
Redis 数据不需要正确
~~~

而是：

~~~text
Redis 这部分状态
和主业务事实
拥有不同的可靠性等级
~~~

因此事务机制必须和数据职责一起判断，而不能单独看到“没有 Rollback”就认为架构不安全。

### 【当前 Token Bucket 的单个 Lua 原子，但 Project + IP 两个 Bucket 不是一个整体事务】

当前源码：

[src/ingestion/rate-limiter.service.ts](../src/ingestion/rate-limiter.service.ts)

~~~ts
const [projectAllowed, ipAllowed] =
  await Promise.all([
    this.consumeKey(
      "ingest:project:<projectId>",
      ...
    ),
    this.consumeKey(
      "ingest:ip:<projectId>:<ip>",
      ...
    ),
  ]);

return projectAllowed && ipAllowed;
~~~

每一个 consumeKey 内部执行：

~~~text
EVAL TOKEN_BUCKET_SCRIPT
~~~

所以：

~~~text
Project Bucket Lua
      ↓
Atomic

IP Bucket Lua
      ↓
Atomic
~~~

但是：

~~~text
Promise.all(
  Project EVAL,
  IP EVAL
)
~~~

不会把两个 EVAL 自动组成一个 Redis Transaction。

因此整体并不是：

~~~text
Project Bucket
+
IP Bucket

All-or-Nothing
~~~

例如可能发生：

~~~text
Project Bucket
Token 足够
    ↓
扣减
    ↓
Allowed

IP Bucket
Token 不足
    ↓
Rejected
~~~

最终：

~~~text
projectAllowed = true
ipAllowed = false

Request Rejected
~~~

但 Project Bucket 已经消耗了 Token。

所以当前实现准确的语义是：

~~~text
两个 Bucket
分别原子消费
        ↓
最后做 AND 判断
~~~

而不是：

~~~text
只有两个 Bucket
同时满足条件

才一起扣减
~~~

这不一定就是 Bug，因为还要看限流产品语义。

如果要求：

~~~text
任意一层失败
另一层绝不能消费 Token
~~~

那么就需要重新设计成：

~~~text
One Lua Script
      ↓
KEYS[1] = Project Bucket
KEYS[2] = IP Bucket
      ↓
同时读取两个 Bucket
      ↓
同时判断
      ↓
都允许
才一起写回
~~~

形成：

~~~text
Atomic Dual-Bucket Decision
~~~

当前源码并没有做到这一层组合原子性。

### 【Analytics Cache 展示了另一种“允许并发但不破坏权威事实”的设计】

AnalyticsService：

[src/analytics/analytics.service.ts](../src/analytics/analytics.service.ts)

~~~text
GET Cache
    ↓
Miss
    ↓
Database Query
    ↓
SET Cache
~~~

这里没有 MULTI、WATCH 或 Lua。

假设两个请求同时 Miss：

~~~text
Request A               Request B

GET Miss                GET Miss

DB Query                DB Query

SET Cache               SET Cache
~~~

于是可能：

~~~text
同一个 Analytics Query
被重复计算两次
~~~

这里的主要风险是：

~~~text
重复数据库计算
增加负载
~~~

而不是：

~~~text
把权威业务数据永久写坏
~~~

所以当前项目接受这种并发窗口。

这体现一个重要工程原则：

> **不是所有并发都必须消除。只有并发会破坏正确性，或者带来的成本已经不可接受时，才需要增加事务、WATCH、Lua 或其他协调机制。**

### 【第三节最终形成 Redis 并发执行机制的完整判断框架】

可以把当前章节收束成：

| 机制 | 核心目标 | 是否阻止本逻辑被其他 Client 穿插 | SQL 式 Rollback | 当前项目 |
|---|---|---|---|---|
| 单条 Command | 一次基本状态变化 | 是，单命令边界 | 不适用 | HINCRBY、INCR |
| Pipeline | 降低 RTT、提高吞吐 | 否 | 否 | 客户端批量发送机制 |
| MULTI / EXEC | 多条已确定 Command 连续执行 | 是 | 否 | Ingestion Statistics |
| WATCH + MULTI/EXEC | Client Read-Modify-Write 冲突检测 | 条件执行，冲突时 Abort | 未执行时无需回滚 | 当前未使用 |
| Lua / EVAL | Server-side Read-Compute-Write | 是，整个脚本不可穿插 | 否，不提供 SQL 式通用回滚 | Token Bucket |

以后设计 Redis 状态修改时，可以按照：

~~~text
我要修改 Redis State
        ↓
一条原生命令能完成吗？
        │
        ├── 能
        │    ↓
        │ Atomic Command
        │ INCR / HINCRBY ...
        │
        └── 不能
             ↓
后续操作是否依赖当前 Redis 读取结果？
             │
       ┌─────┴─────┐
       │           │
      不依赖       依赖
       │           │
       ↓           ↓
只需要性能？     Read → Compute → Write
       │           │
       ↓           ├── 计算留在 Client
   Pipeline         │       ↓
                   │     WATCH
需要连续事务执行？ │
       │           └── 逻辑可移入 Redis
       ↓                   ↓
 MULTI / EXEC              Lua
~~~

如果进一步要求：

~~~text
复杂跨实体业务约束
+
运行时失败必须全部恢复
+
强 All-or-Nothing
+
权威数据事务
~~~

就不能因为 Redis 有 MULTI / EXEC 或 Lua，直接把它等价成：

~~~text
SQL ACID Transaction
~~~

这类场景通常应该重新评估真正权威状态是否更适合由 PostgreSQL 这样的事务型数据库承担。

## 4. Redis 的工程价值来自状态模型组合，而不是单个数据结构或命令

前三节已经分别建立：

~~~text
第一节
Redis 在服务端系统中的位置
        ↓
Redis Server / Client / Shared State

第二节
Redis 如何组织状态
        ↓
Keyspace / Key / Data Type / Command / TTL

第三节
Redis 如何安全修改状态
        ↓
Atomic Command
Pipeline
MULTI / EXEC
WATCH
Lua
Failure Semantics
~~~

到了第四节，需要把这些底层能力重新组合成服务端真正会使用的工程模型。

真实业务不会从下面的问题开始：

~~~text
我要不要使用 Hash？

我要不要调用 ZADD？

我要不要使用 HINCRBY？
~~~

而是从业务状态开始：

~~~text
我要实现 Session

我要实现 Counter

我要实现限流

我要保存最近一分钟状态

我要做查询缓存
~~~

因此 Redis 的工程关系应该理解成：

~~~text
Redis Primitive
│
├── Key
├── String / Hash / Sorted Set
├── GET / SET / INCR / HINCRBY
├── ZADD / ZRANGEBYSCORE
├── TTL
├── MULTI / EXEC
└── Lua

        ↓ 组合

Redis State Model
│
├── Session
├── Counter
├── Rate Limit
├── Recent Window
└── Cache

        ↓ 再继续判断

Performance Requirement
Data Responsibility
Persistence Requirement
Redis / PostgreSQL Boundary
~~~

所以这一节要完整回答三个层次的问题：

~~~text
第一层
Redis 的基础能力
如何组合成业务状态模型？

第二层
为什么这些状态适合 Redis，
Redis 为什么通常比 PostgreSQL 更快？

第三层
这些状态中哪些可以丢，
哪些需要持久化，
哪些不应该只依赖 Redis？
~~~

### 【一个完整 Redis State Model 至少需要回答六个问题】

以后看到任何 Redis 设计，都应该先问：

~~~text
① State 是什么？
        ↓
保存的业务状态是什么？

② Scope 是什么？
        ↓
状态属于谁？

③ Representation 是什么？
        ↓
String / Hash / Sorted Set？

④ Mutation 是什么？
        ↓
GET / SET / INCR / Lua？

⑤ Lifecycle 是什么？
        ↓
什么时候创建？
什么时候过期？
什么时候删除？

⑥ Authority 是什么？
        ↓
Redis 是权威数据？
还是可以重新生成？
~~~

例如当前 Session：

~~~text
State
    Login Session

Scope
    Session Token

Representation
    String JSON

Mutation
    SET / GET / DEL

Lifecycle
    Login 创建
    TTL 到期
    Logout 删除

Authority
    Redis 参与认证热路径
    PostgreSQL 仍保存 Session Record
~~~

Token Bucket：

~~~text
State
    Rate Limit Budget

Scope
    Project
    Project + IP

Representation
    Hash

Mutation
    Lua
      HMGET
      Compute
      HSET

Lifecycle
    请求时创建 / 刷新
    60s TTL

Authority
    Redis Runtime State
~~~

只有把这六层一起看，才能真正判断一个 Redis 设计是否完整。

### 【Session State Model 将身份凭证映射成服务端共享状态】

#### <u>1. 当前 Session 生命周期从登录开始</u>

当前登录流程：

~~~text
Browser
   ↓
email + password
   ↓
AuthService.login()
~~~

首先查询 PostgreSQL：

~~~sql
SELECT id,
       email,
       password_hash,
       display_name,
       email_verified_at
FROM users
WHERE email = $1
~~~

验证通过以后生成：

~~~text
token
csrfToken
expiresAt
~~~

其中原始 Session Token 先经过：

~~~text
token
   ↓
hashToken()
   ↓
tokenHash
~~~

数据库保存的是 tokenHash，而不是原始 Token。

#### <u>2. Session 首先写入 PostgreSQL 持久记录</u>

源码逻辑：

~~~sql
INSERT INTO user_sessions(
    user_id,
    token_hash,
    csrf_token,
    expires_at
)
VALUES (...)
~~~

形成：

~~~text
user_sessions
│
├── user_id
├── token_hash
├── csrf_token
└── expires_at
~~~

这是一份持久 Session Record。

#### <u>3. Redis 保存请求认证真正需要的热 Session State</u>

随后：

~~~ts
await this.redis.set(
  "session:<tokenHash>",
  JSON.stringify(user),
  "EX",
  this.config.SESSION_TTL_SECONDS,
);
~~~

形成：

~~~text
session:<tokenHash>
│
├── Type
│     String
│
├── Value
│     AuthenticatedUser JSON
│
└── TTL
      SESSION_TTL_SECONDS
~~~

其中 AuthenticatedUser 包含：

~~~text
id
email
displayName
sessionId
csrfToken
~~~

因此可以理解为：

~~~text
PostgreSQL
    ↓
保存 Session Record

Redis
    ↓
保存 Request Path
直接需要的 AuthenticatedUser
~~~

#### <u>4. SessionGuard 的认证热路径只读取 Redis</u>

当前 Guard：

~~~ts
const token =
  request.cookies?.bm_session;

const session =
  await this.redis.get(
    "session:<hashToken(token)>"
  );

if (!session) {
  throw new UnauthorizedException({
    code: "session_expired",
  });
}

request.auth =
  JSON.parse(session);
~~~

完整链路：

~~~text
HTTP Request
    ↓
Cookie
    ↓
Session Token
    ↓
hashToken
    ↓
Redis GET
    ↓
Session 存在？
 ┌────┴────┐
No        Yes
 ↓          ↓
401       JSON.parse
            ↓
      request.auth
~~~

当前源码没有：

~~~text
Redis Miss
    ↓
再去 PostgreSQL 查询 user_sessions
~~~

这样的 fallback。

所以当前 Session Redis Key 不是一个单纯可随时丢弃的普通 Cache。

Redis Session 丢失以后，即使 PostgreSQL user_sessions 仍然存在，当前 Guard 仍会把用户判断为 session_expired。

#### <u>5. 当前 Session 是固定 TTL，不是 Sliding Session</u>

登录时：

~~~text
SET session:<hash>
    JSON
    EX SESSION_TTL_SECONDS
~~~

而 SessionGuard 只执行：

~~~text
GET
~~~

没有：

~~~text
EXPIRE session:<hash> ...
~~~

因此当前实现是：

~~~text
Login
  ↓
设置固定过期时间

Day 1
GET
不续期

Day 3
GET
不续期

TTL 到期
    ↓
Session Expired
~~~

更接近：

~~~text
Fixed / Absolute Session Lifetime
~~~

而不是：

~~~text
Sliding Session Lifetime
~~~

#### <u>6. Logout 与 Password Reset 都包含 Session Invalidation</u>

Logout：

~~~ts
await Promise.all([
  this.redis.del(
    "session:<tokenHash>"
  ),
  this.database.pool.query(
    "DELETE FROM user_sessions WHERE token_hash = $1",
    [tokenHash]
  ),
]);
~~~

意味着：

~~~text
Logout
   ↓
Redis DEL
+
PostgreSQL DELETE
   ↓
Session Invalidated
~~~

Password Reset 更进一步：

~~~text
PostgreSQL Transaction
        ↓
更新密码
        ↓
DELETE user_sessions
RETURNING token_hash
        ↓
COMMIT
        ↓
Redis DEL session:<hash> ...
~~~

说明当前项目已经把 Session 设计成：

~~~text
Create
Read
Expire
Logout Revoke
Password Reset Revoke
~~~

一套完整生命周期。

### 【Counter State Model 将高频增量状态压缩为原子数字变化】

Counter 的通用模型是：

~~~text
State(t + 1)
=
State(t)
+
Delta
~~~

例如：

~~~text
Page Views += 1

Accepted Events += 20

Retry Count += 1

Cache Version += 1
~~~

Redis 的 INCR / INCRBY / HINCRBY 很适合这种状态。

#### <u>1. Ingestion Statistics 是统计型 Counter</u>

当前：

~~~text
ingestion:stats:<projectId>
~~~

保存：

~~~text
accepted
duplicate
rejected
~~~

每次 Ingestion：

~~~text
HINCRBY accepted

HINCRBY duplicate

HINCRBY rejected
~~~

形成：

~~~text
Statistics(t + 1)
       =
Statistics(t)
       +
Current Request Result
~~~

这种 Counter 的核心特点：

~~~text
高频增加
字段之间相互独立
不需要每次扫描历史明细
~~~

所以 Hash + HINCRBY 很合适。

#### <u>2. 这份统计不是普通数据库查询 Cache</u>

源码明确说明：

~~~text
rejected events intentionally
never enter the telemetry tables
~~~

也就是说 rejected 请求本来就不会进入 telemetry tables。

所以：

~~~text
Redis Statistics 丢失
    ↓
重新 SELECT telemetry_events
~~~

不能完整恢复 rejected Count。

因此它更接近：

~~~text
Operational Statistics
~~~

而不是：

~~~text
Database Query Cache
~~~

#### <u>3. 当前统计同时具有 Best-effort 特性</u>

源码：

~~~ts
.exec()
.catch(() => undefined);
~~~

注释说明：

~~~text
A statistics failure must not turn
a successfully committed ingestion request
into a retryable SDK error.
~~~

这表示：

~~~text
Primary Ingestion
       ↓
必须成功

Operational Statistics
       ↓
应该记录
但失败不能反过来
让 SDK 重试已经提交的数据
~~~

所以 Counter 设计不能只问：

~~~text
怎么加 1？
~~~

还要问：

~~~text
这个 Counter
是不是权威历史？
丢失以后能不能接受？
~~~

#### <u>4. Analytics Version 是协调型 Counter</u>

另一份 Counter：

~~~text
analytics:version:<projectId>
~~~

Worker：

~~~ts
INCR analytics:version:<projectId>
~~~

这里数字 8、9、10 本身不是业务统计。

它表达的是：

~~~text
Analytics Data Generation
Version
~~~

所以：

~~~text
Counter State
│
├── Measurement Counter
│     ↓
│   accepted / rejected
│
└── Coordination Counter
      ↓
    analytics version
~~~

Version Counter 的意义是：

~~~text
9 != 8
    ↓
数据已经发生变化
    ↓
旧 Cache Namespace
不应该继续使用
~~~

### 【Rate Limit State Model 将共享预算映射成 Allow / Reject 决策】

限流真正解决的是：

~~~text
某一个 Scope
在某一时间尺度内
允许消耗多少资源？
~~~

常见 Scope：

~~~text
User
IP
Project
API Key
Tenant
~~~

Redis 很适合限流，是因为它同时提供：

~~~text
高频共享状态
Atomic Command
TTL
Sorted Set
Lua
~~~

#### <u>1. 常见限流算法需要先建立完整位置</u>

入门阶段可以先建立：

~~~text
Rate Limit
│
├── Fixed Window
├── Sliding Window
├── Token Bucket
└── Leaky Bucket
~~~

Fixed Window 可以理解成：

~~~text
每分钟最多 100 次
~~~

可以用：

~~~text
Counter
+
TTL
~~~

实现。

优点：

~~~text
简单
内存低
~~~

缺点是窗口边界可能产生突发。

Sliding Window 不再看自然分钟，而是看：

~~~text
当前时间往前 N 秒
~~~

可以用 Sorted Set：

~~~text
timestamp
    ↓
Score
~~~

配合范围查询和范围删除实现。

Token Bucket：

~~~text
Bucket
│
├── capacity = burst
├── tokens
└── refill rate
~~~

请求到达时：

~~~text
补充 Token
    ↓
tokens >= cost ?
    ↓
允许 / 拒绝
~~~

它允许受控突发。

Leaky Bucket 更关注稳定输出速率，这里先建立算法位置，不提前深入全部实现细节。

#### <u>2. 当前项目真正使用的是 Token Bucket</u>

当前两个 Key：

~~~text
ingest:project:<projectId>

ingest:ip:<projectId>:<ip>
~~~

都保存：

~~~text
tokens
updated
~~~

所以状态模型是：

~~~text
Token Bucket
│
├── Scope
│     Project
│     Project + IP
│
├── State
│     tokens
│     updated
│
├── Algorithm
│     refill
│     consume
│
├── Concurrency
│     Lua Atomic Script
│
└── Lifecycle
      TTL 60s
~~~

#### <u>3. 当前 cost 不是一个 HTTP Request 固定消耗一个 Token</u>

源码调用：

~~~text
consume(
  projectId,
  ip,
  eventCount
)
~~~

eventCount 被作为 cost 传入 Lua。

因此：

~~~text
Request A
包含 1 Event
    ↓
cost = 1

Request B
包含 50 Events
    ↓
cost = 50
~~~

说明当前真正限制的是：

~~~text
Event Processing Budget
~~~

而不仅仅是 HTTP Request Count。

这是一种很重要的业务建模：

~~~text
资源消耗单位
    ↓
不是请求数
而是事件数
~~~

#### <u>4. Project 与 IP 构成两层限流 Scope</u>

当前逻辑：

~~~text
Request
   ↓
Project Bucket
   ↓
AND
   ↓
IP Bucket
   ↓
Allowed / Rejected
~~~

Project 层限制整个 Project 的总体采集速率。

IP 层限制某个 IP 在同一 Project 下集中消耗预算。

上一节已经分析：

~~~text
Project Bucket Lua
单独原子

IP Bucket Lua
单独原子
~~~

但两者：

~~~text
Promise.all(
  Project EVAL,
  IP EVAL
)
~~~

并不是一个统一 All-or-Nothing 事务。

因此当前准确语义是：

~~~text
两个 Bucket
分别消费
最后做 AND 判断
~~~

而不是：

~~~text
两个 Bucket
只有都允许
才一起扣减
~~~

是否需要组合原子性，取决于产品想要的限流语义。

### 【Recent Time Window 保存“最近发生了什么”，不是长期历史】

当前：

~~~text
ingestion:rate:<projectId>
~~~

非常容易和 Sliding Window Rate Limiter 混淆。

但当前用途并不是限流决策。

#### <u>1. Sorted Set 保存最近一分钟的采集请求</u>

写入：

~~~ts
.zadd(
  recentRateKey,
  recordedAt,
  JSON.stringify([
    requestId,
    accepted
  ])
)
~~~

所以：

~~~text
Score
    recordedAt

Member
    [requestId, accepted]
~~~

形成：

~~~text
10:00:10 → [reqA, 20]
10:00:20 → [reqB, 25]
10:00:40 → [reqC, 18]
~~~

#### <u>2. 每次写入都删除窗口以前的数据</u>

源码：

~~~ts
.zremrangebyscore(
  recentRateKey,
  0,
  recordedAt - 60_000,
)
~~~

意味着只保留：

~~~text
Current Time - 60s
        ↓
Current Time
~~~

之间的请求。

#### <u>3. Analytics 再读取当前时间窗口</u>

查询：

~~~ts
this.redis.zrangebyscore(
  "ingestion:rate:<projectId>",
  recentSince,
  "+inf",
)
~~~

所以：

~~~text
最近一分钟 Member
        ↓
解析 accepted
        ↓
得到最近 Receive Rate
~~~

这是：

~~~text
Rolling Operational Window
~~~

#### <u>4. 这份 Recent Window 是观测状态，不是限流决策状态</u>

真正参与：

~~~text
Allow / Reject
~~~

的是：

~~~text
Token Bucket
~~~

而：

~~~text
ingestion:rate
~~~

用于 Dashboard / Service Status 的最近接收速率。

因此：

~~~text
Rate Limiting State
    ↓
Hash + Lua

Recent Rate Observation
    ↓
Sorted Set
~~~

虽然都和时间、速率、请求有关，但职责完全不同。

#### <u>5. Member Window 与 Key TTL 是两层生命周期</u>

当前同时有：

~~~text
ZREMRANGEBYSCORE
    ↓
只保留约 60 秒 Member

EXPIRE 120
    ↓
长时间无请求
整个 Key 自动删除
~~~

所以：

~~~text
Member Lifecycle
≠
Key Lifecycle
~~~

这是一种可以迁移到 Recent Errors、Recent Login Attempts、Recent Operations、Recent Active Users 的通用状态模型。

### 【Cache State Model 用 Redis 保存可重新生成的读取结果】

Cache 与前几类状态最大的区别：

~~~text
Cache 通常不是 Source of Truth
~~~

它真正解决：

~~~text
同一个昂贵结果
能不能不重复计算？
~~~

当前 Analytics 就是典型 Cache-Aside 读取链路。

#### <u>1. API 先读取 Analytics Version</u>

当前：

~~~text
GET analytics:version:<projectId>
~~~

假设：

~~~text
version = 8
~~~

然后构造：

~~~text
analytics:
<projectId>:
8:
<namespace>:
<filters>
~~~

也就是说 Cache Key 同时包含：

~~~text
Project
Data Version
Query Namespace
Filters
~~~

#### <u>2. 然后执行 Cache-Aside Read Path</u>

核心逻辑：

~~~text
GET Cache
    ↓
Hit?
 ┌──┴───┐
Yes     No
 ↓       ↓
Return  loader()
        ↓
   PostgreSQL /
   TimescaleDB
        ↓
      Result
        ↓
 SET Cache EX 15
        ↓
      Return
~~~

因此：

~~~text
Redis
    ↓
保存 Derived Result

PostgreSQL / TimescaleDB
    ↓
仍然是原始数据来源
~~~

Cache 丢失以后只需要重新执行 loader()。

#### <u>3. TTL = 15 秒形成自动失效和清理</u>

当前：

~~~text
SET key value EX 15
~~~

意味着 Cache Entry 最多自动存在约 15 秒。

TTL 同时承担：

~~~text
Memory Cleanup
Staleness Bound
Failure Safety
~~~

即使没有任何显式 Invalidation，旧 Cache 最终也会自动消失。

### 【Versioned Invalidation 通过改变命名空间让旧 Cache 自动不可达】

当前 Cache 比普通 Cache-Aside 多一层：

~~~text
analytics:version:<projectId>
~~~

#### <u>1. Worker 在数据变化以后增加 Version</u>

Worker：

~~~text
INCR analytics:version:<projectId>
~~~

例如：

~~~text
8
↓
9
~~~

这不是业务统计，而是在告诉 API：

~~~text
Analytics Data Generation
已经变化
~~~

#### <u>2. API 后续请求自动进入新 Cache Namespace</u>

原来：

~~~text
analytics:p001:8:overview:...
~~~

Version 增加以后：

~~~text
analytics:p001:9:overview:...
~~~

所以旧缓存即使还存在：

~~~text
analytics:p001:8:...
~~~

后续请求也不会再命中它。

这叫：

~~~text
Logical Invalidation
~~~

而不是 Physical Deletion。

#### <u>3. Version Pattern 避免枚举和删除所有 Query Key</u>

如果没有 Version，数据变化以后可能需要找到 overview cache、performance cache、route cache、各种 filter 组合 cache，再逐个 DEL。

Version Pattern 则只需要：

~~~text
INCR version
~~~

就能让所有旧 Namespace 自动失效。

#### <u>4. Version Pattern 还能隔离并发中的 Stale Write</u>

假设：

~~~text
Request A
读取 version = 8
        ↓
Cache Miss
        ↓
开始慢 SQL Query
~~~

此时 Worker：

~~~text
更新数据
    ↓
INCR version
    ↓
version = 9
~~~

Request A 后来才完成，并写入：

~~~text
analytics:p001:8:...
~~~

这份结果虽然旧，但仍被写进旧 Namespace。

后面的 Request B：

~~~text
GET version
    ↓
9
    ↓
只访问 analytics:p001:9:...
~~~

所以旧结果不会重新污染当前 Cache Namespace。

这意味着：

~~~text
Stale Write
    ↓
被隔离在旧 Version
~~~

#### <u>5. 旧 Version Cache 最终由 TTL 清理</u>

整个策略：

~~~text
INCR Version
    ↓
旧 Cache 逻辑失效
    ↓
新请求进入新 Namespace
    ↓
旧 Cache 等待 TTL
    ↓
自动清除
~~~

即：

~~~text
Logical Invalidation
+
TTL Garbage Collection
~~~

### 【当前 Cache 仍然存在 Cache Stampede 窗口】

当前 Cache Miss 逻辑没有：

~~~text
SET NX Lock
Singleflight
Lua Stampede Protection
Early Refresh
~~~

所以同一个热 Key 同时失效时，可能：

~~~text
Request A → Miss → DB Query
Request B → Miss → DB Query
Request C → Miss → DB Query
~~~

造成重复数据库查询。

因此当前模型准确说是：

~~~text
Simple Cache-Aside
+
TTL
+
Versioned Invalidation
~~~

还不是完整的 Stampede Protection Cache。

这不一定代表当前项目已经存在性能问题，只有 Query 成本、并发和热点程度达到一定规模时才值得治理。

### 【Redis 快不是单一因为内存，而是整个执行路径更加直接】

最常见的解释是：

~~~text
Redis 在内存
PostgreSQL 在磁盘
所以 Redis 更快
~~~

这个方向没有错，但过于简化。

PostgreSQL 同样会使用 shared_buffers 和 OS Page Cache，热点数据也可能已经在内存中。

Redis 通常更快，真正来自多个因素叠加：

~~~text
内存访问
+
更直接的 Key 访问模型
+
更简单的数据结构操作
+
更轻的事务和约束语义
+
更短的执行路径
~~~

#### <u>1. Redis 的工作数据主要直接驻留在内存</u>

Redis 的核心 Dataset：

~~~text
Key
Value
Data Structure
~~~

主要位于 RAM。

例如：

~~~text
GET
HGET
INCR
HINCRBY
ZADD
~~~

通常直接在内存数据结构上完成。

可以简化成：

~~~text
Client
  ↓
Redis Server
  ↓
定位 Key
  ↓
操作内存数据结构
  ↓
Response
~~~

这使 Redis 非常适合：

~~~text
高频读取
高频计数
短生命周期状态
实时控制状态
~~~

但不能理解成：

~~~text
Redis 永远不访问磁盘
~~~

因为 Redis 还可以通过 RDB / AOF 把内存 Dataset 持久化。

区别是：

> Redis 的普通数据操作主要围绕内存 Dataset 执行，持久化是另外一层机制。

#### <u>2. PostgreSQL 即使命中内存缓存，仍然承担完整数据库语义</u>

PostgreSQL 的典型执行链路更接近：

~~~text
Client
  ↓
SQL
  ↓
Parser
  ↓
Planner / Optimizer
  ↓
Executor
  ↓
MVCC
  ↓
Index / Heap
  ↓
Constraint
  ↓
Transaction / WAL
  ↓
Response
~~~

不同 SQL 不会每次经历完全相同的成本，但 PostgreSQL 必须支持：

~~~text
复杂 SQL
JOIN
Index
Transaction
MVCC
Constraint
Rollback
WAL
Crash Recovery
~~~

例如：

~~~sql
SELECT *
FROM user_sessions
WHERE token_hash = $1
  AND expires_at > now();
~~~

数据库需要理解：

~~~text
访问哪张表
使用什么索引
哪些 Tuple 对当前 Transaction 可见
WHERE 条件是否满足
~~~

而 Redis：

~~~text
GET session:<tokenHash>
~~~

应用已经直接给出：

~~~text
我要访问哪一个 Key
~~~

所以访问模型更直接。

#### <u>3. Redis 使用 Key → Data Structure，而不是通用关系查询模型</u>

Redis：

~~~text
Key
  ↓
Value / Data Structure
~~~

例如：

~~~text
session:abc
    ↓
String

ingestion:stats:p001
    ↓
Hash

ingestion:rate:p001
    ↓
Sorted Set
~~~

应用通常已经知道具体 Key。

因此大量场景可以直接执行：

~~~text
GET
HINCRBY
ZADD
ZRANGEBYSCORE
~~~

而 PostgreSQL 更像：

~~~text
Table
  ↓
Row
  ↓
Column
  ↓
Predicate
  ↓
Index / Scan
  ↓
Relational Operation
~~~

Redis 用更少的通用查询能力，换来了更直接的数据访问路径。

#### <u>4. Redis 把常见高频状态操作直接做成原生命令和数据结构</u>

例如：

~~~text
Counter
    INCR / HINCRBY

Collection
    Set

Ordered State
    Sorted Set

Time Range
    ZRANGEBYSCORE
~~~

当前项目增加 accepted，不需要应用自己 SELECT → +1 → UPDATE，而是直接 HINCRBY。

维护最近一分钟请求，则把 timestamp 映射成 Sorted Set Score，再使用 ZADD / ZRANGEBYSCORE / ZREMRANGEBYSCORE。

这就是 Redis 作为 Data Structure Server 的工程价值。

#### <u>5. Redis 没有承担关系数据库全部事务与约束成本</u>

PostgreSQL 需要支持：

~~~text
PRIMARY KEY
UNIQUE
CHECK
FOREIGN KEY
MVCC
Isolation Level
Rollback
WAL
Crash Recovery
~~~

Redis 的 INCR counter 对应的状态操作更窄、更直接。

所以可以总结：

> **Redis 通常比 PostgreSQL 快，不只是因为 RAM，而是因为 Redis 为 Key/Data Structure 的高频状态操作提供了更短、更简单的执行路径；PostgreSQL 则用更高的执行成本换取关系查询、事务、约束、恢复等更完整的数据库语义。**

### 【Redis 和 PostgreSQL 的选择首先看数据职责，而不是只看性能】

真正应该先判断：

~~~text
这份数据到底是什么性质？
~~~

| 数据职责 | Redis | PostgreSQL |
|---|---|---|
| Cache | 很适合 | 通常作为原始数据来源 |
| Session Runtime State | 很适合 | 可以保存持久 Session Record |
| Counter | 很适合 | 如果要求权威历史也可能需要持久保存 |
| Rate Limit State | 很适合 | 通常不需要 |
| Recent Window | 很适合 | 长期历史通常进入数据库 |
| 排行榜 / 实时排序 | 很适合 | 长期事实仍可能来自数据库 |
| 临时 Token / Coordination State | 很适合 | 视业务要求 |
| 用户 / 订单 / 支付等权威事实 | 通常不是首选 | 很适合 |
| 强关系数据 | 不擅长 | 很适合 |
| 需要复杂事务和约束的数据 | 通常不是首选 | 很适合 |

进一步抽象：

~~~text
Redis
更擅长保存

Runtime State
Temporary State
Derived State
Coordination State
High-frequency Shared State
~~~

而：

~~~text
PostgreSQL
更擅长保存

Authoritative State
Business Fact
Relational Data
Durable History
Transactional Data
~~~

### 【判断数据是否应该进入 Redis，需要从状态性质推导】

#### <u>1. 高频读写是重要信号，但不是充分条件</u>

Session、Rate Limit、Counter 都具有高频访问，所以 Redis 很合适。

但账户余额也可能高频访问，不能因此直接只放 Redis。

因为余额还具有：

~~~text
权威业务事实
强一致性
事务
审计
不可随意丢失
~~~

这些要求往往比纯性能更重要。

#### <u>2. 短生命周期和自动过期是 Redis 非常擅长的状态</u>

例如：

~~~text
Session
Rate Limit Bucket
Recent Window
Temporary Token
Cache
~~~

天然具有 TTL。

Redis 可以让：

~~~text
Key
    ↓
Expiration
    ↓
自动退出 Keyspace
~~~

这类状态非常适合 Redis。

#### <u>3. 可重新计算的数据非常适合 Redis</u>

例如 Analytics Cache：

~~~text
Redis Cache 丢失
      ↓
Cache Miss
      ↓
重新查询 TimescaleDB
      ↓
重新生成 Cache
~~~

所以它属于：

~~~text
Rebuildable State
~~~

#### <u>4. 多实例之间需要共享的运行状态也适合 Redis</u>

如果有多个 API Instance：

~~~text
API A
API B
API C
~~~

不能各自在自己的 Node.js Memory 中维护独立 Rate Limit、Session、Counter，否则每个实例会看到不同状态。

Redis Server 可以提供 Shared State。

#### <u>5. 复杂关系、强事务和权威历史更适合 PostgreSQL</u>

如果一份数据需要：

~~~text
JOIN
Foreign Key
复杂筛选
强 All-or-Nothing Transaction
长期历史
审计
不可丢失
~~~

通常更应该由 PostgreSQL 承担 Source of Truth。

> **Redis 快不是把所有 PostgreSQL 数据迁移进 Redis 的理由。性能只是数据存储决策中的一个维度。**

### 【数据适合放 Redis 与 Redis 是否需要持久化是两个不同问题】

决定一份 State 适不适合 Redis，和决定 Redis Restart 以后这份 State 要不要恢复，不是同一个问题。

可以理解成两层：

~~~text
第一层
Storage Model
    ↓
Redis 还是 PostgreSQL？

第二层
Redis Reliability
    ↓
Redis 内的数据
是否需要通过 Persistence 恢复？
~~~

例如：

~~~text
Analytics Cache
很适合 Redis
~~~

但：

~~~text
Cache 丢失
    ↓
重新查询数据库
    ↓
重新生成
~~~

所以：

~~~text
Redis Suitable
≠
Persistence Required
~~~

<!-- REDIS_SECTION_4_CONTINUE -->

## 参考资料

[1] Redis. Redis Data Types. https://redis.io/docs/latest/develop/data-types/

[2] Redis. Keys and values / Key expiration. https://redis.io/docs/latest/develop/use/keyspace/

[3] Redis. Redis Persistence. https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/

[4] Redis. Scripting with Lua. https://redis.io/docs/latest/develop/programmability/eval-intro/

[5] Redis/ioredis. RedisOptions.ts. https://github.com/redis/ioredis/blob/main/lib/redis/RedisOptions.ts

[6] Redis/ioredis. README and connection behavior. https://github.com/redis/ioredis

[7] Redis. Compare data types. https://redis.io/docs/latest/develop/data-types/compare-data-types/

[8] Redis. Redis Strings. https://redis.io/docs/latest/develop/data-types/strings/

[9] Redis. Redis Hashes. https://redis.io/docs/latest/develop/data-types/hashes/

[10] Redis. Redis Sorted Sets. https://redis.io/docs/latest/develop/data-types/sorted-sets/

[11] Redis. HINCRBY Command. https://redis.io/docs/latest/commands/hincrby/

[12] Redis. ZADD Command. https://redis.io/docs/latest/commands/zadd/

[13] Redis. ZRANGEBYSCORE Command. https://redis.io/docs/latest/commands/zrangebyscore/

[14] Redis. ZREMRANGEBYSCORE Command. https://redis.io/docs/latest/commands/zremrangebyscore/

[15] Redis. Redis Lists. https://redis.io/docs/latest/develop/data-types/lists/

[16] Redis. Redis Sets. https://redis.io/docs/latest/develop/data-types/sets/

[17] Redis. Redis Streams. https://redis.io/docs/latest/develop/data-types/streams/


[18] Redis. Transactions. https://redis.io/docs/latest/interact/transactions/

[19] Redis. EXEC Command. https://redis.io/docs/latest/commands/exec/

[20] Redis. Redis Pipelining. https://redis.io/docs/latest/develop/using-commands/pipelining/

[21] Redis. Scripting with Lua. https://redis.io/docs/latest/develop/programmability/eval-intro/

[22] Redis. Redis Lua API Reference. https://redis.io/docs/latest/develop/interact/programmability/lua-api/

[23] Redis. You Don’t Need Transaction Rollbacks in Redis. https://redis.io/blog/you-dont-need-transaction-rollbacks-in-redis/
