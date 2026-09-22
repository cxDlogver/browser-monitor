# Worker 投影与性能指标计算

Worker 把已经可靠接收的协议事件转换成适合查询和聚合的领域数据。原始事件保留“客户端实际发送了什么”，投影表回答“平台需要怎样统计它”。这两个层次不能合并：原始事实用于审计和追溯，投影模型可以随着查询需求独立演进。

## 1. Worker 的输入和输出

### 【输入不是消息中间件】

API 将每条首次接收的事件写入 `outbox_tasks`。Worker 直接从 PostgreSQL 领取这些任务，不依赖额外消息系统。任务包含 `project_id`、`event_id`、完整事件、状态、可执行时间、锁信息和尝试次数。

```text
outbox_tasks.pending
  → claim
outbox_tasks.processing
  → EventProcessor 事务
领域投影 + telemetry_events.processed_at
  → completed
analytics cache version + 1
```

### 【不同事件进入不同投影】

| payload.type | 投影目标 | 主要用途 |
| --- | --- | --- |
| `performance` | `performance_samples` | 指标趋势、评级分布、分位数和页面排名 |
| `view` | `view_records` | 页面访问量、会话量、页面覆盖率和 View 结束状态 |
| `event` | `custom_event_samples` | 业务事件趋势和页面分布 |

投影完成后，Worker 更新同一条 `telemetry_events.processed_at`。原始事件页因此可以区分“已接收但尚未处理”和“已经进入查询模型”。

## 2. 多实例领取任务

### 【SKIP LOCKED 的作用】

领取 SQL 先找出到期的 pending 任务，以及锁定超过五分钟的 processing 任务，再使用 `FOR UPDATE SKIP LOCKED` 选取一个批次。不同 Worker 实例遇到已被另一个事务锁定的行时会跳过它，而不是彼此等待。

选中的任务在同一条 SQL 中更新为 processing，写入当前 `workerId`、`locked_at` 并增加 attempts。领取动作与状态变化是原子的，不会出现两个实例都先查询到 pending、随后同时处理的时间窗口。

### 【进程退出如何恢复】

Worker 可能在领取后、完成前退出。processing 不是永久状态：锁定时间超过五分钟后，任务重新满足领取条件。后续实例会再次处理它，因此领域投影必须是幂等的，不能假设每个任务只执行一次。

## 3. 投影事务和幂等性

### 【单条任务的事务范围】

`EventProcessor.process()` 为每条事件打开事务，在事务中完成领域写入和原始事件 `processed_at` 更新。任何一步失败都会回滚，Outbox 仍由外层失败逻辑处理。这样不会出现领域表已有数据、原始表却仍显示未处理的半完成状态。

Custom Event 使用 eventId 和发生时间对应的唯一约束配合 `ON CONFLICT DO NOTHING`。View 按协议事件更新同一个 View 记录。Performance 的幂等比简单插入更复杂，因为同一浏览器观测可以合法地多次修订。

### 【为什么 Outbox 仍可能重复执行】

Worker 在领域事务提交后，还要单独把 Outbox 标记为 completed。如果进程恰好在两者之间退出，任务会被重新领取。领域表的幂等规则保证第二次执行不会重复计数，然后任务才能安全进入 completed。系统采用的是至少一次处理加幂等投影，而不是依赖不可恢复的“刚好一次”假设。

## 4. Performance 样本修订

### 【sampleId、sequence 和 state】

Web Vitals 的值会在页面生命周期中更新。SDK 为同一次指标观测保持稳定 `sampleId`，每次修订递增 `sequence`，并使用 `provisional` 或 `final` 表示是否还可能变化。

```text
LCP sampleId = lcp-view-1
sequence 0, value 1800, provisional
sequence 1, value 2300, provisional
sequence 2, value 2600, final
```

Worker 查询当前样本后，只接受高于已有序号的修订。相同或更低 sequence 被视为重复或乱序，不更新数值。`final` 是单向状态：更高序号的迟到事件可以修正最终数值，但不会把已经 final 的样本重新降回 provisional。

FPS 和 LoAF 每次观察本身就是独立最终样本，不需要像 Web Vitals 一样在同一 sampleId 上持续修订。

### 【为什么不能把每次变化都当作新样本】

如果 LCP 从 1800 更新到 2600 时插入两行，分位数和样本量会把同一页面体验计算两次，较活跃的页面还会获得更高权重。按 sampleId 保留当前最高 sequence 后，一个指标观测在聚合中始终只占一个样本。

## 5. 样本终结

### 【正常终结】

