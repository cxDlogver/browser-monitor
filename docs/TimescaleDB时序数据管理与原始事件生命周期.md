# TimescaleDB 时序数据管理与原始事件生命周期

> **文档定位**：以 TimescaleDB 时序数据管理为知识主线，按“时序需求 → Hypertable/Chunk → Chunk Interval → 索引 → 主键幂等 → 时间聚合 → 连续聚合 → 水位与实时查询 → 压缩 → 保留 → 迟到数据 → Browser Monitor 应用 → 运行验证”依次展开。每节先回答实际问题，再解释运行机制，并穿插可复核的 SQL、事件示例和项目源码。
>
> **贯穿案例**：`telemetry_events` 是由浏览器上报、校验、脱敏、去重后保存的原始事件 Hypertable；`telemetry_rollup_1m` 和 `telemetry_rollup_1h` 直接统计其事件数量。涉及 `performance_samples` 等其他表的旧专题实例只用于说明 TimescaleDB 的通用机制、层级聚合和 Two-step State，**不与原始事件的 event_count 混为同一条链**。
>
> **源码与证据边界**：代码与迁移仅能证明配置及调用路径；Chunk Interval、物化水位、后台 Job 成功率和实际压缩率必须在运行数据库中验证。项目采用传统 `timescaledb.compress` 配置，Hypercore/Columnstore 的新 API 作为版本演进单独标识。
>
> **知识衔接**：[PostgreSQL 数据模型与访问](./服务端数据管理源码学习.md) · [数据库事务和并发控制](./服务端数据管理源码学习-2.md) · [浏览器监控平台服务端全链路](./浏览器监控平台-服务端全链路.md)。

## 1. 时序数据管理从持续增长的历史数据需求开始

### 【沿一条原始事件的生命周期建立问题顺序】

~~~text
业务系统产生一次行为或性能事实
    ↓ SDK 获取事实并形成遥测事件
服务端接收一批事件
    ↓ 协议、项目、时间校验，安全处理与去重
数据库写入原始事件
    ↓ Schema / JSONB / 事务 / 主键
时序数据的物理组织
    ↓ PostgreSQL、Hypertable、Chunk、分区粒度
原始明细的查询
    ↓ 索引、查询计划、Chunk 裁剪、时间窗口
时间序列分析
    ↓ time_bucket、Continuous Aggregate、统计状态
历史数据的生命周期
    ↓ 压缩策略、Retention、后台管理
运行与容量验证
    ↓ 活跃数据量、迟到写入、内存、连接与指标
~~~

这是一条**学习因果主线**，不是声称每次插入事件后才依次建立分区、索引与保留策略。建表和策略配置通常提前由 Migration 完成；实际运行时，数据库在同一组存储对象上持续执行写入、查询、后台维护。

接下来逐轮回答这些问题：

1. 为什么不断增长的时间数据会引出专门存储管理需求？（已讨论）
2. Hypertable 与 Chunk 是什么；数据真正写进哪里？（已讨论）
3. Chunk 的时间跨度怎样选，过大或过小会造成什么影响？（已讨论）
4. 时间分区、B-Tree 索引与 JSONB 查询各有什么职责？（已讨论：分区与复合 B-Tree；JSONB 索引为延伸专题）
5. 事务、主键和唯一性在时间分区表中怎么设计？（已讨论）
6. 时间窗口聚合如何从原始事件得出趋势结果？先理解 GROUP BY 和 time_bucket。（已讨论）
7. Continuous Aggregate 为什么需要物化结果、失效记录与自动刷新？（已讨论；水位、历史修改与实时查询已追问）
8. 历史 Chunk 的压缩如何工作？行存储、压缩布局和压缩策略有什么区别？（已讨论）
9. Retention 如何自动清理过期 Chunk？它与原始明细、历史聚合的保留期如何协调？（已讨论）
10. 在上述机制已经建立后，再讨论迟到数据、乱序写入如何影响历史 Chunk、刷新窗口和数据保留。（已讨论）
11. 项目原始事件如何从接入、入库、分钟/小时事件计数，最终被 API 和 Web 消费？（已讨论）
12. 如何用真实 SQL、执行计划和后台 Job 状态验证运行效果？（下一轮）

### 【必要的项目背景：一条原始事件从哪里来】

假设某个网站接入浏览器监控 SDK。用户打开产品页、点击关键按钮、触发异常，或者浏览器形成性能测量值时，SDK 会根据采集规则生成监控记录，再按批次发送到服务端。

“原始事件”指**保留单次事实的明细数据**，并不是把 HTTP 请求原封不动存储；本项目在入库前先完成服务端校验、脱敏和去重。

| 数据 | 例子（仅示意） | 业务含义 |
| --- | --- | --- |
| 所属项目 | 网站 A | 区分多个接入的网站或应用 |
| 事件 ID | `evt-001` | 标识一次事件，以便去重和定位 |
| 发生时间 | 10:00:00 | 用户行为真实发生的时间 |
| 接收时间 | 10:00:03 | 服务端收到并写入的时间 |
| 事件类型 | `view` | 例如一次页面访问 |
| 所属页面 | `/product` | 对应的业务页面 |
| 事件内容 | JSON | 保留安全处理后的协议属性 |

这个例子是帮助理解的简化结构，**不是完整 TelemetryEventV3 协议对象**。

实际业务链路：

~~~text
浏览器监控 SDK → 监控事件批次
    ↓
数据接入 API（Ingestion API）
    ├─ 校验协议、项目身份、来源和事件时间
    ├─ URL 清理、用户 ID 匿名化、指定属性脱敏
    └─ 重复事件过滤
    ↓
PostgreSQL 数据库事务
    ↓
telemetry_events 原始事件明细表
    ↓
TimescaleDB 按事件发生时间组织 Chunk
    ↓
按项目/时间/类型查询、历史压缩、保留窗口清理
~~~

**术语与变量对应**：
- `telemetry_events`：项目为“原始遥测事件明细”起的表名，不是 TimescaleDB 固定名称。
- `occurred_at`：事件**发生时间**；本项目的时间分区维度。
- `received_at`：服务器**接收时间**，与发生时间可能不同。
- `event jsonb`：存储完整安全处理后事件内容的 PostgreSQL JSONB 列。
- `project_id`：事件所属项目，也是常见的查询过滤字段。

源码：[服务端数据接入](../platform/apps/api/src/ingestion/ingestion.service.ts)、[建表与 TimescaleDB 迁移](../platform/packages/database/migrations/0001_platform.sql)。





### 【普通 PostgreSQL 能存储、查询和索引时间数据】

先从一个普通表开始：

~~~sql
-- 通用简化示例，非项目实际完整表
CREATE TABLE events (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  type varchar(32),
  payload jsonb
);
~~~

PostgreSQL 能保存这些数据，能建立 B-Tree 索引，能用 `WHERE occurred_at >= ... AND occurred_at < ...` 按时间查询，也具有原生声明式分区和事务能力。

因此**是否使用 TimescaleDB，不能仅根据表有 `timestamp` 字段判断**。例如用户表有注册时间，但查询主要按用户 ID，未必构成专门的时序数据工作负载。

### 【时序数据管理问题来自三个逐渐叠加的特点】

**第一，持续增长。** 监控、设备传感器、行情等数据一般持续追加；即使业务动作结束，历史事件仍保留，表数据与索引可能不断变大。例：每天 100 万条，30 天就是累计 3000 万条（数字仅为示例）。

**第二，查询以时间范围为主。** 分析通常询问“某项目昨天发生什么”“最近一小时出现多少次错误”“最近一个月的趋势”。需要避免每次查询无关历史数据；可以通过索引，也可以使用时间分区及分区裁剪。

**第三，历史数据需分层管理。** 新数据用于近期精细排查，较旧明细用于有限期追溯，长期只保留部分趋势数据，或者压缩、删除已经过期的明细。

~~~text
PostgreSQL：基础 SQL、事务、索引、数据类型、原生分区
    ↓ 当业务呈现持续写入 + 时间范围查询 + 历史生命周期管理
TimescaleDB 扩展
    ├─ Hypertable / Chunk：自动组织时间分区
    ├─ 时间窗口及连续聚合：反复计算历史趋势
    └─ 压缩与 Retention：自动管理历史数据
~~~

**通用结论**：TimescaleDB 是 PostgreSQL 的时序扩展，不是另一套替代 PostgreSQL SQL/事务的独立数据库。它提供的是针对时序工作负载的一组集成和自动化机制；普通 PostgreSQL 也能通过原生分区和外部调度工具实现相当一部分能力。

### 【结合原始事件验证为什么具有时序特点】

真实建表结构（省略其他上下文列）：

~~~sql
CREATE TABLE telemetry_events (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  type varchar(32) NOT NULL,
  name varchar(128) NOT NULL,
  event jsonb NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (project_id, event_id, occurred_at)
);
~~~

`telemetry_events` 会随着页面访问、性能和异常事件不断增长；按某项目和某时间窗口查询很常见；旧事件不需要永远以完整明细形式保留，所以项目引入了按时间组织与生命周期策略。

这不意味着使用 Hypertable 就保证每个查询都会快。真实效果取决于事件量、Chunk 粒度、索引选择、时间过滤条件以及 SQL 的执行计划。



### 【PostgreSQL 中的时序负载与 Browser Monitor 场景】



这一节先不进入：

~~~text
Hypertable
Chunk
Continuous Aggregate
Compression
Retention
~~~

因为这些都是 TimescaleDB 内部能力。

在理解内部机制之前，必须先回答一个更基础的问题：

> **当前 Browser Monitor 已经使用 PostgreSQL，为什么还需要 TimescaleDB？TimescaleDB 在整个服务端数据管理链路中到底处于什么位置？**

如果这个位置没有建立清楚，后面学习 TimescaleDB 很容易退化成：

~~~text
create_hypertable 是什么

time_bucket 怎么写

Continuous Aggregate 怎么配置

Compression Policy 有哪些参数
~~~

最终只记住零散 API，而没有建立“什么时候需要这一类数据管理能力”的系统框架。

这一节因此只做一件事：

~~~text
把 TimescaleDB 放回完整 Server Data Architecture
~~~



### 【先从项目整体数据链路定位 TimescaleDB】

#### <u>1. 项目原文已经明确给出 TimescaleDB 所处的数据处理阶段</u>

当前 platform/README.md 对完整链路的描述是：

> Monitor SDK → 公开 DSN → Ingestion API → telemetry_events + Outbox → Worker → TimescaleDB 聚合 → Analytics API → React 看板

先不看任何 TimescaleDB API，只把这条链拆成职责：

~~~text
Monitor SDK
    ↓
数据产生

Ingestion API
    ↓
数据接收

telemetry_events + Outbox
    ↓
原始事实可靠落库
+
记录后续处理任务

Worker
    ↓
异步加工
形成领域查询模型

TimescaleDB
    ↓
时序数据组织
+
时序聚合
+
历史数据生命周期

Analytics API
    ↓
查询与统计服务

React Dashboard
    ↓
展示
~~~

因此从项目原文就能先得到一个非常重要的结论：

~~~text
TimescaleDB
并不位于数据入口

TimescaleDB
也不负责前端 Session / Cache / Rate Limit

TimescaleDB
主要出现在数据已经可靠接收以后
进入长期时序分析的阶段
~~~

所以它在当前项目中的位置更接近：

~~~text
Data Ingestion
    ↓
Durable Storage
    ↓
Async Processing
    ↓
Time-Series Management
    ↓
Analytics
~~~

而不是：

~~~text
Request
    ↓
TimescaleDB
    ↓
Response
~~~

这样一条孤立链路。

#### <u>2. TimescaleDB 所处的位置说明它解决的是“长期历史数据怎样管理”</u>

把 Browser Monitor 再压缩成一条数据生命周期：

~~~text
Browser
    ↓
产生 Telemetry

API
    ↓
接收 Telemetry

PostgreSQL Transaction
    ↓
保证 Raw Event + Outbox
可靠提交

Worker
    ↓
把 Raw Event
加工成查询模型

TimescaleDB
    ↓
管理不断增长的
Time-Series Data

Analytics API
    ↓
按照时间范围
查询趋势与统计

Redis
    ↓
缓存最终 Query Result

Web
    ↓
展示
~~~

这里已经可以发现：

~~~text
PostgreSQL Transaction
解决：
这批数据是否可靠成为事实

Worker
解决：
原始数据怎样被加工

TimescaleDB
解决：
长期时序数据怎样组织和查询

Redis
解决：
运行时结果怎样快速复用
~~~

所以 TimescaleDB 的核心问题不是：

~~~text
数据能不能存进去？
~~~

因为普通 PostgreSQL 本身已经可以 INSERT。

它真正面对的是：

~~~text
数据持续产生以后
怎样长期组织？

历史越来越多以后
怎样按时间范围查询？

同一类统计不断被重复计算
怎样降低成本？

旧数据价值变化以后
怎样压缩、降采样和清理？
~~~

这才是：

~~~text
Time-Series Data Management
~~~

的真正入口。



### 【从部署源码确认 TimescaleDB 与 PostgreSQL 的真实关系】

理解项目链路以后，再进入部署代码。

这里最重要的是先纠正一个容易出现的概念错误：

~~~text
PostgreSQL
TimescaleDB
Redis

≠

三个完全独立的数据库系统
~~~

当前项目不是这样设计的。

#### <u>1. Docker Service 名叫 timescaledb，但应用连接的仍然是 PostgreSQL</u>

当前 docker-compose.yml：

~~~yaml
timescaledb:
  image: timescale/timescaledb-ha:pg17

  environment:
    POSTGRES_DB: monitor
    POSTGRES_USER: monitor
    POSTGRES_PASSWORD: ...

  ports:
    - "5432:5432"
~~~

API / Worker 使用：

~~~text
DATABASE_URL
    ↓
postgres://monitor:...@timescaledb:5432/monitor
~~~

这里可以直接看到：

~~~text
Protocol
    ↓
postgres://

Port
    ↓
5432

Database
    ↓
monitor

User
    ↓
PostgreSQL User
~~~

应用没有使用另一套：

~~~text
timescale://
~~~

协议。

因此运行关系应该理解成：

~~~text
Application
    ↓
PostgreSQL Driver
    ↓
PostgreSQL Protocol
    ↓
PostgreSQL Database Engine
    +
TimescaleDB Extension
~~~

而不是：

~~~text
Application
 ├── PostgreSQL Database
 └── TimescaleDB Database
~~~

#### <u>2. Migration 进一步证明 TimescaleDB 是 PostgreSQL 内部扩展能力</u>

当前 0001_platform.sql 一开始：

~~~sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
~~~

这段代码表达的层级非常清楚：

~~~text
PostgreSQL Database
│
├── PostgreSQL Native Capability
│
├── pgcrypto Extension
│
├── timescaledb Extension
│
└── timescaledb_toolkit Extension
~~~

所以前两篇已经学过的：

~~~text
Table

SQL

Index

Constraint

Transaction

MVCC

Connection Pool
~~~

并没有因为 TimescaleDB 出现而失效。

更准确地说：

~~~text
PostgreSQL
    ↓
提供通用关系型数据管理基础

TimescaleDB
    ↓
在 PostgreSQL 之上
增加 Time-Series Capability
~~~

后面才会逐步展开：

~~~text
Hypertable

Chunk

time_bucket

Continuous Aggregate

Retention

Compression / Columnstore

Time-Series Hyperfunctions
~~~

因此需要先固定一个概念：

> **TimescaleDB 不是 PostgreSQL 的替代数据库，而是建立在 PostgreSQL 之上的时序数据管理扩展层。**

#### <u>3. PostgreSQL 与 TimescaleDB 是“基础能力 + 专用工作负载能力”的关系</u>

可以抽象成：

~~~text
PostgreSQL
│
├── General Relational Data Management
│   ├── Table
│   ├── Relation
│   ├── SQL
│   ├── Index
│   ├── Constraint
│   ├── Transaction
│   └── Concurrency Control
│
└── TimescaleDB Extension
    └── Time-Series Data Management
        ├── Time Partition
        ├── Time Range Query
        ├── Time Bucket
        ├── Incremental Aggregate
        ├── Historical Rollup
        └── Data Lifecycle
~~~

因此：

~~~text
TimescaleDB Knowledge
~~~

不是另外一套和 PostgreSQL 毫无关系的知识。

而是：

~~~text
PostgreSQL Knowledge
        ↓
遇到 Time-Series Workload
        ↓
增加专门的数据组织与分析能力
~~~

这也是本篇为什么必须建立在前两篇 PostgreSQL 学习之后。



### 【当前项目之所以需要 TimescaleDB，是因为数据 Workload 已经发生变化】

既然 PostgreSQL 本身可以建表、插入、索引和查询，那么自然要继续问：

> **为什么当前项目不能只停留在普通 PostgreSQL 数据模型？**

答案不应该简化成：

~~~text
TimescaleDB 更快
~~~

而应该先比较项目中的两类数据。

#### <u>1. 一类是关系型业务状态，核心是实体当前状态与关系</u>

当前 Migration 中：

~~~text
users

user_sessions

account_tokens

projects

project_members

ingestion_keys

allowed_origins

threshold_versions

project_invitations

outbox_tasks
~~~

这些数据主要表达：

~~~text
User 是谁

Project 是什么

谁属于哪个 Project

当前使用哪个 Threshold

Token 是否有效

Outbox Task 当前处于什么状态
~~~

典型访问方式：

~~~sql
WHERE id = ?

WHERE user_id = ?

WHERE project_id = ?

WHERE token_hash = ?

WHERE active = true
~~~

它们的核心问题更接近：

~~~text
Entity
    ↓
Relation
    ↓
Constraint
    ↓
Transaction
    ↓
Current Business State
~~~

这就是前两篇 PostgreSQL 学习主要解决的：

~~~text
Relational Business Data
~~~

#### <u>2. 另一类是持续产生的监控事实，核心是系统随时间怎样变化</u>

当前 Migration 中还有：

~~~text
telemetry_events

performance_samples

view_records

custom_event_samples

custom_signal_samples

custom_metric_samples
~~~

这些表都有非常重要的时间字段：

~~~text
occurred_at

observed_at

started_at
~~~

例如 performance_samples 形成的逻辑更像：

~~~text
10:00:01
LCP = 2100

10:00:05
LCP = 2500

10:00:10
INP = 180

10:00:16
LCP = 1900

...
~~~

系统真正关心的通常不是：

~~~text
根据 Primary Key
找某一条 Sample
~~~

而是：

~~~text
Project P001

过去 24 小时

LCP

每一分钟

count
avg
p50
p75
p95
good / poor
~~~

查询结构变成：

~~~text
Entity Scope
    +
Time Range
    +
Time Bucket
    +
Aggregation
~~~

这就是：

~~~text
Time-Series Workload
~~~

#### <u>3. Time-Series 的关键不是“表里有 timestamp”，而是时间成为第一组织维度</u>

普通业务表同样可能有：

~~~text
created_at
updated_at
~~~

但它们不一定是 Time-Series。

判断一份数据是不是典型时序工作负载，更重要的是：

~~~text
Time
    ↓
是否决定数据排序？

Time Range
    ↓
是否是主要查询条件？

New Data
    ↓
是否持续沿时间轴追加？

Analytics
    ↓
是否经常按时间 Bucket 聚合？

Lifecycle
    ↓
历史数据价值是否随时间变化？
~~~

所以可以抽象：

~~~text
Relational Entity Data
        ↓
Entity-centered

Time-Series Data
        ↓
Time-centered
~~~

这个区别非常重要。

后面所有 TimescaleDB 能力都不是凭空产生，而是从这个 Workload 差异自然推出来的。



### 【Time-Series Workload 会产生三类新的数据管理问题】

当前项目引入 TimescaleDB，不是因为普通 PostgreSQL 无法存数据，而是因为随着监控数据规模增长，会出现三类越来越突出的系统问题。

#### <u>1. 第一类问题是 Growing Dataset：持续增长的数据需要稳定的物理组织方式</u>

普通项目表可能：

~~~text
projects
    ↓
几百
几千
几万 Rows
~~~

而 Telemetry 是：

~~~text
每秒持续产生
~~~

假设：

~~~text
100 events / second
~~~

一天就是：

~~~text
8,640,000 events
~~~

如果：

~~~text
1000 events / second
~~~

一天就是：

~~~text
86,400,000 events
~~~

持续运行以后：

~~~text
Time
    ↓
Row Count
    ↓
Storage
    ↓
Index Size
    ↓
Query Cost
    ↓
Maintenance Cost
~~~

都会持续增加。

所以第一类核心问题不是“怎样让数据停止增长”，而是：

~~~text
Growing Dataset
        ↓
Physical Organization
        ↓
怎样把持续增长的数据
拆成可管理的物理范围
~~~

普通：

~~~text
一张表 + 一个 Index
~~~

并不能完整回答：

~~~text
数据持续增长以后
物理数据怎样继续组织和访问
~~~

的问题。

这里需要提前区分两个层次：

~~~text
Hypertable / Chunk
        ↓
组织增长
        ↓
把持续增长的 Time-Series Dataset
按时间范围拆成可管理的 Physical Partitions

Compression / Retention / Downsampling
        ↓
治理长期增长
        ↓
控制历史数据继续占用的存储、扫描和保留成本
~~~

因此 Hypertable 解决的是 **Growing Dataset 的 Physical Organization**，而不是让总数据量不再增长。真正的长期数据量治理还要继续进入 Historical Data Lifecycle。

#### <u>2. 第二类问题是 Analytical Query：查询通常扫描范围后再聚合</u>

普通业务查询：

~~~sql
SELECT *
FROM projects
WHERE id = $1;
~~~

而监控 Analytics 更接近：

~~~sql
SELECT
  time_bucket(
    INTERVAL '1 minute',
    observed_at
  ),
  percentile_cont(0.75)
FROM performance_samples
WHERE
  project_id = $1
  AND observed_at >= $2
  AND observed_at < $3
GROUP BY ...;
~~~

后者往往经历：

~~~text
Time Range Scan
    ↓
Filter
    ↓
Group
    ↓
Aggregate
    ↓
Percentile / Distinct
    ↓
Return Trend
~~~

同一个 Dashboard 还会不断重复类似计算。

于是第二类问题变成：

~~~text
Repeated Analytical Computation
~~~

而不只是：

~~~text
Single Row Lookup
~~~

#### <u>3. 第三类问题是 Data Lifecycle：历史数据价值随时间发生变化</u>

监控数据通常具有很明显的时间价值变化：

~~~text
刚产生
    ↓
定位问题价值最高
需要完整明细
需要高分辨率

几天以后
    ↓
仍需要分析
但单条 Event 价值下降

几个月以后
    ↓
更多关注长期趋势
而不是每一条原始记录
~~~

所以：

~~~text
所有 Raw Data
永远以相同精度保存
~~~

并不是唯一合理方案。

当前项目已经明确：

~~~text
Raw / Detail
    ↓
30 days

Aggregate
    ↓
180 days
~~~

这说明时序数据系统必须继续回答：

~~~text
什么时候保留 Raw？

什么时候聚合？

什么时候压缩？

什么时候降低时间分辨率？

什么时候删除？
~~~

第三类核心问题因此是：

~~~text
Historical Data Lifecycle
~~~



### 【TimescaleDB 的核心能力可以从三类 Workload 问题自然推出】

到这里还没有深入任何一个 API，但已经能够自然推出 TimescaleDB 为什么会出现。

~~~text
Time-Series Workload
│
├── ① Growing Dataset
│      ↓
│   Physical Organization
│      ↓
│   Time Partition
│   Hypertable
│   Chunk
│
├── ② Analytical Query
│      ↓
│   time_bucket
│   Continuous Aggregate
│   Hyperfunctions
│   Rollup
│
└── ③ Data Lifecycle
       ↓
    Compression / Columnstore
    Retention
    Downsampling
~~~

因此 TimescaleDB 不应该被记成：

~~~text
一个比 PostgreSQL 更快的数据库
~~~

而应该记成：

> **TimescaleDB 在 PostgreSQL 通用关系型能力之上，为持续增长、以时间范围查询和聚合为主要访问模式的数据增加专门的数据组织、分析和生命周期能力。**

这也是后面整个学习顺序的来源：

~~~text
为什么需要 Time-Series Management
        ↓
持续增长的数据怎样按时间组织
        ↓
Hypertable / Chunk
        ↓
组织增长，而不是停止增长

然后
        ↓
数据怎样按时间聚合
        ↓
time_bucket / Continuous Aggregate

然后
        ↓
历史数据怎样降采样和继续聚合
        ↓
Rollup / Two-step Aggregate

最后
        ↓
历史数据怎样控制长期成本
        ↓
Compression / Retention
~~~

也就是说：

~~~text
TimescaleDB API
~~~

不是学习起点。

真正的起点是：

~~~text
Time-Series Workload
~~~



### 【回到源码，当前 TimescaleDB 实际已经承担四层职责】

建立通用框架以后，再重新看当前项目源码。

当前项目不是只使用：

~~~text
create_hypertable
~~~

一个功能。

整个 Migration 已经形成四层能力。

#### <u>1. Time-Series Storage 负责组织 Raw 与 Projection Data</u>

源码：

~~~sql
SELECT create_hypertable(
  'telemetry_events',
  'occurred_at',
  if_not_exists => TRUE
);

SELECT create_hypertable(
  'performance_samples',
  'observed_at',
  if_not_exists => TRUE
);

SELECT create_hypertable(
  'view_records',
  'started_at',
  if_not_exists => TRUE
);
~~~

这层负责：

~~~text
持续增长的 Raw / Projected Data
        ↓
按照时间维度组织
~~~

这里下一节才深入：

~~~text
Hypertable
+
Chunk
+
Chunk Pruning
+
Index
~~~

#### <u>2. Time-Series Analytics 负责把时间轴转换成统计结果</u>

源码：

~~~sql
CREATE MATERIALIZED VIEW performance_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(
    INTERVAL '1 minute',
    observed_at
  ) AS bucket,
  ...
FROM performance_samples
GROUP BY ...;
~~~

它把：

~~~text
Raw Samples
    ↓
Continuous Timeline
~~~

转换成：

~~~text
1-minute Aggregate
~~~

后面还存在：

~~~text
1m
    ↓
1h
~~~

形成：

~~~text
Precomputation
+
Downsampling
~~~

#### <u>3. Statistical State 负责保存可继续组合的分析状态</u>

当前不仅计算：

~~~text
count
avg
min
max
~~~

还使用：

~~~sql
percentile_agg(value)
~~~

以及：

~~~sql
hyperloglog(
  8192,
  session_id
)
~~~

说明当前数据库层还承担：

~~~text
Percentile

Distinct Session

Distinct View
~~~

这类复杂统计。

后续会单独进入：

~~~text
Two-step Aggregate
~~~

解释为什么不能简单保存：

~~~text
一个 p75 number
或
一个 count distinct number
~~~

而需要保留可 Rollup 的中间状态。

#### <u>4. Historical Lifecycle 负责决定旧数据怎样继续存在</u>

当前 Migration 还存在：

~~~text
add_compression_policy

add_retention_policy
~~~

说明系统已经明确：

~~~text
Data Age
    ↓
Storage Strategy
    ↓
Resolution
    ↓
Retention
~~~

会随时间发生变化。

最终形成：

~~~text
Recent
    ↓
Raw Detail

Older
    ↓
Compressed Detail

Historical
    ↓
Aggregate

Expired
    ↓
Delete
~~~

所以当前 TimescaleDB 的真实职责已经不是：

~~~text
一个数据库插件
~~~

而是完整的：

~~~text
Time-Series Storage
+
Analytics
+
Statistical Processing
+
Historical Lifecycle
~~~



### 【TimescaleDB 与 PostgreSQL、Redis 的职责边界必须放在同一张图中】

理解 TimescaleDB 以后，需要把前面已经学过的 PostgreSQL 与 Redis 一起放回来。

~~~text
                    Server Data
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
 Relational State   Time-Series State   Runtime State
       │                 │                 │
       ▼                 ▼                 ▼
 PostgreSQL        PostgreSQL +          Redis
                   TimescaleDB
~~~

这里严格来说：

~~~text
TimescaleDB
仍然属于 PostgreSQL 数据库体系
~~~

只是面对不同 Workload。

#### <u>1. PostgreSQL 的核心是长期关系型业务事实是否正确</u>

典型：

~~~text
users

projects

project_members

threshold_versions

outbox_tasks
~~~

核心关注：

~~~text
Relation

Constraint

Transaction

Concurrency

Durability

Business Invariant
~~~

可以概括：

~~~text
Authoritative Relational State
~~~

#### <u>2. TimescaleDB 的核心是持续增长的历史事实怎样长期管理</u>

典型：

~~~text
telemetry_events

performance_samples

view_records

custom_signal_samples
~~~

核心关注：

~~~text
Time Partition

High Ingest

Time Range Query

Aggregation

Downsampling

Historical Lifecycle
~~~

可以概括：

~~~text
Authoritative Time-Series History
~~~

#### <u>3. Redis 的核心是运行中的共享状态怎样高频访问</u>

典型：

~~~text
Session

Rate Limit

Recent Window

Analytics Cache

Cache Version
~~~

核心关注：

~~~text
Low Latency

TTL

Atomic Mutation

Runtime Shared State

Derived State
~~~

可以概括：

~~~text
Runtime / Derived State
~~~

因此不要建立：

~~~text
PostgreSQL = 慢

TimescaleDB = 快

Redis = 最快
~~~

这种性能排序模型。

应该建立：

~~~text
PostgreSQL
    ↓
Relational / Transactional Model

TimescaleDB
    ↓
Time-Series / Analytical Model

Redis
    ↓
Runtime State Model
~~~

它们解决的是不同的数据管理问题。



### 【脱离当前项目，建立是否需要 Time-Series Data Management 的判断框架】

以后遇到其他系统，不应该看到：

~~~text
数据很多
~~~

就直接决定：

~~~text
使用 TimescaleDB
~~~

应该顺着数据语义和访问模式判断。

#### <u>1. 数据是否天然沿时间持续产生</u>

典型：

~~~text
Metrics

Logs

Telemetry

IoT Sensor Data

Financial Ticks

Observability Events
~~~

共同模式：

~~~text
Time T1
    ↓
New Data

Time T2
    ↓
New Data

Time T3
    ↓
New Data
~~~

如果数据主要不是这样产生，TimescaleDB 未必有意义。

#### <u>2. 主要查询是否围绕 Time Range</u>

例如：

~~~text
最近 1 小时

最近 24 小时

过去 7 天

过去 30 天
~~~

如果系统核心查询仍然只是：

~~~text
WHERE id = ?
~~~

那么普通 PostgreSQL 可能已经足够。

#### <u>3. 是否需要大量时间聚合</u>

例如：

~~~text
每分钟

每小时

每天
~~~

并计算：

~~~text
COUNT

AVG

SUM

P75

P95

Distinct
~~~

这时 Time-Series Analytics 特征开始变强。

#### <u>4. 数据是否会长期持续增长</u>

例如：

~~~text
Today
    ↓
10M rows

Next Month
    ↓
300M rows

Next Year
    ↓
Billions of rows
~~~

如果数据规模会沿时间持续累积：

~~~text
Partition
Rollup
Lifecycle
~~~

就会逐渐成为核心设计问题。

#### <u>5. 历史数据是否允许降低时间精度</u>

例如：

~~~text
最近 24h
    ↓
Raw

最近 30d
    ↓
1-minute

半年历史
    ↓
1-hour
~~~

如果答案是 Yes：

~~~text
Continuous Aggregate

Downsampling

Retention
~~~

会具有很高价值。

因此可以形成完整判断链：

~~~text
Data
 ↓
是否 Time-oriented？
 ↓ Yes
是否持续产生？
 ↓ Yes
是否主要 Time Range Query？
 ↓ Yes
是否频繁 Aggregate？
 ↓ Yes
是否随时间长期增长？
 ↓ Yes
是否需要 Historical Lifecycle？
 ↓ Yes

Time-Series Data Management
        ↓
TimescaleDB
成为候选方案
~~~

这里仍然是：

~~~text
候选方案
~~~

而不是：

~~~text
唯一方案
~~~

最终还需要结合：

~~~text
Current PostgreSQL Stack

Scale

Operation Cost

Query Complexity

Team Capability

Deployment Model
~~~

进行判断。



### 【回到 Browser Monitor，给当前 TimescaleDB 一个准确定位】

经过前面的项目源码、Workload 和通用框架，现在可以准确描述当前项目：

> **Browser Monitor 是一个以 PostgreSQL 为统一持久化基础，利用 TimescaleDB Extension 管理大量遥测时序历史，再使用 Redis 管理运行时状态和查询缓存的数据平台。**

完整数据层：

~~~text
                     Browser Monitor Data Layer
                               │
             ┌─────────────────┼──────────────────┐
             │                 │                  │
             ▼                 ▼                  ▼
     Relational Business   Time-Series Data   Runtime State
             │                 │                  │
             ▼                 ▼                  ▼
        PostgreSQL        TimescaleDB             Redis
             │                 │                  │
      User / Project       Telemetry          Session
      Permission           Performance        Rate Limit
      Threshold            View               Cache
      Outbox               Custom Signal      Counter
                               │
                               ▼
                         Continuous Aggregate
                               │
                               ▼
                            Rollup
                               │
                               ▼
                         Analytics API
~~~

因此 TimescaleDB 在当前项目中承担：

~~~text
不是：
另一个 PostgreSQL 替代品

不是：
Redis Cache 的替代品

而是：
PostgreSQL 之上的
Time-Series Data Management Layer
~~~



### 【第一节最终形成 TimescaleDB 的整体位置框架】

这一节不要求记住任何具体 API。

真正需要形成的是：

~~~text
PostgreSQL
解决：
数据怎样成为可靠的关系型业务事实
        ↓
系统开始产生大量
持续增长的时间数据
        ↓
普通 PostgreSQL 能继续保存
但 Workload 已经发生变化
        ↓
Data Growth
+
Time Range Query
+
Repeated Aggregation
+
Historical Lifecycle
        ↓
TimescaleDB
在 PostgreSQL 之上
增加 Time-Series Data Management
~~~

最终固定三个边界：

~~~text
TimescaleDB
≠
PostgreSQL 的替代品

TimescaleDB
≠
Redis 的替代品

TimescaleDB
=
PostgreSQL
+
Time-Series Data Management Capability
~~~

这就是后续整个 TimescaleDB 学习的起点。



## 2. Hypertable 与 Chunk 实现时序数据的分区存储

### 【Hypertable 是统一表入口，Chunk 是物理时间分区】

**Hypertable（超表）**是应用仍然通过同一个名字访问的时序表；**Chunk（数据块）**是 TimescaleDB 根据时间范围自动创建和管理的底层数据存储对象（实际 PostgreSQL 子表/分区），保存具体数据行，不是一次 HTTP Batch，也不是代码里的数组。

~~~text
业务代码：INSERT INTO events(...)
       ↓
Hypertable：events
       ↓ 根据 occurred_at 路由到正确时间范围
  ├── Chunk A（较早时间段）
  ├── Chunk B（中间时间段）
  └── Chunk C（最近时间段）
~~~

例如设想三段时间分别覆盖 10 月 1～7 日、8～14 日、15～21 日：10 月 3 日事件进入第一段，10 月 10 日事件进入第二段。以上“七天”只是**教学示例，不能推断为项目当前分区周期**。

如果一条记录的发生时间落在某个尚无 Chunk 的区间，数据库可以自动创建该范围的 Chunk，再写入记录。应用始终使用相同的 INSERT/SELECT 表名，不直接操作物理 Chunk 名称。

### 【时间分区不是索引，二者可以同时使用】

**分区裁剪（Chunk Pruning / Chunk Exclusion）**：当查询具有与分区时间范围有关的条件时，数据库可排除无关 Chunk，减少参与后续扫描的物理数据范围。

~~~sql
-- 通用查询例子
SELECT *
FROM events
WHERE occurred_at >= '2026-10-10 00:00:00+00'
  AND occurred_at <  '2026-10-11 00:00:00+00';
~~~

**索引查找**：进入相关 Chunk 后，数据库还需要根据项目、类型和时间等条件定位记录。分区并不会取代 B-Tree 等索引。

**历史数据清理**：时间分区还允许按块移除已经过期的整段数据，而不一定通过大量逐行 DELETE 清理。是否能够删掉完整 Chunk，取决于该 Chunk 的时间区间与保留截止时间。

但这三点都不能推出“Chunk 越多越快”。Chunk 过多会增加元数据、规划等成本；Chunk 过大又可能造成活跃索引和查询范围过大。之后专门讨论如何选时间跨度。

### 【项目实际调用 create_hypertable 的含义】

迁移 SQL：

~~~sql
SELECT create_hypertable(
  'telemetry_events',
  'occurred_at',
  if_not_exists => TRUE
);
~~~

解释：

1. `telemetry_events` 是要按时序组织的原始事件逻辑表。
2. `occurred_at` 是决定分块归属的时间字段，不是服务器收到事件的时间。
3. `if_not_exists => TRUE` 避免重复建立超表的操作出错。
4. 应用仍然 `INSERT INTO telemetry_events`，TimescaleDB 负责时间分区路由。
5. 当前源码**没有显式指定 Chunk 时间跨度**；不能从这段 SQL 得出实际一个 Chunk 覆盖一天还是七天。
6. 当前表并未将 `project_id` 定义为第二空间分区维度；它是字段和索引的组成部分。

### 【发生时间与接收时间为什么必须分开】

用户在 10:00:00 点击，客户端延迟或组批，服务器 10:03:00 收到：

~~~text
occurred_at = 10:00:00（业务动作发生时间）
received_at = 10:03:00（服务端接收时间）
~~~

