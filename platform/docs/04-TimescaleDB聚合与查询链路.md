# TimescaleDB 聚合与查询链路

监控数据既需要逐条追溯，也需要按时间、页面和版本快速统计。只保存聚合会失去审计能力，只查询原始 JSON 又无法稳定支撑分位数和长时间趋势。平台因此保留原始事实、领域明细和时间聚合三个层次，并由 Analytics API 根据查询跨度选择合适的数据源。

## 1. 三层数据模型

### 【原始事实层】

`telemetry_events` 保存协议事件和常用检索维度，包括 eventId、发生与接收时间、类型、名称、环境、版本、Session、View、routeName 和服务端清理后的完整事件。它用于原始事件检索、处理状态确认和问题追溯。

原始表不会直接承担所有指标查询。Performance 的多次 sequence、View 的开始与结束以及自定义事件属性具有不同语义，必须先经过 Worker 投影。

### 【领域明细层】

| 表 | 关键内容 | 查询作用 |
| --- | --- | --- |
| `performance_samples` | 当前最高 sequence、数值、state、服务端评级、阈值版本、LoAF 扩展值 | 性能统计和页面性能排名 |
| `view_records` | View 开始、结束、页面、Session、环境和版本 | PV、会话数、覆盖率 |
| `custom_event_samples` | 事件名、页面和清理后属性 | 业务事件趋势与分布 |

Performance 表表示“当前样本”，不是“每次协议更新”。Worker 在同一个 sampleId 上原位应用更高 sequence，使分位数和计数只看到一次观测。

### 【聚合层】

数据库分别维护一分钟和一小时粒度的 Rollup：

- `performance_rollup_1m`、`performance_rollup_1h`；
- `view_rollup_1m`、`view_rollup_1h`；
- `custom_event_rollup_1m`、`custom_event_rollup_1h`；
- `telemetry_rollup_1m`、`telemetry_rollup_1h`。

一分钟聚合服务近期趋势，一小时聚合服务跨度较大的历史查询。`0001_platform.sql` 在基础表和 Hypertable 就绪后创建分钟聚合；`0002_hourly_aggregates.sql` 再基于已经提交的分钟聚合创建小时级分层聚合。小时聚合中的时间表达式与分钟聚合的输入列都名为 `bucket`，因此 SQL 使用位置序号分组，确保 `GROUP BY` 指向新计算出的小时 bucket，而不是输入的一分钟 bucket。第三份迁移将全部聚合设置为 realtime，使已物化范围之外的近期明细可以与聚合结果共同参与查询，而不必等到下一次物化后才可见。

## 2. Hypertable 和时间维度

### 【为什么以 occurredAt 分区】

遥测查询通常围绕“事件什么时候发生”，因此原始和领域明细按 `occurred_at` 或 `observed_at` 建立 Hypertable。接收时间仍然保留，用来分析客户端到平台的延迟，但看板时间范围以用户体验实际发生时间为主。

每个查询都要求项目 ID 和半开时间区间 `[from, to)`。半开区间可以让相邻窗口首尾相接而不重复计算边界记录，也能帮助 TimescaleDB 裁剪不相关时间分区。

### 【常用过滤维度为什么单独存列】

环境、应用版本和 routeName 不只存在 JSON Event 中，也投影为普通列。Analytics 如果每次都从 JSON 读取这些维度，将难以建立有效索引，也会让 SQL 和类型转换复杂化。常用稳定维度列化，完整事件仍保留在 JSON 中，兼顾查询性能与追溯信息。

## 3. Performance 聚合口径

### 【基础统计和分位数】

每个指标、环境、版本、页面和时间桶计算 sample count、最小值、最大值、平均值、p50、p75、p90 与 p95。分位数使用 Timescale Toolkit 的 percentile aggregate 状态，小时 Rollup 可以继续合并分钟或明细生成的中间状态，而不是对已经算出的 p75 再求平均。

平均值跨桶合并时按 `average * sample_count` 加权，再除以总样本数。直接平均多个桶的 average 会让只有少量样本的桶与高流量桶获得相同权重。

### 【评级、覆盖率和 LoAF】

聚合分别计数 good、needs-improvement 和 poor。异常率使用后两者之和除以有效评级样本数。会话和 View 数通过 HyperLogLog 中间状态计算可合并的近似去重数量，覆盖率为有该指标的 View 数除以页面访问 View 数。

LoAF 不产生强制评级，聚合 duration 分位数、blocking duration 总量和 script count。页面排名还计算每千次页面访问的 LoAF 数量：

```text
LoAF per 1000 views = LoAF sample count × 1000 / page views
```

它比单纯次数更能区分“页面访问量大所以事件多”和“单次访问更容易发生长动画帧”。

## 4. 查询源选择

### 【近 29 天查询】

当 from 位于最近 29 天内，Analytics 直接查询领域明细，并按一分钟分桶。明细数据保留 30 天，预留一天边界可以避免查询刚好跨越即将清理的分区。近期查询能够读取最新 sequence、状态和所有细维度。

