# TimescaleDB 时序数据与原始事件存储——讨论草稿

> **状态：持续学习中的讨论草稿，不是已定稿的知识正文。** 当前记录涵盖时序数据管理需求、Hypertable/Chunk、Chunk 时间跨度，以及 Chunk Pruning 与复合 B-Tree 索引如何协作。后续保持**每次抛出一个通用问题并直接展开回答**的方式，不转换为面试题。
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
3. Chunk 的时间跨度怎样选，过大或过小会造成什么影响？（已讨论）
4. 时间分区、B-Tree 索引与 JSONB 查询各有什么职责？（已讨论：分区与复合 B-Tree；JSONB 索引为延伸专题）
5. 事务、主键和唯一性在时间分区表中怎么设计？（已讨论）
6. 乱序事件、迟到写入会带来什么存储与聚合影响？（下一轮）
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

## 5. 通用问题：Chunk 的时间跨度如何确定，为什么过大或过小都不理想

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

源码：[原始事件表及时间分区配置](../../platform/packages/database/migrations/0001_platform.sql)。当前没有连接运行数据库进行查询，故不能假造实际 Chunk 数量、大小及压缩执行日期。

### 【本轮结论与下一轮衔接】

**Chunk Interval 不是单纯的“时间精度”参数，而是同时影响活跃索引工作集、分区数量、查询裁剪、数据压缩和历史淘汰粒度的物理设计。**

选取方法是先测写入速度和索引大小，再结合可用内存、典型查询范围以及历史保留要求确定初始候选，最后用真实数据库计划与数据规模核验。不能推断“越小必然越快”或“越大必然越省资源”。

下一轮只推进一个通用问题：**时间分区（Chunk Pruning）与 B-Tree 索引为什么需要同时存在，二者分别在哪个范围解决查询问题？** 仍使用经过业务说明的原始事件表和查询 SQL 作为验证案例，不预设已有项目知识。

## 6. 通用问题：有时间分区了，为什么仍然需要 B-Tree 索引

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

查询入口在：[analytics.service.ts](../../platform/apps/api/src/analytics/analytics.service.ts)。业务界面允许用户选择项目、时间范围，并可选事件类型、名称、Session、View、Event ID 等筛选项。

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

## 7. 通用问题：时间分区主键为什么包含时间字段

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

源码：[原始事件表结构](../../platform/packages/database/migrations/0001_platform.sql)。

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

源码：[接入服务的完整事务逻辑](../../platform/apps/api/src/ingestion/ingestion.service.ts)。

### 【实现边界与结论】

- 咨询锁只协调遵循同样锁约定的业务写入者。绕开服务直接 INSERT 时，同事件 ID 不同时间仍可能进入表。
- 原始事件表有 30 天保留策略，历史记录被清除后，单靠当前 telemetry_events 无法判断更早是否出现过某个 ID。若业务需要永久幂等，应考虑单独且有匹配保留期限的事件唯一登记机制。
- 不附带分区时间条件的全历史 event_id 去重查询可能扫描更多 Chunk；是否形成瓶颈必须通过实际数据和 EXPLAIN 判断。

**结论：数据库主键确保明确定义的键组合唯一，业务幂等根据“同一次事实”的身份定义。时序分区下两者通常需要协同设计。**

下一轮讨论事件发生时间与接收时间不同，为什么会产生迟到数据、历史 Chunk 写入和统计更新问题。

## 8. 当前知识进度与后续讨论

### 【已经建立的可迁移知识】

1. **时序数据不等于“带一个时间字段”**。核心是持续追加、按时间范围查询和历史生命周期管理。
2. **TimescaleDB 不是 PostgreSQL 的替代品**；它是在 PostgreSQL 之上集成专门的时序存储、聚合和后台管理能力。
3. **Hypertable 是统一的逻辑访问入口，Chunk 是真正的数据存储块**；应用不需要自己选择目标物理表。
4. **时间分区和索引不是同一回事**：分区裁剪减少要考虑的数据块，索引帮助在相关数据中定位目标记录。
5. **按发生时间分块决定了迟到事件的归属**；`occurred_at` 和 `received_at` 应分别理解。
6. **压缩不同于清理**：压缩仍保留数据；Retention 通过清理过期数据块控制增长。
7. **不能仅依据配置宣称性能与运行结果已验证**：真实 Chunk 间隔、存储状态、Job 执行和查询计划都需在运行实例里核实。
8. **案例不应占据通用问题的中心**：项目字段、SQL 和源代码用于解释并验证通用机制。

### 【下一轮只讨论一个问题：迟到事件与乱序写入】

**通用讨论问题：** 时序数据按发生时间分区，但到达数据库的时间可能晚于发生时间甚至乱序。它会如何影响时间分块、已压缩历史数据、过期删除和历史统计？

下一轮结合原始事件的发生时间 occurred_at、接收时间 received_at、服务端允许的时间窗口，以及数据库 24 小时压缩、30 天保留和连续聚合的实际策略，区分已有代码保证、时序数据库通用机制和待运行验证的问题。