当前使用 `occurred_at` 分区，所以一条迟到事件会进入**按其真实发生时间对应的 Chunk**，而不是一律进入当前接收时刻对应的最新 Chunk。

这有利于按业务时间还原事件过程，但会引出迟到事件写旧块、旧块已压缩或者超出保留窗口的问题。项目接入层额外做了发生时间窗口校验：拒绝早于当前 30 天或比当前未来超过 5 分钟的事件。这是**当前业务约束**，不是 TimescaleDB 自动提供的普适规则。

### 【真正的业务代码如何面向 Hypertable 写入】

服务端先从已通过校验的遥测对象提取公共列：

~~~ts
// 来自 IngestionService 的真实字段映射，项目另有其他校验和数据库事务
const rows = pending.map((event) => ({
  event_id: event.eventId,
  occurred_at: new Date(event.occurredAt).toISOString(),
  type: event.type,
  name: event.name,
  environment: event.app.environment,
  app_version: event.app.version,
  session_id: event.context.sessionId,
  view_id: event.context.viewId,
  route_name: event.context.routeName,
  user_hash: event.context.user?.id ?? null,
  event,
}));
~~~

随后将批次的 JSON 结构通过 PostgreSQL 的 `jsonb_to_recordset` 转为行，再执行插入。在这里展示 SQL 的相关部分：

~~~sql
-- 仅为逻辑摘录，不是可以单独运行的完整语句
INSERT INTO telemetry_events (
  project_id, event_id, occurred_at, type, name, ...
)
SELECT ...
ON CONFLICT DO NOTHING;
~~~

业务代码不需要计算 Chunk 名称；TimescaleDB 依据 `occurred_at` 完成物理路由。真实 SQL 同时维护其他必要数据库状态，但本轮不展开异步任务机制。

源码：[IngestionService](../platform/apps/api/src/ingestion/ingestion.service.ts)。

### 【同一个事件表为什么还有时间和项目索引】

迁移还定义：

~~~sql
CREATE INDEX telemetry_project_time_idx
  ON telemetry_events(project_id, occurred_at DESC);

CREATE INDEX telemetry_project_type_time_idx
  ON telemetry_events(project_id, type, occurred_at DESC);
~~~

这让“时间分块”和“索引定位”承担不同职责：

~~~text
WHERE project_id = ? AND occurred_at BETWEEN ... AND ...
       ↓
先借助时间范围排除不相关 Chunk
       ↓
对相关 Chunk 选择合适的索引或扫描方式
       ↓
读取满足项目及其他条件的原始事件
~~~

是否确实走索引，需要观察 `EXPLAIN (ANALYZE, BUFFERS)` 等证据；不能仅凭创建了索引就断言一定使用。PostgreSQL 原生分区也具备分区裁剪能力，TimescaleDB 的差别在于专门的时序组织及自动管理生态。



### 【扩展实例：Hypertable 的逻辑入口与物理分块】



这一节先把三个最容易混淆的问题直接回答清楚：

~~~text
问题 1：
Chunk 是逻辑概念，还是实际存储？

答案：
Chunk 是 TimescaleDB 自动创建和管理的真实 PostgreSQL 子表。
真正的数据 Row 会存入这些 Chunk。
它不是 TypeScript 代码，也不是内存里的一个对象。


问题 2：
create_hypertable 以后 performance_samples 还存在吗？

答案：
存在。

应用仍然：
INSERT INTO performance_samples
SELECT ... FROM performance_samples

performance_samples 仍然是应用看到的逻辑表。


问题 3：
performance_samples 还会不会一直变大？

答案：
逻辑上会。

例如总共有 1 亿条 performance_samples，
SELECT COUNT(*) 看到的仍然是 1 亿条。

但物理上不再是：
“一张 PostgreSQL 物理表里堆 1 亿条”。

而变成：
performance_samples
    ↓
Chunk A：一部分时间范围的数据
Chunk B：一部分时间范围的数据
Chunk C：一部分时间范围的数据
...
~~~

这就是这一节首先要建立的模型。



### 【先看普通 PostgreSQL Table 实际是什么】

先完全不考虑 TimescaleDB。

假设项目只创建：

~~~sql
CREATE TABLE performance_samples (
  project_id uuid NOT NULL,
  sample_id varchar(256) NOT NULL,
  observed_at timestamptz NOT NULL,
  name varchar(16) NOT NULL,
  value double precision NOT NULL
);
~~~

然后持续写：

~~~sql
INSERT INTO performance_samples
VALUES (...);
~~~

那么可以先简单理解为：

~~~text
performance_samples
        │
        ▼
一张 PostgreSQL Physical Table
        │
        ├── Row 1
        ├── Row 2
        ├── Row 3
        ├── ...
        └── Row 100,000,000
~~~

假设每天写 1000 万条：

~~~text
Day 1       1000 万
Day 2       2000 万
Day 3       3000 万
...
Day 100     10 亿
~~~

那么 Logical Table 和主要 Physical Data Structure 都在不断变大。

这里不是说 PostgreSQL 普通表一定不能存十亿数据，而是随着 Time-Series 数据持续增长，会越来越突出：

~~~text
大索引
大范围时间查询
历史数据删除
Vacuum / Maintenance
冷热数据管理
~~~

这些问题。

TimescaleDB 的第一步不是做聚合。

它先改变：

> **这张持续增长的 Table 在 PostgreSQL 内部怎样组织。**



### 【当前项目先创建普通 Table，再把它转换成 Hypertable】

来看当前项目真实源码。

0001_platform.sql：

~~~sql
CREATE TABLE performance_samples (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sample_id varchar(256) NOT NULL,
  observed_at timestamptz NOT NULL,
  last_updated_at timestamptz NOT NULL,
  name varchar(16) NOT NULL,
  value double precision NOT NULL CHECK (value >= 0),
  ...
  PRIMARY KEY (
    project_id,
    sample_id,
    observed_at
  )
);
~~~

执行到这里：

~~~text
performance_samples
        ↓
普通 PostgreSQL Table
~~~

紧接着：

~~~sql
SELECT create_hypertable(
  'performance_samples',
  'observed_at',
  if_not_exists => TRUE
);
~~~

这一步的含义不是：

~~~text
删除 performance_samples
然后创建一个 TimescaleDB 专用文件
~~~

也不是：

~~~text
复制一份 performance_samples
到另外一个数据库
~~~

而是：

~~~text
performance_samples
        ↓
仍然保留这个 Table 名称和 SQL 接口
        ↓
TimescaleDB 接管它的数据分区方式
        ↓
变成 Hypertable
~~~

可以先理解成：

~~~text
转换前

performance_samples
        ↓
普通 PostgreSQL Table


转换后

performance_samples
        ↓
TimescaleDB Hypertable
        ↓
底层自动管理多个 PostgreSQL Chunk Tables
~~~

应用程序依然：

~~~sql
INSERT INTO performance_samples ...

SELECT ...
FROM performance_samples
WHERE ...
~~~

不需要切换成另一套 SQL。



### 【Hypertable 是应用看到的一张逻辑表，Chunk 才是真正存 Row 的 PostgreSQL 子表】

这是这一节最重要的地方。

假设：

~~~sql
SELECT create_hypertable(
  'performance_samples',
  'observed_at'
);
~~~

然后数据库里已经产生一段时间的数据。

对业务代码来说仍然只有：

~~~text
performance_samples
~~~

但数据库内部可以近似理解成：

~~~text
                     performance_samples
                         Hypertable
                       应用访问入口
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
      Chunk A           Chunk B           Chunk C
   PostgreSQL Table   PostgreSQL Table   PostgreSQL Table

   一段时间数据       一段时间数据       一段时间数据
~~~

注意：

> **Chunk 不是程序概念上的数组分片。**

它是数据库内部真实创建和管理的 PostgreSQL 子表。

内部对象通常会位于 TimescaleDB 自己的 internal schema 中，名称类似：

~~~text
_timescaledb_internal._hyper_..._chunk
~~~

所以可以非常具体地理解：

~~~text
performance_samples
        ↓
是业务 SQL 使用的统一表名

_timescaledb_internal....
        ↓
是 TimescaleDB 在 PostgreSQL 内部
创建并管理的真实 Chunk Table
~~~

#### <u>1. Hypertable 和 Chunk 到底谁存数据</u>

| 对象 | 是不是数据库对象 | 是否真正承载 Row | 谁直接使用 |
|---|---|---:|---|
| performance_samples Hypertable | 是 | 对应用表现为完整数据集 | 应用程序 |
| Chunk | 是，真实 PostgreSQL 子表 | 是，实际 Row 分布在这些 Chunk 中 | TimescaleDB 自动管理 |

所以从应用视角：

~~~sql
SELECT *
FROM performance_samples;
~~~

看到所有数据。

从底层视角：

~~~text
这些 Row
实际分布在多个 Chunk
~~~



### 【Table 的总数据量仍然一直增长，但单张物理表不再无限增长】

#### <u>1. 从业务和 SQL 视角看，Hypertable 仍然一直增长</u>

假设每天 1000 万条：

~~~text
Day 1
performance_samples
逻辑上有 1000 万

Day 2
逻辑上有 2000 万

Day 10
逻辑上有 1 亿
~~~

执行：

~~~sql
SELECT COUNT(*)
FROM performance_samples;
~~~

仍然是在查询整张 Hypertable 的全部逻辑数据。

所以：

~~~text
Logical Dataset
仍然持续增长
~~~

#### <u>2. 从物理存储视角看，不再是一个 Physical Table 无限增长</u>

为了理解，假设：

~~~text
Chunk Interval = 1 day
~~~

这只是教学示例，不代表当前项目实际配置。

那么可能形成：

~~~text
performance_samples
Logical Dataset = 5000 万 Rows

底层：

Chunk 2026-10-01
    1000 万 Rows

Chunk 2026-10-02
    1000 万 Rows

Chunk 2026-10-03
    1000 万 Rows

Chunk 2026-10-04
    1000 万 Rows

Chunk 2026-10-05
    1000 万 Rows
~~~

所以：

~~~text
总数据：
仍然越来越多

但是：

单个 Physical Chunk：
只管理自己的时间范围
~~~

因此不能说：

~~~text
Hypertable 让 Table 不增长
~~~

正确表述是：

> **Hypertable 让整个逻辑数据集继续增长，但把不断增长的数据拆给多个较小的物理 Chunk 管理。**



### 【Chunk 为什么按照 observed_at 拆分】

回到项目：

~~~sql
SELECT create_hypertable(
  'performance_samples',
  'observed_at'
);
~~~

这两个参数分别表达：

~~~text
performance_samples
        ↓
哪张 Table 要被 TimescaleDB 管理

observed_at
        ↓
根据哪个字段
决定 Row 应该进入哪个 Chunk
~~~

所以 observed_at 不只是普通查询字段。

它同时变成：

~~~text
Partitioning Column
~~~

#### <u>1. 假设一个 Chunk 覆盖一天</u>

这里只为了理解。

例如：

~~~text
Chunk A

2026-10-01 00:00
~
2026-10-02 00:00


Chunk B

2026-10-02 00:00
~
2026-10-03 00:00


Chunk C

2026-10-03 00:00
~
2026-10-04 00:00
~~~

插入：

~~~text
Sample A

observed_at =
2026-10-01 08:20
~~~

TimescaleDB 判断这个时间属于 Chunk A 的时间范围，所以 Row 实际进入 Chunk A。

再插入：

~~~text
Sample B

observed_at =
2026-10-03 15:00
~~~

它会进入 Chunk C。

应用完全不用自己判断日期并选择目标表。



### 【真实 INSERT 过程到底发生了什么】

当前 Worker 最终只需要执行类似：

~~~sql
INSERT INTO performance_samples (
  project_id,
  sample_id,
  observed_at,
  ...
)
VALUES (...);
~~~

应用只知道：

~~~text
performance_samples
~~~

TimescaleDB 内部则可以理解为：

~~~text
Node / Worker
    ↓
INSERT INTO performance_samples
    ↓
PostgreSQL 接收 SQL
    ↓
TimescaleDB 识别：
performance_samples 是 Hypertable
    ↓
读取 Row 的 observed_at
    ↓
根据 observed_at
判断目标时间范围
    ↓
找到对应 Chunk
    ↓
Row 实际写入对应 Chunk
~~~

所以真正链路：

~~~text
Application SQL
       ↓
Hypertable
       ↓
Partition Routing
       ↓
Physical Chunk
       ↓
Row Storage
~~~

如果新的时间范围还没有对应 Chunk，TimescaleDB 会按自己的分区管理机制创建或使用新的 Chunk。

所以数据增长不再简单意味着一张物理表无限扩大，而更接近：

~~~text
Time Axis
    ↓
不断产生新的 Physical Partitions
~~~



### 【Chunk 是数据库对象，不是应用程序代码】

TimescaleDB 是 PostgreSQL Extension。

Extension 运行在 PostgreSQL Server 内部。

因此：

~~~text
Node.js
NestJS
Worker
~~~

都不会创建：

~~~text
class Chunk
new Chunk(...)
~~~

关系是：

~~~text
Node.js Application
        │
        │ SQL
        ▼
PostgreSQL
        │
        ├── TimescaleDB Extension
        │
        └── PostgreSQL Storage
                 │
                 ├── Chunk Table A
                 ├── Chunk Table B
                 └── Chunk Table C
~~~

所以：

> **Chunk 是 TimescaleDB 在 PostgreSQL 内部创建、注册和管理的真实子表，而不是 TypeScript / JavaScript 代码结构。**



### 【查询 performance_samples 时为什么不用手动查询 Chunk】

假设数据库内部：

~~~text
performance_samples

    Chunk A
    Chunk B
    Chunk C
    Chunk D
    Chunk E
~~~

应用依然可以：

~~~sql
SELECT *
FROM performance_samples
WHERE
  project_id = $1
  AND observed_at >= $2
  AND observed_at < $3;
~~~

原因是：

~~~text
performance_samples
~~~

对应用仍然代表：

~~~text
完整 Hypertable
~~~

PostgreSQL Planner 与 TimescaleDB 会根据时间条件：

~~~text
observed_at >= T1
observed_at < T2
~~~

判断：

~~~text
哪些 Chunk
可能包含这个时间范围
~~~

#### <u>1. 一个具体查询例子</u>

假设底层：

~~~text
Chunk A
10 月 1 日

Chunk B
10 月 2 日

Chunk C
10 月 3 日

Chunk D
10 月 4 日

Chunk E
10 月 5 日
~~~

用户查询：

~~~sql
WHERE observed_at >= '2026-10-03 10:00'
  AND observed_at <  '2026-10-03 11:00'
~~~

数据库可以判断：

~~~text
Chunk A
10/1
    ↓
一定没有
    ↓
跳过

Chunk B
10/2
    ↓
一定没有
    ↓
跳过

Chunk C
10/3
    ↓
可能存在
    ↓
查询

Chunk D
10/4
    ↓
一定没有
    ↓
跳过

Chunk E
10/5
    ↓
一定没有
    ↓
跳过
~~~

最终：

~~~text
5 Chunks
    ↓
只访问相关 Chunk
~~~

这就是：

~~~text
Chunk Pruning
~~~

也可以理解成：

~~~text
Partition Pruning
~~~

它解决的是：

> **先排除时间上绝对不可能包含目标数据的物理分区。**



### 【当前项目为什么选择 observed_at，而不是 last_updated_at】

performance_samples 有：

~~~text
observed_at

last_updated_at
~~~

为什么：

~~~sql
create_hypertable(
  'performance_samples',
  'observed_at'
)
~~~

而不是：

~~~text
last_updated_at
~~~

因为这两个时间表达的业务语义不同。

#### <u>1. observed_at 表示指标属于哪个实际观测时间</u>

例如：

~~~text
2026-10-01 10:05

用户这次 LCP = 2300ms
~~~

Analytics 查询：

~~~text
10:00 ~ 11:00
LCP 怎么变化
~~~

自然应该按照：

~~~text
observed_at
~~~

组织。

#### <u>2. last_updated_at 表示这一 Row 最后什么时候被修订</u>

例如 Web Vital：

~~~text
第一次：
sequence = 0

第二次：
sequence = 1

第三次：
sequence = 2
~~~

last_updated_at 会不断变化。

但是：

~~~text
这次性能观测属于哪个时间段
~~~

仍然由：

~~~text
observed_at
~~~

决定。

所以：

~~~text
Partition Time
~~~

应该与：

~~~text
业务主时间轴
~~~

一致。



### 【当前项目不同 Hypertable 使用不同业务时间轴】

源码：

~~~text
telemetry_events
    ↓
occurred_at
~~~

因为关心：

~~~text
Event 什么时候发生
~~~

performance_samples：

~~~text
observed_at
~~~

因为关心：

~~~text
Metric 什么时候被观测
~~~

view_records：

~~~text
started_at
~~~

因为关心：

~~~text
View 什么时候开始
~~~

custom_event_samples：

~~~text
occurred_at
~~~

custom_signal_samples：

~~~text
occurred_at
~~~

custom_metric_samples：

~~~text
occurred_at
~~~

因此：

> **Partition Column 不是统一找一个 created_at，而是选择真正定义业务时间轴的字段。**



### 【Hypertable 与 PostgreSQL Partitioning 的关系】

PostgreSQL 本身就支持 Partitioning。

TimescaleDB Hypertable 可以先理解成：

~~~text
PostgreSQL Partitioning 基础
        ↓
TimescaleDB
增加 Time-oriented 自动管理
~~~

如果完全手工管理，也可以设计：

~~~text
performance_2026_10_01

performance_2026_10_02

performance_2026_10_03
~~~

但应用和运维就需要自己处理更多：

~~~text
创建新 Partition

管理时间范围

写入路由

删除旧 Partition

维护分区相关策略
~~~

TimescaleDB 的价值之一就是：

~~~text
把 Time-oriented Partition Management
做成数据库 Extension 能力
~~~

因此 Hypertable 可以直观理解成：

> **TimescaleDB 自动管理的一张按时间持续分区的 PostgreSQL 表。**



### 【把当前项目的真实物理结构重新画清楚】

当前：

~~~sql
CREATE TABLE performance_samples (...);

SELECT create_hypertable(
  'performance_samples',
  'observed_at'
);
~~~

为了说明，假设教学示例中的 Chunk Interval 为一天。

可以理解成：

~~~text
Node.js / Worker
        │
        │
        │ INSERT INTO performance_samples
        ▼
┌────────────────────────────────────┐
│          PostgreSQL Server         │
│                                    │
│  ┌──────────────────────────────┐  │
│  │    TimescaleDB Extension     │  │
│  └──────────────────────────────┘  │
│                 │                  │
│                 ▼                  │
│       performance_samples          │
│          Hypertable                │
│        统一 SQL 访问入口             │
│                 │                  │
│       根据 observed_at 路由          │
│                 │                  │
│        ┌────────┼────────┐         │
│        ▼        ▼        ▼         │
│      Chunk A  Chunk B  Chunk C     │
│        │        │        │         │
│      PG Table PG Table PG Table    │
│        │        │        │         │
│      Index A  Index B  Index C     │
│                                    │
└────────────────────────────────────┘
~~~

插入：

~~~text
observed_at =
2026-10-02 12:30
~~~

最终：

~~~text
performance_samples
        ↓
TimescaleDB Routing
        ↓
对应时间范围的 Chunk
        ↓
真实 Row 存入该 Chunk
~~~

这就是整个物理机制。



### 【当前源码实际上连续定义了三个不同层次】

当前：

~~~sql
CREATE TABLE performance_samples (...);
~~~

第一步定义：

~~~text
Row 长什么样

字段类型

Constraint

Foreign Key

Primary Key
~~~

这是：

~~~text
Logical Data Schema
~~~

然后：

~~~sql
SELECT create_hypertable(
  'performance_samples',
  'observed_at'
);
~~~

第二步定义：

~~~text
这份数据
怎样按照时间被物理组织
~~~

这是：

~~~text
Physical Time Partition Strategy
~~~

接着：

~~~sql
CREATE INDEX performance_project_time_idx
ON performance_samples(
  project_id,
  observed_at DESC
);
~~~

第三步定义：

~~~text
进入相关 Chunk 后
怎样快速找到目标 Rows
~~~

这是：

~~~text
Query Access Path
~~~

所以当前源码真正的层次是：

~~~text
CREATE TABLE
    ↓
定义 Row / Schema

create_hypertable
    ↓
定义 Physical Time Partition Strategy

CREATE INDEX
    ↓
定义 Query Access Path
~~~

这三部分不是互相独立的 SQL，而是一条完整的数据组织链。



### 【第二节最终形成 Hypertable 与 Chunk 的直观框架】

最终只需要固定十个事实：

~~~text
1.
performance_samples
仍然是应用访问的 PostgreSQL Table 名称

2.
create_hypertable 以后
应用的 INSERT / SELECT 基本不需要改写

3.
Hypertable 是应用看到的统一逻辑数据集

4.
Chunk 是 TimescaleDB 在 PostgreSQL 内部
创建和管理的真实子表

5.
真正的数据 Row
会按照时间被写入对应 Chunk

6.
整个 Hypertable 的总数据量
仍然会不断增加

7.
变化的是：
不再由一个单一 Physical Table
承担全部历史数据

8.
查询带时间条件时
TimescaleDB 可以先排除无关 Chunk

9.
进入相关 Chunk 后
仍然依靠 PostgreSQL Index
查找 Project / Route / Sample 等 Row

10.
Chunk 还是后续
Compression / Retention / Historical Lifecycle
的重要管理单位
~~~

最终可以压缩成一句：

> **Hypertable 是应用继续访问的一张 PostgreSQL 逻辑表；Chunk 是 TimescaleDB 在 PostgreSQL 内部自动创建的真实子表，真正的数据 Row 按时间分布到这些 Chunk 中。因此总数据仍在增长，但不再由一张单一物理表无限膨胀。**



## 3. Chunk Interval 决定时间分区的规模和管理成本

### 【问题背景：不是按时间分块就意味着分区越细越快】

上一轮建立了 Hypertable（应用统一访问的逻辑时序表）与 Chunk（数据库按时间管理的实际数据块）的关系。这一轮进一步讨论：**每个 Chunk 应该覆盖一天、一周还是更长时间，应该依据什么做决定？**

先采用一个独立于项目的示例：一个时序服务每天产生 100 万条事件。如果定义每个 Chunk 覆盖一天，七天可能形成约七个有数据的 Chunk；如果每个 Chunk 覆盖七天，七天可能只需要一个 Chunk。精确数量还取决于分区边界对齐及是否有数据写入。

| 维度 | 1 天 Chunk | 7 天 Chunk |
| --- | --- | --- |
| 单块数据量（100 万条/天的示例） | 约 100 万条 | 约 700 万条 |
| 30 天涉及的块数量 | 大约 30 个 | 约 4～6 个（与边界有关） |
| 活跃索引大小 | 相对较小 | 相对较大 |
| 分区对象和后台维护数量 | 相对较多 | 相对较少 |
| 按整块压缩/淘汰的时间粒度 | 较细 | 较粗 |

以上是教学推导，不代表实际数据库运行数据。**Chunk Interval（时间块跨度）首先决定单块时间范围，再间接决定数据量、索引、查询规划、历史清理等成本。**

### 【Chunk 过大会增加活跃工作集和索引压力】

当一段时间内的事件不断写入同一个 Chunk，该块的表数据与索引通常随时间增长。B-Tree 等索引有具体页和磁盘空间，不只是抽象查询规则；写入需要更新索引结构，查询也要访问索引页。

例如假定每天产生约 2 GB 的事件原始数据：

~~~text
1 天 Chunk
    ≈ 2 GB 原始数据 + 对应索引及额外存储开销

7 天 Chunk
    ≈ 14 GB 原始数据 + 更大的索引及额外存储开销
~~~

数据量仅用于说明方向，并未计入真实索引大小、TOAST、压缩前后差异及其他 Hypertable。**不能单凭 14 GB 大于物理内存，就断定一条查询必定慢。** 数据库依赖 PostgreSQL Buffer Cache 与操作系统页缓存，实际性能取决于活跃页、访问局部性和并发工作负载。