### 【更长时间查询】

当 from 早于 29 天，API 切换到一小时 Rollup。小时聚合保留 180 天，查询通过 `rollup()` 合并 percentile 和 HyperLogLog 中间状态，重新得到整个时间范围的分位数与去重计数。

这种切换不是把两种结果简单拼在前端，而是在服务端选择完整覆盖查询区间的数据源。若未来需要同时返回近期分钟点和历史小时点，应明确设计多粒度响应，不能让相同时间段由明细与 Rollup 重复贡献。

## 5. Analytics API

### 【统一过滤条件】

主要接口支持：

```text
from、to、environment、version、routeName、metric
```

Controller 将输入转换为受限的日期、字符串和分页参数，Service 以参数化 SQL 构建条件。所有路径位于 `/api/v1/projects/:projectId/analytics` 下，执行 SQL 前先调用项目访问校验，不能仅依靠前端隐藏菜单实现隔离。

### 【查询能力】

| 接口 | 输出重点 |
| --- | --- |
| `overview` | View、Session、事件总量和各指标总体健康度 |
| `performance` | 时间点、分位数、评级分布、覆盖率和 LoAF 扩展值 |
| `routes` | routeName + 指标的 p75、样本量、异常率和页面访问量 |
| `events` | 自定义事件按时间、名称和页面的数量 |
| `raw-events` | 原始协议事件和处理上下文 |
| `service-status` | 采集、消费、积压、失败和死信 |

页面排名查询故意移除传入的 routeName 过滤，因为它要在其他过滤条件下比较多个页面；性能详情则可以用 routeName 聚焦单个页面。

## 6. 原始事件游标分页

### 【为什么不用 offset】

时序表持续写入，较大的 offset 需要数据库扫描并丢弃越来越多的行，而且新事件插入会使页面位置变化。平台按 `(occurred_at, event_id)` 倒序排列，并把最后一行的两个值编码为 Base64URL cursor。

下一页条件为：

```sql
(occurred_at, event_id) < (:cursorOccurredAt, :cursorEventId)
```

eventId 作为同一时间戳下的稳定次级排序键。API 每次多取一行判断是否还有下一页，只返回 limit 条及 `nextCursor`。无效 cursor 不会拼接进 SQL，而是退回第一页。

## 7. Redis 查询缓存

### 【缓存键组成】

缓存键包含项目 ID、项目 Analytics 版本、查询名称和完整过滤条件：

```text
analytics:{projectId}:{version}:{namespace}:{filters}
```

结果只缓存 15 秒。Worker 每次成功处理事件或终结超时样本后增加版本，因此新数据到达会切换到新命名空间。旧结果无需主动遍历删除，TTL 到期后自动释放。

缓存不是权限层。API 每次都会先检查项目成员关系，再进入 cached loader；不能把知道缓存 key 当作读取授权。

## 8. 保留与压缩

### 【数据生命周期】

原始事件和三个领域明细表保留 30 天，超过 24 小时的旧 chunk 进入压缩。分钟和小时聚合保留 180 天。这样近期仍可逐条追溯和重新理解，长期数据只保存看板需要的统计状态。

Outbox 不属于遥测保留策略。completed 任务由 Worker housekeeping 在七天后删除，pending、processing 和 failed 任务不会因为普通清理而丢失。死信记录保留到 Owner 处理或后续制定单独策略。

### 【阈值版本与历史口径】

性能样本保存计算时使用的 `threshold_version_id`。Rollup 统计的是样本已经确定的 serverRating，所以修改项目阈值不会回写旧桶。查询历史趋势时，不同日期可能对应不同阈值版本；若界面要精确解释变化，应同时展示阈值变更审计记录。

## 9. 排查查询差异

### 【原始事件有数据但性能看板为空】

先确认原始事件 `processed_at` 是否为空，再检查 Outbox pending、processing、failed 和死信。如果事件已处理，检查 payload.type 是否为 performance、sample state 和 routeName 是否符合过滤条件，以及 from/to 是否覆盖 occurredAt。

### 【近期数据与历史数据不一致】

确认查询是否跨过 29 天切换点，并检查连续聚合策略是否运行。近期读取明细，历史读取小时 Rollup；如果 Rollup 未刷新或迁移没有成功创建 Toolkit 聚合状态，差异会只出现在长区间。

### 【对应代码】

- `packages/database/migrations/0001_platform.sql`：普通表、Hypertable、分钟连续聚合、压缩和保留；
- `packages/database/migrations/0002_hourly_aggregates.sql`：基于分钟聚合创建小时级分层聚合及其刷新和保留策略；
- `packages/database/migrations/0003_realtime_aggregates.sql`：实时聚合设置；
- `apps/api/src/analytics/analytics.controller.ts`：查询入口与参数；
- `apps/api/src/analytics/analytics.service.ts`：明细/Rollup 选择、SQL、游标和缓存。

