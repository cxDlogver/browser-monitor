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

<!-- REDIS_SECTION_3_CONTINUE -->

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