SDK 在 View 结束时发送当前 Web Vitals 的 final 快照。Worker 收到 `view.end` 时还会把该 View 中残留的 provisional 样本设为 final，并补充最终 routeName。这个步骤处理 Collector 来不及逐项发送 final、但 View 结束事件已经到达的情况。

### 【超时兜底】

浏览器可能被强制关闭、网络断开或 Beacon 未成功发送，因此服务端不能无限等待 final。Worker 主进程每分钟执行一次维护，把五分钟未更新的 provisional 样本设为 final，并为受影响项目递增 Analytics 缓存版本。

超时终结不是拒绝迟到数据。后续更高 sequence 仍可修正数值，只是状态保持 final。这样看板不会永久遗漏样本，同时仍接受网络延迟造成的合法更新。

## 6. 服务端评级

### 【服务端是最终口径】

SDK 上报的 rating 作为 `clientRating` 保存，便于定位客户端版本或阈值差异；看板使用 Worker 计算的 `serverRating`。原因是项目可能覆盖默认阈值，而且阈值版本属于服务端项目配置，旧 SDK 不可能提前知道。

默认阈值如下：

| 指标 | Good | Needs improvement | Poor |
| --- | ---: | ---: | ---: |
| LCP | ≤ 2500 ms | ≤ 4000 ms | > 4000 ms |
| INP | ≤ 200 ms | ≤ 500 ms | > 500 ms |
| CLS | ≤ 0.1 | ≤ 0.25 | > 0.25 |
| FCP | ≤ 1800 ms | ≤ 3000 ms | > 3000 ms |
| FPS | ≥ 50 | ≥ 30 | < 30 |

LCP、INP、CLS 和 FCP 越小越好，FPS 越大越好，所以共享评级函数必须知道指标方向。LoAF 不被强制套入 good/poor 阈值，而是保留持续时间、blocking duration 和 script count，用密度与分位数表达影响。

### 【阈值版本如何保存】

Worker 读取项目当前有效的阈值版本，将项目覆盖项合并到默认集合，然后计算评级，并把 `threshold_version_id` 与样本一起保存。项目修改阈值只影响之后处理的样本，不会静默重写已有数据的历史口径。

如果产品未来需要“按新阈值重算历史”，应当显式创建重算任务和新的口径版本，而不是让一次设置修改直接改变过去看板。

## 7. 失败、退避和死信

### 【可恢复失败】

任务处理失败且 attempts 小于八次时，Worker 把状态恢复为 pending，清除锁，并设置新的 `available_at`。等待秒数为 `2 ** attempts`，最高不超过 300 秒。暂时数据库争用或依赖抖动不会形成紧密重试循环。

### 【不可自动恢复失败】

第八次失败时，Worker 在同一事务中写入 `dead_letter_tasks`，再把 Outbox 设为 failed。死信保存事件、错误堆栈截断结果、尝试次数和失败时间。Owner 从服务状态页触发重试后，平台删除相应死信记录并将 Outbox 恢复为 pending、attempts 归零。

死信不是被忽略的数据。它是“原始事实已接收，但投影需要人工介入”的明确状态。修复代码后重放任务，会继续利用领域幂等规则避免重复。

## 8. 缓存失效和可见时间

### 【为什么使用版本号而不是扫描删除】

Analytics 缓存键包含 `analytics:version:${projectId}`。每条任务成功后，Worker 增加项目版本；新查询自然使用新的 key，不需要枚举和删除这个项目的所有过滤组合。旧 key 只保留 15 秒，到期自动清理。

正常链路的可见延迟由 Worker 轮询、任务处理、连续聚合刷新和 Web 定时请求共同决定。服务状态页的 accepted 增长而 processedLastMinute 不增长，说明问题在 API 之后；pending 长期增大说明消费能力不足，failed 或 deadLetters 增长说明存在确定性处理错误。

## 9. 对应代码

### 【阅读顺序】

1. `apps/worker/src/main.ts`：进程启动、维护定时器和退出处理；
2. `apps/worker/src/outbox-worker.ts`：领取、完成、退避、死信和清理；
3. `apps/worker/src/sequence.ts`：Performance sequence 接受规则；
4. `apps/worker/src/processor.ts`：Performance、View 和 Event 投影；
5. `packages/shared/src/thresholds.ts`：默认阈值、覆盖合并和评级；
6. `packages/database/migrations/0001_platform.sql`：领域表和约束。

阅读时可以人为构造同一个 sampleId 的乱序 sequence，再沿着代码确认数据库最终只保留最高序号，这比只看类名更容易理解 Worker 的可靠性设计。

