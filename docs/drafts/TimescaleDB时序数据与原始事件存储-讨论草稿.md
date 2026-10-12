# TimescaleDB 时序数据与原始事件存储——讨论草稿

> **状态：持续学习中的讨论草稿，不是已定稿的知识正文。** 当前记录涵盖“持续增长的时序数据为什么需要专门管理”与“Hypertable / Chunk 怎样组织一条原始事件”。后续保持**每次抛出一个通用问题并直接展开回答**的方式，不转换为面试题。
>
> **讲解规范**：先交代项目案例中数据的来源、目标和必要角色，再抛出能用于其他业务的通用技术问题；解释原理、具体机制与工程取舍之后，最后才对照实际源码。不要预设读者认识 `Ingestion`、`telemetry_events` 或其他项目变量。
>
> **范围**：以原始事件从浏览器产生、服务端接收和预处理，到入库、时间分块、查询、压缩、保留的生命周期为案例；本阶段不展开 Outbox、Worker 及异步任务的内部协作。
>
> **已有文档的关系**：[服务端数据管理源码学习](../服务端数据管理源码学习.md)涵盖关系型数据库、表、索引；[服务端数据管理源码学习-2](../服务端数据管理源码学习-2.md)涵盖事务与并发；[服务端数据管理源码学习-3](../服务端数据管理源码学习-3.md)已有 TimescaleDB 专题。本草稿更聚焦“原始事件从写入到删除”的连贯案例，后续整理时需对照旧知识查缺补漏，避免重复建设。

## 1. 学习框架与贯穿实例

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
3. Chunk 的时间跨度怎样选，过大或过小会造成什么影响？（下一轮）
4. 时间分区、B-Tree 索引与 JSONB 查询各有什么职责？
5. 事务、主键和唯一性在时间分区表中怎么设计？
6. 乱序事件、迟到写入会带来什么存储与聚合影响？
7. 时间聚合与 Continuous Aggregate 解决什么问题？
8. 压缩、Retention 和后台 Job 怎样管理旧数据？
9. 如何用真实 SQL 与执行计划验证数据存储和查询效率？

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

源码：[服务端数据接入](../../platform/apps/api/src/ingestion/ingestion.service.ts)、[建表与 TimescaleDB 迁移](../../platform/packages/database/migrations/0001_platform.sql)。

## 2. 通用问题：为什么带时间字段的表仍然会需要专门的时序管理

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

## 3. 通用问题：为什么应用只访问一张表，数据却会进入不同 Chunk

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

源码：[IngestionService](../../platform/apps/api/src/ingestion/ingestion.service.ts)。

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

## 4. 已接触到的历史生命周期：压缩和保留不是同一件事

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

## 5. 本轮结论、工程边界与下轮讨论

### 【已经建立的可迁移知识】

1. **时序数据不等于“带一个时间字段”**。核心是持续追加、按时间范围查询和历史生命周期管理。
2. **TimescaleDB 不是 PostgreSQL 的替代品**；它是在 PostgreSQL 之上集成专门的时序存储、聚合和后台管理能力。
3. **Hypertable 是统一的逻辑访问入口，Chunk 是真正的数据存储块**；应用不需要自己选择目标物理表。
4. **时间分区和索引不是同一回事**：分区裁剪减少要考虑的数据块，索引帮助在相关数据中定位目标记录。
5. **按发生时间分块决定了迟到事件的归属**；`occurred_at` 和 `received_at` 应分别理解。
6. **压缩不同于清理**：压缩仍保留数据；Retention 通过清理过期数据块控制增长。
7. **不能仅依据配置宣称性能与运行结果已验证**：真实 Chunk 间隔、存储状态、Job 执行和查询计划都需在运行实例里核实。
8. **案例不应占据通用问题的中心**：项目字段、SQL 和源代码用于解释并验证通用机制。

### 【下一轮只讨论一个问题：Chunk 的时间跨度如何确定】

**通用讨论问题：** 一张时序表会按时间不断形成 Chunk。为什么不能简单地让每个 Chunk 都非常小，或者把一个 Chunk 定得非常大？应该根据什么判断分区时间跨度？

下一轮围绕：
- 数据产生速度怎样决定单个 Chunk 的行数和数据大小；
- Chunk 的数量怎样影响查询规划、元数据和索引内存；
- 活跃 Chunk 和多个并行写入目标之间的关系；
- 历史迟到事件怎样使写入落到旧 Chunk；
- 时间块大小怎样影响保留策略清理的粒度；
- 最后结合 `telemetry_events` 当前**未显式设置 Chunk Interval**的事实，说明如何查看真实配置与运行数据。

本草稿按照本轮讨论的顺序保留完整的因果链。后续每次补充讨论内容时，先检查已有章节是否重复，再确定新增位置；**不因摘要化而省略源码、机制、限制与重要讨论结果**。