当活跃索引页超过可用缓存而频繁产生磁盘读写时，写入维护和查询可能受到影响。Timescale 官方提供的**初始经验**是考虑一个 Chunk 处理前的尺寸及活跃 Hypertable 索引工作集与可用内存的关系，并以约 25% 主内存为 Chunk 大小初步参考，而不是直接依据事件条数决定时间跨度。[Timescale 官方 Hypertables 文档](https://docs.timescale.com/use-timescale/latest/hypertables/)。

Chunk 大还会影响“时间范围裁剪”的粒度：如果一个 Chunk 覆盖七天，用户只查询其中一小时，数据库仍需访问与查询条件有交集的该 Chunk；然后再依靠块内索引或者顺序扫描判断具体有哪些匹配行。**分区裁剪不是 Chunk 内的行级索引。**

### 【Chunk 过小会增加数据库对象、规划与管理开销】

缩短时间跨度会减少单块数据量，但也增加整个保留窗口内 Chunk 数量。过多 Chunk 可能导致：

1. **执行计划与元数据管理**：数据库规划器需要考虑更多分区关系、统计信息和可行路径，分区裁剪不等于对大量分区的管理成本完全为零。
2. **新建 Chunk 的代价**：事件第一次进入新的时间范围时，TimescaleDB 需要创建并维护对应的数据库对象及索引。这不同于简单向已有 Chunk 插入。
3. **索引和后台维护成本**：更多分区意味着更多需要维护的实际表和索引对象；大量非常小的 Chunk 还可能影响压缩效率。
4. **分散写入的代价**：如果事件发生时间跨度很广或迟到数据较多，同时打开的活跃 Chunk 也可能增多。

因此也不能仅以“更短时间跨度提高 Chunk Pruning 精度”为理由，将每个 Chunk 都设为分钟级；最终还须看单块容量与对象总数。

### 【分区跨度的工程选择：先测量，再给出候选值】

选择 Chunk Interval 时，先收集四类事实：

- **写入速率**：一天写入多少事件、表数据占多少空间，是否有高峰和迟到数据。
- **活跃工作集与索引大小**：需要频繁访问的 Chunk 及索引页是否适应可用内存预算。
- **查询窗口与条件**：通常查最近一小时、一天还是三十天；是否总是附带分区时间过滤条件。
- **压缩和历史清理要求**：旧数据何时允许压缩、保留窗口多长、超过窗口的清理粒度能容忍多粗。

例：假设每天新增约 2 GB 数据，服务器内存 16 GB。以约 4 GB 的主内存参考规模估算，可先把 1 天作为候选，再把真实索引和缓存占用、并行活跃块和查询计划纳入验证。**不能直接把 4 GB / 2 GB = 2 天当作最终 Chunk Interval**，因为 2 GB 只是原始数据大小，索引与并发其他表仍占用资源。

~~~text
记录单位时间真实数据量
        ↓
估计 Chunk 中的数据量和索引大小
        ↓
给出候选时间跨度（例如 1 天、数天）
        ↓
检查活跃内存与索引工作集
        ↓
检查常见 SQL 的 Chunk 裁剪和索引扫描
        ↓
检查历史压缩与保留窗口的实际效果
        ↓
用真实负载和 EXPLAIN (ANALYZE, BUFFERS) 验证
~~~

这一流程并非 TimescaleDB 内置自动推导算法，而是一般工程调优方法。要注意 `EXPLAIN ANALYZE` 会真正执行查询，线上验证要控制查询负荷。

### 【压缩与 Retention 作用于 Chunk，不是逐行精确倒计时】

假设时序表设置了：

~~~sql
SELECT add_compression_policy('events', INTERVAL '24 hours');
SELECT add_retention_policy('events', INTERVAL '30 days');
~~~

这里的 24 小时和 30 天是**策略阈值**，不代表每条记录恰好在写入满 24 小时自动被压缩、满 30 天立即删除。

传统按时间区间的策略通常以完整 Chunk 的时间范围是否达到年龄要求进行判断。例如一个七天跨度的 Chunk，第一天写入的数据在第二天虽然已经超过 24 小时，但所属 Chunk 尚包含更新的数据，不能据此推断“它已压缩”。等该块整体达到策略阈值、且后台 Job 执行时，才可能被处理。

同理，保留策略通常删除其时间范围**完全早于保留截止时间**的旧 Chunk。Chunk 粒度越粗，历史事件超过名义保留天数后仍等待整块过期的情况可能越明显。

~~~text
Chunk Interval
    ├─ 单块数据与索引规模
    ├─ 有效 Chunk 数量和查询规划成本
    ├─ 分区裁剪精度
    ├─ 历史压缩的可执行粒度
    └─ Retention 清理的可执行粒度
~~~

需要额外区分：压缩后的时序数据仍然可以按数据库支持的方式查询，旧数据清理则会移除对应明细。较旧 Chunk 是否支持更新及其性能成本还与 TimescaleDB 的压缩/列存储实现和版本相关，不应将某一版本的行为写成通用结论。

### 【项目验证：原始事件的 Chunk 时间跨度到底是多少】

本案例中，浏览器 SDK 产生监控事件，接入服务检验后将单次事实保存到名为 `telemetry_events` 的表。数据库按 `occurred_at`（事件发生时间）组织 Chunk。

实际迁移写法：

~~~sql
SELECT create_hypertable(
  'telemetry_events',
  'occurred_at',
  if_not_exists => TRUE
);
~~~

**关键事实：当前这段迁移没有显式设置 Chunk Interval。** 对经典按时间分区、且时间列使用 `timestamptz` 的 Hypertable，部分 TimescaleDB 版本传统默认区间为七天；但这不能代替对运行实例的版本和真实配置检查。更不能据此断言数据库中每个 Chunk 都已覆盖七天或系统当前有多少块。

要实际核验，可在运行数据库中执行：

~~~sql
-- 当前时间分区维度与分块时间间隔
SELECT hypertable_name, column_name, time_interval
FROM timescaledb_information.dimensions
WHERE hypertable_name = 'telemetry_events';

-- 实际 Chunk 的覆盖范围（列可用性需对应安装的 TimescaleDB 版本）
SELECT chunk_name, range_start, range_end, is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'telemetry_events'
ORDER BY range_start DESC
LIMIT 10;

-- 活跃和历史块的数据及索引空间；不同版本压缩块的统计口径需另外核验
SELECT chunk_name,
       pg_size_pretty(table_bytes) AS table_size,
       pg_size_pretty(index_bytes) AS index_size,
       pg_size_pretty(total_bytes) AS total_size
FROM chunks_detailed_size('telemetry_events');
~~~

上述是**运维核验 SQL，不是已经在该生产数据库执行的结果**。应根据实际扩展版本及权限确认函数和返回列。可参考 Timescale 官方[Hypertables 文档](https://docs.timescale.com/use-timescale/latest/hypertables/)。

### 【项目的压缩与保留配置会与 Chunk Interval 发生耦合】

数据库迁移中已经设置：

~~~sql
SELECT add_compression_policy('telemetry_events', INTERVAL '24 hours', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry_events', INTERVAL '30 days', if_not_exists => TRUE);
~~~

因此即使项目没有显式定义 Chunk Interval，也有必要核实以下三个问题：

1. 运行实例真正的 Chunk Interval、活动 Chunk 的大小及数量是什么？
2. 以完整 Chunk 为对象执行时，“24 小时压缩阈值”实际上多快能让一批旧数据压缩？是否符合项目意图？
3. “30 天保留窗口”在实际 Chunk 边界及后台任务调度下，会使部分旧数据继续保留多久？

特别是**若**运行实例沿用七天跨度，则 24 小时压缩阈值和七天块完成时间并不等价。这是需要测量的配置效果，不是已验证的线上异常。

源码：[原始事件表及时间分区配置](../platform/packages/database/migrations/0001_platform.sql)。当前没有连接运行数据库进行查询，故不能假造实际 Chunk 数量、大小及压缩执行日期。

### 【本轮结论与下一轮衔接】

**Chunk Interval 不是单纯的“时间精度”参数，而是同时影响活跃索引工作集、分区数量、查询裁剪、数据压缩和历史淘汰粒度的物理设计。**

选取方法是先测写入速度和索引大小，再结合可用内存、典型查询范围以及历史保留要求确定初始候选，最后用真实数据库计划与数据规模核验。不能推断“越小必然越快”或“越大必然越省资源”。

下一轮只推进一个通用问题：**时间分区（Chunk Pruning）与 B-Tree 索引为什么需要同时存在，二者分别在哪个范围解决查询问题？** 仍使用经过业务说明的原始事件表和查询 SQL 作为验证案例，不预设已有项目知识。



### 【工作集、分区规模与 Chunk Interval 的实测依据】

### 【Chunk Interval 决定一个 Physical Chunk 覆盖多大的时间范围】

现在再引入：

~~~text
Chunk Interval
~~~

就比较容易理解。

假设：

~~~text
chunk_time_interval = 1 day
~~~

就是：

~~~text
一个 Chunk
负责约一天的时间范围
~~~

于是：

~~~text
Day 1
    ↓
Chunk A

Day 2
    ↓
Chunk B

Day 3
    ↓
Chunk C
~~~

#### <u>1. Chunk Interval 不是每多少 Row 建一个 Chunk</u>

不是：

~~~text
每 100 万 Rows
创建一个 Chunk
~~~

而是：

~~~text
根据 Time Range
划分 Chunk
~~~

例如同一天：

~~~text
Project A
100 Rows

Project B
1000 万 Rows
~~~

如果都属于同一时间范围，仍然进入该时间范围对应的 Chunk。

所以：

~~~text
Chunk Row Count
≈
Ingest Rate
×
Chunk Time Interval
~~~

#### <u>2. Chunk 太大会重新接近 Giant Table 问题</u>

假设：

~~~text
一个 Chunk = 90 days
~~~

而每天写入量非常大。

那么一个 Chunk 本身就可能非常大：

~~~text
Large Chunk
    ↓
Large Index
    ↓
Large Working Set
    ↓
Maintenance Cost
~~~

#### <u>3. Chunk 太小又会产生大量管理开销</u>

例如：

~~~text
一个 Chunk = 1 minute
~~~

长期运行后会产生大量 Chunk。

随之增加：

~~~text
Metadata

Planning Overhead

Index Object Count

Background Job Management
~~~

所以 Chunk Interval 是典型 Trade-off：

~~~text
Larger Chunk
    ↓
Fewer Chunks
Lower Metadata Cost
but Larger Per-chunk Working Set

Smaller Chunk
    ↓
Smaller Individual Partition
but More Chunks / Metadata
~~~



### 【当前项目的 Chunk Interval 到底是多少】

这个地方必须区分：

~~~text
源码明确了什么
~~~

和：

~~~text
源码没有明确什么
~~~

当前项目：

~~~sql
SELECT create_hypertable(
  'performance_samples',
  'observed_at',
  if_not_exists => TRUE
);
~~~

没有显式写：

~~~text
chunk_time_interval
~~~

所以：

> **从当前仓库不能确定 performance_samples 实际每个 Chunk 是一天、七天还是其他长度。**

当前代码只明确：

~~~text
Hypertable：
performance_samples

Partition Column：
observed_at
~~~

没有明确：

~~~text
Chunk Interval
~~~

因此文档中的“一天一个 Chunk”只能作为教学示例，不能描述成当前项目事实。

如果未来进入生产容量治理，需要结合：

~~~text
Actual TimescaleDB Version

Runtime Configuration

Ingest Rate

Chunk Count

Chunk Size

Index Size
~~~

再决定是否显式配置 Chunk Interval。



## 4. 时间分区与 B-Tree 索引共同优化原始事件查询

### 【先建立业务背景与具体查询目标】

假设业务系统持续写入大量事件。每条事件记录它属于哪个项目、发生时间、事件类别和业务内容。数据库已按发生时间将这些记录分配至多个 Chunk。现在用户希望查看“项目 A 在某一天产生的错误事件”，按发生时间从近到远分页展示。

这里产生了新的问题：**时间范围已经让数据库找到若干相关 Chunk，为什么还需要额外创建数据库索引？**

比如一个 Chunk 覆盖一天，但里面仍有数百万条不同项目、不同类型的数据。**选中某个 Chunk，并不等于直接找到这个 Chunk 内符合条件的那几十条事件。**

### 【Chunk Pruning 缩小分区范围，B-Tree 索引缩小块内行的访问范围】

~~~text
SQL：查项目 A + 10 月 10 日 + 错误事件
          ↓
时间条件与 occurred_at 分区范围比较
          ↓
Chunk Pruning / Chunk Exclusion（排除无关时间块）
    ├─ 10 月 9 日的时间块：跳过
    ├─ 与 10 月 10 日相交的块：保留
    └─ 10 月 11 日的时间块：跳过
          ↓
PostgreSQL 查询规划器对剩余块选择访问路径
    ├─ B-Tree Index Scan / Index Only Scan：索引定位
    ├─ Bitmap Index/Heap Scan：先找候选位置后批量读
    └─ Seq Scan：数据量或选择性合适时顺序扫描
          ↓
结果过滤、排序、分页、返回
~~~

这是**逻辑解释顺序**，不是断言 PostgreSQL 执行器总要先完整裁剪、再必然进行一次 Index Scan。不同计划可能有 Merge Append、Sort、并行执行以及更多扫描方式。

- **时间分区**决定哪几个物理数据块可能包含所需时间范围。
- **B-Tree** 是 PostgreSQL 中有序的树形索引，可将项目、类型、时间等键映射到可定位的表行。它能帮助在相关数据块内查找匹配行，也可能直接提供部分所需排序顺序。
- **行级数据过滤**在查询计划中仍然存在，不能因为索引中出现某列就假设数据库不再读取表数据。

PostgreSQL 原生分区也有分区裁剪能力，不是 TimescaleDB 独有。TimescaleDB 的 Hypertable 继续利用 PostgreSQL 的索引与规划机制。

### 【复合 B-Tree 索引需要与实际查询条件匹配】

例如：

~~~sql
-- 项目与时间：适合查询某项目的近期全部事件
CREATE INDEX idx_project_time
ON events(project_id, occurred_at DESC);

-- 项目、类型和时间：适合项目和类型都有等值过滤时的时间范围查询
CREATE INDEX idx_project_type_time
ON events(project_id, type, occurred_at DESC);
~~~

B-Tree 复合键按索引的字段顺序组织。对于第二个索引：

~~~text
project_id → type → occurred_at
      等值       等值         范围
~~~

若查询同时指定 `project_id = A`、`type = error` 和一个时间范围，索引可以较好地缩小键空间。如果没有 `type` 条件，索引虽然仍可能被使用，但通常不能像第一种索引那样直接对该项目所有类型按时间形成统一有序的结果。实际规划也受到 PostgreSQL 版本、跳跃扫描、数据分布和统计信息影响，不能把“左前缀”误写成绝对禁止后列被使用。

| 查询需求 | 更匹配的方向 | 应注意的问题 |
| --- | --- | --- |
| 某项目最近的全部事件 | `(project_id, occurred_at)` | 若查询返回大部分数据，顺序扫描也可能更优 |
| 某项目最近的特定类型 | `(project_id, type, occurred_at)` | 类型等值过滤要有意义，选择性可能很低 |
| 只有时间范围、所有项目 | 时间分区和可用的时间路径 | 两种复合索引均以 project_id 开头，是否利用取决于规划器 |
| JSONB 内某个属性 | 按字段查询模式评估 GIN 或表达式索引 | 普通项目/时间索引并不自动覆盖所有 JSONB 内部属性 |

**不能无限增加索引。** 每个索引都占磁盘空间并需要在 INSERT/UPDATE/DELETE 时维护，时序表的大量写入会放大这类维护成本；是否保留两个相近索引应依据实际查询受益判断。

### 【回到项目：原始事件的真实索引与查询】

当前监控平台使用 `telemetry_events` 保存通过校验和安全处理后的单次遥测事件，`project_id` 表示所属项目，`occurred_at` 表示事件实际发生时间，`type` 表示事件类型。TimescaleDB 按 `occurred_at` 划分 Chunk。

迁移文件中真实存在：

~~~sql
CREATE INDEX telemetry_project_time_idx
  ON telemetry_events(project_id, occurred_at DESC);

CREATE INDEX telemetry_project_type_time_idx
  ON telemetry_events(project_id, type, occurred_at DESC);
~~~

这些索引与项目常见的“按项目和时间查询”“增加事件类型筛选”的需求相匹配。

查询入口在：[analytics.service.ts](../platform/apps/api/src/analytics/analytics.service.ts)。业务界面允许用户选择项目、时间范围，并可选事件类型、名称、Session、View、Event ID 等筛选项。

它形成的 SQL 可简化为：

~~~sql
-- 教学 SQL，项目/时间/类型参数须由真实业务传入；
-- 实际服务支持更多可选条件、权限验证与游标分页。
SELECT event_id, occurred_at, type, name, event
FROM telemetry_events
WHERE project_id = $1
  AND occurred_at >= $2
  AND occurred_at < $3
  AND type = $4
ORDER BY occurred_at DESC, event_id DESC
LIMIT 50;
~~~

这个查询中：
- `occurred_at` 既能触发时间范围的 Chunk 裁剪，也可能参与 B-Tree 范围查找。
- `project_id` 和 `type` 为 B-Tree 复合索引提供等值过滤条件。
- `ORDER BY occurred_at DESC, event_id DESC` **没有被上述两个索引中的任何一个明确完整覆盖**：实际是否需要额外排序，取决于执行计划、候选行数等。
- `event JSONB` 会返回单次事件的完整属性，但筛选 JSONB 内部任意字段并不自动获得上面两个索引的加速。

**事实边界**：从迁移可以核实“创建了这些索引”，从代码可核实“查询具有这些过滤条件”；不能未经运行数据验证就声称某次查询必然使用某个索引，或已经达到具体的毫秒延迟。

### 【用真实执行计划证明分区与索引分别发挥了什么作用】

 PostgreSQL 可使用：

~~~sql
-- 实际执行请替换为有数据的项目 ID 和时间窗口；
-- ANALYZE 会真正运行 SQL，生产环境须限制测试负荷。
EXPLAIN (ANALYZE, BUFFERS)
SELECT event_id, occurred_at, type
FROM telemetry_events
WHERE project_id = '00000000-0000-0000-0000-000000000001'
  AND occurred_at >= '2026-10-10 00:00:00+00'
  AND occurred_at <  '2026-10-11 00:00:00+00'
  AND type = 'event'
ORDER BY occurred_at DESC
LIMIT 50;
~~~

需要观察三件事：

1. **Chunk/分区**：哪些子表参与执行、有没有排除明显不相关时间区间的 Chunk。
2. **扫描方式**：在相关 Chunk 内究竟执行 Index Scan、Bitmap Scan 还是 Seq Scan；有没有使用预期的索引。
3. **执行代价**：Planning/Execution Time、实际返回行数、Blocks 命中及读取、必要时的排序开销。

`EXPLAIN ANALYZE` 使用真实行数与真实耗时，`BUFFERS` 记录缓冲读写信息；为了说明机制，可以使用教学 SQL，但要验证项目现状必须运行在有代表性数据的实际实例。

### 【当前讨论结论与下一轮的因果衔接】

**时间分区回答“哪些时间块可能有目标记录”，B-Tree 索引回答“如何在可访问的块中高效定位某些键对应的行”，二者可以同时参与同一条 SQL 的执行。**

下一轮进入与物理分区直接相关的数据正确性问题：**既然一张 Hypertable 的行分散在不同 Chunk 中，数据库如何在写入时保证主键和唯一约束？为什么时序分区表上的 UNIQUE/PRIMARY KEY 必须包含分区时间字段？**

实践会继续使用 `telemetry_events`，但先解释事件 ID 在业务上表示什么、主键与唯一约束在 PostgreSQL 中是什么意思，再看项目的实际复合主键与幂等去重策略。

权威参考：[PostgreSQL 分区裁剪](https://www.postgresql.org/docs/current/ddl-partitioning.html)、[PostgreSQL 多列 B-Tree 索引](https://www.postgresql.org/docs/current/indexes-multicolumn.html)、[PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)、[TimescaleDB Hypertable](https://docs.timescale.com/use-timescale/latest/hypertables/)。



### 【时间范围查询：SQL 谓词、Chunk Pruning 与查询模型】



第二节解决的是：

~~~text
数据怎样存

performance_samples
    ↓
Hypertable
    ↓
Chunk
    ↓
Physical Row Storage
~~~

第三节继续解决：

> **这些已经存进 Chunk 的数据，在一次 Analytics 查询中，怎样从原始 Row 变成前端可以展示的时间趋势？**

这一节不把：

~~~text
Time Range
Chunk Pruning
Index
time_bucket
GROUP BY
Aggregate
~~~

拆成多个互相并列的大标题。

因为它们本质上属于同一条 Query Pipeline。

整个查询真正只有四个主要部分：

~~~text
Time-Series Query
│
├── 一、Data Selection
│      ↓
│   找到本次查询真正需要的 Raw Rows
│
├── 二、Analytical Aggregation
│      ↓
│   把 Raw Rows 转换成 Trend Points
│
├── 三、Query Model
│      ↓
│   Detail Query 与 Aggregate Query
│   使用不同结果模型
│
└── 四、Temporal Alignment
       ↓
    多条时序序列通过统一 Bucket
    对齐到同一时间坐标轴
~~~

先建立完整执行链：

~~~text
Analytics Request
        ↓
Project Scope
+
from / to
        ↓
Relevant Chunks
        ↓
Matching Raw Rows
        ↓
        ├──────────── Detail Query
        │                   ↓
        │              Order + Cursor
        │
        └──────────── Aggregate Query
                            ↓
                        time_bucket
                            ↓
                     Business Dimension
                            ↓
                         GROUP BY
                            ↓
                        Aggregate
                            ↓
                         Trend Point
~~~



### 【Data Selection 先确定本次查询真正需要哪些 Raw Rows】

这一部分还没有开始做统计。

它只解决：

> **数据库里已经积累了大量历史数据，这次请求究竟需要读取哪一部分？**

当前 AnalyticsService 把这一层统一封装在 filters() 中。

#### <u>1. 项目源码先把业务 Scope 与 Time Range 转成 SQL Predicate</u>

当前源码：

~~~ts
private filters(
  alias: string,
  timeColumn: string,
  projectId: string,
  filters: AnalyticsFilters,
): SqlFilter {
  const values: unknown[] = [
    projectId,
    filters.from,
    filters.to,
  ];

  const conditions = [
    alias + ".project_id = $1",
    alias + "." + timeColumn + " >= $2",
    alias + "." + timeColumn + " < $3",
  ];

  const add = (
    column: string,
    value: string | undefined,
  ): void => {
    if (!value) return;

    values.push(value);

    conditions.push(
      alias + "." + column + " = $" + values.length,
    );
  };

  add("environment", filters.environment);
  add("app_version", filters.version);
  add("route_name", filters.routeName);

  if (filters.metric && alias === "p") {
    add("name", filters.metric);
  }

  return {
    where: conditions.join(" AND "),
    values,
  };
}
~~~

针对 performance_samples：

~~~ts
const filter = this.filters(
  "p",
  "observed_at",
  projectId,
  filters,
);
~~~

最终会形成类似：

~~~sql
WHERE
  p.project_id = $1
  AND p.observed_at >= $2
  AND p.observed_at < $3
~~~

如果还有：

~~~text
environment
version
routeName
metric
~~~

则继续增加：

~~~sql
AND p.environment = ...
AND p.app_version = ...
AND p.route_name = ...
AND p.name = ...
~~~

这里可以把所有条件分成两类：

~~~text
Business Scope
│
├── project_id
├── environment
├── app_version
├── route_name
└── metric

Time Scope
│
├── from
└── to
~~~

所以 Data Selection 的第一步不是 time_bucket。

而是：

~~~text
All Historical Data
        ↓
Business Scope
+
Time Scope
        ↓
Candidate Raw Data
~~~

#### <u>2. Time Range 不只是业务过滤条件，也直接对应 Hypertable 的物理分区边界</u>

假设：

~~~text
from = 2026-10-03 10:00

to   = 2026-10-03 11:00
~~~

SQL：

~~~sql
p.observed_at >= '2026-10-03 10:00'
AND
p.observed_at < '2026-10-03 11:00'
~~~

业务上表示：

~~~text
用户只想看
10:00 ~ 11:00
这一个小时的数据
~~~

但第二节已经知道：

~~~text
performance_samples
按照 observed_at
被划分到不同 Chunks
~~~

所以这个条件同时能够帮助数据库判断：

~~~text
哪些 Chunk 的时间范围
与 10:00 ~ 11:00
完全不相交
~~~

这些 Chunk 就没有必要参与本次查询。

例如教学示例中：

~~~text
Chunk A
10/01

Chunk B
10/02

Chunk C
10/03

Chunk D
10/04
~~~

查询：

~~~text
10/03 10:00
~
10/03 11:00
~~~

可以先得到：

~~~text
Chunk A
    ↓
时间不重叠
    ↓
排除

Chunk B
    ↓
时间不重叠
    ↓
排除

Chunk C
    ↓
存在重叠
    ↓
参与查询

Chunk D
    ↓
时间不重叠
    ↓
排除
~~~

这就是：

~~~text
Chunk Pruning
~~~

所以这里真正的关系是：

~~~text
WHERE observed_at >= from
AND   observed_at < to
        │
        ├── 业务意义：
        │   选择用户想看的时间范围
        │
        └── 物理意义：
            排除无关 Chunk
~~~

#### <u>3. Chunk Pruning 只缩小 Physical Partition 范围，还没有找到最终 Rows</u>

假设最终只剩：

~~~text
Chunk C
~~~

但 Chunk C 里可能仍然有：

~~~text
Project A
Project B
Project C

LCP
INP
CLS

/checkout
/home
/search

数百万甚至更多 Rows
~~~

所以：

~~~text
Relevant Chunk
≠
Final Result
~~~

Chunk Pruning 只解决：

~~~text
从哪些物理子表读取？
~~~

还需要继续解决：

~~~text
这些子表里面
哪些 Row 真正满足条件？
~~~

#### <u>4. Index 与其他 Predicate 再在相关 Chunk 中寻找真正匹配的 Row</u>

当前项目已经建立：

~~~sql
CREATE INDEX performance_project_time_idx
ON performance_samples(
  project_id,
  observed_at DESC
);
~~~

以及：

~~~sql
CREATE INDEX performance_project_route_time_idx
ON performance_samples(
  project_id,
  route_name,
  observed_at DESC
);
~~~

所以：

~~~sql
WHERE
  project_id = 'P001'
  AND route_name = '/checkout'
  AND observed_at >= T1
  AND observed_at < T2
~~~

可以形成：

~~~text
Hypertable
    ↓
Time Range
    ↓
Relevant Chunks
    ↓
Project / Route / Time Predicate
    ↓
Index / Scan
    ↓
Matching Raw Rows
~~~

这里要保留一个 PostgreSQL 基础边界：

> **存在 Index 不代表 PostgreSQL 每次一定执行 Index Scan。**

真实 Physical Plan 仍由 PostgreSQL Planner 根据：

~~~text
数据统计

Predicate Selectivity

Chunk Size

查询范围

Index Cost

Sequential Scan Cost

Parallelism
~~~

决定。

因此当前索引的准确含义是：

~~~text
项目为
Project + Time

以及
Project + Route + Time

提供了合适的 Index Access Path
~~~

而不是：

~~~text
所有查询一定使用这个 Index
~~~

#### <u>5. Data Selection 最终只应该理解成一条连续链</u>

所以前面的 Scope、Time Range、Chunk Pruning、Index 不应该各自被提升成平级知识模块。

它们共同完成一件事情：

~~~text
Data Selection

All Historical Data
        ↓
Project / Dimension Scope
        ↓
Time Range
        ↓
Chunk Pruning
        ↓
Index / Predicate
        ↓
Matching Raw Rows
~~~

到这里为止，数据库已经找到本次查询真正需要的原始数据。

但还没有：

~~~text
一分钟一个点

平均值

p75

趋势图
~~~

这些属于下一阶段。



### 【Chunk Pruning 和 Index 是两个不同层级】

当前项目：

~~~sql
SELECT create_hypertable(
  'performance_samples',
  'observed_at'
);
~~~

随后还有：

~~~sql
CREATE INDEX performance_project_time_idx
ON performance_samples(
  project_id,
  observed_at DESC
);
~~~

以及：

~~~sql
CREATE INDEX performance_project_route_time_idx
ON performance_samples(
  project_id,
  route_name,
  observed_at DESC
);
~~~

如果 Chunk 已经把数据拆开，为什么还需要 Index？

因为解决的是两个不同问题。

#### <u>1. Chunk Pruning 先确定查询哪些物理分区</u>

查询：

~~~sql
WHERE
  project_id = 'P001'
  AND observed_at >= T1
  AND observed_at < T2
~~~

第一步：

~~~text
observed_at 范围
    ↓
判断 Chunk 时间范围
    ↓
确定只需要相关 Chunks
~~~

解决的是：

> **哪些物理分区需要参与查询？**

#### <u>2. Index 再在相关 Chunk 内找目标 Row</u>

假设某个 Chunk 里面仍然有：

~~~text
1000 万 Rows
~~~

其中包含：

~~~text
Project A
Project B
Project C
...
~~~

还需要找：

~~~text
project_id = P001
~~~

这时才继续依赖：

~~~text
Index
~~~

所以查询路径：

~~~text
SELECT performance_samples
        ↓
WHERE observed_at BETWEEN T1 AND T2
        ↓
Chunk Pruning
        ↓
只保留相关 Chunks
        ↓
WHERE project_id = P001
        ↓
相关 Chunk 上的 Index
        ↓
Matching Rows
~~~

这就是：

~~~text
Partition
+
Index
~~~

两级访问。

#### <u>3. 当前索引直接对应真实 Query Pattern</u>

例如：

~~~sql
CREATE INDEX performance_project_time_idx
ON performance_samples(
  project_id,
  observed_at DESC
);
~~~

对应：

~~~text
Project
    +
Time Range
~~~

而：

~~~sql
CREATE INDEX performance_project_route_time_idx
ON performance_samples(
  project_id,
  route_name,
  observed_at DESC
);
~~~

对应：

~~~text
Project
    +
Route
    +
Time Range
~~~

因此当前访问路径可以理解成：

~~~text
Time Condition
    ↓
Chunk Pruning

Project / Route Condition
    ↓
Index Scan
~~~

Hypertable 没有替代 PostgreSQL Index，而是在 Index 之前增加了一层 Time Partition Pruning。



### 【为什么分成多个 Chunk 后，Index 也更容易管理】

普通大表：

~~~text
performance_samples
1 billion Rows
        ↓
一个非常大的 Index
~~~

可能意味着：

~~~text
Index Tree 更大

Memory Working Set 更大

写入需要持续维护大型 Index
~~~

分 Chunk 后可以近似理解成：

~~~text
Chunk A
    ↓
Index A

Chunk B
    ↓
Index B

Chunk C
    ↓
Index C
~~~

最近数据主要写入：

~~~text
Newest Chunk
~~~

因此活跃写入主要维护：

~~~text
Newest Chunk 对应的索引
~~~

而不是所有历史时间范围组成的一个单一超大物理结构。

所以 Chunk 改变的不只是：

~~~text
查询时少扫描一些数据
~~~

还改变：

~~~text
数据维护单位

索引维护单位

历史生命周期管理单位
~~~



## 5. 时间分区表的主键、唯一约束与业务幂等

### 【从重复事件进入数据库的业务问题出发】

时序系统持续接收设备采样、用户行为和错误事件。网络失败后同一事件可能重试，数据库需要避免重复记录。但时间分区把不同时间的行存入不同 Chunk：如果仅依赖各 Chunk 的本地唯一索引，能否保证整个表的事件 ID 都不重复？

首先区分三种规则：PRIMARY KEY 要求键唯一且非空；UNIQUE 约束指定的字段组合必须满足唯一性；业务幂等键定义哪两个请求代表同一业务事实。三者可以有关联，但不必一致。

### 【分区边界为何决定唯一约束的组成】

假设事件按 occurred_at 分到不同 Chunk。事件 evt-001 可以在 10 月 3 日落到 Chunk A，在 10 月 10 日落到 Chunk B。若唯一键仅含 event_id，两个块的本地唯一索引无法直接知道另一块已有同一个 ID。

因此，TimescaleDB 要求 Hypertable 的 PRIMARY KEY 和 UNIQUE 包含所有分区列；PostgreSQL 原生分区有类似约束。这使得违反同一复合键唯一性的记录落在能够共同检查它们的分区范围内。若同时有时间和空间分区字段，均需包含在唯一键中。

~~~sql
-- 同一项目、事件 ID 和发生时间组合不得重复
PRIMARY KEY (project_id, event_id, occurred_at)
~~~

上面的约束允许：同项目、同事件 ID、但发生时间不同的两条记录。因此**数据库复合主键唯一，不等于业务要求的 event_id 唯一**。

权威资料：[TimescaleDB 的唯一索引约束](https://docs.timescale.com/use-timescale/latest/hypertables/hypertables-and-unique-indexes/)、[PostgreSQL 分区限制](https://www.postgresql.org/docs/current/ddl-partitioning.html)。

### 【原始事件表的实际数据模型】

监控平台会接收不同网站的浏览器事件：project_id 代表所属项目，event_id 代表本次事件标识，occurred_at 表示事件发生时间，数据库据此按时间分 Chunk。

项目数据库迁移真实定义：

~~~sql
PRIMARY KEY (project_id, event_id, occurred_at);
~~~

源码：[原始事件表结构](../platform/packages/database/migrations/0001_platform.sql)。

该主键既满足按 occurred_at 分区时的约束限制，也让不同项目能使用相同事件 ID；但它并不能单独阻止同一项目使用两个不同时间戳写入相同 event_id。

### 【项目如何补足业务幂等】

接入 API 的真实流程如下：

~~~text
一批通过校验的事件
  ↓ 请求内 Set 去重，保留每个 event_id 第一次出现的记录
开始 PostgreSQL 事务
  ↓ 为同一项目、相同 event_id 获取事务级咨询锁
  ↓ 查询 telemetry_events 中已存在的 event_id
  ↓ 排除数据库已保存的事件
  ↓ INSERT ... ON CONFLICT DO NOTHING
成功 COMMIT，错误 ROLLBACK
~~~

请求内去重：

~~~ts
const seenEventIds = new Set<string>();
const uniqueValid = valid.filter((event) => {
  if (seenEventIds.has(event.eventId)) return false;
  seenEventIds.add(event.eventId);
  return true;
});
~~~

事务级咨询锁：服务端按项目和事件 ID 生成锁键，使用 PostgreSQL 的 pg_advisory_xact_lock，在事务内协调多个遵循相同锁规则的并发写入操作；按事件 ID 排序取锁降低死锁风险。它不是数据库 UNIQUE 约束，事务结束自动释放。

存在性查询：

~~~sql
SELECT event_id FROM telemetry_events
WHERE project_id = $1 AND event_id = ANY($2::text[])
GROUP BY event_id;
~~~

此处没有按照 occurred_at 限定时间，是因为业务要识别同项目同 ID 的重复事件，即使发生时间不同。因此该查询不一定可以通过时间范围裁剪排除大量旧 Chunk，存在需要以执行计划评估的性能取舍。

最后使用 ON CONFLICT DO NOTHING 处理数据库约束冲突，但它只兜底复合主键冲突，不能替代上述业务去重。

源码：[接入服务的完整事务逻辑](../platform/apps/api/src/ingestion/ingestion.service.ts)。

### 【实现边界与结论】

- 咨询锁只协调遵循同样锁约定的业务写入者。绕开服务直接 INSERT 时，同事件 ID 不同时间仍可能进入表。
- 原始事件表有 30 天保留策略，历史记录被清除后，单靠当前 telemetry_events 无法判断更早是否出现过某个 ID。若业务需要永久幂等，应考虑单独且有匹配保留期限的事件唯一登记机制。
- 不附带分区时间条件的全历史 event_id 去重查询可能扫描更多 Chunk；是否形成瓶颈必须通过实际数据和 EXPLAIN 判断。

**结论：数据库主键确保明确定义的键组合唯一，业务幂等根据“同一次事实”的身份定义。时序分区下两者通常需要协同设计。**

本节解释数据库唯一性与业务幂等；迟到数据造成的历史 Chunk、压缩和统计影响，需要在掌握时间聚合、连续聚合、压缩与 Retention 的基本机制后再讨论。



### 【跨 Chunk 唯一性与实际主键约束】

### 【Primary Key 为什么也包含时间字段】

当前：

~~~sql
PRIMARY KEY (
  project_id,
  sample_id,
  observed_at
);
~~~

而不是：

~~~sql
PRIMARY KEY (
  project_id,
  sample_id
);
~~~

telemetry_events 同样：

~~~sql
PRIMARY KEY (
  project_id,
  event_id,
  occurred_at
);
~~~

这与 Hypertable 的分区模型有关。

TimescaleDB 对 Hypertable 上的 Unique Index / Primary Key 有分区列相关约束。

#### <u>1. 为什么唯一键需要包含时间分区列</u>

假设：

~~~text
Chunk A
10/01

Chunk B
10/02
~~~

如果只声明：

~~~text
event_id UNIQUE
~~~

数据库要保证：

~~~text
Chunk A
不存在 E1

Chunk B
不存在 E1

其他所有 Chunks
也不存在 E1
~~~

这会变成跨 Partition 的全局唯一判断。

当前项目的物理唯一键：

~~~text
project_id
+
event_id
+
occurred_at
~~~

把分区时间也纳入唯一性定义。

#### <u>2. Physical Uniqueness 不一定等于 Business Uniqueness</u>

业务可能真正认为：

~~~text
同一个 Project 下
eventId 应该唯一
~~~

但物理 Primary Key 是：

~~~text
project_id
+
event_id
+
occurred_at
~~~

理论上如果 event_id 相同但 occurred_at 不同，物理键仍不同。

所以：

~~~text
Physical Constraint
~~~

和：

~~~text
Business Idempotency
~~~

不是完全相同的概念。

当前项目后续在 Ingestion 层还会通过：

~~~text
Advisory Lock

Existing Event Query

Insert
~~~

补足协议级幂等语义。

这说明：

> **Time Partition 的物理约束有时会反过来影响 Primary Key 设计，而真正的业务唯一语义可能还需要应用层额外保证。**



## 6. GROUP BY 与 time_bucket 将原始事件转换为时间窗口统计

### 【先从事实明细与分析目标的差异理解需求】

假设一个网站接入浏览器监控 SDK，用户每次访问页面会产生一条独立事件。原始事件表保存的是一次次业务事实，而看板通常要回答“每分钟有多少次访问”“每小时事件量怎样变化”，不是逐条阅读所有明细。

教学示例：

| 发生时间 | 类型 | 项目 |
| --- | --- | --- |
| 10:00:10 | view | A |
| 10:00:35 | view | A |
| 10:00:52 | view | A |
| 10:01:20 | view | A |
| 10:01:48 | view | A |

期望的分钟统计为：

| 时间窗口起点 | 页面访问数 |
| --- | --- |
| 10:00:00 | 3 |
| 10:01:00 | 2 |

**问题：原始事实的时间戳各不相同，如何按统一时间窗口合并，再统计每组记录数量？**

### 【PostgreSQL GROUP BY 与聚合函数各自负责什么】

\`GROUP BY\` 根据分组键将多条记录归为一组；\`COUNT\`、\`SUM\`、\`AVG\`、\`MIN\`、\`MAX\` 等函数计算该组的统计值。完整事件时间戳通常精确到毫秒，如果直接按照完整时间戳分组，很多事件各自属于不同组，不能直接得出每分钟的访问量。

所以先要**把不同的事件时间映射到相同的时间窗口起点**，然后按照这个起点进行 GROUP BY。

### 【time_bucket 用于把时间戳映射到固定时间窗口】

通用 SQL：

~~~sql
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  COUNT(*) AS event_count
FROM events
GROUP BY bucket
ORDER BY bucket;
~~~

- \`occurred_at\`：事件真实发生时间。
- \`INTERVAL '1 minute'\`：聚合分桶的时间跨度。
- \`time_bucket\`：按约定的时间对齐规则，返回某条事件所属时间桶的**起始时间**。
- \`GROUP BY bucket\`：同一分钟的记录合并成组。
- \`COUNT(*)\`：得到组内的事件条数。
- \`ORDER BY bucket\`：按时间显示趋势。

例如 10:00:10、10:00:35、10:00:52 均映射到 10:00:00。通常可以用半开区间来描述窗口：\`[10:00:00, 10:01:00)\`，避免边界上的记录重复落入两个相邻窗口。要考虑时区、桶原点与夏令时等语义，不能简单认为所有时间分桶均必然按用户本地时区自然日对齐。

### 【time_bucket 的统计窗口不等于 Chunk Interval】

| 概念 | 决定什么 | 所属层次 |
| --- | --- | --- |
| Chunk Interval（物理时间分区间隔） | 每块物理存储覆盖的时间区间 | 数据物理组织 |
| time_bucket 的 \`1 minute\` | 相隔一分钟的时间戳如何统计到同一个桶 | 查询与聚合计算 |

例如一个 Hypertable 可以每七天形成一个 Chunk（仅作教学假设），但可以在它上面运行分钟级、小时级或天级统计。**聚合分桶不会因为被查询就重新物理切分原始事件表**；它给 SQL 提供了分组键。

### 【项目的原始事件一分钟统计是怎样计算的】

在 browser-monitor 中，网站产生的监控事件会安全处理后写入 \`telemetry_events\`。时间字段 \`occurred_at\` 是事件在网页上实际发生的时间，\`project_id\` 区分项目，\`type\`、\`name\` 区分事件类别与事件名称。

数据库迁移中定义了 \`telemetry_rollup_1m\`，意为“按一分钟汇总的原始遥测统计”。其中统计查询的核心部分为：

~~~sql
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id,
  type,
  name,
  environment,
  app_version,
  route_name,
  count(*)::bigint AS event_count
FROM telemetry_events
GROUP BY bucket, project_id, type, name,
         environment, app_version, route_name;
~~~

与只按时间分组的教学示例不同，这里还必须根据项目、事件类型、名称、环境、版本及页面路由分别分组，防止无关业务事件被合并统计。多个维度同时 GROUP BY 的结果是一组组“时间桶 + 维度组合”的统计行。

源码：[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)。

**当前这段真实 SQL 实际出现在 Continuous Aggregate 的 CREATE MATERIALIZED VIEW 定义中。** 在本轮只解释其中 \`time_bucket / GROUP BY / count\` 的基础聚合语义；物化结果及刷新机制留给下一轮，避免一次抛出太多前置知识。

### 【为什么基础聚合还不足以应对重复历史查询】

普通的 \`SELECT ... GROUP BY\` 定义了如何计算一次统计结果，但它**不会仅因为执行过一次 SELECT 就自动持久化结果，供下次按同样条件直接复用**。

如果原始事件表规模很大，历史看板频繁请求相同时间范围，每次重读并重新聚合原始行可能浪费资源。PostgreSQL 的普通物化视图可以保存查询结果，却需要管理刷新，而不是默认自动按时序变化精细维护。

因此自然引出下一轮：**Continuous Aggregate 如何保存时间窗口结果，增量发现变更并刷新，而不是每次完整重新聚合所有历史？**

本轮小结：\`time_bucket\` 是时间归桶函数，\`GROUP BY\` 是分组规则，\`COUNT\` 等是统计计算；物理 Chunk 是存储粒度，时间桶是统计粒度，两者既可共存也不可混淆。




### 【从 Data Selection 到 time_bucket 的分析查询】

### 【Analytical Aggregation 再把 Raw Rows 转换成 Trend Points】

假设 Data Selection 最终得到：

| observed_at | name | value |
|---|---|---:|
| 10:00:05 | LCP | 2100 |
| 10:00:18 | LCP | 2500 |
| 10:00:45 | INP | 180 |
| 10:01:03 | LCP | 1900 |
| 10:01:25 | LCP | 2300 |
| 10:01:40 | INP | 120 |
| 10:02:08 | LCP | 3000 |

这些仍然是一条一条 Raw Sample。

前端趋势图需要的却是：

~~~text
10:00
LCP p75 = ...

10:01
LCP p75 = ...

10:02
LCP p75 = ...
~~~

所以接下来需要：

~~~text
Analytical Aggregation
~~~

这一部分也只是一条连续链：

~~~text
Matching Raw Rows
        ↓
time_bucket
        ↓
Business Dimension
        ↓
GROUP BY
        ↓
Aggregate
        ↓
Trend Point
~~~

#### <u>1. time_bucket 只负责把 timestamp 映射到统计时间窗口</u>

当前 performance()：

~~~sql
SELECT
  time_bucket(
    INTERVAL '1 minute',
    observed_at
  ) AS bucket,
  name,
  ...
~~~

对于每一条 Row：

~~~text
10:00:05
    ↓
10:00:00

10:00:18
    ↓
10:00:00

10:00:45
    ↓
10:00:00

10:01:03
    ↓
10:01:00

10:01:59
    ↓
10:01:00
~~~

所以 time_bucket 可以先理解成：

~~~text
Timestamp
    ↓
Bucket Function
    ↓
Bucket Start Time
~~~

例如：

~~~text
time_bucket(
  1 minute,
  10:00:37
)

=
10:00:00
~~~

它不会：

~~~text
创建 Chunk

创建 Table

移动 Row

改变 observed_at

重新分区
~~~

它只是查询中的时间分组函数。

#### <u>2. Chunk 与 time_bucket 都使用时间，但属于完全不同层次</u>

第二节的 Chunk：

~~~text
Chunk
    ↓
Physical Storage Partition
~~~

这一节的 time_bucket：

~~~text
time_bucket
    ↓
Analytical Time Group
~~~

可以直接比较：

| 维度 | Chunk | time_bucket |
|---|---|---|
| 所属阶段 | 数据存储 | 查询分析 |
| 是不是实际表 | 是 | 不是 |
| 是否真正保存 Row | 是 | 否 |
| 什么时候产生作用 | INSERT / Storage Management | SELECT / Aggregation |
| 核心输入 | Partition Time + Chunk Interval | Timestamp + Bucket Interval |
| 解决的问题 | Row 物理存在哪里 | Row 属于哪个统计时间组 |

因此：

~~~text
Chunk
=
物理时间分区

time_bucket
=
统计时间分组
~~~

二者不能混为一谈。

#### <u>3. Chunk Interval 与 time_bucket Interval 可以完全不同</u>

为了理解，假设：

~~~text
Chunk Interval = 1 day
~~~

表示：

~~~text
物理上
一天的数据
可能存放在同一个 Chunk
~~~

但查询仍然可以：

~~~sql
time_bucket(
  INTERVAL '1 minute',
  observed_at
)
~~~

那么：

~~~text
一个 1-day Chunk
内部可以产生
1440 个 1-minute Analytical Buckets
~~~

反过来：

~~~text
Chunk Interval = 1 hour
~~~

查询也可以：

~~~sql
time_bucket(
  INTERVAL '1 day',
  observed_at
)
~~~

这时一个 1-day Analytical Bucket 可以覆盖多个 1-hour Physical Chunks。

所以：

~~~text
Physical Partition Granularity
和
Analytical Granularity
~~~

是两个独立设计参数。

#### <u>4. time_bucket 只是给每一条 Row 计算 bucket，真正形成统计组还需要 GROUP BY</u>

执行：

~~~sql
time_bucket(
  INTERVAL '1 minute',
  observed_at
) AS bucket
~~~

以后，数据可以理解成：

| observed_at | bucket | name | value |
|---|---|---|---:|
| 10:00:05 | 10:00:00 | LCP | 2100 |
| 10:00:18 | 10:00:00 | LCP | 2500 |
| 10:00:45 | 10:00:00 | INP | 180 |
| 10:01:03 | 10:01:00 | LCP | 1900 |
| 10:01:25 | 10:01:00 | LCP | 2300 |

此时 Row 仍然没有合并，只是多了 bucket 这个计算结果。

源码继续：

~~~sql
GROUP BY
  bucket,
  name
~~~

才把：

~~~text
相同 Bucket
+
相同 Metric Name
~~~

归为同一个 Statistical Group。

#### <u>5. Business Dimension 决定一个时间 Bucket 内还要按什么继续拆组</u>

为什么不能只：

~~~sql
GROUP BY bucket
~~~

因为同一分钟可能同时存在：

~~~text
10:00

LCP
LCP
LCP

INP
INP

CLS
CLS
~~~

如果只按 bucket，会把：

~~~text
LCP + INP + CLS
~~~

混在同一个统计组。

所以真正的 Group Key 是：

~~~text
Time Dimension
+
Business Dimension
~~~

当前就是：

~~~text
bucket
+
name
~~~

即：

~~~text
10:00 + LCP

10:00 + INP

10:00 + CLS

10:01 + LCP
...
~~~

可以抽象：

~~~text
Aggregate Group
=
Time Bucket
×
Business Dimensions
~~~

未来如果继续加入 environment、route、browser、region 等 Dimension，本质是在扩展 Group Cardinality，而不是改变 time_bucket 的作用。

#### <u>6. Aggregate 才真正把多条 Raw Rows 压缩成一个统计结果</u>

当前源码：

~~~sql
count(*)::bigint
  AS count,

count(DISTINCT session_id)::bigint
  AS session_count,

count(DISTINCT view_id)::bigint
  AS view_count,

avg(value)
  AS average,

percentile_cont(0.50)
  WITHIN GROUP (ORDER BY value)
  AS p50,

percentile_cont(0.75)
  WITHIN GROUP (ORDER BY value)
  AS p75,

percentile_cont(0.90)
  WITHIN GROUP (ORDER BY value)
  AS p90,

percentile_cont(0.95)
  WITHIN GROUP (ORDER BY value)
  AS p95
~~~

还会继续统计：

~~~sql
count(*) FILTER (
  WHERE server_rating = 'good'
)
  AS good_count,

count(*) FILTER (
  WHERE server_rating = 'needs-improvement'
)
  AS needs_improvement_count,

count(*) FILTER (
  WHERE server_rating = 'poor'
)
  AS poor_count
~~~

例如 10:00 的 LCP：

~~~text
1900
2100
2300
2500
~~~

最终得到：

~~~text
bucket = 10:00

name = LCP

count = 4

average = 2200

p50 = ...

p75 = ...

p90 = ...

p95 = ...
~~~

于是：

~~~text
Many Raw Rows
        ↓
Aggregate
        ↓
One Trend Point
~~~

这才是前端图表真正消费的数据。



### 【Temporal Alignment 用统一 Bucket 把多条时序序列放到同一时间坐标轴】

当前 performance() 还有一个比单表聚合更进一步的设计：

它不是只查询：

~~~text
performance_samples
~~~

而是同时查询：

~~~text
performance_samples
+
view_records
~~~

并把两条时序序列放到同一个分钟时间轴上。

当前 SQL：

~~~sql
WITH metric_points AS (
  ...
),
view_points AS (
  ...
)

SELECT
  m.*,
  COALESCE(
    v.page_views,
    0
  ) AS page_views

FROM metric_points m

LEFT JOIN view_points v
USING (bucket)

ORDER BY
  m.bucket,
  m.name
~~~

这一部分需要先分别看两条序列，再看它们怎样通过 bucket 对齐。

#### <u>1. Performance Series 先形成自己的分钟时间点</u>

当前：

~~~sql
SELECT
  time_bucket(
    INTERVAL '1 minute',
    observed_at
  ) AS bucket,
  name,
  ...
FROM performance_samples p
WHERE ...
GROUP BY
  bucket,
  name
~~~

结果可以理解成：

| bucket | name | count | p75 |
|---|---|---:|---:|
| 10:00 | LCP | 20 | 2300 |
| 10:00 | INP | 15 | 180 |
| 10:01 | LCP | 22 | 2400 |
| 10:01 | INP | 18 | 170 |

形成：

~~~text
Performance Series
        ↓
10:00
10:01
10:02
...
~~~

#### <u>2. View Series 也被映射到同样的一分钟时间轴</u>

当前：

~~~sql
SELECT
  time_bucket(
    INTERVAL '1 minute',
    started_at
  ) AS bucket,

  count(*)::bigint
    AS page_views

FROM view_records v

WHERE ...

GROUP BY bucket
~~~

结果：

| bucket | page_views |
|---|---:|
| 10:00 | 100 |
| 10:01 | 120 |
| 10:02 | 95 |

形成：

~~~text
View Series
        ↓
10:00
10:01
10:02
...
~~~

虽然两个表原始时间字段不同：

~~~text
performance_samples
    ↓
observed_at

view_records
    ↓
started_at
~~~

但经过：

~~~text
同一个 1 minute time_bucket
~~~

以后，都映射成：

~~~text
bucket
~~~

这个共同时间键。

#### <u>3. USING(bucket) 实际上是在做时间对齐</u>

当前：

~~~sql
LEFT JOIN view_points v
USING (bucket)
~~~

不是普通业务主键 Join。

它不是：

~~~text
performance_id
=
view_id
~~~

而是：

~~~text
两条不同 Time Series
在同一个时间窗口里
分别发生了什么
~~~

例如：

~~~text
10:00

Performance:
LCP Samples = 20

View:
Page Views = 100
~~~

通过：

~~~text
bucket = 10:00
~~~

对齐成：

~~~text
10:00
│
├── LCP Samples = 20
└── Page Views   = 100
~~~

因此 bucket 在这里除了作为：

~~~text
统计时间分组
~~~

还承担：

~~~text
Temporal Join Key
~~~

#### <u>4. Temporal Alignment 让跨序列指标成为可能</u>

当前最终返回：

~~~ts
sampleCoverage:
  Number(row.page_views) > 0
    ? Number(row.view_count)
      / Number(row.page_views)
    : 0
~~~

这个指标依赖：

~~~text
Performance View Count
        ↓
同一分钟

Page View Count
        ↓
同一分钟
~~~

如果两条序列没有统一时间粒度：

~~~text
Performance
10:00:05
10:00:18
10:00:43

View
10:00:02
10:00:37
10:00:58
~~~

就无法直接形成：

~~~text
10:00
统一统计结果
~~~

time_bucket 先把两边都映射到：

~~~text
10:00
~~~

于是才能进行：

~~~text
Temporal Alignment
        ↓
Cross-series Metric
~~~

#### <u>5. 这种模式可以抽象成通用 Multi-Series Analytics</u>

脱离当前项目：

~~~text
Series A
    ↓
自己的 Timestamp
    ↓
Common Bucket
        ┐
        │
        ├── Temporal Join
        │
Series B│
    ↓   │
自己的 Timestamp
    ↓   │
Common Bucket
        ┘
        ↓
Composite Metric
~~~

常见场景：

~~~text
Requests
+
Errors
    ↓
Error Rate

Orders
+
Users
    ↓
Orders per User

CPU
+
Traffic
    ↓
Resource per Request

Performance Samples
+
Page Views
    ↓
Sample Coverage
~~~

所以 time_bucket 不仅可以用于：

~~~text
Single-Series Aggregation
~~~

还可以作为：

~~~text
Cross-Series Temporal Alignment
~~~

的共同时间坐标。



### 【第三节收束：时序查询先选数据，再决定结果模型】

这一节真正只有四个主要分支：

~~~text
Time-Series Query
│
├── 一、Data Selection
│   │
│   ├── Business Scope
│   ├── Time Range
│   ├── Chunk Pruning
│   └── Index / Predicate
│
├── 二、Analytical Aggregation
│   │
│   ├── time_bucket
│   ├── Business Dimension
│   ├── GROUP BY
│   └── Aggregate
│
├── 三、Query Model
│   │
│   ├── Detail Query
│   │     └── Order + Cursor
│   │
│   └── Aggregate Query
│         └── Bucket + Group + Aggregate
│
└── 四、Temporal Alignment
    │
    ├── Series A → Common Bucket
    ├── Series B → Common Bucket
    └── Join by Bucket → Composite Metric
~~~

#### <u>1. Data Selection 只解决本次请求需要读取哪些 Raw Rows</u>

~~~text
All Historical Data
        ↓
Business Scope
        ↓
Time Range
        ↓
Chunk Pruning
        ↓
Index / Predicate
        ↓
Matching Raw Rows
~~~

核心问题：

> **这次请求到底需要读取哪些原始数据？**

#### <u>2. Analytical Aggregation 解决 Raw Rows 怎样变成趋势</u>

~~~text
Matching Raw Rows
        ↓
time_bucket
        ↓
Business Dimension
        ↓
GROUP BY
        ↓
Aggregate
        ↓
Trend Point
~~~

核心问题：

> **这些 Raw Rows 怎样被压缩成时间趋势？**

#### <u>3. Query Model 决定返回具体事实还是统计趋势</u>

~~~text
Matching Rows
        ↓
        ├── Detail
        │     ↓
        │  Raw Facts
        │
        └── Aggregate
              ↓
           Trend Points
~~~

核心问题：

> **产品真正需要的是具体事实，还是整体趋势？**

#### <u>4. Temporal Alignment 解决多个时序数据源怎样关联</u>

~~~text
Series A
    ↓
Bucket
        ┐
        ├── Join
        │
Series B│
    ↓   │
Bucket  ┘
        ↓
Composite Metric
~~~

核心问题：

> **不同来源的数据怎样被放到同一个时间坐标轴上做关联计算？**

#### <u>第三节最重要的三个概念边界</u>

第一：

~~~text
Chunk
=
物理存储分区

time_bucket
=
查询统计分组
~~~

第二：

~~~text
Time Range
=
本次请求读取哪一段历史数据

time_bucket
=
读出来以后怎样按时间重新组织
~~~

第三：

~~~text
Detail Query
=
保留 Raw Facts

Aggregate Query
=
压缩为 Trend Points
~~~

因此可以把整个第三节压缩成：

> **时序查询首先通过业务 Scope 与 Time Range 缩小需要读取的物理数据范围，再根据产品问题选择 Detail 或 Aggregate 结果模型；Aggregate Query 使用 time_bucket、Business Dimension、GROUP BY 和统计函数把 Raw Rows 转换成 Trend Points，而多个不同时间序列还可以通过统一 Bucket 对齐后形成跨序列指标。**



## 7. Continuous Aggregate 通过物化结果减少历史重复计算

### 【从反复计算历史事件统计的成本出发】

前一节已经解释了，原始事件通过 time_bucket + GROUP BY + COUNT 可以变成按分钟汇总的统计结果。但是 SELECT 本身不会自动保存聚合输出；如果每次请求历史图表都重新读取大量相同事件并分组，就会重复计算。

因此产生一个通用问题：**能否保存已经算好的历史时间桶，同时在原始事件继续进入数据库后，只刷新需要更新的桶？**

要先区分三种机制：

| 机制 | 统计结果是否保存 | 原始事件变化后如何维护 |
| --- | --- | --- |
| 普通 GROUP BY 查询 | 不会因 SELECT 自动持久化结果 | 下一次查询重新执行聚合 |
| PostgreSQL Materialized View | 将查询结果物化保存 | 需要 REFRESH MATERIALIZED VIEW；常规刷新重新执行定义查询 |
| TimescaleDB Continuous Aggregate | 保存分桶统计结果 | 根据物化范围、数据变更以及刷新窗口增量更新受影响的时间桶 |

**物化（Materialization）**的意思不是缓存到应用进程的内存里，而是将按时间桶及其他分组维度得到的统计结果，保存在数据库管理的物化结构中。原始事件仍存储于源 Hypertable。

### 【什么是增量物化，而不只是给计数器加一】

假设某一分钟已物化 COUNT=100，之后该分钟又产生了两条事件：

~~~text
已物化时间桶：10:00 → 100
新的原始事件：10:00:20、10:00:40
        ↓
该分钟历史统计不再对应原始事实
        ↓
记录相关原始时间范围发生了变化
        ↓
下次刷新覆盖这个分钟桶
        ↓
重新聚合这个时间桶 → 102
~~~

这里的增量是**识别并重算受影响的时间桶，而不是每次新 INSERT 都直接 UPDATE event_count = event_count + 1**。当历史修改超出自动刷新窗口时，还需要额外刷新或补算。

TimescaleDB 通过物化范围及 invalidation（失效）机制降低重复扫描全部历史的必要性。失效范围用于指出可能受原始数据变化影响的时间桶，刷新操作按当前原始数据计算更新后的聚合结果。

### 【刷新策略管理何时计算以及刷新哪段时间】

通用示例：

~~~sql
SELECT add_continuous_aggregate_policy(
  'event_stats_1m',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute'
);
~~~

- start_offset：从执行时刻向历史回溯，确定本轮候选刷新窗口的较早边界；
- end_offset：当前时间之前留出的较新边界，避免频繁物化还在持续变化的最新桶；
- schedule_interval：后台任务的目标调度周期，**不表示每一周期必然成功刷新或推进水位**。

后台刷新针对**完整位于指定刷新区间的时间桶**执行；对已物化区域可结合失效信息更新受影响的时间桶，对尚未物化且符合范围的时间桶执行首次物化。SQL WHERE 能查询原始数据与否，不自动保证所有历史桶都处于这轮刷新范围。

### 【项目：分钟级原始事件统计具体建立在哪里】

监控平台中，一次页面访问或自定义事件经过入库校验后保存在原始表 telemetry_events。项目希望查看每分钟的事件量，因此另外建立名为 telemetry_rollup_1m 的连续聚合。

~~~sql
CREATE MATERIALIZED VIEW telemetry_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id, type, name, environment, app_version, route_name,
  count(*)::bigint AS event_count
FROM telemetry_events
GROUP BY bucket, project_id, type, name, environment, app_version, route_name
WITH NO DATA;
~~~

- timescaledb.continuous：声明使用 TimescaleDB 的连续聚合维护机制；
- FROM telemetry_events：源头是原始事件，而不是预先统计的结果；
- GROUP BY：按分钟和项目/事件类型/环境等组合分别保存统计；
- WITH NO DATA：建视图时不立即把全部历史源数据物化；自动策略通常覆盖有限时间窗口，早于该窗口的历史需要考虑手动回填。

项目刷新策略：

~~~sql
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);
~~~

这里的 10 秒是刷新任务的调度间隔，**并不是 time_bucket 的统计粒度**，也不等于每 10 秒就把过去 29 天完全重算一遍。统计仍按一分钟分桶，任务对窗口中的完整桶进行相关计算。

源码：[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)。

### 【实时聚合为什么有必要】

如果最新的一分钟尚未完成物化，只查询已经保存的历史统计，就可能看不到最近收到的事件。为此可启用：

~~~sql
ALTER MATERIALIZED VIEW telemetry_rollup_1m
SET (timescaledb.materialized_only = false);
~~~

此配置表示 Continuous Aggregate 查询**不局限于已物化结果**，可把物化水位之后、尚未物化的原始事件在查询时临时分桶聚合后纳入结果。此行为是数据库 SELECT 的查询方式，**不意味着更新了物化存储、不意味着有 WebSocket 推送，也不承诺已经物化的历史改变会即时更新**。

项目源码：[0003_realtime_aggregates.sql](../platform/packages/database/migrations/0003_realtime_aggregates.sql)。

资料：[Timescale 连续聚合的运行机制](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)、[刷新策略与窗口](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/refresh-policies/)、[实时聚合](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/)。



### 【Continuous Aggregate 物化与刷新详细机制】



第三节已经解决：

~~~text
Raw Time-Series Data
        ↓
Data Selection
        ↓
Matching Raw Rows
        ↓
time_bucket
        ↓
GROUP BY
        ↓
Aggregate
        ↓
Trend Points
~~~

这里继续出现一个新的问题。

假设 Dashboard 查询：

~~~text
过去 24 小时
每分钟 LCP
count / avg / p75 / p95
~~~

当前近期查询每请求一次，数据库都会重新：

~~~text
读取 Raw Rows
    ↓
重新 time_bucket
    ↓
重新 GROUP BY
    ↓
重新 count
    ↓
重新 avg
    ↓
重新算 percentile
~~~

如果同一个 Dashboard 被大量重复访问，那么历史数据上的同一批统计会被反复计算。

因此这一节真正解决的问题是：

> **对于已经发生、而且经常被重复统计的历史数据，为什么每次查询都重新从 Raw Rows 开始计算？**

Continuous Aggregate 就是从这个问题出现的。

整个知识框架只有四个主要部分：

~~~text
Continuous Aggregate
│
├── 一、Repeated Computation
│      ↓
│   为什么需要 Precomputation
│
├── 二、Materialization
│      ↓
│   Continuous Aggregate
│   实际保存了什么
│
├── 三、Refresh
│      ↓
│   Raw Data 变化以后
│   预计算结果怎样更新
│
└── 四、Read Architecture
       ↓
    Raw Detail
    1m Aggregate
    1h Aggregate
    如何在当前项目中分工
~~~



### 【Repeated Computation 是 Continuous Aggregate 出现的直接原因】

#### <u>1. 当前近期 Performance 查询是标准 Query-time Aggregation</u>

analytics.service.ts 中：

~~~ts
async performance(
  userId: string,
  projectId: string,
  filters: AnalyticsFilters,
) {
  await this.projects.requireAccess(
    userId,
    projectId,
  );

  if (this.useRollups(filters)) {
    return this.performanceFromRollups(
      projectId,
      filters,
    );
  }

  ...
}
~~~

如果时间范围没有进入历史 Rollup：

~~~ts
const filter = this.filters(
  "p",
  "observed_at",
  projectId,
  filters,
);
~~~

然后直接查询：

~~~sql
FROM performance_samples p
WHERE ...
~~~

再执行：

~~~sql
time_bucket(
  INTERVAL '1 minute',
  observed_at
)
~~~

随后：

~~~sql
GROUP BY
  bucket,
  name
~~~

并重新计算：

~~~sql
count(*)

count(DISTINCT session_id)

count(DISTINCT view_id)

avg(value)

percentile_cont(0.50)

percentile_cont(0.75)

percentile_cont(0.90)

percentile_cont(0.95)
~~~

这就是：

~~~text
Query-time Aggregation
~~~

完整逻辑：

~~~text
Request
    ↓
Raw performance_samples
    ↓
Time Range
    ↓
Matching Rows
    ↓
time_bucket
    ↓
GROUP BY
    ↓
Aggregate
    ↓
Result
~~~

#### <u>2. Query-time Aggregation 本身没有问题，问题出现在大量重复计算</u>

例如数据库已经有：

~~~text
10 月 1 日
1000 万条 performance_samples
~~~

用户第一次请求：

~~~text
10 月 1 日
每分钟 LCP p75
~~~

数据库需要：

~~~text
读取相关 Rows
    ↓
分成分钟 Bucket
    ↓
计算每分钟 p75
~~~

这本身是合理的。

但第二个用户请求完全相同的数据时：

~~~text
10 月 1 日
每分钟 LCP p75
~~~

数据库又重新：

~~~text
读取
    ↓
分组
    ↓
排序 / percentile
    ↓
计算
~~~

第三次、第四次仍然重复相同工作。

最终形成：

~~~text
Historical Raw Data
        │
        ├── Query 1
        │      ↓
        │   Aggregate
        │
        ├── Query 2
        │      ↓
        │   Same Aggregate
        │
        ├── Query 3
        │      ↓
        │   Same Aggregate
        │
        └── Query N
               ↓
            Same Aggregate
~~~

真正的问题不是 SELECT 本身，而是：

> **大量基本不会再变化的历史数据，被反复执行相同的聚合计算。**

#### <u>3. Precomputation 把重复工作从 Read Path 搬到后台</u>

假设：

~~~text
10:00 ~ 10:01
~~~

这一分钟已经结束，并且其中存在：

~~~text
100000 条 LCP Samples
~~~

后续大量查询真正需要的可能只是：

~~~text
10:00

count
min
max
avg
p75
good count
poor count
...
~~~

那么就可以提前计算一次：

~~~text
100000 Raw Rows
        ↓
Background Aggregate
        ↓
1 Aggregate State
~~~

以后多个请求直接读取：

~~~text
已经计算好的 Aggregate Result
~~~

于是查询结构从：

~~~text
Read
    ↓
Heavy Compute
~~~

变成：

~~~text
Background
    ↓
Heavy Compute

Read
    ↓
Lightweight Query
~~~

这就是：

~~~text
Precomputation
~~~

所以 Continuous Aggregate 首先不是一个 SQL API，而是一种设计思想：

> **把高频、昂贵、重复、结构稳定的分析计算提前维护。**



### 【Materialization 把聚合结果真正保存下来】

当前项目的 performance_rollup_1m：

~~~sql
CREATE MATERIALIZED VIEW
performance_rollup_1m

WITH (
  timescaledb.continuous
)

AS

SELECT
  time_bucket(
    INTERVAL '1 minute',
    observed_at
  ) AS bucket,

  project_id,
  name,
  environment,
  app_version,
  route_name,
  threshold_version_id,

  count(*)::bigint
    AS sample_count,

  min(value)
    AS minimum,

  max(value)
    AS maximum,

  avg(value)
    AS average,

  percentile_agg(value)
    AS value_percentiles,

  count(*) FILTER (
    WHERE server_rating = 'good'
  )::bigint
    AS good_count,

  count(*) FILTER (
    WHERE server_rating = 'needs-improvement'
  )::bigint
    AS needs_improvement_count,

  count(*) FILTER (
    WHERE server_rating = 'poor'
  )::bigint
    AS poor_count,

  hyperloglog(
    8192,
    session_id
  ) AS session_hll,

  hyperloglog(
    8192,
    view_id
  ) AS view_hll,

  ...

FROM performance_samples

GROUP BY
  bucket,
  project_id,
  name,
  environment,
  app_version,
  route_name,
  threshold_version_id

WITH NO DATA;
~~~

这段代码可以按职责拆成：

~~~text
Source
    ↓
performance_samples

Grouping
    ↓
1 minute
+
Business Dimensions

Aggregation
    ↓
count
min
max
avg
percentile state
rating count
HLL state
...

Destination
    ↓
performance_rollup_1m
~~~

#### <u>1. 普通 View 只保存查询定义，不保存预计算结果</u>

普通 View：

~~~sql
CREATE VIEW ...
AS
SELECT ...
~~~

可以理解成：

~~~text
View
    ↓
保存 Query Definition
~~~

当查询：

~~~sql
SELECT *
FROM my_view;
~~~

数据库仍然需要根据 View 定义执行底层 Query。

所以：

~~~text
View
≠
Precomputed Result
~~~

#### <u>2. Materialized View 会真正保存 Query Result</u>

Materialized View：

~~~text
Raw Table
    ↓
Aggregate Query
    ↓
Materialized Result
    ↓
Persistent Storage
~~~

以后查询 Materialized View 时，可以读取已经物化的结果，而不是每次重新执行完整原始计算。

因此：

~~~text
View
    ↓
保存 Query Definition

Materialized View
    ↓
保存 Query Result
~~~

#### <u>3. Continuous Aggregate 是面向 Time-Series 的增量 Materialized View</u>

当前：

~~~sql
WITH (
  timescaledb.continuous
)
~~~

告诉 TimescaleDB：

~~~text
这个 Materialized View
由 TimescaleDB 按 Time-Series 模型
持续维护
~~~

所以关系可以理解成：

~~~text
View
    ↓
只保存 Query Definition


Materialized View
    ↓
保存 Query Result
    ↓
需要 Refresh


Continuous Aggregate
    ↓
保存 Time-Series Aggregate Result
    +
跟踪需要更新的时间范围
    +
执行增量 Refresh
~~~

#### <u>4. Continuous Aggregate 的数据不是 Redis Cache，也不是应用内存</u>

它不是：

~~~text
Node.js Memory
~~~

不是：

~~~text
Redis
~~~

也不是：

~~~text
SELECT 时临时产生的数据
~~~

它属于：

~~~text
PostgreSQL / TimescaleDB
内部持久化管理的
预计算 Aggregate Data
~~~

可以先直观理解：

~~~text
performance_samples
Raw Hypertable
        ↓
Continuous Aggregate Definition
        ↓
TimescaleDB Internal
Materialized Aggregate Storage
        ↓
performance_rollup_1m
作为 SQL 查询入口
~~~

#### <u>5. Materialization 保存的是聚合状态，不是 Raw Row 副本</u>

假设 Raw Data：

~~~text
10:00:05 LCP 2100
10:00:08 LCP 2500
10:00:12 LCP 1900
10:00:27 LCP 2300
...
10000 Rows
~~~

Continuous Aggregate 不会再复制这 10000 条 Raw Rows。

而会形成类似：

~~~text
bucket = 10:00

project_id = P001

name = LCP

sample_count = 10000

minimum = ...

maximum = ...

average = ...

value_percentiles = ...

good_count = ...

poor_count = ...

session_hll = ...

view_hll = ...
~~~

所以：

~~~text
Many Raw Rows
        ↓
Materialization
        ↓
Much Smaller Aggregate State
~~~

这才是它降低长期分析成本的根本原因。



### 【Refresh 让已经物化的 Aggregate 跟随 Raw Data 持续变化】

如果只：

~~~text
Raw Data
    ↓
算一次 Aggregate
    ↓
以后永远不更新
~~~

当然无法满足持续写入的时序系统。

因为当前：

~~~text
performance_samples
~~~

还在不断产生新 Row，而且部分最近 Sample 还可能被修订。

因此 Continuous Aggregate 需要继续解决：

> **Raw Data 发生变化以后，已经保存的 Aggregate Result 怎样更新？**

这就是 Refresh。

#### <u>1. WITH NO DATA 表示创建定义时不立即完整回填历史</u>

当前：

~~~sql
WITH NO DATA;
~~~

它不是：

~~~text
这个 Continuous Aggregate
永远没有数据
~~~

而是：

~~~text
CREATE 时
先建立 Continuous Aggregate Definition

不立即扫描全部历史
完成完整 Materialization
~~~

因此创建后可以理解成：

~~~text
Continuous Aggregate Definition
    ↓
已经存在

Historical Aggregate Data
    ↓
需要后续 Refresh / Backfill
逐步产生
~~~

这样可以避免数据库已经有大量历史数据时，Migration 创建 Aggregate 的同时立即执行一次非常重的全历史聚合。

#### <u>2. 当前项目通过 Refresh Policy 自动维护一分钟 Aggregate</u>

源码：

~~~sql
SELECT add_continuous_aggregate_policy(
  'performance_rollup_1m',

  start_offset
    => INTERVAL '29 days',

  end_offset
    => INTERVAL '10 seconds',

  schedule_interval
    => INTERVAL '10 seconds',

  if_not_exists
    => TRUE
);
~~~

前面的：

~~~sql
CREATE MATERIALIZED VIEW ...
AS
SELECT ...
~~~

回答：

~~~text
What to Compute
~~~

而 Refresh Policy 回答：

~~~text
When to Refresh

以及

Which Time Range to Refresh
~~~

所以：

~~~text
Continuous Aggregate Definition
        ↓
聚合规则

Refresh Policy
        ↓
维护规则
~~~

#### <u>3. 三个 Policy 参数要放在同一个 Refresh Window 中理解</u>

当前：

~~~text
start_offset = 29 days

end_offset = 10 seconds

schedule_interval = 10 seconds
~~~

可以画成：

~~~text
Past                                              Now
│                                                  │
│<---------------------- 29 days ----------------->│
│                                                  │
└──────── Refresh Window ────────────────┐          │
                                        │<--10s--->│
~~~

近似理解：

~~~text
Refresh Window

now - 29 days
        ↓
到
        ↓
now - 10 seconds
~~~

start_offset：

~~~text
决定向历史回看多远
~~~

end_offset：

~~~text
决定离 Now 留出多少最新数据缓冲区
~~~

schedule_interval：

~~~text
决定后台 Refresh Job 多久运行一次
~~~

因此：

~~~text
start_offset
+
end_offset
    ↓
定义 Refresh Window

schedule_interval
    ↓
定义 Refresh Frequency
~~~

#### <u>4. Refresh Window 与 Retention Window 不是同一个概念</u>

当前：

~~~text
start_offset = 29 days
~~~

不代表：

~~~text
performance_rollup_1m
只能保留 29 天
~~~

29 天描述的是：

~~~text
Refresh Policy
向历史维护多远
~~~

而保存多久属于：

~~~text
Retention Policy
~~~

所以必须固定：

~~~text
Refresh Window
≠
Retention Window
~~~

#### <u>5. end_offset 为最新的热数据留下缓冲</u>

当前：

~~~text
end_offset = 10 seconds
~~~

表示 Policy 的物化范围不会一直追到绝对 Now。

最近的数据可能仍在：

~~~text
持续写入

迟到上报

Sample Sequence 更新

Provisional → Final
~~~

因此保留：

~~~text
10-second Buffer
~~~

避免后台物化一直围绕最热的数据窗口反复工作。

这个 10 秒只是当前项目配置，不是所有 Continuous Aggregate 的固定规则。

#### <u>6. schedule_interval 是 Freshness 与 Background Cost 的权衡</u>

当前：

~~~text
schedule_interval = 10 seconds
~~~

意味着后台 Job 大约每 10 秒触发一次维护。

更频繁：

~~~text
Aggregate Freshness 更高
~~~

但：

~~~text
Background Refresh Cost 更高
~~~

更慢：

~~~text
后台成本更低
~~~

但：

~~~text
Aggregate Lag 更大
~~~

因此这是：

~~~text
Freshness
vs
Maintenance Cost
~~~

的设计参数。

#### <u>7. Continuous Aggregate 的关键是增量维护，而不是反复完整重算历史</u>

如果每 10 秒都：

~~~text
扫描 29 天全部 Raw Data
    ↓
重新计算所有 Bucket
~~~

那么即使自动化了，成本仍然非常高。

Continuous Aggregate 的核心是：

~~~text
Raw Data Change
    ↓
Affected Time Range / Bucket
    ↓
Invalidation
    ↓
Incremental Refresh
~~~

例如：

~~~text
10:00 Bucket
已经稳定

10:01 Bucket
已经稳定

10:02 Bucket
新数据发生变化
~~~

理想维护目标不是：

~~~text
10:00 重新算
10:01 重新算
10:02 重新算
~~~

而是优先重新处理受到变化影响的范围。

所以：

~~~text
Continuous
~~~

不是指：

~~~text
每一条 INSERT
同步重新计算完整 Aggregate
~~~

而是：

~~~text
持续跟踪变化
+
后台增量维护预计算结果
~~~

#### <u>8. Continuous Aggregate 不是应用层 Dual Write</u>

当前应用代码没有：

~~~text
INSERT performance_samples

然后：

UPDATE performance_rollup_1m
~~~

这种业务逻辑。

应用只写：

~~~text
Raw Hypertable
~~~

例如：

~~~text
performance_samples
~~~

而 Aggregate Maintenance 由 TimescaleDB 后台机制负责：

~~~text
Application
    ↓
Raw Hypertable

TimescaleDB Background Job
    ↓
Continuous Aggregate
~~~

因此不是：

~~~text
Application
    ↓
Dual Write
    ├── Raw
    └── Aggregate
~~~

这减少了应用自己维护两份数据一致性的复杂度。



### 【脱离项目形成 Continuous Aggregate 的完整判断框架】

Continuous Aggregate 可以抽象成：

~~~text
Time-Series Raw Data
        ↓
Repeated Analytical Query
        ↓
Repeated Computation
        ↓
Precompute Stable Work
        ↓
Materialized Aggregate State
        ↓
Incremental Refresh
        ↓
Fast Historical Read
~~~

完整能力结构：

~~~text
Continuous Aggregate
│
├── Source
│      ↓
│   Raw Hypertable
│
├── Definition
│      ↓
│   time_bucket
│   Dimensions
│   Aggregate State
│
├── Materialization
│      ↓
│   Persist Precomputed Result
│
├── Invalidation
│      ↓
│   Track Changed Time Ranges
│
├── Refresh Policy
│      ↓
│   start_offset
│   end_offset
│   schedule_interval
│
└── Read
       ↓
    Query Aggregate Result
~~~

是否值得引入 Continuous Aggregate，可以顺着：

~~~text
Query 是否频繁执行？
        ↓
结果是否大量重复？
        ↓
底层 Raw Data 是否很多？
        ↓
历史 Bucket 是否相对稳定？
        ↓
是否可以接受一定 Refresh Lag？
        ↓
聚合维度是否比较稳定？
        ↓
Continuous Aggregate
可能有价值
~~~

典型适合：

~~~text
过去 30 天每小时 CPU avg

过去 90 天每天订单数

过去半年每小时 LCP p75

长期 PV / UV
~~~

而少见、临时、组合维度高度动态的查询，可能直接查询 Raw Data 更合理。

所以：

> **Continuous Aggregate 不是把所有 SQL 都预计算，而是把高频、昂贵、重复、结构稳定的时序聚合提前维护。**



### 【第四节收束：当前项目把计算从请求路径逐步移动到后台】

当前项目最终形成：

~~~text
performance_samples
Raw Hypertable
        │
        ├──────────────────────────┐
        │                          │
        ▼                          ▼
Recent Query               Background Precompute
        │                          │
Query-time Aggregate              1m CAGG
        │                          │
Exact                             ▼
Statistics                       1h CAGG
        │                          │
        ▼                          ▼
Recent Result             Historical Read Model
~~~

这一节最重要的四个边界：

~~~text
Continuous Aggregate
≠
普通 View
~~~

因为它保存聚合结果。

~~~text
Continuous Aggregate
≠
普通 Materialized View
~~~

因为它针对时序数据持续增量维护，而不是把“完整历史重新刷新”作为唯一模型。

~~~text
Continuous Aggregate
≠
Redis Cache
~~~

因为它属于数据库长期分析数据模型，而 Redis 是短生命周期 Query Result Cache。

~~~text
Continuous Aggregate
≠
应用 Dual Write
~~~

应用继续写 Raw Hypertable，Aggregate 由 TimescaleDB 后台机制维护。

最终可以压缩成：

> **Continuous Aggregate 的核心不是单纯“查询更快”，而是把高频重复的时序聚合从请求路径搬到数据库后台：Raw Data 仍然作为事实保存，TimescaleDB 将稳定历史按时间 Bucket 物化成 Aggregate State，并通过 Refresh 持续维护，历史查询再直接读取这些预计算结果。**



### 【层级连续聚合：分钟到小时的真实项目实现】



前面已经建立：

~~~text
Raw Hypertable
        ↓
Continuous Aggregate
        ↓
Materialized Result
~~~

这一节再向前一步。

Hierarchical Continuous Aggregate 最关键的变化不是：

~~~text
1 minute
变成
1 hour
~~~

而是：

~~~text
Higher-level Continuous Aggregate
        ↓
它的数据源
不再直接是 Raw Hypertable

而是：

Lower-level Continuous Aggregate
~~~

所以先固定定义：

> **Hierarchical Continuous Aggregate 是建立在另一个 Continuous Aggregate 之上的 Continuous Aggregate。更粗的时间粒度只是常见结果，真正的结构变化是 Source 从 Raw Hypertable 变成 Lower-level CAGG。**



### 【当前项目已经形成真实的 1m → 1h Hierarchical CAGG】

当前 `0002_hourly_aggregates.sql`：

~~~sql
CREATE MATERIALIZED VIEW performance_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  ...
FROM performance_rollup_1m
GROUP BY ...
WITH NO DATA;
~~~

这里最重要的不是：

~~~text
time_bucket = 1 hour
~~~

而是：

~~~text
FROM performance_rollup_1m
~~~

因此当前真实数据链：

~~~text
performance_samples
        ↓
performance_rollup_1m
        ↓
performance_rollup_1h
~~~

同样：

~~~text
view_rollup_1m
        ↓
view_rollup_1h

custom_event_rollup_1m
        ↓
custom_event_rollup_1h

telemetry_rollup_1m
        ↓
telemetry_rollup_1h
~~~

所以：

~~~text
普通 CAGG
=
Raw Hypertable
        ↓
Continuous Aggregate

Hierarchical CAGG
=
Continuous Aggregate
        ↓
Higher-level Continuous Aggregate
~~~

#### <u>1. 为什么不直接让 1h CAGG 每次重新扫描 Raw</u>

如果每一层都直接读取 Raw：

~~~text
Raw
├── 1m Aggregate
├── 1h Aggregate
└── 1d Aggregate
~~~

那么不同粒度都会重复读取和聚合原始历史数据。

Hierarchical CAGG 则可以形成：

~~~text
Raw
    ↓
1m
    ↓
1h
    ↓
1d
~~~

让更高层复用更低层已经形成的 Aggregate Result / Aggregate State。

因此它解决的不只是：

~~~text
时间粒度更粗
~~~

还包括：

~~~text
Reuse Lower-level Precomputation
~~~



### 【Bucket Compatibility 决定两层 CAGG 能不能建立层级关系】

Hierarchical CAGG 不是任意时间粒度都可以直接叠加。

当前项目：

~~~text
1 minute
        ↓
1 hour
~~~

之所以自然，是因为：

~~~text
1 hour
=
60 × 1 minute
~~~

对于 Fixed-width Bucket，可以先建立最重要的判断：

~~~text
Parent Bucket
必须 >= Child Bucket

并且：

Parent Bucket
必须能够由 Child Bucket
完整组合得到
~~~

常见情况下可理解成：

~~~text
Parent Width
%
Child Width
=
0
~~~

例如：

~~~text
1m → 1h
✓

1h → 6h
✓

1h → 90m
✗
~~~

因此：

~~~text
Hierarchical CAGG
        ↓
不仅要求 Source 是 CAGG
        ↓
还要求 Bucket Compatibility
~~~

#### <u>1. Fixed-width 与 Variable-width Bucket 需要分开理解</u>

并不是所有时间 Bucket 都是：

~~~text
固定秒数
~~~

例如：

~~~text
1 month
~~~

属于 Variable-width Calendar Bucket。

因此不能简单用：

~~~text
秒数整除
~~~

解释所有组合。

学习阶段先保留边界：

~~~text
Fixed-width → Fixed-width
        ↓
需要满足兼容的整数倍层级

Fixed-width → Variable-width
        ↓
可以存在合法层级

Variable-width → Fixed-width
        ↓
不能直接按普通 Fixed-width 层级理解
~~~

具体 Calendar Bucket 兼容规则后续在真正遇到 Month / Year 聚合时再深入。

当前 Browser Monitor：

~~~text
1 minute
→
1 hour
~~~

属于最清晰的 Fixed-width Hierarchy。



### 【Hierarchical Aggregation 要求 Lower-level Result 可以继续组合】

当前 `performance_rollup_1h` 并不是把 1m Row 简单重新 GROUP BY。

它对不同统计量使用了不同的 Rollup 方式。

最简单的是：

~~~sql
sum(sample_count)
min(minimum)
max(maximum)
~~~

这类统计可以直接组合：

~~~text
count
        ↓
sum(count)

min
        ↓
min(min)

max
        ↓
max(max)
~~~

但 Average 不能：

~~~text
avg(
  1m average
)
~~~

当前源码采用：

~~~sql
sum(average * sample_count)
/
NULLIF(sum(sample_count), 0)
~~~

原因是：

~~~text
不同 1m Bucket
sample_count
可能不同
~~~

所以正确的 1h Average 必须按样本数量重新加权：

~~~text
Σ(1m Average × 1m Count)
──────────────────────
       Σ(1m Count)
~~~

#### <u>1. Percentile 与 Distinct Count 更不能直接组合最终数值</u>

当前源码：

~~~sql
rollup(value_percentiles)

rollup(session_hll)

rollup(view_hll)
~~~

说明 Lower-level CAGG 保存的不是只有：

~~~text
p75 = 2300

distinct_session = 100
~~~

这类最终显示值。

它还保存：

~~~text
可以继续合并的
Intermediate Aggregate State
~~~

因此 Hierarchical Aggregation 可以先分成：

~~~text
可直接组合的 Aggregate
│
├── count
├── min
├── max
└── sum
│
└── 直接 Rollup

需要额外 State 的 Aggregate
│
├── average
├── percentile
└── distinct count
│
└── 需要 Weighted / Intermediate State
~~~

这一节只建立：

~~~text
Higher-level Aggregate
要求 Lower-level Result
具有可组合性
~~~

至于：

~~~text
为什么 percentile 需要 percentile_agg

为什么 distinct 需要 HLL

为什么 Two-step Aggregate
可以解决 Rollup
~~~

留到下一节单独展开。

这样形成：

~~~text
第 7 节
Hierarchical CAGG
        ↓
提出：
哪些 Aggregate 能继续组合？

第 8 节
Two-step Aggregate
        ↓
解释：
为什么需要 Intermediate State
~~~



### 【Hierarchical CAGG 的 Freshness 是跨层传播的】

第 4 节已经建立：

~~~text
Continuous Aggregate
        ↓
Materialization
        ↓
Watermark
~~~

以及：

~~~text
materialized_only
~~~

决定 Query 是否只读取已经 Materialized 的结果。

进入 Hierarchical CAGG 后，这些概念不能只看单层。

例如：

~~~text
Raw
    ↓
1m CAGG
    ↓
1h CAGG
~~~

1h CAGG 的 Source 是：

~~~text
1m CAGG
~~~

所以 1h 能看到多新的数据，首先受 1m Source 状态影响。

可以抽象：

~~~text
Raw Freshness
        ↓
1m Materialization / Real-time Boundary
        ↓
1h Materialization / Real-time Boundary
        ↓
最终 Query Freshness
~~~

#### <u>1. Real-time 数据传播会受到每一层 materialized_only 边界影响</u>

如果：

~~~text
Raw
↓
1m Real-time
↓
1h Real-time
~~~

那么 Recent Raw Tail 可以沿 Hierarchy 继续向上传播。

但如果中间层：

~~~text
materialized_only = true
~~~

例如：

~~~text
Raw
↓
1m Real-time
↓
1h Materialized-only
↓
更高层
~~~

那么：

~~~text
Real-time Propagation
~~~

会在这个 Materialized-only Layer 被截断。

因此：

~~~text
Hierarchical CAGG Freshness
≠
只看最高层 Refresh Policy
~~~

而应该理解成：

~~~text
Lower-level Materialization
+
Higher-level Materialization
+
各层 Real-time / Materialized-only Boundary
~~~

这也是第 6 节：

~~~text
Policy Dependency
~~~

进入实际 CAGG Hierarchy 后的第一种具体表现。



### 【Refresh Policy 会形成跨层 Materialization Dependency】

当前项目 1m CAGG：

~~~text
start_offset = 29 days

end_offset = 10 seconds

schedule_interval = 10 seconds
~~~

1h CAGG：

~~~text
start_offset = 179 days

end_offset = 1 hour

schedule_interval = 5 minutes
~~~

这说明：

~~~text
1m
负责更近期、更高频率的 Aggregate Maintenance

1h
负责更长历史范围、
但允许更大的 Freshness Delay
~~~

而 1h 的 Source 又是 1m：

~~~text
1h Refresh
        ↓
依赖
        ↓
1m Source Result
~~~

所以第 6 节抽象的：

~~~text
Policy Dependency
~~~

在这里具体化成：

~~~text
Data Dependency
│
└── 1h Source = 1m CAGG

Refresh Dependency
│
└── 1h Refresh 依赖 1m 可读取结果

Freshness Dependency
│
└── 上游 Stale 会限制下游 Freshness

Retention Dependency
│
└── 下游仍需要的数据
    不能先被上游删除
~~~



### 【Source Retention 必须覆盖 Dependent Refresh Window】

当前项目还有一个很值得保留的真实配置：

~~~text
1m CAGG Retention
=
180 days
~~~

而 1h CAGG：

~~~text
start_offset
=
179 days
~~~

因此当前配置形成：

~~~text
Lower-level Source Retention
180d

        >

Higher-level Refresh History
179d
~~~

从工程角度可以理解成：

~~~text
Dependent Refresh Window
仍然位于
Source Available Window
内部
~~~

并保留了大约：

~~~text
1 day
~~~

的 Source Availability Margin。

但必须区分：

~~~text
仓库事实
=
180d vs 179d

工程分析
=
当前形成约 1d Margin

TimescaleDB 官方固定规则
≠
必须多留 1d
~~~

真正需要固定的是：

~~~text
Source Retention
必须覆盖
仍可能被 Dependent Refresh 使用的数据范围
~~~

具体 Margin 应结合：

~~~text
Late Arrival

Refresh Frequency

Failure Recovery Window

Operational Margin
~~~

共同设计。

因此不能简单记成：

~~~text
Retention
=
Refresh Window + 1 day
~~~

而应该记成：

~~~text
Source Retention
>
Dependent Refresh Requirement
~~~



### 【第六节的 Policy Dependency 在这里变成真实数据依赖】

上一节已经建立：

~~~text
Policy Design
=
Data Selection Rule
+
Schedule
+
Dependency
+
Resource
+
Observability
~~~

所以本节不重新解释：

~~~text
Policy

Job

Scheduler

Background Worker
~~~

而是直接复用 Dependency。

对于 Hierarchical CAGG：

~~~text
Automation Framework
        ↓
Policy Dependency
        ↓
Hierarchical CAGG
        ↓
Data Dependency
        ↓
Refresh Dependency
        ↓
Retention Dependency
        ↓
Freshness Dependency
~~~

这就是为什么：

~~~text
一组独立的定时 Job
~~~

不能完整描述 Hierarchical CAGG。

真正的系统是：

~~~text
多个 Background Jobs
        ↓
共同维护
        ↓
同一条层级化 Data Lifecycle
~~~



### 【当前源码只需要抽取最小证据，不复制整份 Migration】

理解项目实现时，只需要抓住四段代码。

第一段：

~~~sql
FROM performance_rollup_1m
~~~

证明：

~~~text
1h CAGG Source
=
1m CAGG
~~~

第二段：

~~~sql
time_bucket(
  INTERVAL '1 hour',
  bucket
)
~~~

证明：

~~~text
1m Time Bucket
        ↓
重新组织成
1h Time Bucket
~~~

第三段：

~~~sql
sum(average * sample_count)
/
NULLIF(sum(sample_count), 0)
~~~

证明：

~~~text
Average
不能简单 avg(avg)
~~~

第四段：

~~~sql
rollup(value_percentiles)

rollup(session_hll)

rollup(view_hll)
~~~

证明：

~~~text
Higher-level CAGG
需要 Lower-level Aggregate State
继续可组合
~~~

完整 Migration 仍然保留在：

~~~text
browser-monitor/platform/packages/database/migrations/
0002_hourly_aggregates.sql
~~~

知识正文只保留能够证明概念的最小代码。



### 【第七节最终形成 Hierarchical CAGG 的完整框架】

把这一节压缩：

~~~text
Raw Hypertable
        ↓
Lower-level CAGG
        ↓
Higher-level CAGG
~~~

成立需要同时满足：

~~~text
Hierarchical CAGG
│
├── Source Compatibility
│   └── Source 是 Lower-level CAGG
│
├── Bucket Compatibility
│   └── Higher-level Bucket 能由 Lower-level Bucket 合法组合
│
├── Aggregate Compatibility
│   └── Lower-level Result 能继续 Rollup
│
├── Materialization Dependency
│   └── 上游状态限制下游 Refresh
│
├── Retention Dependency
│   └── Source 不能提前删除下游仍需要的数据
│
└── Freshness Dependency
    └── Materialization / Real-time Boundary 会沿层级传播
~~~

因此：

> **Hierarchical Continuous Aggregate 不是简单把 1m 改成 1h，而是让 Lower-level Continuous Aggregate 成为 Higher-level Continuous Aggregate 的数据源；从这一刻开始，Bucket、Aggregate State、Refresh、Retention 与 Freshness 都进入跨层依赖设计。**

下一节再继续回答：

~~~text
为什么 Average
不能 avg(avg)？

为什么 Percentile
不能 percentile(p75)？

为什么 Distinct Count
不能 sum(distinct count)？

为什么需要
Two-step Aggregate
+
Intermediate Aggregate State
+
Hyperfunctions
~~~

也就是进入：

~~~text
Hierarchical CAGG
        ↓
Aggregate State Composability
        ↓
Two-step Aggregate
~~~




### 【可组合统计状态：Two-step Aggregation 与统计实例】



第 7 节已经得到一个问题：

~~~text
Hierarchical CAGG
        ↓
Higher-level Aggregate
        ↓
要求 Lower-level Result
还能继续组合
~~~

如果 Lower-level CAGG 只保存最终展示值：

~~~text
Average = 120

P75 = 230

Distinct Sessions = 100
~~~

很多信息已经不可逆地丢失。

因此 Two-step Aggregation 的核心不是：

~~~text
连续调用两个函数
~~~

而是：

> **先把 Raw Values 聚合成可保存、可继续组合的 Intermediate Aggregate State，再在需要展示结果时通过 Accessor 读取 Final Result。**



### 【Final Result 与 Intermediate Aggregate State 解决的是两个不同问题】

普通一次性聚合：

~~~text
Raw Values
        ↓
Aggregate
        ↓
Final Result
~~~

例如：

~~~sql
SELECT avg(value)
FROM performance_samples;
~~~

查询结束以后：

~~~text
AVG Result
=
最终展示值
~~~

通常已经足够。

但进入：

~~~text
Raw
↓
1m CAGG
↓
1h CAGG
↓
1d CAGG
~~~

以后，Lower-level Result 还要成为 Higher-level Input。

这时：

~~~text
Final Result
~~~

和：

~~~text
Reusable Aggregate State
~~~

不能继续混成同一个概念。

Two-step Aggregation 因此建立：

~~~text
Raw Values
        ↓
Aggregate
        ↓
Intermediate Aggregate State
        ↓
Accessor
        ↓
Final Result
~~~

当需要继续向更大范围合并时，中间再增加：

~~~text
Intermediate Aggregate State
        ↓
rollup()
        ↓
Larger Intermediate Aggregate State
~~~

完整模型：

~~~text
Raw Values
        ↓
Aggregate
        ↓
Intermediate Aggregate State
        ↓
rollup()
        ↓
Larger Intermediate Aggregate State
        ↓
Accessor
        ↓
Final Result
~~~



### 【Aggregate、Rollup 与 Accessor 分别承担不同职责】

Three Roles 需要严格区分。

#### <u>1. Aggregate：Raw Values → Intermediate Aggregate State</u>

例如当前项目：

~~~sql
percentile_agg(value)
~~~

把原始 Performance Values 聚合成：

~~~text
Percentile State
~~~

又例如：

~~~sql
hyperloglog(8192, session_id)
~~~

把大量 Session IDs 聚合成：

~~~text
HLL State
~~~

#### <u>2. Rollup：State → Larger State</u>

例如：

~~~sql
rollup(value_percentiles)
~~~

不是直接返回：

~~~text
p75
~~~

而是：

~~~text
多个 Percentile State
        ↓
合并
        ↓
更大范围 Percentile State
~~~

同理：

~~~sql
rollup(session_hll)
~~~

仍然返回可以继续组合的 HLL State。

#### <u>3. Accessor：State → Final Result</u>

例如：

~~~sql
approx_percentile(
  0.75,
  rollup(value_percentiles)
)
~~~

这里：

~~~text
approx_percentile
~~~

才负责把 Percentile State 转换成：

~~~text
p75
~~~

HLL 同理：

~~~sql
distinct_count(
  rollup(session_hll)
)
~~~

最终得到：

~~~text
Approximate Distinct Sessions
~~~

因此固定：

~~~text
Aggregate
≠
Rollup
≠
Accessor
~~~

它们分别解决：

~~~text
Raw → State

State → Larger State

State → Final Result
~~~



### 【当前项目的 Percentile 已经完整实现 Two-step Aggregation】

当前 `0001_platform.sql` 的 1m CAGG：

~~~sql
percentile_agg(value)
AS value_percentiles
~~~

形成：

~~~text
Raw Performance Value
        ↓
percentile_agg
        ↓
1m Percentile State
~~~

随后 `0002_hourly_aggregates.sql`：

~~~sql
rollup(value_percentiles)
AS value_percentiles
~~~

形成：

~~~text
多个 1m Percentile States
        ↓
rollup
        ↓
1h Percentile State
~~~

最终 `analytics.service.ts`：

~~~sql
approx_percentile(
  0.50,
  rollup(value_percentiles)
) AS p50,

approx_percentile(
  0.75,
  rollup(value_percentiles)
) AS p75,

approx_percentile(
  0.90,
  rollup(value_percentiles)
) AS p90,

approx_percentile(
  0.95,
  rollup(value_percentiles)
) AS p95
~~~

所以当前真实链路是：

~~~text
Raw Value
        ↓
percentile_agg
        ↓
1m Percentile State
        ↓
rollup
        ↓
1h / Query-range Percentile State
        ↓
approx_percentile
        ↓
p50 / p75 / p90 / p95
~~~



### 【Accessor 延迟到 Query Time，让一份 State 支持多个最终结果】

如果 1m CAGG 一开始只保存：

~~~text
p75
~~~

那么后面突然需要：

~~~text
p90

p95

p99
~~~

就无法从：

~~~text
p75
~~~

反推出这些结果。

当前项目没有把：

~~~text
p50
p75
p90
p95
~~~

全部预先物化成独立列。

它保存：

~~~text
value_percentiles
=
Reusable Percentile State
~~~

然后在 Query Time：

~~~text
同一 State
├── approx_percentile(0.50)
├── approx_percentile(0.75)
├── approx_percentile(0.90)
└── approx_percentile(0.95)
~~~

因此可以建立：

~~~text
Materialization Time
        ↓
Store Reusable Aggregate State

Query Time
        ↓
Choose Accessor
        ↓
Produce Final Result
~~~

这带来两个直接价值：

~~~text
1. Higher-level CAGG 可以继续 Rollup

2. Final Result 不必在 Materialization Time
   一次性全部决定
~~~

即使 Raw Historical Data 后续已经被 Retention，仍然可以基于保存的 Aggregate State 做允许范围内的 Retrospective Analysis。



### 【Intermediate Aggregate State 是总概念，不只是 Statistical State】

第 7 节曾用：

~~~text
Intermediate Statistical State
~~~

描述 Percentile / HLL。

进入 Two-step Aggregation 后，总称应该统一为：

~~~text
Intermediate Aggregate State
        ↓
聚合中间状态
~~~

原因是 Two-step Pattern 并不只服务：

~~~text
统计分布
~~~

它还可以承载：

~~~text
Percentile Sketch

HyperLogLog State

Statistical Summary

Counter / Gauge Summary

Time-weighted State

...
~~~

所以：

~~~text
Intermediate Aggregate State
=
总概念

Statistical State
=
其中一类
~~~

当前 Browser Monitor 实际使用：

~~~text
Percentile State

HLL State
~~~

本节只围绕真实源码展开，不扩展成完整 Hyperfunctions API 列表。



### 【HLL 是当前项目第二条完整 Two-step 链】

当前 1m CAGG：

~~~sql
hyperloglog(8192, session_id)
AS session_hll
~~~

不是保存：

~~~text
Distinct Sessions = 100
~~~

而是保存：

~~~text
HLL State
~~~

1h CAGG：

~~~sql
rollup(session_hll)
~~~

继续合并 State。

最终 Query：

~~~sql
distinct_count(
  rollup(session_hll)
)
~~~

才得到：

~~~text
Approximate Distinct Sessions
~~~

完整链：

~~~text
session_id
        ↓
hyperloglog
        ↓
1m HLL State
        ↓
rollup
        ↓
Larger HLL State
        ↓
distinct_count
        ↓
Approximate Distinct Sessions
~~~

#### <u>1. 为什么不能 sum(distinct_count)</u>

假设：

~~~text
Minute A
Distinct Sessions = 100

Minute B
Distinct Sessions = 100
~~~

不能推出：

~~~text
两分钟
Distinct Sessions = 200
~~~

因为同一个 Session 可能同时出现在：

~~~text
Minute A

和

Minute B
~~~

如果直接：

~~~text
100 + 100
~~~

会重复计数。

因此：

~~~text
Final Distinct Count
不能直接 Rollup

HLL State
可以继续 Merge
~~~

这与 Percentile 是同一个结构性问题：

~~~text
Percentile
        ↓
Final Quantile 不具备足够信息继续组合

Distinct Count
        ↓
Final Count 不具备集合重叠信息继续组合
~~~

解决方式都是：

~~~text
Preserve Intermediate Aggregate State
~~~



### 【Two-step Aggregation 解决可组合性，不代表结果一定 Exact】

这里需要建立非常重要的边界：

~~~text
Two-step Aggregation
        ↓
解决：
State 能不能继续组合

不代表：
Final Result 一定等价于 Raw Data Exact Recompute
~~~

当前项目可以分成三类。

#### <u>1. Count / Min / Max 属于可直接组合的精确聚合</u>

~~~text
sum(count)

min(min)

max(max)
~~~

不会因为 Hierarchical Rollup 本身引入 Sketch Approximation。

#### <u>2. Average 使用 Weighted State 思路，而不是 avg(avg)</u>

当前项目：

~~~sql
sum(average * sample_count)
/
NULLIF(sum(sample_count), 0)
~~~

逻辑上是在恢复：

~~~text
总和
/
总数量
~~~

而不是：

~~~text
Average of Averages
~~~

因此它解决的是不同 Bucket 样本数量不同造成的数学错误。

需要注意：当前字段和计算仍使用浮点数，所以数据库数值表示本身可能存在 Floating-point Rounding；这与 UddSketch / HLL 的算法近似不是同一种问题。

#### <u>3. UddSketch / HLL 本身属于 Approximate Data Structure</u>

~~~text
percentile_agg
        ↓
UddSketch-style Percentile State
        ↓
Approximate Percentile

hyperloglog
        ↓
HLL State
        ↓
Approximate Distinct Count
~~~

因此：

~~~text
rollup()
~~~

能保证：

~~~text
Approximate State
仍然可以继续组合
~~~

但不能理解成：

~~~text
Rollup
=
重新恢复 Raw Data
=
100% Exact
~~~

所以要区分：

~~~text
Composability

和

Accuracy Model
~~~

它们是两个维度。



### 【Two-step Aggregation 与 PostgreSQL Aggregate Internal State 有联系，但不是同一个抽象层】

普通 PostgreSQL Aggregate 在执行过程中本来就需要维护内部状态。

例如 AVG 从概念上需要：

~~~text
sum
+
count
~~~

最后才得到：

~~~text
sum / count
~~~

可以抽象：

~~~text
Raw Rows
        ↓
Transition / Internal State
        ↓
Final Function
        ↓
Final Result
~~~

Two-step Aggregation 与这个思想存在直接联系：

~~~text
PostgreSQL Aggregate
内部已经存在
State → Final Result

        ↓

Toolkit Two-step Aggregation
把可复用 Aggregate State
显式暴露为用户可以保存和组合的数据
~~~

于是 State 可以：

~~~text
存入 Continuous Aggregate

继续 rollup()

延迟执行 Accessor
~~~

但两者不能直接画等号：

~~~text
PostgreSQL Internal Aggregate State
=
数据库 Aggregate 执行机制中的内部状态

Toolkit Intermediate Aggregate State
=
面向用户可保存、可组合、可查询的聚合结果类型
~~~

它们共享：

~~~text
State
→
Final Result
~~~

这一思想，但处在不同抽象层。



### 【第八节收束为一个可复用的 Two-step Pattern】

最终可以把当前项目压缩成：

~~~text
Raw Data
        ↓
Aggregate
        ↓
Intermediate Aggregate State
        ↓
┌──────────────────────┐
│                      │
▼                      ▼
rollup()             Accessor
│                      │
▼                      ▼
Larger State        Final Result
│
└────── 可以继续进入更高层 CAGG
~~~

当前项目：

~~~text
Percentile
│
├── percentile_agg
├── rollup
└── approx_percentile

Distinct Count
│
├── hyperloglog
├── rollup
└── distinct_count
~~~

因此：

> **Two-step Aggregation 的核心不是“调用两个函数”，而是把 Final Result 之前的 Aggregate State 变成可以持久化、继续 Rollup 和延迟读取的正式数据层。**

它正好承接上一节：

~~~text
Hierarchical CAGG
        ↓
需要 Aggregate State 可组合
        ↓
Two-step Aggregation
        ↓
保存 Intermediate Aggregate State
        ↓
Rollup
        ↓
Accessor
        ↓
Final Result
~~~

下一阶段如果继续深入 Hyperfunctions，再分别进入：

~~~text
Percentile Sketch

HyperLogLog

Stats Aggregate

Counter / Gauge

Time-weighted Average
~~~

当前阶段不展开成 Hyperfunctions API 大全。



## 8. 物化水位、Invalidation 与实时聚合共同维护统计结果

### 【原始讨论问题】

> 什么时候水位推进？什么时候判断当前的物化水位可以推进？对于物化以后的历史区间，直接读取物化的统计结果。那对于新近历史数据，还会进行处理吗？如果要处理，应该怎么处理？对于未物化的数据，直接读取原始数据，去统计它的聚合数据。

**讨论重点：理解三个对象的边界，而不是只记“实时聚合=两部分结果相加”**：

1. Materialization Watermark：实时聚合查询以哪个时间点分开物化历史与未物化近期数据。
2. Refresh Policy / Materialization：后台什么时候真正把时间桶统计写进物化存储。
3. Invalidation：已物化时间范围内的原始事件发生变化后，怎样通知刷新机制重新计算历史桶。

### 【首先区分：数据已入库，不等于统计已物化】

假设当前 10:05:25，物化水位为 10:04:00，聚合粒度为一分钟：

| 事件发生时间所在桶 | 当前状态 | 实时聚合 SELECT 的数据来源 |
| --- | --- | --- |
| [10:02, 10:03) | 已物化 | 已保存的聚合结果 |
| [10:03, 10:04) | 已物化 | 已保存的聚合结果 |
| [10:04, 10:05) | 尚未物化，但原始事件已写入 | 临时读取原始事件进行 GROUP BY |
| [10:05, 10:06) | 当前未完成的桶 | 临时按已收到的原始事件聚合；查询值可能继续变化 |

**“未物化”只意味着该桶结果尚未由刷新操作保存**，不是原始事件未入库。

### 【水位推进：依据已经完成的刷新范围，而不是判断数据未来不再变化】

TimescaleDB 的物化水位表示已物化历史与实时查询所读的最新原始数据之间的边界。它与后台物化刷新的进度有关，而不是按照墙上时钟每隔 10 秒机械自增。

仍以当前时刻 10:05:25、end_offset=10 seconds 举例：

~~~text
刷新最近端：10:05:25 - 10s = 10:05:15

一分钟的完整桶：
[10:03,10:04) 完整
[10:04,10:05) 完整
[10:05,10:06) 尚不完整，不能在本轮作为完整桶物化
~~~

如果系统以前物化到 10:04，本次成功刷新新增的完整 [10:04,10:05) 桶，已物化范围向前延展，水位就可能推进到 10:05。

这里并非判断“以后永远不会再来发生在 10:04 的事件”。系统只判断**本次刷新范围内的完整时间桶可被物化**，然后执行计算、保存；晚到历史变化可以在后续刷新中重算。

须区分：
- **schedule_interval 到点**：触发运行尝试，不能直接断言完成刷新。
- **时间桶完整处于可刷新区间**：使该桶具备参与本轮物化的时间条件，但不是水位已经改变的证明。
- **刷新操作实际完成并延展已物化范围**：才构成水位推进的基础。
- **已物化旧桶重新刷新**：数据被更新，但物化水位不一定变化，因为没有扩展历史的最近边界。

TimescaleDB 内部还会使用与变更追踪相关的 materialization/invalidation threshold。讨论时应区分**面向实时查询的 watermark**与**面向失效日志的 threshold**，虽然二者都与物化边界有关，但不能未经版本与具体机制核对就宣称是同一个数据库字段。

### 【状态 A：水位之后的新数据如何被查询与后续物化】

例如水位 10:04，一条发生时间 10:04:30 的事件写入原始表：

~~~text
INSERT 原始事件
  ↓ occurred_at 属于 [10:04,10:05)
目前尚未物化
  ├─ 用户现在 SELECT 实时聚合
  │     └─ 查原始表并临时 GROUP BY，不写入物化结果
  └─ 后台刷新覆盖这一个完整时间桶
        └─ 计算并保存物化结果，可能推进水位
~~~

**实时聚合的临时计算，不会自行推进物化水位**。只有实际执行刷新并完成物化，才会改变已物化范围。

### 【状态 B：已经物化的旧时间桶，又有新事件写入怎么办】

例如水位已到 10:04，10:02 时间桶物化值为 100，后来收到一条发生在 10:02:30 的事件。

~~~text
已物化：10:02 → event_count=100
        ↓
原始表新增 occurred_at=10:02:30
        ↓
标记已物化区域发生变化（Invalidation）
        ↓
后续 Refresh 覆盖该桶所在窗口
        ↓
重新读取该时间桶相关原始数据进行聚合
        ↓
更新保存的结果：10:02 → 101
~~~

此时只是**刷新历史统计**，并没有必然将物化水位从 10:04 推进到 10:05。

因此用户所说“物化以后的历史区间直接读取物化结果”要加上重要前提：**已物化历史发生修改后，在对应桶重新刷新之前，读取的结果可能暂时滞后**。

启用 Real-Time Aggregate 也不会自动让水位之前的历史修改立即在查询中体现。若修改的时间位于自动刷新策略窗口之外，需要额外安排手动刷新或历史补算。

### 【状态 C：已物化历史未发生变化时】

不需要每次查图表都重新聚合所有历史事件。读取已经保存的时间窗口结果即可。这是 Continuous Aggregate 降低历史重复计算的主要收益。

### 【把后台维护和前台查询严格分成两条链】

~~~text
后台维护链（有持久化写入）：
原始事件写入
  ↓
新近完整时间桶进入刷新范围 → 首次物化 → 水位可推进
已物化历史桶发生变化 → Invalidation → 历史重新刷新
  ↓
保存或更新物化统计结果

查询链（不必更新物化存储）：
SELECT Continuous Aggregate（materialized_only=false）
  ├─ 水位之前：读取已经物化的统计结果
  └─ 水位之后：查询时从原始数据临时聚合
           ↓
将两段查询结果统一呈现
~~~

**一句话结论**：水位决定“实时查询中物化数据和近期原始数据的分界”；刷新负责“持久化或更新统计结果”；Invalidation 负责“让已物化历史的变化在后续刷新中得到处理”。

### 【对照原始事件项目配置并记录待验证边界】

`telemetry_rollup_1m` 是由 `telemetry_events` 的 `occurred_at` 构建的一分钟连续聚合，项目迁移中的配置是：

~~~sql
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);

ALTER MATERIALIZED VIEW telemetry_rollup_1m
SET (timescaledb.materialized_only = false);
~~~

第一个配置控制后台刷新窗口与调度频率，第二个配置控制 SELECT 是否纳入未物化原始数据；不能把它们误解为相同功能。

目前仅核对代码配置，没有读取运行中数据库的物化水位、Job 执行历史和真实统计结果，因此**不能确认水位实际推进到了哪里、历史刷新是否发生或真实实时查询是否存在延迟**。

### 【延伸问题留到下一轮，不直接进入压缩与 Retention】

下一步如果继续深入 Continuous Aggregate 内部机制，应该先讨论：**Invalidation 如何把原始数据变化的最小/最大时间范围转换成需要刷新的一组完整时间桶？为什么刷新不是在每次 INSERT 时简单执行 COUNT + 1？**

这属于当前连续聚合主题内部的进阶讨论。完成其边界与刷新代价后，再进入历史数据压缩机制；然后研究 Retention；最后再讨论乱序迟到数据对整条链路的影响。

官方参考：[连续聚合物化引擎与失效追踪](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)、[物化水位与历史修改限制](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/troubleshooting/)、[实时聚合](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/)、[连续聚合刷新策略](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/refresh-policies/)。




### 【跨层物化边界的实践提醒】

当 1h Continuous Aggregate 的来源是 1m 连续聚合时，水位和 Refresh Policy 分属不同层；需要分别检查上游物化完成度与下游刷新覆盖的时间范围。对 1m 的历史写入并不意味着 1h 查询必然同步变更，应按实际刷新调度和版本行为验证。



## 9. Compression 将历史 Chunk 转换为压缩存储

### 【压缩仍然保存事实，Retention 才移除过期历史】

当前原始事件迁移里存在两项策略：

~~~sql
SELECT add_compression_policy(
  'telemetry_events',
  INTERVAL '24 hours',
  if_not_exists => TRUE
);

SELECT add_retention_policy(
  'telemetry_events',
  INTERVAL '30 days',
  if_not_exists => TRUE
);
~~~

**Compression（压缩）**：较旧的 Chunk 符合策略条件时，后台任务可以将其转换成更紧凑的存储布局；其目的不是删除记录。

**Retention（保留策略）**：当完整旧 Chunk 的时间范围超出保留窗口后，将其清理以控制长期历史明细量；不是为每条 Row 设置精确到秒的 TTL。

~~~text
近期 Chunk：写入与常见明细查询
        ↓ 随时间推移
旧 Chunk：满足压缩条件 → 仍保留，降低存储成本
        ↓ 达到保留清理窗口
过期 Chunk：后台按块移除，不再保留原始明细
~~~

24 小时压缩阈值、30 天保留期是**当前迁移配置**。并非每条事件恰好到 24 小时就压缩、30 天零秒就删除：具体动作受到 Chunk 时间边界和后台任务执行计划影响。当前项目还保留更长期的聚合数据，但不等于旧原始事件自动被“搬运”成统计行。

数据压缩可能改变查询及迟到写入的执行代价；Retention 也会影响能够追溯的历史范围。这些将在后续轮次深入，而非在本轮只罗列几个 API。





### 【问题背景：持续写入的行式记录为什么值得重新组织】

假设系统每秒保存设备测量或浏览器事件，每条数据都有发生时间、所属设备/项目、事件类型和具体值。随着时间累积，历史数据数量不断增长；近期数据主要用于频繁写入和查单次事件，而历史数据经常按时间范围查询趋势。

普通 PostgreSQL 行式存储可以理解为一条记录把多个字段放在一起：

~~~text
Row 1：[10:00:01, device=A, type=cpu, value=60]
Row 2：[10:00:02, device=A, type=cpu, value=61]
Row 3：[10:00:03, device=A, type=cpu, value=62]
Row 4：[10:00:04, device=A, type=cpu, value=63]
~~~

这有利于插入和获取单条完整记录，但历史数据中 device、type 等维度反复出现；查询平均值时往往只需要特定列。因此引出**将较旧 Chunk 的行数据重新组织为按列存放的压缩批次**这一存储策略。

### 【行式与压缩列式布局：不是把原始事件聚合掉】

传统 TimescaleDB 压缩可将同组中多条行记录重新组织为更少的列式批次。抽象示意：

~~~text
压缩前（行）：
[10:00:01, A, cpu, 60]
[10:00:02, A, cpu, 61]
[10:00:03, A, cpu, 62]
[10:00:04, A, cpu, 63]

压缩后（列式批次，非物理源码精确格式）：
device_id = A
type = cpu
time = [10:00:01, 10:00:02, 10:00:03, 10:00:04]
value = [60, 61, 62, 63]
~~~

关键收益可能包括：减少重复维度、对邻近时间/数值使用适合列数据的压缩编码、历史分析查询可以避免读取不需要的部分数据。但并非所有 SQL 都更快，依赖 event_id 查某条完整 JSONB 与按项目、类型、时间做范围分析的访问模式不同。

**Compression 不等于 Continuous Aggregate。** 压缩以不同物理布局保存原始记录的可查询信息；连续聚合单独保存某一分钟事件 COUNT 等汇总结果，后者本身不能还原每条原始事件。

### 【segmentby 决定压缩批次如何按业务维度分组】

示例：

~~~sql
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'time DESC'
);
~~~

\`segmentby\` 指定共同形成压缩批次的业务维度。按 device_id 分组后，设备 A 的记录不会随意与设备 B 记录混到同一组批次。适合与常用查询的过滤字段协调；但若所选维度基数太高、每组数据量很小，可能导致批次数过多、压缩效率下降。

**segmentby 不会额外创建一组 Hypertable 时间分区**；它属于既有 Chunk 内部压缩布局的组织规则。

### 【orderby 决定压缩批次内的排列与时间范围定位】

\`orderby = 'time DESC'\` 使同组数据按时间排序。时序数据的相邻时间值常有规律，适合进行时间相关的压缩编码；排序列的辅助范围信息还有助于在查询时间窗口时跳过无关压缩批次。

\`orderby\` 并不是保证 \`SELECT\` 返回顺序的 SQL ORDER BY，应用如果要求稳定输出顺序，仍应在查询中显式 ORDER BY。

### 【当前原始事件的真实压缩配置】

browser-monitor 中，浏览器 SDK 产生的访问、性能、异常、自定义业务事件经服务端验证、脱敏并去重后进入 \`telemetry_events\`。主要公共字段有：
- \`project_id\`：网站/应用所属项目；
- \`type\`：事件类型；
- \`occurred_at\`：事件实际发生时间，也是 Hypertable 时间分区列；
- \`event\`：安全处理后的完整遥测 JSONB。

项目实际迁移：

~~~sql
ALTER TABLE telemetry_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,type',
  timescaledb.compress_orderby = 'occurred_at DESC'
);
~~~

含义：
1. 为该 Hypertable 配置传统压缩能力，并不立即压缩全部历史数据。
2. 在每个待压缩 Chunk 内，将同项目和事件类型的数据组织为压缩批次，有利于常见“项目 + 类型 + 时间”查询；如果组合维度过于稀疏则不一定最佳。
3. 按发生时间倒序组织批次内容，支持时间范围检索与时间序列压缩。

源码：[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)。

### 【什么时候真正压缩：Compression Policy 的年龄是 Chunk 级阈值】

项目另有：

~~~sql
SELECT add_compression_policy(
  'telemetry_events',
  INTERVAL '24 hours',
  if_not_exists => TRUE
);
~~~

这里的阈值不是每条事件自发生/入库 24 小时后分别压缩。在当前传统策略机制中，需要**整个 Chunk 的时间范围已足够旧**，再由后台任务判断是否执行压缩。

假设一个 Chunk 覆盖 10 月 1 日至 10 月 8 日零时；10 月 1 日的事件不会在 10 月 2 日就被这一策略单独压缩。该 Chunk 的结束时间满足“早于当前 24 小时”后，下一次符合条件的后台任务才可能执行压缩。

因此 \`Chunk Interval\` 与 \`compress_after\` 有联系：Chunk 时间跨度越长，最早进入 Chunk 的记录距离实际压缩可能越久。本项目在建表迁移中没有显式指定 Chunk Interval，**不能仅凭 24 小时阈值得到真实压缩日期**。

### 【压缩后的读取机制与 B-Tree 的边界】

查询仍使用原来的逻辑表名：

~~~sql
SELECT event_id, occurred_at, type, event
FROM telemetry_events
WHERE project_id = $1
  AND type = $2
  AND occurred_at >= $3
  AND occurred_at < $4;
~~~

数据库可针对已压缩 Chunk 选择对应的压缩数据查询路径。传统压缩的批次存储与普通行式 Chunk 上的 B-Tree 访问方式不同；可利用 segmentby、orderby 及压缩数据元信息减少不必要的批次扫描和解压。

**不能声称配置 segmentby/排序以后，所有点查、任意 JSONB 属性查找都比未压缩快**。性能仍应通过真实数据、执行计划、查询延迟和压缩率验证。项目这里采用传统 \`timescaledb.compress\` / \`compress_segmentby\` / \`compress_orderby\` API，新版本 Hypercore/Columnstore API 在存储和 DML 行为上有所发展，应针对部署版本区分。

### 【如何验证真实压缩效果，而不是只读 Migration】

可以查询实际 Chunk 与压缩统计。下列 SQL 仅为运行实例检查方法，并未在当前项目数据库运行：

~~~sql
-- 先看哪些 Chunk 已经压缩，以及对应时间范围
SELECT chunk_name, range_start, range_end, is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'telemetry_events'
ORDER BY range_start DESC;

-- 传统压缩 API：比较压缩前/后大小
SELECT
  number_compressed_chunks,
  pg_size_pretty(before_compression_total_bytes) AS before_size,
  pg_size_pretty(after_compression_total_bytes) AS after_size
FROM hypertable_compression_stats('telemetry_events');
~~~

需核对实际 TimescaleDB 版本、权限和统计口径；除了压缩空间占用变化，还应比较常用原始事件时间查询的延迟与执行计划。

### 【本轮结论与后续问题的依赖关系】

~~~text
近期事件持续写入 → 行式 Chunk
          ↓
Chunk 逐渐成为历史数据
          ↓
压缩策略按 Chunk 的时间边界判断候选
          ↓
按 segmentby 组织、按 orderby 排列
          ↓
压缩列式批次
          ↓
保留原始事件的可查询信息，同时降低历史存储成本
~~~

**压缩是旧 Chunk 的存储布局转换，不是统计汇总，也不是数据删除。** 后续需要继续讨论 Retention：既然历史数据可能已经压缩，为何数据库还能在保留窗口到期时以 Chunk 为单位删除，而不执行逐行 DELETE？

官方参考：[TimescaleDB Compression](https://docs.timescale.com/use-timescale/latest/compression/about-compression/)、[选择 segmentby 和 orderby](https://docs.timescale.com/use-timescale/latest/compression/about-compression/#configure-time-series-compression)、[压缩策略](https://docs.timescale.com/use-timescale/latest/compression/compression-policy/)。




### 【Hypercore、Rowstore 与 Columnstore：现代体系和项目旧 Compression API 的映射】



前四节已经建立了两条主线：

~~~text
TimescaleDB
│
├── Data Organization
│   ├── Hypertable
│   └── Chunk
│
└── Query & Analytics
    ├── Time Range Query
    ├── time_bucket
    └── Continuous Aggregate
~~~

但目前还有一个问题没有解决：

> **一份时序数据写入以后，会长期以完全相同的物理形式存在吗？**

答案是否定的。

时序数据最大的特点之一就是：

~~~text
数据年龄不断变化
        ↓
访问模式也不断变化
~~~

例如监控数据：

~~~text
刚产生
    ↓
频繁 INSERT
可能 UPDATE
可能迟到
可能需要立即查看

1 天以后
    ↓
基本稳定
查询以扫描和统计为主

30 天以后
    ↓
单条 Raw Row 价值进一步降低

180 天以后
    ↓
可能只保留 Aggregate
或者直接删除
~~~

因此 TimescaleDB 不只是：

~~~text
把数据分 Chunk
+
加速 Query
~~~

还建立了另一条完整体系：

~~~text
Time-Series Data Lifecycle
│
├── Recent Data
│      ↓
│   Rowstore
│
├── Historical Data
│      ↓
│   Columnstore
│
├── Long-term Analytics
│      ↓
│   Continuous Aggregate / Rollup
│
└── Expired Data
       ↓
    Retention
~~~

TimescaleDB 当前把这套混合 Row / Column 存储体系称为 Hypercore。新数据优先进入适合快速写入和更新的 Rowstore，数据变冷以后可以转换到 Columnstore，从而降低存储量并提高历史分析扫描效率。



### 【Rowstore 与 Columnstore 解决的是两种不同的数据访问模式】

理解 Hypercore 之前，必须先理解为什么数据库会同时需要：

~~~text
Row-oriented Storage
+
Column-oriented Storage
~~~

它们不是：

~~~text
新存储
vs
旧存储
~~~

而是针对不同 Workload 的两种物理组织方式。

#### <u>1. Rowstore 按一整行数据组织，天然适合实时写入和单条修改</u>

假设 performance_samples 有：

~~~text
observed_at
project_id
name
value
route_name
session_id
view_id
environment
~~~

Rowstore 可以直观理解成：

~~~text
Row 1
┌──────────┬─────────┬─────┬───────┬──────────┐
│ 10:00:01 │ P001    │ LCP │ 2100  │ /home    │ ...
└──────────┴─────────┴─────┴───────┴──────────┘

Row 2
┌──────────┬─────────┬─────┬───────┬──────────┐
│ 10:00:02 │ P001    │ LCP │ 2300  │ /detail  │ ...
└──────────┴─────────┴─────┴───────┴──────────┘

Row 3
...
~~~

同一条记录的字段放在一起。

所以当系统收到：

~~~sql
INSERT INTO performance_samples (...)
VALUES (...);
~~~

数据库写入的是一整条新 Row。

如果：

~~~sql
UPDATE performance_samples
SET state = 'final'
WHERE ...
~~~

也是定位某一条 Row 后修改。

因此 Rowstore 特别适合：

~~~text
INSERT

UPDATE

DELETE

UPSERT

Point Lookup

Recent Data Access
~~~

这正符合刚产生的时序数据特点。

#### <u>2. 当前项目的 Recent Performance Data 就具有明显 Row-oriented Workload</u>

当前 performance_samples 并不是绝对不可修改的数据。

它存在：

~~~text
sequence

state = provisional / final

last_updated_at
~~~

意味着最近的数据可能经历：

~~~text
第一次 Sample
    ↓
sequence = 0

后续修订
    ↓
sequence = 1

最终确认
    ↓
state = final
~~~

因此最近数据不是：

~~~text
写入以后永久不变
~~~

而是：

~~~text
High Write
+
Possible Update
+
Low-latency Read
~~~

Rowstore 非常适合这个阶段。

#### <u>3. Columnstore 按列组织，更适合扫描大量历史数据</u>

再看一个 Analytics Query：

~~~sql
SELECT
  avg(value)
FROM performance_samples
WHERE
  observed_at >= ...
  AND observed_at < ...
~~~

真正主要需要的是：

~~~text
observed_at

value
~~~

但一条 Raw Row 还有：

~~~text
session_id
view_id
route_name
environment
app_version
detail
...
~~~

如果数据按 Row 存储，扫描大量 Row 时会持续面对完整记录。

Columnstore 则可以近似理解：

~~~text
observed_at column
────────────────────────
10:00:01
10:00:02
10:00:03
10:00:04
...


value column
────────────────────────
2100
2300
1800
2500
...


project_id column
────────────────────────
P001
P001
P001
P002
...


name column
────────────────────────
LCP
LCP
INP
LCP
...
~~~

查询 AVG(value) 时，更容易围绕需要的 Column 做扫描。

所以：

~~~text
Rowstore
    ↓
以 Row 为主要访问单位

Columnstore
    ↓
以 Column 为主要分析单位
~~~

#### <u>4. Columnstore 为什么通常还会获得更高压缩率</u>

因为同一列的数据通常具有：

~~~text
相同 Data Type

相似 Value Distribution

大量重复值
~~~

例如：

~~~text
project_id

P001
P001
P001
P001
P001
...
~~~

或者：

~~~text
name

LCP
LCP
LCP
LCP
...
~~~

把同类值放在一起以后，更适合做编码和压缩。

因此 Columnstore 同时服务：

~~~text
Analytical Scan
+
Compression
~~~

而不是只解决磁盘空间。

#### <u>5. Rowstore 与 Columnstore 的核心不是性能高低，而是 Workload 不同</u>

不要理解成：

~~~text
Columnstore
>
Rowstore
~~~

更准确：

| Workload | Rowstore | Columnstore |
|---|---:|---:|
| 高频 INSERT | 更适合 | 不是主要优势 |
| 高频 UPDATE | 更适合 | 可支持，但不是传统优势 |
| 单 Row Lookup | 更自然 | 不一定占优 |
| 扫描大量历史数据 | 成本更高 | 更适合 |
| 聚合大量 Column | 一般 | 更适合 |
| Compression | 通常较低 | 通常更高 |

因此核心矛盾是：

~~~text
Real-time Write
        ↓
Rowstore 更合适

Historical Analytics
        ↓
Columnstore 更合适
~~~

TimescaleDB 要解决的是：

> **同一份 Time-Series Data 既需要实时写入，又需要长期分析，为什么一定要二选一？**

这就是 Hypercore 的入口。



### 【Hypercore 让同一个 Hypertable 的不同 Chunk 使用不同存储形态】

第二节已经知道：

~~~text
Hypertable
    ↓
Chunk A
Chunk B
Chunk C
...
~~~

例如教学示例：

~~~text
performance_samples
│
├── Chunk A
│   10/01
│
├── Chunk B
│   10/02
│
├── Chunk C
│   10/03
│
└── Chunk D
    10/04
~~~

Hypercore 的关键不是：

~~~text
把整张 Hypertable
统一改成 Columnstore
~~~

而是利用 Chunk：

~~~text
不同年龄的数据
可以处于不同物理存储阶段
~~~

#### <u>1. Recent Chunk 保持 Rowstore</u>

假设现在是 10/04。

当前活跃 Chunk：

~~~text
Chunk D
~~~

仍然不断收到：

~~~text
INSERT

UPDATE

late-arriving data
~~~

那么：

~~~text
Chunk D
    ↓
Rowstore
~~~

有利于：

~~~text
快速写入

最近数据更新

最新数据查询
~~~

#### <u>2. Historical Chunk 可以转入 Columnstore</u>

随着时间继续，10/01 的数据基本稳定：

~~~text
几乎没有 INSERT

很少 UPDATE

主要 Query：
过去 7 天
过去 30 天
趋势
平均
p75
COUNT
~~~

于是：

~~~text
Chunk A
    ↓
Columnstore
~~~

就更合理。

所以同一张 performance_samples 可以出现：

~~~text
performance_samples
Hypertable
│
├── Chunk A
│      ↓
│   Columnstore
│
├── Chunk B
│      ↓
│   Columnstore
│
├── Chunk C
│      ↓
│   Columnstore
│
└── Chunk D
       ↓
    Rowstore
~~~

注意：

> **不是 Rowstore Table 和 Columnstore Table 两套业务表。**

应用仍然：

~~~sql
SELECT *
FROM performance_samples;
~~~

TimescaleDB 自己处理不同 Chunk 的底层存储格式。

#### <u>3. Hypercore 的核心单位再次回到了 Chunk</u>

这说明第二节学习 Chunk 时不能只理解成：

~~~text
为了 Chunk Pruning
~~~

Chunk 至少承担三类角色：

~~~text
Chunk
│
├── Partition Unit
│      ↓
│   按时间拆分数据
│
├── Query Unit
│      ↓
│   Chunk Pruning
│
└── Lifecycle Unit
       ↓
    Rowstore
    Columnstore
    Retention
~~~

这就把 Hypertable 和 Data Lifecycle 连接起来了。

#### <u>4. 数据转入 Columnstore 后，应用 SQL 语义仍然保持 PostgreSQL 模型</u>

Hypercore 改变的是：

~~~text
Physical Storage Layout
~~~

而不是：

~~~text
应用数据模型
~~~

也不是：

~~~text
SQL 语言
~~~

可以理解：

~~~text
Application
    ↓
Same PostgreSQL SQL
    ↓
Hypertable
    ↓
TimescaleDB
    ↓
根据 Chunk Storage Format
选择对应执行路径
~~~



### 【Columnstore 不只是压缩，还重新组织数据以服务历史分析】

这里需要纠正一个容易形成的旧概念：

~~~text
Compression
=
单纯把文件压小
~~~

在 TimescaleDB 体系中，更准确的是：

~~~text
Historical Chunk
    ↓
Columnization
    ↓
Columnar Organization
    +
Compression
    ↓
Analytical Storage
~~~

因此 Columnstore 同时解决：

~~~text
Storage Cost
+
Analytical Query Performance
~~~

而不是只有磁盘压缩。

#### <u>1. Columnstore 内部还需要按照 Query Pattern 组织数据</u>

Columnstore 并不是简单：

~~~text
一列数据
全部堆成一个巨大数组
~~~

还需要继续回答：

~~~text
哪些数据应该放在一起？

放在一起以后
应该按照什么顺序排列？
~~~

TimescaleDB 中很重要的两个概念是：

~~~text
SEGMENTBY

ORDERBY
~~~

它们决定 Columnstore 内部如何组织数据。

#### <u>2. SEGMENTBY 决定哪些业务实体的数据应该放在一起</u>

假设有大量 Performance Samples：

~~~text
Project P001
Project P002
Project P003

LCP
INP
CLS
~~~

而最常见 Query 是：

~~~sql
WHERE
  project_id = 'P001'
  AND name = 'LCP'
~~~

那么可以让：

~~~text
project_id
+
name
~~~

成为 Segment Key。

物理组织可以近似理解：

~~~text
Segment A

project_id = P001
name = LCP

    ↓

这一组 Performance Data


Segment B

project_id = P001
name = INP


Segment C

project_id = P002
name = LCP
~~~

这样查询：

~~~text
P001 + LCP
~~~

时，更容易排除其他 Segment。

所以：

~~~text
SEGMENTBY
    ↓
回答：
哪些数据应该被组织在一起？
~~~

#### <u>3. ORDERBY 决定 Segment 内的数据怎样排列</u>

例如：

~~~text
project_id = P001
name = LCP
~~~

这个 Segment 内可能有：

~~~text
10:00
10:01
10:02
...
~~~

时序查询最常见：

~~~text
WHERE observed_at BETWEEN T1 AND T2
~~~

因此可以：

~~~text
ORDERBY observed_at DESC
~~~

近似形成：

~~~text
Segment:
P001 + LCP

observed_at

10:30
10:29
10:28
10:27
...
~~~

所以：

~~~text
SEGMENTBY
    ↓
哪些数据放在一起

ORDERBY
    ↓
放在一起以后怎样排列
~~~

二者不能混为一谈。

#### <u>4. Columnstore Query 并不是先解压全部数据再执行普通扫描</u>

现代 Hypercore 的分析路径还会利用：

~~~text
Chunk Pruning

Segment / Batch Filtering

Column Selection

Metadata

Vectorized Execution
~~~

例如：

~~~sql
SELECT avg(value)
FROM metrics
WHERE
  project_id = 'P001'
  AND time BETWEEN T1 AND T2;
~~~

可以逐步缩小：

~~~text
所有 Chunks
    ↓
只留下时间相关 Chunks
    ↓
只留下 project=P001 的相关 Segment / Batch
    ↓
只读取 time / value 等需要的 Column
    ↓
执行 Aggregate
~~~

本节只需要建立一个核心认识：

> **Columnstore 不只是压缩，而是在历史数据阶段重新组织物理布局，使扫描、聚合和存储成本同时受益。**

更深入的 Batch Metadata、Chunk Skipping、Vectorized Execution 后续再放到 Query Engine & Performance 专题。



### 【当前项目旧 Compression API 与现行 Hypercore / Columnstore 属于同一能力的版本演进】

现在回到 Browser Monitor。

当前 0001_platform.sql：

~~~sql
ALTER TABLE performance_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby =
    'project_id,name',
  timescaledb.compress_orderby =
    'observed_at DESC'
);
~~~

然后：

~~~sql
SELECT add_compression_policy(
  'performance_samples',
  INTERVAL '24 hours',
  if_not_exists => TRUE
);
~~~

其他表也是类似：

~~~text
telemetry_events

segmentby:
project_id,type

orderby:
occurred_at DESC
~~~

以及：

~~~text
view_records

segmentby:
project_id

orderby:
started_at DESC
~~~

#### <u>1. 当前项目源码使用的是旧 Compression API</u>

这一点必须明确：

~~~text
当前 Browser Monitor

timescaledb.compress

compress_segmentby

compress_orderby

add_compression_policy
~~~

这是当前源码事实。

不能为了匹配最新文档，直接把源码解释成：

~~~text
已经使用
enable_columnstore
~~~

因为当前仓库并没有这样写。

#### <u>2. 当前 TimescaleDB 官方主线已经转向 Hypercore / Columnstore API</u>

现行官方体系更强调：

~~~text
Hypercore

Rowstore

Columnstore

enable_columnstore

segmentby

orderby

add_columnstore_policy
~~~

所以需要建立：

~~~text
Concept
    ↓
Historical Data
→ Columnar Organization
→ Compression
→ Analytical Scan

Current API Direction
    ↓
Hypercore / Columnstore

Current Project Source
    ↓
Legacy Compression API
~~~

这样知识体系不会被当前仓库中的旧 API 绑死。

#### <u>3. 当前项目的 segmentby 已经直接反映真实 Query Pattern</u>

当前：

~~~text
compress_segmentby
=
project_id,name
~~~

为什么是：

~~~text
project_id
+
name
~~~

而不是：

~~~text
session_id
+
value
~~~

因为 Performance Analytics 最常见的访问模型是：

~~~text
一个 Project

某个 Metric

一段 Time Range
~~~

也就是：

~~~text
Project
+
Metric
+
Time
~~~

因此：

~~~text
SEGMENTBY
=
project_id,name
~~~

让相同：

~~~text
Project + Metric
~~~

的数据尽量聚集。

然后：

~~~text
ORDERBY
=
observed_at DESC
~~~

让 Segment 内继续按照时间组织。

所以当前物理布局其实和前面学习的 Query Pattern 完全一致：

~~~text
Query Pattern

Project
+
Metric
+
Time

        ↓

Columnstore Layout

SEGMENTBY
project_id,name

ORDERBY
observed_at DESC
~~~

这里再次体现：

> **存储布局应该从 Query Pattern 反推，而不是只根据字段名称设计。**



### 【脱离项目形成完整的 Time-Series Data Lifecycle 设计框架】

以后设计任意时序系统，都可以依次回答五个问题。

#### <u>1. Recent Data 需要多久保持高频可写</u>

例如：

~~~text
1 hour

1 day

7 days
~~~

决定：

~~~text
Hot Window
~~~

#### <u>2. 数据什么时候进入 Historical Storage 阶段</u>

即：

~~~text
Rowstore
    ↓
Columnstore
~~~

边界。

需要考虑：

~~~text
Late-arriving Data

Update Frequency

Query Pattern

Storage Cost
~~~

#### <u>3. Columnstore 怎样按照主要 Query Pattern 组织</u>

回答：

~~~text
SEGMENTBY 什么？

ORDERBY 什么？
~~~

不能凭字段名称决定。

应该从：

~~~text
WHERE 常查什么？

GROUP BY 常按什么？

Time Range 怎么查？
~~~

反推。

#### <u>4. Raw Data 需要保存多久</u>

例如：

~~~text
30 days
~~~

回答：

~~~text
什么时候
不再需要逐条事实？
~~~

#### <u>5. Aggregate Data 需要保存多久以及保留什么粒度</u>

例如：

~~~text
Raw
    ↓
30 days

1m
    ↓
90 days

1h
    ↓
1 year

1d
    ↓
5 years
~~~

这就进入：

~~~text
Multi-resolution Storage
~~~

设计。



### 【第五节收束：TimescaleDB Storage & Lifecycle 是完整数据管理主线】

这一节最终不是在学：

~~~text
add_compression_policy
~~~

或者：

~~~text
add_retention_policy
~~~

两个函数。

真正建立的是：

~~~text
Time-Series Storage Lifecycle
│
├── 一、Storage Format
│   │
│   ├── Rowstore
│   └── Columnstore
│
├── 二、Hypercore
│   │
│   ├── Recent Chunk → Rowstore
│   └── Historical Chunk → Columnstore
│
├── 三、Columnar Layout
│   │
│   ├── SEGMENTBY
│   ├── ORDERBY
│   └── Compression
│
└── 四、Data Retention
    │
    ├── Raw Retention
    ├── Aggregate Retention
    └── Multi-resolution History
~~~

和前四节连接起来：

~~~text
TimescaleDB
│
├── Storage Organization
│   └── Hypertable / Chunk
│
├── Query
│   └── Time Range / time_bucket
│
├── Precomputation
│   └── Continuous Aggregate
│
└── Storage Lifecycle
    ├── Rowstore
    ├── Columnstore
    ├── Compression
    └── Retention
~~~

到这里，TimescaleDB 的基础数据管理框架才比较完整。



### 【当前项目与 TimescaleDB 现行体系的最终映射】

| TimescaleDB 体系 | 当前推荐 / 现行概念 | Browser Monitor 当前源码 |
|---|---|---|
| 时间分区 | Hypertable / Chunk | create_hypertable() |
| 热数据存储 | Rowstore | Hypertable 最近 Chunk |
| 历史数据存储 | Hypercore Columnstore | 旧 Compression API |
| 分组布局 | segmentby | compress_segmentby |
| 时间布局 | orderby | compress_orderby |
| 自动转入历史存储 | add_columnstore_policy() | add_compression_policy() |
| Raw 生命周期 | Retention | add_retention_policy(...30 days) |
| 历史趋势 | Continuous Aggregate | *_rollup_1m / *_rollup_1h |
| Aggregate 生命周期 | Retention | ...180 days |

学习时应该以：

~~~text
Hypercore
    ↓
Rowstore / Columnstore
    ↓
Lifecycle
~~~

作为知识主框架，再把当前项目的旧 Compression API 映射回来，而不是反过来用旧 API 定义 TimescaleDB。



## 10. Retention 通过淘汰完整 Chunk 管理数据保留期限

### 【问题背景：Compression 和 Continuous Aggregate 都不等于删除】

设备监控、日志、浏览器遥测等系统持续产生事件。Compression 将旧 Chunk 转为更紧凑的布局，但仍保存原始事件；Continuous Aggregate 将原始事实转换为单分钟或单小时的统计，却不意味着自动删除原始明细。

如果每天产生 100 万条事件，一年约新增 3.65 亿条，压缩之后仍要支付磁盘、备份、索引及管理成本。业务可能仅需最近 30 天的事件明细，却要保留过去 180 天的趋势统计。

因此产生本轮问题：**既然历史事件具有明确的时间范围，为什么不能每天批量 DELETE 全部过期行，而要使用 TimescaleDB Retention 按物理 Chunk 删除？**

### 【为什么逐行 DELETE 可能造成高维护成本】

PostgreSQL 使用 MVCC（多版本并发控制），DELETE 通常标记原有记录对后续事务不再可见，并留下等待后续清理的死元组；为了维护事务持久性还会写 WAL（预写日志）。大量行级删除还涉及索引、页可复用空间及 VACUUM 等后续工作。

~~~sql
DELETE FROM events
WHERE occurred_at < NOW() - INTERVAL '30 days';
~~~

如果上述 SQL 一次匹配数百万条记录，数据库需为这些行完成删除逻辑，而普通 VACUUM 通常只是使空间可以复用，不能保证表文件立即缩小。因此持续批量淘汰整段时序数据时，DELETE 可能产生显著 I/O、WAL、锁与清理成本；不是说少量 DELETE 一概不应该使用。

### 【为什么按 Chunk DROP 可以避免大量逐行处理】

Hypertable 是逻辑表，其历史数据被组织在多个具有确定时间范围的物理 Chunk 中。Retention 可以选择**时间范围整体符合淘汰条件**的旧 Chunk，将整个数据块及其相关存储对象移除。

~~~text
Hypertable：events
    ├─ 历史 Chunk A：完整过期 → 删除整个 Chunk
    ├─ 历史 Chunk B：跨越截止时间 → 整块保留
    ├─ Chunk C：尚未过期 → 保留
    └─ 当前 Chunk D：仍接收新事件 → 保留
~~~

该方法不必逐行制造大量死元组、再依靠逐行清理回收空间。即使某 Chunk 已经压缩，符合生命周期条件后也可以作为完整数据块删除，无需先把所有行解压再逐行删除。

但 DROP Chunk 仍需要元数据更新、取得相应锁和执行后台任务，不是零开销，也可能因为有其他会话访问而等待或失败。

### 【Retention 的时间阈值作用于整个 Chunk 范围】

假设现在是 10 月 12 日零时，保留 30 天，截止时间为 9 月 12 日零时：

| Chunk 覆盖区间 | 与截止点的关系 | Retention 结果 |
| --- | --- | --- |
| 9 月 1 日～9 月 8 日 | 时间范围全部早于截止 | 可以删除 |
| 9 月 8 日～9 月 15 日 | 部分早于、部分晚于截止 | 暂时保留整个 Chunk |
| 9 月 15 日～9 月 22 日 | 尚未过期 | 保留 |

这里重要的是**Chunk 的结束时间是否越过过期边界**，而不是块里是否已有部分行变旧。

因此 \`INTERVAL '30 days'\` 不是精确到每条 Row 的自动 TTL。真正的删除时间还受到 Chunk Interval、区间边界和后台调度影响。块跨度越长，过期淘汰粒度一般越粗。

### 【Retention Policy 怎样自动运行】

项目和通用时序表都可以使用：

~~~sql
SELECT add_retention_policy(
  'events',
  INTERVAL '30 days'
);
~~~

这会注册一个后台 Job。其逻辑为：

~~~text
配置 add_retention_policy
    ↓
注册后台调度任务
    ↓
Job 按调度规则尝试运行
    ↓
计算当前时间 - drop_after
    ↓
检查 Chunk 完整时间范围是否过期
    ↓
删除符合条件的整个 Chunk
    ↓
等待下一次任务
~~~

要区分：
- \`drop_after\`：定义分区时间范围相对当前时间的过期条件。
- \`schedule_interval\`：定义后台任务的调度间隔；不是每条记录的到期精确时刻。
- \`drop_created_before\`：较新 API 还有按 Chunk 创建时间淘汰的独立选项，**不能与当前按事件时间的 drop_after 混为一谈**。

当前迁移采用 \`INTERVAL\` 形式的 drop_after，针对的是 \`occurred_at\` 所在的时序维度，不是 \`received_at\` 或 Chunk 的创建时间。

### 【真实项目：原始数据 30 天与历史统计 180 天】

本案例中，监控平台接收多种浏览器原始事件，先在接入服务校验、去重、脱敏后保存在 \`telemetry_events\`；为了查看历史趋势，数据库另外物化一分钟统计 \`telemetry_rollup_1m\`，再基于分钟数据形成小时统计 \`telemetry_rollup_1h\`。

原始事件及分钟统计的真实配置：

~~~sql
-- 原始事件明细
SELECT add_retention_policy(
  'telemetry_events',
  INTERVAL '30 days',
  if_not_exists => TRUE
);

-- 一分钟连续聚合
SELECT add_retention_policy(
  'telemetry_rollup_1m',
  INTERVAL '180 days',
  if_not_exists => TRUE
);
~~~

小时连续聚合另有：

~~~sql
SELECT add_retention_policy(
  'telemetry_rollup_1h',
  INTERVAL '180 days',
  if_not_exists => TRUE
);
~~~

由此形成分层生命周期：
1. **近期原始明细 30 天**：支持追查某一条事件的 JSONB、时间、类型、页面上下文。
2. **分钟聚合 180 天**：保留分钟级趋势，失去还原单次事件的能力。
3. **小时聚合 180 天**：以分钟聚合为来源，支持跨度更长、粒度更粗的统计查询。

注意这不是“删除时把原始事件移动到分钟聚合表”：聚合结果在持续刷新时单独形成，Retention 独立地淘汰上游旧 Chunk。

源码：[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)、[0002_hourly_aggregates.sql](../platform/packages/database/migrations/0002_hourly_aggregates.sql)。

### 【关键耦合：为什么不能在已删除原始事件的时间段重新刷新连续聚合】

虽然连续聚合物化存储与上游原始数据分别管理，**它并不是被永久冻结、与原始数据清理完全无关的历史快照**。

假设某一分钟此前保存 \`event_count=100\`；后来包含这些事件的原始 Chunk 被 Retention 删除。如果再对这段已丢失原始事实的时间窗口执行刷新，连续聚合将根据当前可见源数据重新计算，原统计行可能消失或变为无数据，历史统计就被破坏。

因此，如果业务希望“原始事件只留 30 天，但历史趋势保存 180 天”，原则上需要**让自动刷新窗口不覆盖已经被原始 Retention 删除的数据范围**，并避免不合适的手动历史刷新。

项目相关刷新策略：

~~~sql
-- 分钟聚合：只自动刷新向前约 29 天的窗口
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);

-- 小时聚合：以分钟聚合为源，刷新到约 179 天前
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1h',
  start_offset => INTERVAL '179 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);
~~~

分钟级上游 \`telemetry_events\` 保留 30 天，刷新从 29 天前开始；小时级上游 \`telemetry_rollup_1m\` 保留 180 天，刷新从 179 天前开始。这体现了**每一层的刷新回溯范围与它直接读取的上一层保留窗口相协调**。

这一设计降低了重新刷新已删除上游数据的风险，但不能单凭配置保证 180 天统计总是完整：初始 \`WITH NO DATA\` 回填、任务成功率、运行版本、数据过期边界、人工刷新和历史补写都需验证。

### 【如何在运行实例中验证，而非停留在代码配置】

检查保留任务和运行状态（不同 TimescaleDB 版本所暴露的信息视图字段可能略有区别）：

~~~sql
SELECT job_id, hypertable_name, proc_name, schedule_interval
FROM timescaledb_information.jobs
WHERE proc_name = 'policy_retention';

SELECT job_id, last_run_status, last_successful_finish,
       next_start, total_runs, total_failures
FROM timescaledb_information.job_stats;
~~~

另需查询 \`timescaledb_information.chunks\` 中实际 Chunk 的时间边界，并核对被删除的原始范围是否还存在合理的连续聚合物化数据。以上是待执行的验证方法，不能据此声称线上已经按预期清理。

### 【本轮结论与下一轮的衔接】

~~~text
原始事件持续增长
     ↓
Compression：旧 Chunk 变成更紧凑的存储布局，但仍保存原始事件
     ↓
Continuous Aggregate：另存分钟/小时统计
     ↓
Retention：按时间清理完整过期 Chunk，不依赖逐行 DELETE
     ↓
原始明细 30 天 + 分钟/小时统计 180 天（不同保留层次）
     ↓
刷新窗口须避开已经被淘汰的上游原始数据
~~~

**Aggregation = 汇总，Compression = 调整历史存储布局，Retention = 淘汰已不需要的历史数据。** 三者在正常时序链路中协作，不能互相替代。

权威来源：[Timescale Data Retention](https://docs.timescale.com/use-timescale/latest/data-retention/about-data-retention/)、[Retention Policy](https://docs.timescale.com/api/latest/data-retention/add_retention_policy/)、[连续聚合与历史清理](https://docs.timescale.com/use-timescale/latest/data-retention/data-retention-with-continuous-aggregates/)、[原始数据清理后聚合刷新风险](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/drop-data/)。




### 【生命周期策略：Retention 与分层保留的工程原则】

### 【Retention 决定数据生命周期的终点，而不是单纯执行 DELETE】

有了：

~~~text
Recent
    ↓
Rowstore

Historical
    ↓
Columnstore
~~~

还没有结束。

数据继续变老：

~~~text
30 days

180 days

1 year
...
~~~

最终还需要回答：

> **这份 Raw Data 还有没有继续保存的价值？**

这就是：

~~~text
Retention
~~~

#### <u>1. 普通思路可能是逐 Row DELETE 旧数据</u>

例如：

~~~sql
DELETE FROM performance_samples
WHERE
  observed_at
  < now() - INTERVAL '30 days';
~~~

如果：

~~~text
每天上千万 Rows
~~~

那么可能需要：

~~~text
找到大量 Row

逐 Row 删除

更新 Index

产生 dead tuples

后续 Vacuum
~~~

这对于持续增长的 Time-Series Data 成本很高。

#### <u>2. Time Partition 让 Retention 可以围绕 Chunk 工作</u>

因为已经有：

~~~text
Chunk A
10/01

Chunk B
10/02

Chunk C
10/03
~~~

假设 Retention 是：

~~~text
30 days
~~~

如果：

~~~text
Chunk A
整个时间范围
已经早于 30 days
~~~

就可以直接：

~~~text
Drop Chunk
~~~

而不是：

~~~text
在 Chunk A 里面
DELETE 数百万 Row
~~~

所以前面学习 Hypertable / Chunk 的价值再次出现：

~~~text
Chunk
    ↓
不仅用于 Query Pruning

还用于：
Lifecycle Management
~~~

#### <u>3. 当前项目的 Raw Retention 是 30 天</u>

当前源码：

~~~sql
SELECT add_retention_policy(
  'telemetry_events',
  INTERVAL '30 days',
  if_not_exists => TRUE
);

SELECT add_retention_policy(
  'performance_samples',
  INTERVAL '30 days',
  if_not_exists => TRUE
);

SELECT add_retention_policy(
  'view_records',
  INTERVAL '30 days',
  if_not_exists => TRUE
);
~~~

因此：

~~~text
Raw Detail
    ↓
主要保留 30 days
~~~

这意味着：

~~~text
30 天以后
~~~

不是：

~~~text
所有监控历史
完全消失
~~~

因为还有：

~~~text
Continuous Aggregate
~~~

保存更长期的趋势。

#### <u>4. Aggregate Retention 比 Raw Retention 更长</u>

当前：

~~~sql
SELECT add_retention_policy(
  'performance_rollup_1m',
  INTERVAL '180 days',
  if_not_exists => TRUE
);
~~~

后续：

~~~text
performance_rollup_1h
    ↓
180 days
~~~

所以项目形成：

~~~text
Raw Data
    ↓
30 days

Aggregate Data
    ↓
180 days
~~~

这是典型的：

~~~text
Multi-resolution History
~~~

或者：

~~~text
Downsampled Historical Storage
~~~

思想。

即：

~~~text
Recent
    ↓
保留细节

Historical
    ↓
保留趋势
~~~

而不是：

~~~text
所有数据
统一以 Raw 形式
保留 180 天
~~~



### 【Compression、Continuous Aggregate 与 Retention 必须放进同一个生命周期理解】

这三个能力不要分别记成：

~~~text
Compression
一套功能

Continuous Aggregate
一套功能

Retention
一套功能
~~~

真正的时间序列生命周期是：

~~~text
Incoming Data
        ↓
Recent Raw
        ↓
Rowstore
        ↓
        │
        │ Time Passes
        ▼
Historical Raw
        ↓
Columnstore
+
Compression
        ↓
        │
        ├──────────────┐
        │              │
        ▼              ▼
     Detail        Continuous Aggregate
                      ↓
                     1m
                      ↓
                     1h
        │              │
        │              │
        ▼              ▼
Raw Retention      Aggregate Retention
30 days            180 days
        │              │
        ▼              ▼
Drop Raw Chunk     Keep Trend Longer
~~~

于是形成完整关系：

~~~text
Data Age
    ↓
Access Pattern
    ↓
Storage Format
    ↓
Resolution
    ↓
Retention
~~~

这才是 TimescaleDB Data Lifecycle 体系。



### 【回到 Browser Monitor，可以完整解释 24h / 30d / 180d 三个时间边界】

当前项目实际上已经形成明确 Data Lifecycle。

#### <u>1. 0 ～ 24 小时：最新 Raw Data</u>

当前：

~~~sql
add_compression_policy(
  'performance_samples',
  INTERVAL '24 hours'
)
~~~

说明当前源码期望：

~~~text
大约 24h 内
    ↓
Recent / Hot Raw Data
~~~

这个阶段最有可能：

~~~text
持续写入

修订

近期查询
~~~

#### <u>2. 24 小时以后：旧 Raw Data 进入历史存储阶段</u>

当前旧 API 表达：

~~~text
Chunk older than 24h
    ↓
Compression
~~~

从现代 TimescaleDB 体系理解，就是：

~~~text
Hot Row-oriented Data
        ↓
随着数据变冷
        ↓
Historical Columnar / Compressed Data
~~~

因此当前项目的：

~~~text
24 hours
~~~

本质上定义了：

~~~text
Hot
    ↓
Historical
~~~

的生命周期边界。

#### <u>3. 30 天以后：Raw Detail 不再长期保留</u>

当前：

~~~text
Raw Retention
=
30 days
~~~

所以：

~~~text
Historical Raw Chunk
        ↓
超过 30 天
        ↓
Drop
~~~

#### <u>4. 180 天以内：继续依靠 Aggregate 保存历史趋势</u>

当前：

~~~text
1m / 1h Aggregate
        ↓
180 days
~~~

所以：

~~~text
30 ~ 180 days
~~~

仍然可以知道：

~~~text
趋势

count

average

percentile state

distinct state
~~~

但不再保证可以读取：

~~~text
每一条 Raw Event
或
每一条 Raw Sample
~~~

#### <u>5. 当前项目最终生命周期</u>

~~~text
0
│
├── 0 ~ 24h
│      ↓
│   Hot Raw
│   高频写入 / 查询
│
├── 24h ~ 30d
│      ↓
│   Historical Raw
│   Compressed / Column-oriented
│
├── 30d
│      ↓
│   Raw Retention Boundary
│   Raw Detail 删除
│
├── 30d ~ 180d
│      ↓
│   Aggregate History
│   1m / 1h Rollup
│
└── 180d
       ↓
    Aggregate Retention Boundary
~~~

这张生命周期图比单独记：

~~~text
24h compression

30d retention

180d retention
~~~

更重要。



## 11. 迟到与乱序数据对时序存储和统计一致性的影响

### 【先说明事件为什么不按发生时间顺序入库】

浏览器监控、设备监测、日志采集等系统，事件先在客户端产生，再经过批量发送、网络传输和服务端接入写进数据库。网络失败、重试、设备离线或时钟偏差，都会使“事件发生顺序”和“事件入库顺序”不同。

教学示例：

| 事件 | 发生时间 Event Time | 服务端接收时间 |
| --- | --- | --- |
| A | 10:00:10 | 10:00:11 |
| B | 10:01:20 | 10:05:00 |
| C | 10:02:30 | 10:02:31 |

事件发生顺序是 A → B → C；接收顺序是 A → C → B。B 相对其他事件发生了乱序接入。

- **Event Time（事件时间）**：业务事实实际发生的时间。
- **Ingestion / Received Time（接入/接收时间）**：服务端接收或数据库记录收到事实的时间。
- **Processing Time（处理时间）**：真正执行某个数据处理操作时的时间。
- **Out-of-Order（乱序）**：到达顺序不符合发生顺序。
- **Late Arrival（迟到）**：到达时间显著晚于事件时间；是否对历史物化结果造成影响，还取决于是否已经跨过物化边界。

**问题：一条发生在历史时间段、现在才到达的事件，存储位置、历史压缩、聚合统计和 Retention 会怎样处理？** 本轮复用前面已经建立的四个机制，不引入新的异步系统。

### 【第一层：按 Event Time 路由到旧 Chunk，不按收到时刻写入最新 Chunk】

假设 Hypertable 以 `occurred_at` 分区，每个 Chunk 覆盖一小时（教学假设）：

~~~text
Chunk A：[09:00, 10:00)
Chunk B：[10:00, 11:00)
Chunk C：[11:00, 12:00)

11:10 收到一条发生于 09:30 的事件
           ↓
检查记录的 occurred_at = 09:30
           ↓
路由到 Chunk A（09:00～10:00）
           ↓
与是否在 11:10 收到无关
~~~

SQL 写入仍面向逻辑 Hypertable：

~~~sql
-- 教学示例；不是本项目真实 Schema 的完整 INSERT。
INSERT INTO events (event_id, occurred_at, type)
VALUES ('evt-001', '2026-10-12 09:30:00+00', 'error');
~~~

因此乱序本身不会让数据库按服务器当前时间错误归档。数据库根据分区键决定 Chunk；一批不同发生时间的事件也可以分发到不同 Chunk。

但“正确路由”不能推出“后续聚合、压缩、生命周期无需特殊考虑”。接下来需要分别判断旧 Chunk 的状态和聚合物化边界。

### 【第二层：新近未物化数据与已物化历史的数据处理方式不同】

设当前 10:05，`telemetry_rollup_1m` 的**假设**物化水位在 10:04。

| 事件的发生时间 | 相对物化水位 | 对实时查询的处理 |
| --- | --- | --- |
| 10:04:30 | 水位之后，尚未物化 | SELECT 连续聚合时，可读取最新原始事件并临时 GROUP BY |
| 10:02:30 | 水位之前，已物化历史 | 先记录历史变更 Invalidation，后续刷新对应时间桶 |

**情况 A——水位之后的新事件**：

~~~text
INSERT occurred_at=10:04:30
          ↓
原始表拥有这条事实
          ↓
materialized_only=false 的实时聚合 SELECT
          ↓
对未物化较新原始数据临时分桶计算
          ↓
后台 Refresh 覆盖完整时间桶
          ↓
物化结果被保存；水位可向前推进
~~~

查询时临时聚合**不会**因 SELECT 自动持久化、不会自行推进水位。

**情况 B——水位之前的历史事件**：

~~~text
已物化的 10:02 桶 event_count=100
          ↓
INSERT occurred_at=10:02:30
          ↓
已物化历史范围发生变化
          ↓
记录受影响范围（Invalidation）
          ↓
Refresh 覆盖 10:02 桶时重新聚合
          ↓
已保存的 event_count 更新为 101
~~~

这里水位可以依旧停留在 10:04，因为修改的是旧桶，而不是首次物化新的时间桶。

**关键边界**：实时聚合不意味着水位之前的历史变动立即可见。如果尚未完成有效刷新，读取历史物化结果仍可能暂时是旧值；如果超出自动刷新策略窗口，则需另外刷新或补算。

### 【第三层：写入已压缩 Chunk 时的成本】

Compression 已将符合条件的旧 Chunk 从行式布局转换为压缩批次。后续一条旧事件仍会根据发生时间定位到相关旧 Chunk，但其物理写入方式取决于是否压缩以及 TimescaleDB 版本支持。

对于支持插入压缩数据的传统压缩版本，正常 INSERT 可以面向已压缩 Hypertable 工作；数据库需要处理压缩存储的维护，成本可能高于对普通活跃 Chunk 的追加写入。对于大量历史批次回填，可能更适合评估先解压相关 Chunk、批量写入、再次压缩；不能假定所有版本都有相同行为或同样 DML 成本。

要注意“24 小时压缩阈值”是**完整 Chunk 的年龄条件**，而非事件发生满 24 小时就立即压缩。因此迟到 2 小时的事件，不意味着一定命中压缩 Chunk；迟到数天也不能仅靠事件年龄断言 Chunk 已压缩，必须核对实际分块范围和后台 Job 状态。

### 【第四层：超出 Retention 的历史写入不能依赖数据库自动拦截】

Retention 采用按时间范围淘汰整个旧 Chunk 的策略。如果客户端上报一条很早以前的事件，数据库可能面向已被清理的历史时间范围执行写入或重新建立旧 Chunk，之后该 Chunk 又可能被下一轮保留任务移除；精确行为取决于运行版本、策略与并发状态。

**Retention 不是接入层的事件时间校验器。** 业务必须明确允许补录的时间范围、超过范围的拒绝方式，以及是否有特别的人工历史回填流程。

### 【实际项目的五个时间配置】

`browser-monitor` 将网页产生的性能、访问、异常、自定义事件经接入 API 校验、脱敏和去重后写入 `telemetry_events`。分区列是 `occurred_at`（浏览器事件发生时间），另有 `received_at`（记录接收时间）。数据库以发生时间选择 Chunk。

实际策略如下：

| 控制点 | 项目配置 | 意义 |
| --- | --- | --- |
| 接入层事件时间准入 | 过去 30 天 ～ 未来 5 分钟 | 过旧/过未来事件拒绝 |
| `telemetry_events` Compression | 24 小时阈值 | 旧 Chunk 达到压缩条件可由后台执行 |
| `telemetry_events` Retention | 30 天 | 完整过期 Chunk 由后台删除 |
| `telemetry_rollup_1m` 刷新窗口 | 29 天前 ～ 最近 10 秒之前 | 周期性刷新该区间的完整分钟桶 |
| 分钟/小时聚合的 Retention | 180 天 | 按各层聚合自身的时间范围清理 |

接入时间校验的真实代码：

~~~ts
if (
  parsed.data.occurredAt > now + 5 * 60_000 ||
  parsed.data.occurredAt < now - 30 * 24 * 60 * 60_000
) {
  rejections.push({ index, code: "event_time_out_of_range" });
  return;
}
~~~

分钟级物化刷新策略：

~~~sql
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);
~~~

源码：[IngestionService](../platform/apps/api/src/ingestion/ingestion.service.ts)、[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)、[0002_hourly_aggregates.sql](../platform/packages/database/migrations/0002_hourly_aggregates.sql)。

### 【重点边界：29 天 12 小时前的事件现在才到达】

假设服务端现在收到一条发生在 **29 天 12 小时前** 的事件。

1. **接入校验**：未超过过去 30 天范围，可以通过本项时间校验；仍须通过协议、项目等其他检查。
2. **Chunk 路由**：按照旧 `occurred_at` 找对应 Chunk。它是否仍存在、是否已压缩、能否高效写入，要结合当前真实状态。
3. **压缩状态**：项目的 24 小时阈值可能让相应历史 Chunk 已压缩，但必须通过实际 Chunk 状态确认。
4. **聚合刷新**：分钟级自动刷新只向前覆盖约 29 天；该事件对应时间桶位于窗口之外。若旧桶已经物化，则新插入可能使它变旧；若尚未物化，常规自动刷新也不会补全这段结果。
5. **数据保留**：30 天原始明细 Retention 按 Chunk 淘汰，因此这条事件可能被接受入库，但其剩余存活时间受所属 Chunk 时间边界及后台清理时刻影响。

**结论不是断言线上已有统计错误，而是配置暴露了一个可验证的边界：接入层允许的最大迟到时间大于分钟连续聚合自动回溯的刷新范围。**

可以考虑从业务角度明确策略：缩小迟到准入窗口、拓宽安全的聚合刷新窗口，或者对极迟到事件触发有控制的历史补算。但不能只把刷新窗口无条件扩大到早于 Retention 的已删除上游数据范围，否则可能覆盖或抹掉应保留的历史统计。

### 【针对具体场景验证，而不是只看 SQL 配置】

建议在测试项目中验证三类样本：

| 迟到时间 | 主要验证目标 |
| --- | --- |
| 约 30 秒 | 是否成功入库，实时聚合什么时候能看到最新分钟桶 |
| 约 2 小时 | 对应历史桶是否已物化、Invalidation/Refresh 是否使统计增加 |
| 约 29 天 12 小时 | 旧 Chunk 是否压缩、记录能否入库、是否位于自动刷新窗口外 |

按事件 ID 检查原始事件是否写入：

~~~sql
-- 示例参数应使用测试项目真实 ID 和 event ID。
SELECT event_id, occurred_at, received_at, type
FROM telemetry_events
WHERE project_id = $1 AND event_id = $2;
~~~

检查与事件发生时间对应的一分钟统计：

~~~sql
SELECT bucket, type, SUM(event_count) AS total
FROM telemetry_rollup_1m
WHERE project_id = $1
  AND bucket = time_bucket(
    INTERVAL '1 minute', $2::timestamptz
  )
GROUP BY bucket, type;
~~~

上述聚合 SQL 为了观察方便按类型汇总；真实视图还有 name、environment、app_version、route_name 等分组维度。如果仅验证某一特定事件类型/名称，应补充相应过滤条件，不能误把全项目的事件数当作某一事件的统计值。

还应核验 `timescaledb_information.chunks` 的真实状态、连续聚合物化水位和后台 Job 的成功情况。项目源码不能代替生产实例测试。

### 【本轮完整结论】

~~~text
迟到或乱序事件进入服务端
          ↓
校验 Event Time 是否允许进入数据库
          ↓
按 occurred_at 路由至时间对应的旧 Chunk
          ↓
根据 Chunk 是否压缩，使用可用写入路径
          ↓
根据事件时间与物化边界：
    ├─ 水位之后 → 实时查询临时聚合 → 后续首次物化
    └─ 水位之前 → 历史 Invalidation → 覆盖范围内重新刷新
          ↓
若早于自动刷新窗口 → 需额外历史补算或明确定义不补算
          ↓
Retention 独立淘汰过期 Chunk，可能限制历史可追溯窗口
~~~

**时序数据库保证数据可按 Event Time 进行正确的分区组织，不等于自动保证所有历史统计实时准确或无限期保留。** 写入正确性、统计一致性和生命周期规则需要分别设计与验证。

下一轮应继续通过真实数据库观测验证这些机制：EXPLAIN 查询计划、Chunk 与压缩率、Continuous Aggregate 水位与刷新结果、后台 Job 状态，形成基于证据的数据库运行与容量检查方法。

资料：[Timescale Continuous Aggregates](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)、[Real-Time Aggregates](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/)、[Compression](https://docs.timescale.com/use-timescale/latest/compression/about-compression/)、[Data Retention](https://docs.timescale.com/use-timescale/latest/data-retention/about-data-retention/)。



## 12. Browser Monitor 原始事件的 TimescaleDB 实践

### 【问题与范围：为什么要从其他投影指标中单独抽出原始事件】

**提问：** 回到当前 browser-monitor 项目：只看原子/原始事件记录的完整链路，不讨论后续异步处理。原始事件经过怎样的预处理，实际存储在哪个数据库表中，压缩、保留、分钟/小时聚合分别如何执行，最终 Web 页面与 API 能取得哪些数据？

**边界**：本节只讨论原始事件 `telemetry_events` 及它直接生成的 `telemetry_rollup_1m`、`telemetry_rollup_1h`。不将 `performance_samples`、`view_records`、`custom_signal_samples` 及其聚合结果混入原始事件链路。真实入库事务还会在同一事务中写入待处理任务，这是源码的存在事实，但其后续消费/投影不属于本节。

**结论先行：原始事件自身当前主要提供两项对外能力——可检索的原始明细、指定时间范围内的原始事件总数。** 分钟/小时连续聚合只计算 `event_count`，暂未直接给 Web 提供按分钟展示的原始事件量曲线，更不能用该统计推导 LCP、INP、p75 或页面停留时长。

### 【原始事件端到端主链】

~~~text
浏览器监控 SDK
  └─ 生成 performance / view / event / trace / span 等协议事件
          ↓ 批量上报
POST /api/v3/ingest/:publicKey/envelopes
          ↓
IngestionService：同步接入
  ① 解析 JSON 与协议版本、批次 Header 校验
  ② 校验 publicKey 对应的项目、允许的 Origin、项目/IP 限流
  ③ 每条事件 Schema、app.name 项目归属、发生时间范围校验
  ④ URL 清理、用户 ID 哈希、敏感属性脱敏
  ⑤ 同批重复 eventId 与已入库历史 ID 的幂等去重
          ↓ 数据库事务
PostgreSQL + TimescaleDB
  └─ telemetry_events（按 occurred_at 分区的 Hypertable）
       ├─ 公共查询列 + 脱敏完整事件 JSONB
       ├─ 读取单次事实 → GET /analytics/raw-events
       │                     → Web「原始事件」页
       ├─ 每分钟事件计数 → telemetry_rollup_1m
       │                    ↓ 按小时合并 event_count
       │                  telemetry_rollup_1h
       │                    ↓
       │                  GET /analytics/overview 的 events
       │                    → Web「运行总览」中的「采集事件」
       └─ Chunk 生命周期
             ├─ Compression：24 小时压缩阈值
             └─ Retention：30 天明细淘汰阈值

分钟/小时统计的独立保留策略：180 天
~~~

注意：这里的“24 小时压缩”和“30 天删除”都是按符合条件的 Chunk 执行，不是每条 Row 精确到龄自动转换/删除。实际发生时间取决于 Chunk 时间区间及后台任务执行。

### 【接入 API 与原始事件预处理】

接入端点：

~~~http
POST /api/v3/ingest/:publicKey/envelopes
~~~

`IngestionController` 仅提取入参并调用 `IngestionService.ingest()`；实际校验与脱敏发生在 Service：

1. **解析与协议校验**：支持 JSON 对象，或由 `sendBeacon` 发出的 JSON 文本；校验 `protocolVersion`、整个 Batch Header 的 Schema。
2. **准入校验**：`publicKey` 必须能定位启用状态、密钥有效的项目；校验 Origin 是否符合项目允许清单；按项目和 IP 做事件数限流。
3. **逐事件校验**：`telemetryEventV3Schema.safeParse` 检查结构；要求 `event.app.name` 匹配项目；发生时间 `occurredAt` 必须位于相对当前时间的 **[-30 天, +5 分钟]** 内。
4. **安全处理**：使用 `sanitizeUrl` 清理 URL 查询参数；对用户 ID 做含项目盐及服务端密钥的哈希处理；用 `redactProperties` 脱敏用户属性、event/trace/span 的 attributes。真正入库的完整 JSONB 是脱敏后的事件。
5. **幂等去重**：先用 Set 过滤同请求重复 `eventId`；数据库事务内按事件 ID 排序获取咨询锁，检查同项目已入库的事件 ID，确保并发或不同 `occurred_at` 的同一业务事件不会因为分区键要求而重复进入。
6. **批量落库与结果**：把协议对象的公共属性展开成 SQL 列，其余完整安全事件仍存入 JSONB `event`；事务提交后按本批成功/重复/拒绝数量作出响应。

正常持久化接收的响应状态是 HTTP 202，例如：

~~~json
{
  "accepted": 10,
  "duplicate": 2,
  "rejected": 1,
  "requestId": "example-request-id",
  "rejections": [
    { "index": 3, "code": "event_time_out_of_range" }
  ]
}
~~~

这是**响应结构示例，不是线上数据**。`accepted` 表示原始记录持久化接收；不能推断后续异步环节已完成。校验拒绝的事件不会成为 `telemetry_events` 明细，重复事件也不会重复计入接收成功的原始行。

源码：[IngestionController](../platform/apps/api/src/ingestion/ingestion.controller.ts)、[IngestionService](../platform/apps/api/src/ingestion/ingestion.service.ts)。

### 【数据库落点：一张 Hypertable 保存可追溯的原始事实】

核心建表与索引：

~~~sql
CREATE TABLE telemetry_events (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id varchar(256) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  type varchar(32) NOT NULL,
  name varchar(128) NOT NULL,
  environment varchar(64) NOT NULL,
  app_version varchar(64) NOT NULL,
  session_id varchar(256) NOT NULL,
  view_id varchar(256) NOT NULL,
  route_name varchar(160) NOT NULL,
  user_hash varchar(64),
  event jsonb NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (project_id, event_id, occurred_at)
);
SELECT create_hypertable(
  'telemetry_events',
  'occurred_at',
  if_not_exists => TRUE
);
CREATE INDEX telemetry_project_time_idx
  ON telemetry_events(project_id, occurred_at DESC);
CREATE INDEX telemetry_project_type_time_idx
  ON telemetry_events(project_id, type, occurred_at DESC);
~~~

字段职责：
- **`project_id`、`event_id`**：项目隔离及单事件身份；单纯数据库主键的范围是 `(project_id,event_id,occurred_at)`，业务 eventId 幂等需要接入侧额外配合。
- **`occurred_at`**：浏览器端发生时间，作为事件时间范围查询和 Hypertable Chunk 路由依据。
- **`received_at`**：数据库记录接收的时间，区别于客户端发生时间。
- **`type`、`name`、`environment`、`app_version`、`route_name`**：常用检索、统计维度。
- **`session_id`、`view_id`、`user_hash`**：追踪关联；用户标识为匿名化值。
- **`event jsonb`**：保留脱敏后的完整协议事件，用于单事件排查；不是只保留部分聚合字段。
- **`processed_at`**：数据库中存在该状态字段，但当前只分析接收与存储，不引入其异步更新逻辑。

**为什么是公共字段 + JSONB，而不是把全部内容只保存在 JSONB？** 因为对项目、时间、类型、会话等条件检索时有明确的 SQL 列与索引路径，同时保留事件特有结构，避免为每一种浏览器事件扩展固定 Schema。

源码：[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)。

### 【分钟与小时连续聚合：唯一的原始事件指标是 event_count】

分钟视图的完整核心 SQL：

~~~sql
CREATE MATERIALIZED VIEW telemetry_rollup_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
  project_id, type, name, environment, app_version, route_name,
  count(*)::bigint AS event_count
FROM telemetry_events
GROUP BY bucket, project_id, type, name,
         environment, app_version, route_name
WITH NO DATA;
~~~

`bucket`、`project_id`、`type`、`name`、`environment`、`app_version`、`route_name` 都是**分组维度**，而非不同的聚合指标。`event_count` 才是结果指标：某分钟、某一维度组合下发生多少条**原始事件**。

例如（教学假设）：

| bucket | type | name | route_name | event_count |
| --- | --- | --- | --- | --- |
| 10:00 | performance | LCP | /home | 120 |
| 10:00 | view | view.start | /home | 80 |
| 10:00 | event | purchase | /order | 12 |

注意这些是 **LCP 上报事件次数**、**view.start 原始事件次数**与**purchase 原始事件次数**，不是 LCP 实测数值、已归并的页面 View 数、订单总金额或任意其他业务指标。

小时视图建立在分钟视图之上，保留同一组维度，将 1m 桶的 count 汇总为 1h：

~~~sql
CREATE MATERIALIZED VIEW telemetry_rollup_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  project_id, type, name, environment, app_version, route_name,
  sum(event_count)::bigint AS event_count
FROM telemetry_rollup_1m
GROUP BY 1, 2, 3, 4, 5, 6, 7
WITH NO DATA;
~~~

例如某类事件在同一小时的 60 个分钟桶各出现 100 次，则对应小时总计 6000 次。**时间粒度由一分钟改为一小时，不会把 event_count 自动变成性能数值或独立访问人数。**

源码：[0001_platform.sql](../platform/packages/database/migrations/0001_platform.sql)、[0002_hourly_aggregates.sql](../platform/packages/database/migrations/0002_hourly_aggregates.sql)。

### 【原始事件自身的物化与保留时间策略】

实际配置：

~~~sql
-- 分钟连续聚合
SELECT add_continuous_aggregate_policy(
  'telemetry_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds',
  if_not_exists => TRUE
);

-- 原始表：按 Chunk 年龄压缩及保留
SELECT add_compression_policy(
  'telemetry_events', INTERVAL '24 hours',
  if_not_exists => TRUE
);
SELECT add_retention_policy(
  'telemetry_events', INTERVAL '30 days',
  if_not_exists => TRUE
);

-- 一分钟聚合统计保留 180 天
SELECT add_retention_policy(
  'telemetry_rollup_1m', INTERVAL '180 days',
  if_not_exists => TRUE
);
~~~

小时聚合有独立的刷新策略（约 179 天的刷新回溯、排除最近一小时、约 5 分钟调度）和 180 天保留策略。原始表压缩布局：

~~~sql
ALTER TABLE telemetry_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id,type',
  timescaledb.compress_orderby = 'occurred_at DESC'
);
~~~

原始表超过完整 Chunk 清理条件以后，该段明细 JSONB 不再可从该表恢复；但如果对应聚合结果在删除之前已正确形成、未被危险的历史刷新覆盖并且尚未超过其自身保留期，则长期事件数量依然可供查询。这是**原始明细 30 天、汇总统计 180 天**的意义。

上述都是 Migration 中声明的策略；是否已成功运行必须核对实例中的后台 Job、Chunk 和物化结果。

### 【API 一：原始明细查询 raw-events】

~~~http
GET /api/v1/projects/:projectId/analytics/raw-events
~~~

`AnalyticsService.rawEvents()` **直接从 telemetry_events 查询原始行**，不从分钟或小时统计反向恢复事件。API 依赖登录态与项目访问权限。

支持时间范围及 `type`、`name`、`eventId`、`sessionId`、`viewId`、`environment`、`version`、`routeName` 筛选。结果按 `occurred_at DESC, event_id DESC` 排序，使用游标翻页；请求 `limit` 最多 100，默认 50。

返回的结构是：

~~~json
{
  "items": [
    {
      "eventId": "evt-001",
      "occurredAt": "2026-10-12T10:00:00Z",
      "receivedAt": "2026-10-12T10:00:02Z",
      "type": "performance",
      "name": "LCP",
      "environment": "production",
      "version": "1.0.0",
      "sessionId": "session-001",
      "viewId": "view-001",
      "routeName": "/home",
      "event": {}
    }
  ],
  "nextCursor": null
}
~~~

示例值并非真实线上返回，`event` 在真实请求中是已脱敏的完整事件 JSONB。API **并不**在该响应里返回 `processed_at` 或聚合的 `event_count`。

Web [RawEventsPage](../platform/apps/web/src/pages/RawEventsPage.tsx) 的使用：
- 页面标题“原始事件”，支持事件类型（performance/view/event/trace/span）、名称、Event ID、Session ID、View ID、环境、版本、路由筛选；
- 表格展示发生时间、事件类型、名称、页面、环境和版本；
- 点击行打开 Drawer，可查看 Event ID、Session、View、Route 与完整事件 JSON；
- 当前前端默认时间范围**固定最近 24 小时**（虽然 API 可接收其他 `from/to`），每次请求 `limit=100`，游标翻页，每 15 秒刷新。

这解决“某条事件何时、在哪个页面、携带什么安全处理后的事实”的**明细追溯**问题。

### 【API 二：总览事件数量 overview.events】

~~~http
GET /api/v1/projects/:projectId/analytics/overview
~~~

本节只分析该接口返回对象中的 **`events`**，不讨论同时返回的性能和页面统计指标。

`AnalyticsService.useRollups()` 实际判断：

~~~ts
private useRollups(filters: AnalyticsFilters): boolean {
  return filters.from.getTime()
    < Date.now() - 29 * 24 * 60 * 60_000;
}
~~~

也就是说，该项目按**查询起始时间**选择两种读法：

**较近期范围**：直接对原始表计数。

~~~sql
SELECT count(*)::bigint AS events
FROM telemetry_events e
WHERE ...;
~~~

**查询起点早于约 29 天之前**：读取小时连续聚合，再根据项目和查询维度求和。

~~~sql
SELECT COALESCE(sum(event_count), 0)::bigint AS events
FROM telemetry_rollup_1h c
WHERE ...;
~~~

两条路径最后都归入响应的 `events: number`。例如 `{ "events": 12580 }` 表示示例查询范围内事件总数，不是分钟级曲线或某一个事件类型独立计数。

Web [OverviewPage](../platform/apps/web/src/pages/OverviewPage.tsx) 把该值展示为“**采集事件**”总量卡片；该页面虽然还有访问、性能与服务状态卡片，但它们的数据来源不属于本次原始事件专项。

**当前没有独立 Web 事件数量趋势接口直接返回 telemetry_rollup_1m 各分钟的 event_count。** 该一分钟物化视图的实际用途是保存分钟统计，并作为 `telemetry_rollup_1h` 的上游；小时物化统计的 `event_count` 被 `/overview` 的历史查询消费。

现有接口还存在两个值得明确记录的精度边界：
1. `useRollups()` 只看 `from`，时间范围即使跨越 29 天门槛，查询也不会把两段自动拆成“旧数据读聚合、近期数据读明细”；
2. 小时聚合使用 `bucket` 时间起点进行范围过滤，若传入的起止时间不对齐整点，其语义与精确到秒的原始事件时间过滤可能不同。不能宣称两类查询任何时间窗口下统计口径完全一致，需设计边界测试。

源码：[AnalyticsService](../platform/apps/api/src/analytics/analytics.service.ts)、[AnalyticsController](../platform/apps/api/src/analytics/analytics.controller.ts)、[OverviewPage](../platform/apps/web/src/pages/OverviewPage.tsx)。

### 【补充边界：接入计数不是同一种来源】

接入 Service 还会记录 `accepted`、`duplicate`、`rejected` 等接入结果到 Redis，并利用近期请求记录计算接入速率；`/analytics/service-status` 的相关状态数据由这些接入统计提供，**不依赖 telemetry_rollup_1m**。这是“本次 HTTP 接受/拒绝了多少条”的口径，区别于“指定 occurred_at 时间窗口内存在多少条原始事件”。此处只说明区别，不展开其他任务状态字段。

### 【原始事件链路最终能力对照】

| 业务问题 | 当前数据源 | API / Web 用途 |
| --- | --- | --- |
| 单次事件内容与上下文是什么？ | telemetry_events 的独立列 + event JSONB | raw-events → 原始事件页列表及 JSON 详情 |
| 一分钟、某类型/名称/路由有多少原始事件？ | telemetry_rollup_1m 的 event_count | 已在数据库物化；目前没有单独事件量曲线 API/Web |
| 一小时、某类型/名称/路由有多少原始事件？ | telemetry_rollup_1h 的 event_count | 数据库存储；overview 历史查询将各维度 event_count 汇总为 events |
| 近期给定范围内原始事件总量？ | telemetry_events 的 COUNT(*) | overview.events → Web 采集事件卡片 |
| 更长历史给定范围内原始事件总量？ | telemetry_rollup_1h 的 SUM(event_count) | overview.events → Web 采集事件卡片 |
| 超过原始保留窗口还能查看具体 JSONB 吗？ | 原始 Chunk 到期被淘汰 | 不能通过聚合反推单次事实；历史事件量可在聚合保留期内使用 |
| API 收到多少成功/重复/拒绝记录？ | 接入后的 Redis 计数 | service-status；不要误认为这是按事件发生时间聚合的 event_count |

**最终回答**：这条原始事件链路将协议事件经过校验、安全处理和幂等去重后写入 `telemetry_events`，并按发生时间管理 Chunk；数据库另将它们归桶计数为分钟/小时 `event_count`。Web 目前主要提供**原始事件明细追溯**与**总览事件数量**两种直接消费场景。没有直接将原始事件聚合转化为性能分位数或其他业务指标，也没有把原始分钟级事件数量作为独立曲线展示。

### 【后续可讨论的问题】

是否应该开放按 `type/name/route` 维度的原始事件量趋势 API，直接使用 `telemetry_rollup_1m` / `telemetry_rollup_1h`？如果这样设计，如何按时间范围自动选择粒度、处理部分时间桶、保证最近数据的新鲜度，以及区分原始事件发生量与接入接受量？

这是能力扩展方向，不属于已经完成的实现。后续仍沿原先学习计划，用实际 SQL、Chunk 状态、物化水位及 Job 执行结果验证数据库运行效果。




### 【应用读路径的扩展对照：明细与统计的取舍】

### 【Query Model 决定读取 Raw Detail 还是 Aggregate Trend】

到这里需要再抽象一层。

Time-Series Query 并不等于：

~~~text
所有查询都必须 time_bucket
~~~

当前项目实际上同时存在两种完全不同的查询模型：

~~~text
Time-Series Query
│
├── Detail Query
│      ↓
│   保留每一条原始事实
│
└── Aggregate Query
       ↓
    把大量 Raw Rows
    压缩成 Trend Points
~~~

它们前半段都可能经历：

~~~text
Business Scope
    ↓
Time Range
    ↓
Chunk Pruning
    ↓
Row Filtering
~~~

真正不同的是：

~~~text
Matching Rows
之后怎样返回结果
~~~

#### <u>1. Detail Query 保留原始 Row，不进入 time_bucket</u>

当前 rawEvents()：

~~~ts
async rawEvents(
  userId: string,
  projectId: string,
  filters: AnalyticsFilters,
  cursor: string | undefined,
  limit: number,
  ...
) {
  await this.projects.requireAccess(
    userId,
    projectId,
  );

  const filter = this.filters(
    "e",
    "occurred_at",
    projectId,
    filters,
  );

  ...
}
~~~

这里同样使用：

~~~text
project_id

occurred_at >= from

occurred_at < to
~~~

所以同样首先经历：

~~~text
Scope
    ↓
Time Range
    ↓
Relevant Chunks
    ↓
Matching telemetry_events Rows
~~~

但是后面没有：

~~~text
time_bucket

GROUP BY

Aggregate
~~~

而是继续：

~~~sql
ORDER BY
  occurred_at DESC,
  event_id DESC
~~~

并使用 Cursor Pagination。

当前 Cursor 条件：

~~~sql
(
  e.occurred_at,
  e.event_id
)
<
(
  cursorOccurredAt,
  cursorEventId
)
~~~

完整链路：

~~~text
Detail Query
    ↓
Business Scope
    ↓
Time Range
    ↓
Chunk Pruning
    ↓
Matching Rows
    ↓
Time Order
    ↓
Cursor Pagination
    ↓
Raw Events
~~~

它的目标是：

> **保留每一条事实，让用户能够看到具体发生了什么。**

这种查询需要的是：

~~~text
Detail
+
Order
+
Pagination
~~~

而不是：

~~~text
一分钟一个统计值
~~~

#### <u>2. Aggregate Query 不关心每一条 Row，而关心一段时间整体表现</u>

当前 performance()：

~~~text
performance_samples
    ↓
Scope / Time Range
    ↓
Matching Rows
    ↓
time_bucket
    ↓
GROUP BY
    ↓
Aggregate
    ↓
Trend Points
~~~

它最终不会返回：

~~~text
10:00:05 LCP = 2100

10:00:18 LCP = 2500

10:00:35 LCP = 1900
~~~

而是返回：

~~~text
10:00
LCP
count = ...
average = ...
p75 = ...
p95 = ...
~~~

因此它的目标是：

> **回答这一段时间整体表现如何变化，而不是逐条展示所有事实。**

#### <u>3. 两种 Query Model 的差异本质上是结果表示方式不同</u>

| 查询模型 | Detail Query | Aggregate Query |
|---|---|---|
| 目标 | 查看具体事实 | 查看趋势 |
| Time Range | 有 | 有 |
| Chunk Pruning | 有 | 有 |
| Row Predicate | 有 | 有 |
| time_bucket | 无 | 有 |
| GROUP BY | 无 | 有 |
| Aggregate Function | 无 | 有 |
| 排序 | 通常按时间 | 通常按 Bucket |
| 分页 | 常见 Cursor | 通常直接返回 Trend Points |
| 返回粒度 | 一条 Row | 一个统计组 |

所以更准确的流程是：

~~~text
先选择数据
    ↓
再根据业务问题
选择结果模型
~~~

即：

~~~text
Matching Rows
        ↓
        ├── Detail
        │     ↓
        │  Order / Cursor
        │
        └── Aggregate
              ↓
           Bucket / Group / Aggregate
~~~

#### <u>4. Query Model 应由产品问题决定，而不是由数据库类型决定</u>

例如：

~~~text
过去 10 分钟发生了哪些错误？
    ↓
Detail Query
~~~

而：

~~~text
过去 24 小时每分钟错误率是多少？
    ↓
Aggregate Query
~~~

所以不是：

~~~text
用了 TimescaleDB
    ↓
所有查询都应该 time_bucket
~~~

而是：

~~~text
Product Question
    ↓
Result Model
    ↓
Query Model
~~~

这是能够脱离当前项目复用的判断方式。



### 【Read Architecture 决定 Raw、1m Aggregate 与 1h Aggregate 怎样分工】

当前项目并没有：

~~~text
创建 Continuous Aggregate
    ↓
以后所有查询都改成读它
~~~

而是形成分层 Read Architecture。

#### <u>1. 当前近期 Performance 查询仍然直接读取 Raw Data</u>

源码：

~~~ts
private useRollups(
  filters: AnalyticsFilters,
): boolean {
  return (
    filters.from.getTime()
    <
    Date.now()
    -
    29 * 24 * 60 * 60_000
  );
}
~~~

因此：

~~~text
from >= now - 29 days
        ↓
performance()
直接查询 performance_samples

from < now - 29 days
        ↓
performanceFromRollups()
~~~

可以确认当前读取边界：

~~~text
Recent
    ↓
Raw Query

Historical
    ↓
Rollup Query
~~~

#### <u>2. 1m Continuous Aggregate 当前主要是中间聚合层</u>

performance_rollup_1m：

~~~text
performance_samples
        ↓
1 minute Aggregate
~~~

但是当前历史 Performance API 并不是直接读取：

~~~text
performance_rollup_1m
~~~

而是读取：

~~~sql
FROM performance_rollup_1h
~~~

因为 0002_hourly_aggregates.sql 又定义：

~~~sql
CREATE MATERIALIZED VIEW
performance_rollup_1h

WITH (
  timescaledb.continuous
)

AS

SELECT
  time_bucket(
    INTERVAL '1 hour',
    bucket
  ) AS bucket,

  ...

FROM performance_rollup_1m

GROUP BY ...
~~~

所以真实链路：

~~~text
performance_samples
        ↓
performance_rollup_1m
        ↓
performance_rollup_1h
        ↓
Historical Analytics
~~~

因此：

~~~text
performance_rollup_1m
~~~

在当前项目中主要承担：

~~~text
Intermediate Aggregate Layer
~~~

而：

~~~text
performance_rollup_1h
~~~

才是历史 Performance Query 直接使用的 Read Model。

#### <u>3. 当前项目形成三层数据粒度</u>

完整结构：

~~~text
Raw Layer
performance_samples
        │
        │
        ├── Recent Analytics
        │      ↓
        │   Query-time
        │   Exact Calculation
        │
        ▼
1m Continuous Aggregate
        │
        ▼
1h Continuous Aggregate
        │
        ▼
Historical Analytics
~~~

也可以理解：

~~~text
Recent
    ↓
Raw Detail
    ↓
High Resolution
    ↓
Exact Query-time Aggregation


Historical
    ↓
Precomputed Aggregate
    ↓
Lower Resolution
    ↓
Lower Read Cost
~~~

当前源码可以确认的是：

~~~text
Recent → Raw

Historical → Rollup
~~~

至于作者为什么做这种选择，源码没有直接写成设计注释。

但从技术效果看，这种设计可以让 Recent Query 保留：

~~~text
最新 Raw Data

Exact percentile_cont

Exact COUNT DISTINCT

更灵活的过滤
~~~

而 Historical Query 使用：

~~~text
Precomputed State

更粗粒度

更低查询成本
~~~

这部分属于根据代码结构做出的设计分析，需要和源码事实区分。

#### <u>4. Continuous Aggregate 与 Redis Cache 是两个不同层级的优化</u>

当前项目还存在：

~~~ts
await this.redis.set(
  key,
  JSON.stringify(value),
  "EX",
  15,
);
~~~

Redis 缓存的是：

~~~text
某一次完整 Analytics Query Result
~~~

而 Continuous Aggregate 保存的是：

~~~text
数据库内部长期复用的
Aggregate Data Model
~~~

完整关系：

~~~text
Raw Data
    ↓
Continuous Aggregate
    ↓
Analytics Query
    ↓
Redis Query Result Cache
    ↓
API Response
~~~

因此：

~~~text
Continuous Aggregate
    ↓
优化数据库内部数据模型与统计成本

Redis Cache
    ↓
优化 API Read Path
~~~

二者不是替代关系。

#### <u>5. Real-time Continuous Aggregate 是另一种处理最新数据的机制，但当前项目不能直接假设全部启用</u>

因为 Refresh Policy 存在：

~~~text
end_offset = 10 seconds
~~~

所以可能出现：

~~~text
最新 Raw Data 已写入

但
Materialized Aggregate
暂时还没有刷新到
~~~

TimescaleDB 提供 Real-time Aggregate 模式，可以把：

~~~text
已 Materialize 的历史数据

+

最新 Raw Data
~~~

在查询时组合。

但当前较早创建的：

~~~text
performance_rollup_1m
view_rollup_1m
custom_event_rollup_1m
telemetry_rollup_1m
~~~

没有在这一段 Migration 中显式设置：

~~~text
materialized_only = false
~~~

因此不能仅凭当前源码断言：

~~~text
所有 1m Continuous Aggregate
都一定启用了 Real-time Aggregate
~~~

更重要的是，当前 performance() 对近期数据本身就直接读取 Raw Table，所以近期可见性并不依赖这一能力。



## 13. TimescaleDB 的运行验证与工程优化

### 【面向 telemetry_events 的最小可执行检查清单】

上述配置都来自迁移文件，运行时应逐步验证而不是只看 Schema：

~~~sql
-- 确认原始事件 Hypertable 实际分区范围与压缩状态
SELECT chunk_name, range_start, range_end, is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'telemetry_events'
ORDER BY range_start DESC;

-- 核对各项维护任务是否已注册、按预期运行
SELECT job_id, application_name, proc_name, schedule_interval
FROM timescaledb_information.jobs
ORDER BY job_id;

SELECT job_id, last_run_status, last_successful_finish,
       total_runs, total_failures, next_start
FROM timescaledb_information.job_stats;
~~~

原始事件查询可在**隔离测试库和真实项目 ID**下使用 `EXPLAIN (ANALYZE, BUFFERS)` 对比时间范围、事件类型和索引访问路径；它会真正执行 SQL，不应直接对高成本写入语句使用。另需核验两个结果：`telemetry_events` 中原始事件数量与 `telemetry_rollup_1m` 对应时间桶的 `event_count`，以及水位之前历史修改后刷新结果是否收敛。正常接入、延迟 2 小时、延迟 29 天 12 小时应作为独立测试用例。

**指标口径**：`/analytics/overview` 的 `events` 为发生时间范围内的原始事件记录数；`/analytics/service-status` 的接入接受/拒绝数量来自 Redis 接入统计，不能作为同一指标直接比对。

### 【TimescaleDB Background Jobs、Policy、Scheduler 与数据库工作线程】



前几节已经连续遇到很多这样的 SQL：

~~~sql
SELECT add_continuous_aggregate_policy(...);

SELECT add_compression_policy(...);

SELECT add_retention_policy(...);
~~~

按照 TimescaleDB 当前体系，还会看到：

~~~sql
SELECT add_columnstore_policy(...);
~~~

如果只分别学习这些 API，很容易形成：

~~~text
Continuous Aggregate
    ↓
有一个 Refresh Policy

Columnstore
    ↓
有一个 Columnstore Policy

Retention
    ↓
有一个 Retention Policy
~~~

看起来像三个互不相关的功能。

实际上，它们背后共享的是同一套基础设施：

~~~text
TimescaleDB Automation Framework
│
├── Policy
│     ↓
│   描述“要自动维护什么”
│
├── Background Job
│     ↓
│   一个真正被注册、调度和执行的任务
│
├── Scheduler
│     ↓
│   决定 Job 什么时候运行
│
└── Background Worker
      ↓
    真正执行 Job
~~~

这一节真正要解决的是：

> **Policy、Job、Scheduler、Worker 到底是什么关系，以及数据库为什么能够自己定时完成 Refresh、Columnstore 转换和 Retention，而不需要 Node.js 写定时任务。**



### 【Policy 与 Job 是维护规则和可执行任务的关系】

#### <u>1. Policy 不是正在运行的代码，而是一条自动维护规则</u>

例如当前项目：

~~~sql
SELECT add_retention_policy(
  'performance_samples',
  INTERVAL '30 days',
  if_not_exists => TRUE
);
~~~

这条 SQL 表达的是：

~~~text
Target
    ↓
performance_samples

Rule
    ↓
超过 30 天的数据
应该被 Retention
~~~

也就是：

~~~text
Retention Policy
=
数据生命周期规则
~~~

同样：

~~~sql
SELECT add_compression_policy(
  'performance_samples',
  INTERVAL '24 hours',
  if_not_exists => TRUE
);
~~~

表达：

~~~text
超过约 24h 的 Chunk
    ↓
进入历史压缩阶段
~~~

Continuous Aggregate：

~~~sql
SELECT add_continuous_aggregate_policy(
  'performance_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds'
);
~~~

表达：

~~~text
这个 Aggregate
应该按照指定时间窗口
定期 Refresh
~~~

所以 Policy 首先回答的是：

> **数据库应该自动维持什么状态？**

#### <u>2. Job 才是 Scheduler 可以真正执行的任务实体</u>

当 TimescaleDB 注册这些 Policy 后，会创建对应的后台 Job。

可以把关系理解成：

~~~text
add_retention_policy(...)
        ↓
Retention Policy
        ↓
Background Job


add_continuous_aggregate_policy(...)
        ↓
Refresh Policy
        ↓
Background Job


add_columnstore_policy(...)
        ↓
Columnstore Policy
        ↓
Background Job
~~~

这些 Job 可以通过：

~~~sql
SELECT *
FROM timescaledb_information.jobs;
~~~

进行查看。

因此这里需要区分的是 **用户面对的维护规则抽象** 与 **数据库内部真正被调度的运行时任务**，而不是把 Policy 和 Job 理解成两个彼此独立的运行时对象：

~~~text
User-facing Policy
        ↓
声明数据库希望维持什么状态

add_xxx_policy(...)
        ↓
register

Background Job
        ↓
承载该 Policy 的
调度 / 执行 / 重试 / 状态
~~~

所以可以在概念职责上区分：

~~~text
Policy
    ↓
Declarative Maintenance Rule

Background Job
    ↓
Executable Scheduled Runtime Task
~~~

但从 TimescaleDB 的 Automation Framework 看，add_xxx_policy(...) 最终会注册用于实现该 Policy 的 Background Job。

#### <u>3. Policy 与 Job 可以用维护规则和运行时任务理解</u>

可以类比：

~~~text
Policy

“定期清理超过 30 天的数据”
这条维护规则


Background Job

数据库内部真正注册出来、
由 Scheduler 管理的执行任务
~~~

完整关系：

~~~text
Policy
    ↓
add_xxx_policy(...)
    ↓
注册实现该 Policy 的 Background Job
    ↓
被 Scheduler 管理
    ↓
被 Worker 执行
~~~

所以 add_xxx_policy(...) 不只是：

~~~text
给 Table 增加一个属性
~~~

而是把用户声明的维护规则接入 Background Job Framework，启动一整条自动维护链路。



### 【Scheduler 与 Background Worker 负责真正运行 Job】

Policy 和 Job 都有以后，还缺少两个问题：

~~~text
谁知道什么时候该执行？

谁真正执行？
~~~

答案分别是：

~~~text
Scheduler

Background Worker
~~~

#### <u>1. Scheduler 负责判断哪个 Job 到时间了</u>

例如当前项目的一分钟 Aggregate：

~~~text
schedule_interval
=
10 seconds
~~~

可以理解：

~~~text
Scheduler
    ↓
管理已经注册的 Jobs
    ↓
发现：
performance_rollup_1m Refresh Job
已经到 next_start
    ↓
安排执行
~~~

Scheduler 关注的是：

~~~text
Job A
什么时候执行？

Job B
什么时候执行？

Job C
是否暂停？

Job D
失败后什么时候 Retry？
~~~

因此：

~~~text
Scheduler
≠
具体执行 Retention / Refresh 逻辑
~~~

它主要解决：

~~~text
When to Run
~~~

#### <u>2. Background Worker 才真正执行对应维护逻辑</u>

TimescaleDB 是 PostgreSQL Extension。

所以这套后台任务不是：

~~~text
外部 Linux cron

Node.js setInterval

NestJS Cron

Redis Queue Worker
~~~

而是在 PostgreSQL / TimescaleDB 自己的后台 Worker 基础设施中运行。

可以理解：

~~~text
PostgreSQL Server
│
├── Application Connections
│
│   ├── API Query
│   └── Worker Query
│
└── TimescaleDB Background Workers
        │
        ├── Continuous Aggregate Job
        ├── Retention Job
        ├── Columnstore Job
        └── Custom Job
~~~

#### <u>3. 一次 Job 执行可以抽象成完整生命周期</u>

~~~text
Job Registered
      ↓
等待 Schedule
      ↓
到达 next_start
      ↓
Scheduler 选择 Job
      ↓
Background Worker
      ↓
调用对应 Procedure
      ↓
读取 Job Config
      ↓
执行维护操作
      ↓
Success / Failure
      ↓
记录 Statistics
      ↓
计算下一次 next_start
~~~

这条链就是：

~~~text
Background Job Lifecycle
~~~



### 【不同 Policy 只是复用同一 Job Framework 执行不同数据库维护操作】

理解 Job Framework 后，再重新看前面学过的几个 Policy。

它们就不应该被看成三个独立系统：

~~~text
TimescaleDB Job Framework
│
├── Continuous Aggregate Refresh Job
│
├── Columnstore / Compression Job
│
└── Retention Job
~~~

#### <u>1. Continuous Aggregate Policy 的 Job 负责 Refresh</u>

当前：

~~~sql
SELECT add_continuous_aggregate_policy(
  'performance_rollup_1m',
  start_offset => INTERVAL '29 days',
  end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '10 seconds'
);
~~~

可以重新解释成：

~~~text
Policy
    ↓
Refresh performance_rollup_1m

Job Config
    ↓
start_offset = 29d
end_offset = 10s

Schedule
    ↓
10s

Job Execution
    ↓
Refresh affected aggregate range
~~~

因此第四节中的 Incremental Refresh，不是应用请求触发的，而是由 Background Refresh Job 持续维护。

#### <u>2. Columnstore / Compression Policy Job 负责数据形态转换</u>

当前项目：

~~~sql
SELECT add_compression_policy(
  'performance_samples',
  INTERVAL '24 hours'
);
~~~

现行 Hypercore 体系更倾向使用 Columnstore Policy。

但从 Job Framework 看，两者表达的是同一类自动维护：

~~~text
Scheduler
    ↓
定期运行
    ↓
找到符合年龄条件的 Chunks
    ↓
转换为 Historical Storage
~~~

所以第五节中的：

~~~text
24h
=
Hot → Historical Boundary
~~~

真正能够自动发生，是因为：

~~~text
Columnstore / Compression Policy
        ↓
Background Job
~~~

#### <u>3. Retention Policy Job 负责删除过期 Chunk</u>

当前：

~~~sql
SELECT add_retention_policy(
  'performance_samples',
  INTERVAL '30 days'
);
~~~

后台维护链可以理解成：

~~~text
Scheduler
    ↓
Retention Job
    ↓
检查 Chunk Age
    ↓
Chunk 已完全超过 Retention Window？
    ↓
Yes
    ↓
Drop Chunk
~~~

所以 30 days 不是：

~~~text
一到第 30 天
由 API 请求顺便 DELETE
~~~

而是：

~~~text
后台 Job
按照自己的调度周期
发现符合条件的 Chunk 后清理
~~~

三类 Policy 可以统一成：

~~~text
                    Job Scheduler
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
    CAGG Refresh      Columnstore       Retention
        Job               Job              Job
          │               │                │
          ▼               ▼                ▼
 Refresh Buckets     Convert Chunks     Drop Chunks
~~~

上层 Policy 不同：

~~~text
Refresh Rule

Storage Transition Rule

Retention Rule
~~~

底层 Automation Framework 是共享的。



### 【Job Config 与 Schedule 分别描述怎么执行和什么时候执行】

查看：

~~~sql
SELECT *
FROM timescaledb_information.jobs;
~~~

会遇到很多字段。

与其逐个平铺记忆，不如把 Job 信息分成四类：

~~~text
Job
│
├── Identity
├── Execution
├── Schedule
└── Failure Policy
~~~

#### <u>1. Identity 描述这个 Job 是谁</u>

主要包括：

~~~text
job_id

application_name

owner

hypertable_name
~~~

例如：

~~~text
Job 1001

Retention Policy

Target:
performance_samples
~~~

其中最重要的是：

~~~text
job_id
~~~

后续修改 Job 时通常需要使用 Job ID。

#### <u>2. Execution 描述这个 Job 实际执行什么</u>

主要包括：

~~~text
proc_schema

proc_name

config
~~~

可以理解：

~~~text
Job
    ↓
调用哪个 Procedure？

Procedure
    ↓
拿到什么 Config？
~~~

例如 Custom Job：

~~~sql
SELECT add_job(
  'process_hourly_reports',
  '1 hour',
  config => '{"hypertable":"metrics"}'
);
~~~

这里：

~~~text
process_hourly_reports
    ↓
执行逻辑

config JSON
    ↓
运行参数
~~~

#### <u>3. Schedule 描述什么时候执行</u>

主要包括：

~~~text
schedule_interval

next_start

initial_start

fixed_schedule

timezone
~~~

第一层可以先把：

~~~text
schedule_interval
~~~

理解成：

~~~text
Job 希望以多大的时间间隔调度
~~~

例如：

~~~text
10 seconds

5 minutes

1 hour
~~~

但真正的 Schedule 不只有一个 Interval，还需要结合：

~~~text
Schedule
│
├── schedule_interval
│   └── 调度间隔
├── fixed_schedule
│   └── 是否按固定时间轴对齐
├── initial_start
│   └── 固定调度的时间锚点
├── timezone
│   └── 固定时间调度的时区语义
└── next_start
    └── Scheduler 实际计算出的下一次运行时间
~~~

所以：

~~~text
schedule_interval
≠
单独决定下一次墙钟执行时间
~~~

Scheduler 真正执行判断时更直接关注：

~~~text
Current Time
    ↓
是否到达 next_start？
~~~

schedule_interval 负责表达调度间隔，而 fixed_schedule / initial_start / timezone 会进一步影响调度如何与时间轴对齐。

#### <u>4. Failure Policy 描述失败后怎样处理</u>

主要包括：

~~~text
max_runtime

max_retries

retry_period
~~~

可以理解：

~~~text
Job Running
    ↓
是否超过 max_runtime？

Failure
    ↓
还能 Retry 几次？

Retry
    ↓
等待多久？
~~~

所以 Job Framework 不只是：

~~~text
定时执行 SQL
~~~

还包含：

~~~text
Execution Lifecycle
+
Failure Handling
~~~



### 【Job Observability 是数据库自动化进入生产后的必要部分】

执行：

~~~sql
add_retention_policy(...)
~~~

返回成功，只能说明：

~~~text
Policy / Job
已经注册
~~~

不能说明：

~~~text
以后每一次执行
都会永久成功
~~~

Job 后续可能因为：

~~~text
Lock

Resource Pressure

SQL Error

Permission

Crash

Timeout

Version Issue
~~~

而失败。

所以：

> **自动化不等于无需监控。**

#### <u>1. jobs 查看系统计划运行什么</u>

查询：

~~~sql
SELECT *
FROM timescaledb_information.jobs;
~~~

主要回答：

~~~text
有哪些 Job？

目标 Hypertable 是谁？

执行哪个 Procedure？

多久运行一次？

下一次什么时候？

是否 Scheduled？

Config 是什么？
~~~

可以理解成：

~~~text
Job Definition / Schedule View
~~~

#### <u>2. job_stats 查看这些 Job 实际运行得怎么样</u>

计划存在以后，还需要知道：

~~~text
到底有没有成功执行？
~~~

因此可以查询 Job 运行统计信息。

重点关注：

~~~text
last_run_status

last_run_started_at

last_successful_finish

total_runs

total_successes

total_failures
~~~

概念上：

~~~text
jobs
    ↓
What should run?

job_stats
    ↓
How has it actually run?
~~~

#### <u>3. job_errors 继续回答为什么失败</u>

如果：

~~~text
last_run_status = Failed
~~~

还需要知道：

~~~text
Why?
~~~

Job Error 信息可以继续提供：

~~~text
Job ID

执行 Procedure

PostgreSQL Error Code

Error Message

Process ID
~~~

所以完整观察链：

~~~text
jobs
    ↓
这个 Job 应该怎么运行？

job_stats
    ↓
它实际运行得怎么样？

job_errors
    ↓
失败原因是什么？
~~~



### 【Job 失败不一定让 API 挂掉，但会让数据库维护状态逐渐失真】

Background Job 的特殊之处在于：

~~~text
它不是用户请求链路
~~~

所以 Job 失败时，经常不会立刻表现成：

~~~text
API 500
~~~

但会让数据库内部状态越来越偏离预期。

#### <u>1. Continuous Aggregate Refresh Job 失败会造成 Aggregate Stale</u>

假设：

~~~text
API
正常

Worker
正常

Raw Data
持续写入
~~~

但是：

~~~text
Continuous Aggregate Refresh Job
失败
~~~

可能结果：

~~~text
performance_samples
持续有新数据

但是

performance_rollup_1m
performance_rollup_1h

越来越旧
~~~

于是 Dashboard 历史统计可能出现：

~~~text
Stale Aggregate
~~~

所以：

~~~text
Raw Data Fresh
≠
Aggregate Fresh
~~~

#### <u>2. Columnstore / Compression Job 失败会让旧 Chunk 一直停留在热存储状态</u>

如果：

~~~text
Compression / Columnstore Job
失败
~~~

可能出现：

~~~text
旧 Chunk
一直保持 Rowstore
~~~

直接后果：

~~~text
Storage Cost ↑

Historical Query Cost ↑

Maintenance Cost ↑
~~~

所以：

~~~text
数据还能查询
~~~

不代表：

~~~text
生命周期策略仍然正常
~~~

#### <u>3. Retention Job 失败会让过期数据不断积累</u>

如果：

~~~text
Retention Job
失败
~~~

那么：

~~~text
30 天 Raw Retention Boundary
~~~

并不会被真正执行。

最终：

~~~text
Old Chunks
持续累积
        ↓
Storage 持续增长
~~~

所以需要固定一个工程边界：

~~~text
Application Health
≠
TimescaleDB Lifecycle Health
~~~

应用接口健康和数据库后台维护健康，需要分别观察。



### 【当前 Browser Monitor 已经注册大量 Policy，但尚未形成 Job Monitoring 闭环】

回到当前项目。

0001_platform.sql 已经创建：

~~~text
4 个 1m Continuous Aggregate Refresh Policies

4 个 Raw Retention Policies

4 个 Aggregate Retention Policies

4 个 Compression Policies
~~~

0002_hourly_aggregates.sql 又增加：

~~~text
4 个 1h Continuous Aggregate Refresh Policies

4 个 1h Aggregate Retention Policies
~~~

0005_custom_observability.sql 又继续增加：

~~~text
2 个 1m Refresh Policies

4 个 Retention Policies

2 个 Compression Policies
~~~

这说明 Migration 完成以后，数据库内部实际上会注册相当数量的 Background Jobs。

#### <u>1. 当前源码可以确认的是 Policy Registration</u>

当前仓库明确存在：

~~~text
add_continuous_aggregate_policy

add_retention_policy

add_compression_policy
~~~

因此可以确认：

~~~text
Policy / Background Job
会被注册
~~~

#### <u>2. 当前源码不能确认已经建立 Job Health Monitoring</u>

目前已读取的仓库资料中，还没有看到应用层主动查询：

~~~text
timescaledb_information.jobs

timescaledb_information.job_stats

timescaledb_information.job_errors
~~~

并建立：

~~~text
Dashboard

Alert

Lag Monitoring
~~~

闭环。

所以必须区分：

~~~text
Confirmed Implementation

Policy / Background Jobs
已经大量注册
~~~

与：

~~~text
Current Source Not Confirmed

还没有确认
TimescaleDB Job Health
已经进入应用监控闭环
~~~

不能把“TimescaleDB 提供可观察能力”直接描述成“当前项目已经实现”。

#### <u>3. Database Maintenance Monitoring 可以形成独立模型</u>

如果未来补全，可以关注：

~~~text
Background Job Health
│
├── Job Inventory
│      ↓
│   jobs
│
├── Freshness
│      ↓
│   last_successful_finish
│   next_start
│
├── Reliability
│      ↓
│   total_runs
│   total_failures
│
├── Error
│      ↓
│   job_errors
│
└── Lag
       ↓
    now - last_successful_finish
~~~

尤其 Continuous Aggregate 的 Refresh Lag 非常关键。

例如：

~~~text
schedule_interval = 10s
~~~

但：

~~~text
last_successful_finish
=
10 分钟以前
~~~

即使：

~~~text
API 返回 200
~~~

也已经说明：

~~~text
Aggregate Maintenance
严重落后
~~~



### 【Custom Job 说明 Job Framework 不只服务内置 Policy】

TimescaleDB Job Scheduler 不只是：

~~~text
Internal Policy Executor
~~~

它还可以注册：

~~~text
User-defined Job
~~~

例如概念上：

~~~sql
SELECT add_job(
  'process_hourly_reports',
  '1h'
);
~~~

或者：

~~~sql
SELECT add_job(
  'process_hourly_reports',
  '1h',
  config => '{"hypertable":"metrics"}'
);
~~~

然后 Scheduler 周期调用对应 PostgreSQL Procedure。

#### <u>1. Custom Job 的基本模型</u>

~~~text
PostgreSQL Procedure
        ↓
add_job(...)
        ↓
Job Registration
        ↓
Scheduler
        ↓
Background Worker
        ↓
Procedure Execution
~~~

因此：

~~~text
TimescaleDB Automation Framework
│
├── Built-in Policy Jobs
│   ├── Refresh
│   ├── Retention
│   └── Columnstore
│
└── Custom Jobs
    └── User Procedure
~~~

#### <u>2. alter_job 修改任务运行配置，而不是重写 Procedure</u>

例如：

~~~sql
SELECT alter_job(
  1000,
  scheduled => false
);
~~~

可以用于：

~~~text
暂停调度
~~~

也可以调整：

~~~text
schedule_interval

next_start

config
~~~

因此需要区分：

~~~text
Procedure
    ↓
What to Do

Job Config
    ↓
How to Run

Schedule
    ↓
When to Run
~~~

#### <u>3. delete_job 删除的是任务注册</u>

例如：

~~~sql
SELECT delete_job(1234);
~~~

表示：

~~~text
Scheduler
不再管理这个 Job
~~~

不等于：

~~~text
删除业务 Table
~~~

也不等于：

~~~text
删除 PostgreSQL Procedure
~~~



### 【TimescaleDB Background Worker 与当前应用 Worker 是两套完全不同的异步系统】

这对 Browser Monitor 特别重要。

当前项目已经有自己的：

~~~text
Application Worker
~~~

负责：

~~~text
Outbox
    ↓
Projection
    ↓
performance_samples
view_records
custom_signal_samples
...
~~~

同时数据库内部还有：

~~~text
TimescaleDB Background Worker
~~~

二者不能混淆。

#### <u>1. Application Worker 属于业务处理层</u>

它运行在：

~~~text
Node.js Application Layer
~~~

负责：

~~~text
业务数据加工
~~~

例如：

~~~text
Raw Telemetry Event
        ↓
Performance Projection
        ↓
performance_samples
~~~

#### <u>2. TimescaleDB Background Worker 属于数据库基础设施层</u>

它负责：

~~~text
Continuous Aggregate Refresh

Columnstore / Compression

Retention

Custom Database Job
~~~

也就是：

~~~text
数据库自动维护
~~~

而不是业务事件处理。

#### <u>3. 当前项目完整异步链可以画成</u>

~~~text
Browser SDK
    ↓
API
    ↓
telemetry_events
    ↓
Application Worker
    ↓
performance_samples
    ↓
TimescaleDB Background Jobs
    ├── Refresh Aggregate
    ├── Columnstore / Compression
    └── Retention
~~~

所以：

~~~text
Application Worker
≠
TimescaleDB Background Worker
~~~

前者解决：

~~~text
业务状态如何加工
~~~

后者解决：

~~~text
数据库如何自动维护
~~~



### 【脱离项目建立完整的 TimescaleDB Automation Framework】

现在可以彻底抽象：

~~~text
                 TimescaleDB Automation
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
         Built-in Policy          Custom Job
              │                       │
      ┌───────┼────────┐              │
      ▼       ▼        ▼              ▼
   Refresh  Column   Retention    User Procedure
              │                       │
              └───────────┬───────────┘
                          ▼
                         Job
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
       Config          Schedule        Retry Policy
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                      Scheduler
                          │
                          ▼
                  Background Worker
                          │
                          ▼
                       Execute
                          │
                    ┌─────┴─────┐
                    ▼           ▼
                 Success      Failure
                    │           │
                    ▼           ▼
                job_stats   job_errors
~~~

这张图就是本节真正需要建立的 TimescaleDB 自动化体系。



### 【生产环境中的 Policy 需要同时设计五个维度】

以后再看到：

~~~sql
add_xxx_policy(...)
~~~

不能只问：

~~~text
参数怎么写？
~~~

而应该同时考虑五个问题。

#### <u>1. Data Selection Rule 决定本轮维护应该处理哪些数据</u>

不同 Policy 的数据选择语义并不完全相同。

Retention / Columnstore 更接近：

~~~text
Age / Eligibility Boundary

older than 24h
older than 30d
~~~

回答的是哪些数据已经满足进入下一个生命周期阶段的条件。

Continuous Aggregate 则是：

~~~text
Refresh Window
=
start_offset
+
end_offset
~~~

例如：

~~~text
now - 29d
        ↓
本轮允许重新计算的历史边界

now - 10s
        ↓
本轮停止刷新的最新边界
~~~

因此更准确的统一模型是：

~~~text
Data Selection Rule
├── Retention / Columnstore
│   └── Eligibility Boundary
└── Continuous Aggregate
    └── Refresh Window
~~~

而不是把所有 Policy 都统一解释成 Trigger Condition。

#### <u>2. Schedule 决定维护任务怎样进入时间轴</u>

schedule_interval 第一层回答系统希望以多大的时间间隔调度；进入实际 Job Framework 后，还需要结合 fixed_schedule、initial_start、timezone 与 next_start 判断真正的下一次执行时间。

#### <u>3. Dependency 决定多个 Policy 的数据边界和先后关系</u>

多个 Background Jobs 可能共同维护同一条 Data Lifecycle，因此不能把每个 Policy 都当成彼此独立的定时任务。

~~~text
Raw Hypertable
        ↓
CAGG Refresh
        ↓
Aggregate Materialized

Raw Chunk
        ↓
Columnstore / Compression

Raw Chunk
        ↓
Retention / Drop
~~~

如果 Raw Retention 已经删除某个时间范围，而后续 CAGG Refresh 仍需要重新读取该范围，就可能破坏原本希望维持的 Aggregate 结果。

因此需要判断：

~~~text
CAGG Refresh Window
        ↓
是否已经覆盖需要的 Raw Data

Columnstore Boundary
        ↓
是否与仍需频繁刷新的时间窗口协调

Retention Boundary
        ↓
是否晚于仍然依赖 Raw Data 的维护阶段
~~~

Production Policy Design 不只是判断每个 Job 多久运行一次，还要判断多个 Job 是否维护同一条数据生命周期，以及它们之间是否存在 Data Dependency。

#### <u>4. Cost 决定后台维护会消耗多少数据库资源</u>

Job 执行会占用 CPU、Memory、I/O、Locks 与 Worker Capacity，因此不能把所有 Job 都配置成最高频率而忽略资源竞争。Job 本身也是数据库 Workload，需要容量治理。

#### <u>5. Observability 决定自动化是否真的健康</u>

每个 Policy 都应该能够回答最近成功时间、失败状态、失败次数、Lag 与下一次运行时间。

所以完整的 Policy Design 应该包含：

~~~text
Data Selection Rule
+
Schedule
+
Dependency
+
Resource
+
Observability
~~~

而不是只包含：

~~~text
Retention = 30 days
~~~



### 【第六节收束：TimescaleDB 具备数据库内部 Automation & Operations Framework】

这一节真正建立的是：

~~~text
TimescaleDB Automation
│
├── 一、Policy
│   └── 声明数据库希望维持什么状态
│
├── 二、Job
│   └── 把 Policy 转换成可调度执行任务
│
├── 三、Scheduler / Worker
│   └── 决定什么时候运行并真正执行
│
└── 四、Observability
    ├── jobs
    ├── job_stats
    └── job_errors
~~~

前面六节现在可以连接成：

~~~text
TimescaleDB
│
├── Storage Organization
│   └── Hypertable / Chunk
│
├── Query
│   └── Time Range / time_bucket
│
├── Precomputation
│   └── Continuous Aggregate
│
├── Storage Lifecycle
│   └── Rowstore / Columnstore / Retention
│
└── Automation
    └── Policy / Job / Scheduler / Worker
~~~

这意味着 TimescaleDB 不只是：

~~~text
一个能够存储 Time-Series Data
的 PostgreSQL Extension
~~~

而是进一步具备：

> **主动维护时序数据生命周期的数据库内部自动化框架。**

#### <u>当前项目最终映射</u>

~~~text
Application
│
├── API
│
└── Node Worker
│      ↓
│   业务数据加工
│
▼
PostgreSQL + TimescaleDB
│
├── Raw Hypertables
│
├── Continuous Aggregates
│
└── Background Job Framework
    │
    ├── 1m Refresh Jobs
    │
    ├── 1h Refresh Jobs
    │
    ├── Compression Jobs
    │
    └── Retention Jobs
~~~

当前源码已经完成：

~~~text
Policy Registration
~~~

但从目前已读取仓库资料中，还不能确认已经建立：

~~~text
Job Monitoring
+
Failure Alert
+
Refresh Lag Alert
~~~

这应该作为：

~~~text
当前实现
~~~

与：

~~~text
完整生产治理体系
~~~

之间的边界。





### 【已经建立的可迁移知识】

1. **时序数据不等于“带一个时间字段”**。核心是持续追加、按时间范围查询和历史生命周期管理。
2. **TimescaleDB 不是 PostgreSQL 的替代品**；它是在 PostgreSQL 之上集成专门的时序存储、聚合和后台管理能力。
3. **Hypertable 是统一的逻辑访问入口，Chunk 是真正的数据存储块**；应用不需要自己选择目标物理表。
4. **时间分区和索引不是同一回事**：分区裁剪减少要考虑的数据块，索引帮助在相关数据中定位目标记录。
5. **按发生时间分块决定了迟到事件的归属**；`occurred_at` 和 `received_at` 应分别理解。
6. **压缩不同于清理**：压缩仍保留数据；Retention 通过清理过期数据块控制增长。
7. **不能仅依据配置宣称性能与运行结果已验证**：真实 Chunk 间隔、存储状态、Job 执行和查询计划都需在运行实例里核实。
8. **案例不应占据通用问题的中心**：项目字段、SQL 和源代码用于解释并验证通用机制。

### 【运行数据库验证的问题与方法】

**通用问题：** 通过 Schema、Migration 和策略配置，我们知道数据库“应该怎样工作”；怎样从实际运行数据判断 Chunk、索引、压缩、Continuous Aggregate、Retention 与后台任务是否真的实现目标，并区分性能问题和数据正确性问题？

下一轮按证据链推进：
- 用 `timescaledb_information.dimensions`、`chunks` 等元数据检查真实 Chunk Interval、时间范围、压缩状态与存储大小；
- 用 `EXPLAIN (ANALYZE, BUFFERS)` 验证典型查询的 Chunk Pruning、索引选择和资源消耗；
- 用压缩统计及执行计划核实压缩率及压缩后查询的性能取舍；
- 检查 Continuous Aggregate 物化水位、自动刷新范围和与源数据对照的统计结果；
- 检查 retention/compression/refresh Job 是否确实成功执行，而不是仅创建成功；
- 建立最小化、可复现的容量和迟到事件校验步骤，区分“源码能证明的配置”“SQL 可验证的运行状态”“必须通过实测得到的结论”。

保留完整理论—运行—源码衔接，暂不引入与本题无关的中间件机制。


### 【资料与源码索引（原专题参考来源）】



[1] Browser Monitor Platform. browser-monitor/platform/README.md. 当前项目完整链路定义为 Monitor SDK → Ingestion API → telemetry_events + Outbox → Worker → TimescaleDB 聚合 → Analytics API → React 看板。

[2] Browser Monitor Platform. browser-monitor/platform/infra/docker-compose.yml. 当前项目通过 timescale/timescaledb-ha:pg17 提供 PostgreSQL / TimescaleDB 数据服务，应用仍通过 postgres:// 与 5432 端口连接。

[3] Browser Monitor Platform. browser-monitor/platform/packages/database/migrations/0001_platform.sql. 当前 Migration 启用 timescaledb 与 timescaledb_toolkit Extension，并定义 telemetry_events、performance_samples、view_records 等 Hypertable，以及 Continuous Aggregate、Retention 与 Compression Policy。

[4] Tiger Data Documentation. TimescaleDB 是 PostgreSQL Extension，在 PostgreSQL 之上增加面向 Time-Series / Analytics Workload 的 Hypertable、Continuous Aggregate 与生命周期能力。https://www.tigerdata.com/docs


[5] Tiger Data. Hypertables and Chunks. Hypertable 对应用表现为 PostgreSQL Table，底层由多个按时间范围组织的 Chunk 子表组成。https://www.tigerdata.com/docs/learn/hypertables/understand-hypertables

[6] Tiger Data. Database indexes in PostgreSQL and Timescale. Hypertable 的索引会作用到各个 Chunk，Chunk 与 Index 共同构成时序查询的物理访问路径。https://www.tigerdata.com/blog/database-indexes-in-postgresql-and-timescale-cloud-your-questions-answered

[7] Tiger Data. Scale PostgreSQL via partitioning and hypertables. Hypertable 的时间分区、唯一约束与分区列设计。https://www.tigerdata.com/blog/scale-postgresql-via-partitioning-hypertables


[8] Tiger Data. time_bucket. time_bucket 用于把时间值映射到固定统计区间，是查询与聚合函数，不负责创建或管理 Hypertable Chunk。https://www.tigerdata.com/docs/api/latest/hyperfunctions/time_bucket/

[9] Browser Monitor Platform. browser-monitor/platform/apps/api/src/analytics/analytics.service.ts. performance() 使用 filters、time_bucket、GROUP BY、percentile_cont 与 view_points 的 bucket join 构建分钟级性能趋势；rawEvents() 使用 Time Range、时间排序和 Cursor Pagination 返回原始事件。

[10] PostgreSQL Documentation. Using EXPLAIN. 实际 Index Scan、Sequential Scan、Aggregate 等执行方式由 PostgreSQL Planner 根据成本与统计信息决定，可通过 EXPLAIN / EXPLAIN ANALYZE 验证。https://www.postgresql.org/docs/current/using-explain.html


[11] Tiger Data. Continuous Aggregates. Continuous Aggregate 将时序聚合结果物化并通过增量刷新维护，避免每次查询都重新扫描完整历史。https://www.tigerdata.com/learn/continuous-aggregates-timescaledb

[12] Browser Monitor Platform. browser-monitor/platform/packages/database/migrations/0002_hourly_aggregates.sql. 当前项目从 1m Continuous Aggregate 继续生成 1h Hierarchical Continuous Aggregate，并配置独立 Refresh Policy 与 Retention。

[13] Browser Monitor Platform. browser-monitor/platform/apps/api/src/analytics/analytics.service.ts. 当前 useRollups() 以约 29 天为边界：近期查询直接读取 Raw Detail，历史查询读取 1h Rollup。


[14] Tiger Data. Hypercore and columnstore. TimescaleDB 当前以 Hypercore 描述混合 Rowstore / Columnstore 体系，新数据保持适合高频写入的 Rowstore，历史数据可转入 Columnstore。https://www.tigerdata.com/docs/learn/columnar-storage/understand-hypercore

[15] Tiger Data. PostgreSQL compression and columnstore. 当前 API 方向使用 enable_columnstore、segmentby、orderby 与 add_columnstore_policy；Browser Monitor 当前源码仍使用旧 Compression API。https://www.tigerdata.com/learn/postgresql-compression

[16] Tiger Data. Moving from row deletes to instant data retention. Time-series retention 可以利用 Chunk 生命周期直接删除过期时间分区，而不是逐 Row DELETE。https://www.tigerdata.com/blog/moving-from-row-deletes-to-instant-data-retention

[17] Browser Monitor Platform. browser-monitor/platform/packages/database/migrations/0001_platform.sql. 当前项目为 Raw Hypertable 配置旧 Compression API、24h Compression Policy、30d Raw Retention，以及 180d Continuous Aggregate Retention。


[18] Tiger Data. Background jobs and policies. TimescaleDB 的 Continuous Aggregate、Retention、Columnstore 等自动化能力通过数据库内部 Background Job Framework 调度执行。https://www.tigerdata.com/docs/use-timescale/latest/jobs/

[19] Tiger Data. User-defined actions and add_job. TimescaleDB 除内置 Policy Job 外，也支持通过 add_job 注册自定义 PostgreSQL Procedure 作为后台任务。https://www.tigerdata.com/docs/api/latest/actions/add_job/

[20] Tiger Data. Informational views for jobs. timescaledb_information.jobs、job_stats 与 job_errors 分别用于查看 Job 定义、执行统计与错误信息。https://www.tigerdata.com/docs/api/latest/informational-views/jobs/

[21] Browser Monitor Platform. browser-monitor/platform/packages/database/migrations/0001_platform.sql、0002_hourly_aggregates.sql、0005_custom_observability.sql. 当前项目已经注册多组 Continuous Aggregate Refresh、Compression 与 Retention Policy，但当前已读取源码尚未确认针对 TimescaleDB Job Health 的应用层监控闭环。

[22] Tiger Data. Jobs informational view. timescaledb_information.jobs 暴露 schedule_interval、fixed_schedule、initial_start、timezone、next_start 等 Job 调度字段，用于区分调度间隔与实际下一次运行时间。https://docs.tigerdata.com/api/latest/informational-views/jobs/

[23] Tiger Data. Continuous aggregate refresh policies. Continuous Aggregate 的 start_offset 与 end_offset 共同定义 Refresh Window，而不是普通的一次性 Trigger Condition。https://docs.tigerdata.com/use-timescale/latest/continuous-aggregates/refresh-policies/

[24] Tiger Data. Data retention with continuous aggregates. Raw Retention 与 Continuous Aggregate Refresh Window 之间存在数据依赖；Retention Boundary 需要避免删除后续 Refresh 仍然依赖的 Raw Data。https://docs.tigerdata.com/use-timescale/latest/data-retention/data-retention-with-continuous-aggregates/

[25] Tiger Data. Hierarchical continuous aggregates. Hierarchical Continuous Aggregate 可以建立在另一个 Continuous Aggregate 上；Higher-level Bucket 需要与 Lower-level Bucket 兼容，并且 Real-time Aggregate 的传播会受到各层 materialized_only 配置影响。https://docs.tigerdata.com/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates/

[26] Tiger Data. Troubleshooting continuous aggregates. Hierarchical Continuous Aggregate 在 Bucket Width 不兼容时会拒绝创建，用于说明 Parent / Child Bucket 需要满足兼容关系。https://docs.tigerdata.com/use-timescale/latest/continuous-aggregates/troubleshooting/

[27] Browser Monitor Platform. browser-monitor/platform/packages/database/migrations/0002_hourly_aggregates.sql. 当前项目的 performance/view/custom_event/telemetry 1h CAGG 均直接读取对应 1m CAGG，并通过 Weighted Average、rollup(percentile state) 与 rollup(HLL state) 构造 Higher-level Aggregate；1h Refresh 使用 179d start_offset，而 1m CAGG Retention 为 180d。

[28] TimescaleDB Toolkit. Two-step aggregation design. Two-step Aggregation 将聚合拆成可复用的中间 Aggregate State 与 Accessor，使中间状态可以保存、重新聚合并用于 Continuous Aggregate。https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md

[29] Tiger Data. Percentile approximation hyperfunctions. percentile_agg 生成可继续 rollup 的 Percentile Aggregate State，approx_percentile 负责从该 State 读取最终分位值。https://docs.tigerdata.com/api/latest/hyperfunctions/percentile-approximation/uddsketch/

[30] Tiger Data. HyperLogLog hyperfunctions. HyperLogLog State 用于近似 Distinct Count，并可以通过 rollup 合并后由 distinct_count 读取最终结果。https://docs.tigerdata.com/api/latest/hyperfunctions/approximate-count-distinct/hyperloglog/

[31] Browser Monitor Platform. browser-monitor/platform/packages/database/migrations/0001_platform.sql、0002_hourly_aggregates.sql 与 browser-monitor/platform/apps/api/src/analytics/analytics.service.ts. 当前项目真实使用 percentile_agg / hyperloglog 生成 1m Intermediate Aggregate State，通过 rollup 构造更大范围 State，并在 Query Time 通过 approx_percentile / distinct_count 读取最终结果。
