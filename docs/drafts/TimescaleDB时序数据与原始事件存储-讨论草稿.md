# TimescaleDB 时序数据与原始事件存储——讨论草稿

> **状态：持续学习中的讨论草稿，不是已定稿的知识正文。** 当前记录涵盖时序数据管理需求、Hypertable/Chunk、Chunk 时间跨度、Chunk Pruning 与复合 B-Tree、分区主键与业务幂等、普通时间窗口聚合、连续聚合的物化水位和刷新，以及历史 Chunk 压缩机制。后续保持**每次抛出一个通用问题并直接展开回答**的方式，不转换为面试题。
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
6. 时间窗口聚合如何从原始事件得出趋势结果？先理解 GROUP BY 和 time_bucket。（已讨论）
7. Continuous Aggregate 为什么需要物化结果、失效记录与自动刷新？（已讨论；水位、历史修改与实时查询已追问）
8. 历史 Chunk 的压缩如何工作？行存储、压缩布局和压缩策略有什么区别？（已讨论）
9. Retention 如何自动清理过期 Chunk？它与原始明细、历史聚合的保留期如何协调？（下一轮）
10. 在上述机制已经建立后，再讨论迟到数据、乱序写入如何影响历史 Chunk、刷新窗口和数据保留。
11. 如何用真实 SQL、执行计划和后台 Job 状态验证运行效果？

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

本节解释数据库唯一性与业务幂等；迟到数据造成的历史 Chunk、压缩和统计影响，需要在掌握时间聚合、连续聚合、压缩与 Retention 的基本机制后再讨论。

## 8. 通用问题：为什么需要将原始事件按时间窗口聚合

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

源码：[0001_platform.sql](../../platform/packages/database/migrations/0001_platform.sql)。

**当前这段真实 SQL 实际出现在 Continuous Aggregate 的 CREATE MATERIALIZED VIEW 定义中。** 在本轮只解释其中 \`time_bucket / GROUP BY / count\` 的基础聚合语义；物化结果及刷新机制留给下一轮，避免一次抛出太多前置知识。

### 【为什么基础聚合还不足以应对重复历史查询】

普通的 \`SELECT ... GROUP BY\` 定义了如何计算一次统计结果，但它**不会仅因为执行过一次 SELECT 就自动持久化结果，供下次按同样条件直接复用**。

如果原始事件表规模很大，历史看板频繁请求相同时间范围，每次重读并重新聚合原始行可能浪费资源。PostgreSQL 的普通物化视图可以保存查询结果，却需要管理刷新，而不是默认自动按时序变化精细维护。

因此自然引出下一轮：**Continuous Aggregate 如何保存时间窗口结果，增量发现变更并刷新，而不是每次完整重新聚合所有历史？**

本轮小结：\`time_bucket\` 是时间归桶函数，\`GROUP BY\` 是分组规则，\`COUNT\` 等是统计计算；物理 Chunk 是存储粒度，时间桶是统计粒度，两者既可共存也不可混淆。


## 9. 通用问题：Continuous Aggregate 为什么要保存聚合结果并持续刷新

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

源码：[0001_platform.sql](../../platform/packages/database/migrations/0001_platform.sql)。

### 【实时聚合为什么有必要】

如果最新的一分钟尚未完成物化，只查询已经保存的历史统计，就可能看不到最近收到的事件。为此可启用：

~~~sql
ALTER MATERIALIZED VIEW telemetry_rollup_1m
SET (timescaledb.materialized_only = false);
~~~

此配置表示 Continuous Aggregate 查询**不局限于已物化结果**，可把物化水位之后、尚未物化的原始事件在查询时临时分桶聚合后纳入结果。此行为是数据库 SELECT 的查询方式，**不意味着更新了物化存储、不意味着有 WebSocket 推送，也不承诺已经物化的历史改变会即时更新**。

项目源码：[0003_realtime_aggregates.sql](../../platform/packages/database/migrations/0003_realtime_aggregates.sql)。

资料：[Timescale 连续聚合的运行机制](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)、[刷新策略与窗口](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/refresh-policies/)、[实时聚合](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/real-time-aggregates/)。

## 10. 追问：物化水位什么时候推进，已物化历史与未物化数据怎样分别处理

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


## 11. 通用问题：为什么需要压缩历史 Chunk，压缩后如何存储与查询

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

源码：[0001_platform.sql](../../platform/packages/database/migrations/0001_platform.sql)。

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


## 12. 当前知识进度与后续讨论

### 【已经建立的可迁移知识】

1. **时序数据不等于“带一个时间字段”**。核心是持续追加、按时间范围查询和历史生命周期管理。
2. **TimescaleDB 不是 PostgreSQL 的替代品**；它是在 PostgreSQL 之上集成专门的时序存储、聚合和后台管理能力。
3. **Hypertable 是统一的逻辑访问入口，Chunk 是真正的数据存储块**；应用不需要自己选择目标物理表。
4. **时间分区和索引不是同一回事**：分区裁剪减少要考虑的数据块，索引帮助在相关数据中定位目标记录。
5. **按发生时间分块决定了迟到事件的归属**；`occurred_at` 和 `received_at` 应分别理解。
6. **压缩不同于清理**：压缩仍保留数据；Retention 通过清理过期数据块控制增长。
7. **不能仅依据配置宣称性能与运行结果已验证**：真实 Chunk 间隔、存储状态、Job 执行和查询计划都需在运行实例里核实。
8. **案例不应占据通用问题的中心**：项目字段、SQL 和源代码用于解释并验证通用机制。

### 【下一轮只讨论一个问题：Retention 为什么按 Chunk 清理历史数据】

**通用讨论问题：** 一张 Hypertable 可能积累几千万条历史事件。为什么 TimescaleDB 倾向于根据保留窗口删除完整的旧 Chunk，而不是每天对所有过期 Row 执行一条巨大的 DELETE？

下一轮依次讨论：
- DELETE 的 MVCC 死元组、WAL、索引维护与 VACUUM 成本；
- DROP 旧 Chunk 与逐行删除的本质差异；
- drop_after 与 Chunk 结束时间、调度执行时刻怎样决定实际清理；
- 压缩过的 Chunk 如何参与同样的生命周期；
- 原始事件 30 天、分钟与小时聚合 180 天的配置关系；
- 连续聚合不能因源数据清理而无条件假定历史统计始终保留，什么时候需要协调 Refresh 和 Retention。

之后再讨论迟到事件、历史修改对这些已学机制的影响，不提前展开未讲的异常情形。
