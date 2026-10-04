# 异步任务与 Worker 可靠消费体系源码学习

> **专题定位**：本篇以 Browser Monitor 当前源码为事实基础，完整梳理 Ingestion API 接收数据以后，任务怎样通过 Transactional Outbox（事务性发件箱）可靠地产生，再由独立 Worker 安全领取、投影、重试、进入死信并最终被监控和恢复。
>
> **通用知识入口**：[Full-Stack-AI-NOTES · 服务端异步任务与消息处理体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/%E6%9C%8D%E5%8A%A1%E7%AB%AF%E5%BC%82%E6%AD%A5%E4%BB%BB%E5%8A%A1%E4%B8%8E%E6%B6%88%E6%81%AF%E5%A4%84%E7%90%86%E4%BD%93%E7%B3%BB.md)。通用文档负责解释 Async Boundary、Durable Task、Outbox、ACK / Lease、At-least-once、Idempotency、Retry、Dead Letter、Backpressure 等概念；本文只回答这些机制在 Browser Monitor 当前版本中如何真实落地。
>
> **事实边界**：本文中的表名、状态值、重试次数、时间窗口、并发度和缓存策略均以当前仓库源码为准。没有在源码中实现的能力会明确标记为“当前未实现 / 可演进”，不会把主流方案写成项目事实。

Browser Monitor 的异步链路不是一个单独的 Worker 文件，而是一条跨 API、PostgreSQL、Worker、Redis、Analytics 和 Web 的完整可靠处理链：

~~~text
Browser SDK
    ↓
POST /api/v3/ingest/:publicKey/envelopes
    ↓
Ingestion API
    ↓
Validation / Origin / Rate Limit / Privacy / Idempotency
    ↓
PostgreSQL Transaction
    ├── telemetry_events
    └── outbox_tasks
            ↓
        202 Accepted
            ↓
────────────────────────────────────────
        HTTP Request 已结束
────────────────────────────────────────
            ↓
        Outbox Worker
            ↓
 Claim / Lock / Lease / Attempts
            ↓
       EventProcessor
            ↓
 Performance / View / Custom Signal Projection
            ↓
 telemetry_events.processed_at
            ↓
 outbox_tasks.completed
            ↓
 analytics:version + 1
            ↓
 Analytics API / Redis Cache
            ↓
 React Dashboard
~~~

把这条链压缩后，项目真正需要解决的是六个连续问题：

~~~text
为什么要异步？
    ↓
任务怎样可靠产生？
    ↓
多个 Worker 怎样安全领取？
    ↓
重复处理怎样保持结果正确？
    ↓
失败怎样自动恢复并最终停止？
    ↓
怎样证明 Worker 链路长期健康？
~~~

后文按这条因果链展开，而不是把 Outbox、Worker、Retry、Dead Letter 等概念平铺成互不相关的章节。

## 1. 异步边界把“可靠接收”与“后台加工”拆成两条时间线

### 【API 的完成条件是原始事件和任务已经持久化，而不是指标已经计算完成】

**结论**：Browser Monitor 的采集接口只承诺“这批事件已经被平台可靠接收”，不承诺 Performance / View / Custom Signal 等投影已经完成。

采集入口位于：

~~~text
platform/apps/api/src/ingestion/ingestion.controller.ts
~~~

控制器明确返回：

~~~ts
@Post(':publicKey/envelopes')
@HttpCode(202)
~~~

源码注释进一步说明：

~~~text
202 = 已持久化接收，而非已处理完成
同步链路只保证原始事件与 Outbox 任务同事务落库
~~~

因此一次采集请求存在两个完成时刻：

~~~text
T1：API 接收完成
    telemetry_events + outbox_tasks 已 COMMIT
    ↓
    HTTP 202

T2：后台加工完成
    Worker Projection 成功
    ↓
    outbox_tasks = completed
~~~

这两个时间点不能混为一谈。

如果把所有工作都塞进采集请求：

~~~text
SDK
 ↓
API
 ↓
协议校验
 ↓
原始数据写入
 ↓
性能投影
 ↓
View 修订
 ↓
评级计算
 ↓
缓存更新
 ↓
Response
~~~

那么 Worker 中任意一步变慢或失败，都会反向放大 SDK 上报延迟和重试压力。

当前设计把职责改成：

~~~text
API
负责
“收不收”

Worker
负责
“怎么加工”
~~~

### 【API 和 Worker 分成独立 Process 是故障隔离，不只是代码拆文件】

Worker 启动入口位于：

~~~text
platform/apps/worker/src/main.ts
~~~

API 与 Worker 在运行时是不同进程，在 Docker Compose 中也是不同 Service：

~~~text
api
worker
~~~

两者共享 PostgreSQL 与 Redis，但生命周期独立。

这带来三层隔离：

| 隔离维度 | 结果 |
| --- | --- |
| Request Latency | Worker 的复杂投影不会直接阻塞采集响应 |
| Failure | Worker 崩溃时 API 仍然可以继续接收并把任务积压到 Outbox |
| Scaling | API 与 Worker 可以根据不同瓶颈独立扩容 |

这里不能把“异步”简单理解为在 API 中启动一个不等待的 Promise。只要任务仍依赖当前 API Process 的内存，Process Crash 后任务就可能丢失。项目真正的异步边界建立在**持久化 Outbox + 独立 Worker Process**之上。

### 【面试与答辩应该先解释职责边界，再解释技术实现】

这一层最核心的回答可以收敛为：

> Browser Monitor 把采集链路拆成同步接收和异步加工两部分。API 只负责校验、幂等和把 Raw Event + Outbox Task 在同一事务中持久化，随后返回 202；性能投影、View 修订和自定义指标加工交给独立 Worker。这样可以隔离请求延迟和后台计算故障，同时允许 API 与 Worker 独立扩容。

常见追问是：

~~~text
为什么不用 API 内部 Promise 异步执行？
为什么返回 202？
Worker 崩溃以后采集是否还能继续？
API 和 Worker 为什么不能共用一个 Process？
~~~

这些问题都应该回到“Request 生命周期之外的任务必须有独立、可靠的生命周期”回答。

## 2. 可靠交接通过 telemetry_events 与 outbox_tasks 同事务建立

### 【Outbox 先解决的是任务可靠产生，而不是任务如何消费】

**结论**：Browser Monitor 使用 PostgreSQL Table 作为 Durable Outbox。API 在同一个数据库 Transaction 中写入原始事件和待处理任务，因此不会出现“业务事实成功但后台任务丢失”的双写窗口。

核心数据结构位于：

~~~text
platform/packages/database/src/schema.ts
~~~

原始事件：

~~~text
telemetry_events
├── project_id
├── event_id
├── occurred_at
├── event
└── processed_at
~~~

异步任务：

~~~text
outbox_tasks
├── id
├── project_id
├── event_id
├── occurred_at
├── event
├── status
├── attempts
├── available_at
├── locked_at
├── locked_by
├── last_error
├── completed_at
└── created_at
~~~

其中 status、attempts、available_at、locked_at / locked_by、last_error 和 completed_at 共同表达任务当前生命周期，因此 outbox_tasks 不只是一张“消息表”，还是任务状态的持久载体。

### 【Ingestion Transaction 把 Raw Event 与 Outbox Task 绑定成一个原子状态变化】

核心写入位于：

~~~text
platform/apps/api/src/ingestion/ingestion.service.ts
~~~

采集服务在事务中完成幂等检查以后，用同一条 CTE 写入 telemetry_events 和 outbox_tasks。

逻辑可以简化为：

~~~text
BEGIN
↓
幂等检查
↓
INSERT telemetry_events
↓
仅基于真正 inserted 的 event
INSERT outbox_tasks
↓
COMMIT
~~~

这解决两个相反的错误状态：

~~~text
错误 A
telemetry_events 已提交
但 outbox_tasks 没有产生

结果：
事件永远不会被 Worker 加工
~~~

~~~text
错误 B
outbox_tasks 已产生
但 telemetry_events 最终回滚

结果：
Worker 开始处理一个并不存在的业务事实
~~~

Transactional Outbox 通过同一个本地数据库 Transaction 把两者绑定起来。

AWS Transactional Outbox Pattern 对这个问题的描述也是：业务数据和 Outbox Record 一起写入同一本地事务，任意一步失败则整体回滚。[AWS Transactional Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

### 【项目当前没有独立 Message Broker，Outbox 本身就是 Database-backed Job Store】

当前链路是：

~~~text
PostgreSQL
    ↓
outbox_tasks
    ↓
Worker Polling
~~~

没有额外引入 Kafka、RabbitMQ、SQS 或 Redis Streams。

因此更准确的项目描述是：

> 当前使用 PostgreSQL Outbox Table 同时承担任务持久化、状态管理和 Worker 领取协调，属于 Database-backed Job Store / Queue。

这个取舍的优势是 Raw Event 和 Task 本来就在 PostgreSQL，可以直接共享本地事务，同时减少独立 Broker 的部署和运维成本。

代价则是 Polling Cost、数据库 Row Lock / Index Pressure，以及任务吞吐受主数据库能力约束；Fan-out、Consumer Group、Replay 等能力也需要自行设计。

所以当前方案不能被表述成“PostgreSQL Queue 比 Kafka 更好”，只能说：

> 在当前项目规模和任务模型下，数据库 Outbox 可以用较低基础设施复杂度满足可靠交接和后台消费；当消息吞吐、Fan-out、Consumer Group、分区或 Replay 需求明显增强时，再评估专用 Broker。

### 【Outbox 与 Ingestion eventId 幂等是上下游两层可靠性】

采集侧首先通过 eventId 处理 SDK 重试：

~~~text
同一批次重发
↓
同一 eventId
↓
API 识别 duplicate
↓
不重复生成 Outbox
~~~

Outbox 自身还有：

~~~text
unique(project_id, event_id, occurred_at)
~~~

因此项目存在两层边界：

~~~text
入口幂等
解决：
同一个浏览器事件不要重复成为新的 Raw Event

Worker 幂等
解决：
同一个已经存在的 Task 以后如果再次执行，业务结果仍要正确
~~~

这两个问题不能混为一谈。

## 3. Worker 通过 State Machine、Claim 与 Lease 管理任务处理权

### 【Worker 主循环只做三件事：Claim、等待、处理】

Worker 的核心入口：

~~~text
platform/apps/worker/src/outbox-worker.ts
~~~

主循环可以压缩成：

~~~text
while (running)
    ↓
claim()
    ↓
是否有任务？
├── No
│   ↓
│   delay(WORKER_POLL_INTERVAL_MS)
│   ↓
│   下一轮
│
└── Yes
    ↓
按 10 条一组
Promise.all(handle)
~~~

当前默认配置来自：

~~~text
platform/packages/shared/src/config.ts
~~~

默认值：

| 配置 | 当前默认值 | 作用 |
| --- | ---: | --- |
| WORKER_POLL_INTERVAL_MS | 1000 ms | 没有任务时的轮询间隔 |
| WORKER_BATCH_SIZE | 100 | 每次 Claim 最多领取多少任务 |

需要注意：

~~~text
Claim Batch Size = 最多 100
实际处理并发 = 每组最多 10
~~~

因为源码不是对整批直接 Promise.all，而是每 10 条切成一组再并发处理。

所以 WORKER_BATCH_SIZE 控制领取规模，源码中的固定 10 控制单组执行并发，两者不是同一个参数。

### 【Claim 使用 FOR UPDATE SKIP LOCKED 让多个 Worker 并行领取不同任务】

Claim 核心 SQL：

~~~sql
WITH candidates AS (
  SELECT id
  FROM outbox_tasks
  WHERE (
    status = 'pending'
    AND available_at <= now()
  ) OR (
    status = 'processing'
    AND locked_at < now() - INTERVAL '5 minutes'
  )
  ORDER BY available_at, created_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE outbox_tasks o
SET
  status = 'processing',
  locked_at = now(),
  locked_by = $2,
  attempts = attempts + 1
FROM candidates c
WHERE o.id = c.id
RETURNING ...
~~~

这段 SQL 同时完成：

~~~text
找任务
↓
锁任务
↓
跳过别人已经锁住的任务
↓
把处理权写进任务状态
↓
增加 attempts
↓
返回 Worker
~~~

FOR UPDATE 负责锁定候选 Row。

SKIP LOCKED 让另一个 Worker 遇到已锁 Row 时直接跳过，而不是等待：

~~~text
Worker A
锁住 Task 1

Worker B
遇到 Task 1
↓
SKIP
↓
继续 Task 2
~~~

PostgreSQL 官方明确指出，SKIP LOCKED 不适合一般一致性查询，但可以用于多个 Consumer 访问 queue-like table 时降低 Lock Contention。[PostgreSQL SELECT / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)

### 【locked_at + locked_by 构成当前项目的简化 Lease】

当前任务一旦被 Claim：

~~~text
status = processing
locked_at = now()
locked_by = worker-<uuid>
~~~

这里的 locked_by 表示“谁拥有当前处理权”，locked_at 表示“处理权从什么时候开始”。

项目并没有单独维护 lease_expires_at，而是在下一次 Claim 时动态判断：

~~~text
processing
+
locked_at < now() - 5 minutes
↓
可以被重新领取
~~~

因此当前实现可以理解成一个固定 5 分钟的简化 Lease（租约）：

~~~text
Claim
↓
Worker 获得临时处理权
↓
5 分钟以内默认仍由当前 Worker 处理

如果超过 5 分钟仍未完成
↓
认为 Worker 可能崩溃 / 失联
↓
其他 Worker 可以 Reclaim
~~~

当前源码**没有实现 Lease Heartbeat / Renewal**。

这意味着 5 分钟同时承担 Crash Recovery Timeout 和单任务允许的最大“无续租处理窗口”。

当前任务通常较短，因此可以接受；如果未来出现合法的超长任务，就需要重新评估 Heartbeat 或可配置 Lease。

### 【Worker Crash Recovery 通过 Stale Processing Reclaim 完成】

假设：

~~~text
Worker A
↓
Claim Task X
↓
status = processing
↓
Process Crash
~~~

任务不会因为 Worker A 消失而立即恢复为 pending。

它会保留 processing 和 locked_at。超过 5 分钟以后：

~~~text
下一次 Claim
↓
命中 stale processing 条件
↓
其他 Worker Reclaim
↓
attempts + 1
↓
重新执行
~~~

这就是当前项目的 Crash Recovery 主路径。

### 【Graceful Shutdown 尽量避免部署时主动制造 Stale Task】

Worker 入口：

~~~text
platform/apps/worker/src/main.ts
~~~

监听 SIGINT 和 SIGTERM。

Shutdown 流程是：

~~~text
收到 Signal
↓
shuttingDown = true
↓
worker.stop()
↓
停止下一轮 while Claim
↓
清理 finalize / housekeeping Timer
↓
await 当前 runPromise
↓
等待已经 Claim 的 Batch 处理完
↓
关闭 Database
↓
redis.quit()
~~~

一个细节是：

> stop() 只把 running 设为 false；如果当前已经进入一个 Claim Batch 的 for-loop，Worker 仍会把这一批已领取任务处理完以后再退出。

因此当前关闭行为更接近：

~~~text
Stop Claiming New Batch
+
Drain Current Claimed Batch
+
Close Connections
~~~

而不是收到 SIGTERM 后立即中断正在处理的任务。

## 4. 当前消费语义更接近 At-least-once，Projection 必须自己保证幂等

### 【At-least-once 是从故障窗口推导出来的，而不是一个显式配置】

**结论**：当前 Worker 无法保证每个任务在应用层绝对只执行一次，更准确的模型是 **At-least-once Processing + Idempotent Projection**。

关键时间线：

~~~text
Worker Claim
↓
processor.process()
↓
Projection Transaction COMMIT
↓
                 ← 如果这里 Process Crash
↓
UPDATE outbox_tasks
SET status = 'completed'
~~~

EventProcessor.process() 内部是一个独立数据库 Transaction。

processor.process() 成功返回以后，OutboxWorker.handle() 才单独更新 Outbox completed。

所以存在一个故障窗口：

~~~text
Projection 已经 COMMIT
但是 Outbox 仍然是 processing
~~~

如果 Worker 此时崩溃：

~~~text
5 分钟后 Reclaim
↓
同一个 Task 再次 process()
~~~

因此：

~~~text
Outbox + Lease
保证
任务最终还能继续处理

但不能天然保证
process() 只被调用一次
~~~

这也是 Transactional Outbox 的典型边界。AWS 官方同样提醒 Outbox / Queue 场景可能重复交付，因此 Consumer 应设计成 Idempotent。[AWS Transactional Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

### 【Custom Signal 主要通过 Unique Key + ON CONFLICT DO NOTHING 防重复】

processor.ts 中 Custom Signal 投影使用：

~~~sql
INSERT INTO custom_signal_samples(...)
...
ON CONFLICT DO NOTHING
~~~

Custom Metric 同样使用 ON CONFLICT DO NOTHING，并由复合 Primary Key 约束重复写入。

因此重复执行：

~~~text
同一个 event
↓
再次 INSERT
↓
命中相同 Unique / Primary Key
↓
DO NOTHING
~~~

不会再次生成一份重复记录。

### 【Performance Sample 通过 Advisory Lock + sequence 建立“只接受更新修订”的幂等语义】

Performance 的问题更复杂，因为同一个 sampleId 不是只写一次，而可能经历 sequence 1、2、3 等多个修订。

Worker 先对：

~~~text
performance:<projectId>:<sampleId>
~~~

执行事务级 Advisory Lock，然后读取当前 sequence 与 state，再使用 shouldApplySequence(current, incoming) 判断：

~~~ts
return current === null || incoming > current;
~~~

所以：

~~~text
incoming sequence <= current sequence
↓
直接忽略
~~~

它同时解决重复投影、乱序投影和旧版本覆盖新版本。

### 【Performance final 是单向终态，避免迟到数据重新打开已经结束的样本】

当前状态计算满足以下任一条件就保持 final：

~~~text
payload.state == final
或 current.state == final
或 View 已结束
~~~

因此：

~~~text
final
不能被后来的更高 sequence
重新改回 provisional
~~~

这是一个重要的业务状态幂等：数值允许被更新修正，但生命周期终态不能倒退。

### 【View 通过业务 Key 锁和 Existing Check 避免 start / end 并发冲突】

View 投影对：

~~~text
view:<projectId>:<viewId>
~~~

加 Advisory Lock，然后查询现有 view_records。

逻辑是：

~~~text
没有 Existing
↓
INSERT

已经存在
+
收到 view.end
↓
UPDATE ended_at / route / url
~~~

同一个 View 的 start / end 因此在多个 Worker 间被串行化，避免重复 INSERT 和旧状态覆盖结束状态。

收到 view.end 后还会把该 view 下所有 provisional performance_samples 置为 final，使 View 生命周期和性能样本生命周期保持一致。

### 【幂等不是统一一招，而是按业务数据类型分别实现】

当前项目可以归纳成：

| Projection | 当前幂等 / 顺序策略 |
| --- | --- |
| Custom Signal | Primary Key / Unique Key + ON CONFLICT DO NOTHING |
| Custom Metric | 复合 Primary Key + ON CONFLICT DO NOTHING |
| Performance | Advisory Lock + sampleId + sequence + final 单向状态 |
| View | Advisory Lock + Existing Check + start/end 状态约束 |
| Raw Event | Ingestion eventId 去重 + 数据库唯一约束 |

这也是回答“Worker 为什么敢重试”的核心依据：

> 不是因为系统能够确保 Worker 永远不重复执行，而是因为下游 Projection 明确设计了去重、状态约束和 sequence 规则。

## 5. Retry、Backoff 与 Dead Letter 把失败恢复组织成状态闭环

### 【每次 Claim 都会先增加 attempts，失败后根据次数决定 Retry 或 Dead Letter】

Claim 时：

~~~text
attempts = attempts + 1
~~~

所以 attempts 表示该 Task 已经进入实际处理尝试的次数，而不是“失败以后才加一”。

handle() 捕获 processor.process()、completed 更新或 Redis version 更新过程中的 Error，再进入 fail(task, error)。

当前分支：

~~~text
attempts < 8
↓
Retry

attempts >= 8
↓
Dead Letter
~~~

### 【Retry 使用 Exponential Backoff，但当前没有 Jitter】

当前重试等待：

~~~ts
Math.min(300, 2 ** task.attempts)
~~~

单位是秒。

大致形成：

~~~text
2s
4s
8s
16s
32s
64s
128s
256s
300s 封顶
~~~

然后任务重新写为 pending，并设置下一次 available_at，同时清空锁信息。

所以真正的 Retry 不是 catch 后立即再次调用 process()，而是：

~~~text
Failure
↓
重新进入 pending
↓
设置下一次 available_at
↓
以后由 Claim 重新领取
~~~

当前实现**没有加入 Jitter（随机抖动）**。

因此大量任务如果因为同一个依赖同时失败，它们可能按照相同指数间隔再次集中出现。

可演进为：

~~~text
Current
Exponential Backoff

Possible Evolution
Exponential Backoff + Jitter
~~~

不能写成“当前已经实现 Jitter”。

### 【当前 fail() 没有显式区分 Retryable 与 Non-retryable Error】

当前逻辑对进入 handle() catch 的 Error 统一处理。

源码没有类似：

~~~text
isRetryable(error)
~~~

的错误分类。

所以 Temporary Database Error、业务数据处理 Bug、Redis Error 等在 Worker 层都会先走同一 Retry Policy。

优点是策略简单、瞬态故障有自动恢复机会。

代价是永久错误也会消耗完整 Retry Budget，直到第 8 次才进入 Dead Letter。

如果后续错误类型变复杂，可以演进成：

~~~text
Failure
├── Retryable
│   ↓
│   Backoff Retry
│
└── Non-retryable
    ↓
    Direct Dead Letter / Terminal Failure
~~~

### 【第 8 次失败通过数据库 Transaction 原子进入 failed + dead_letter_tasks】

当 task.attempts >= 8，Worker 新开一个数据库 Transaction：

~~~text
BEGIN
↓
INSERT / UPDATE dead_letter_tasks
↓
UPDATE outbox_tasks
SET status = failed
↓
COMMIT
~~~

因此 Dead Letter 明细和 Outbox failed 状态作为一个原子状态变化提交。

如果其中一步失败就 ROLLBACK，不会出现 Outbox 已 failed 但没有 Dead Letter，或者 Dead Letter 已存在但 Outbox 仍处于正常待执行状态。

### 【Dead Letter 不是链路终点，Owner 可以人工 Replay】

项目管理服务：

~~~text
platform/apps/api/src/projects/projects.service.ts
~~~

提供 retryDeadLetter()，并且只有 Project Owner 能操作。

事务流程：

~~~text
BEGIN
↓
DELETE dead_letter_tasks
↓
UPDATE outbox_tasks
SET
  status = pending
  attempts = 0
  available_at = now()
  locked_at = null
  locked_by = null
  last_error = null
↓
COMMIT
~~~

然后 Task 会重新进入普通 Worker Claim。

因此完整失败闭环是：

~~~text
Processing Failure
↓
Automatic Retry
↓
Retry Budget Exhausted
↓
Dead Letter
↓
Service Status 暴露失败
↓
人工定位原因
↓
Owner Retry
↓
pending
↓
Worker 再执行
~~~

### 【面试和答辩需要解释“为什么不是无限 Retry”】

这一层可以回答：

> 瞬态故障可以通过 Retry 自动恢复，但永久错误如果无限重试会持续消耗数据库连接、CPU 和日志容量。当前 Worker 使用指数退避并设置最多 8 次尝试，超过以后进入 dead_letter_tasks，保留错误、事件和尝试次数，由 Owner 在修复问题后手动重新放回 Outbox。

## 6. 任务完成以后还要连接 processed_at、缓存版本与后台维护

### 【Projection Transaction 与 Outbox completed 是两个不同提交边界】

EventProcessor.process()：

~~~text
BEGIN
↓
具体 Projection
↓
UPDATE telemetry_events.processed_at
↓
COMMIT
~~~

然后 OutboxWorker.handle()：

~~~text
UPDATE outbox_tasks
SET status = completed
~~~

所以：

~~~text
processed_at
表示 Raw Event 已完成领域投影

completed
表示 Outbox Task 已完成 Worker 生命周期
~~~

两者通常一起推进，但属于不同 SQL Transaction。

这也是前面 At-least-once 故障窗口产生的原因。

### 【Analytics Cache 通过 Version Key 失效，而不是枚举删除所有缓存】

任务完成以后 Worker 调用 Redis INCR 更新：

~~~text
analytics:version:<projectId>
~~~

Analytics 查询时先读取 version，再把 version 放进 Cache Key：

~~~text
analytics:<projectId>:<version>:<namespace>:<filters>
~~~

缓存本身使用 15 秒 TTL。

于是：

~~~text
Worker 完成新数据
↓
version + 1
↓
下一次 Analytics Query
使用新的 Cache Key
↓
旧缓存不再命中
↓
旧 Key 15 秒后自然过期
~~~

这是一种 Versioned Cache Invalidation。

### 【Redis version 更新当前属于 Worker 成功路径的一部分】

需要特别注意 handle() 的当前代码顺序：

~~~text
processor.process()
↓
UPDATE outbox status = completed
↓
redis.incr(analytics:version)
↓
try 结束
~~~

这三步在同一个 JavaScript try 中。

因此如果：

~~~text
Projection 成功
completed 更新成功
Redis INCR 失败
~~~

也会进入 fail(task, error)。

即：

> 当前 Worker 把 Analytics Cache Version 更新失败也视为整条 Task 处理失败。

由于 Projection 已经有幂等保护，后续 Retry 一般不会重复制造错误数据，但可能形成额外重复处理。

这里存在一个值得复盘的工程取舍：

~~~text
当前策略
Cache Invalidation 是 Task Success 的一部分
↓
Redis Failure 会触发 Retry

另一种可能策略
Projection 成功即完成 Task
Redis Cache Failure 单独降级
↓
因为 Cache TTL 只有 15 秒
可以接受短暂 Stale
~~~

当前仓库采用的是前一种。答辩中应该先描述真实实现，再把后一种作为演进方案。

### 【Worker 还承担 provisional 样本终结和 Housekeeping】

Worker 不只消费 Outbox。

main.ts 创建两个 Timer。

每 60 秒执行 finalizeStaleSamples()：

~~~text
performance_samples
state = provisional
且 last_updated_at < now() - 5 minutes
↓
state = final
↓
对涉及 project
analytics:version + 1
~~~

每小时执行 housekeeping()，清理：

~~~text
completed 且超过 7 天的 outbox_tasks
过期 user_sessions
~~~

所以当前 Worker 实际承担三类后台职责：

~~~text
1. Outbox Event Processing
2. Performance State Finalization
3. Housekeeping
~~~

如果未来后台职责继续增多，需要评估是否继续集中在一个 Process，还是按不同 SLO、资源消耗和故障边界拆成独立 Worker / Scheduler。

## 7. 容量与可观测性决定可靠消费链能否长期运行

### 【Batch Size 与并发不能简单理解为越大越快】

当前：

~~~text
WORKER_BATCH_SIZE 默认 100
↓
一次最多 Claim 100 条

内部每 10 条 Promise.all
↓
最多约 10 个 Task 并发处理
~~~

这两个数值分别影响 Claim Frequency、Database Row Lock 范围、Worker 内存中的 In-flight Task、Database Connection 使用和 Projection SQL 并发。

如果把并发简单从 10 调成 100，吞吐可能提高，也可能让 DB Connection Pool 更快耗尽、Row / Advisory Lock 竞争增加、CPU / I/O 与 Redis 压力增加。

因此 Worker Capacity 应该围绕：

~~~text
Arrival Rate
Processing Rate
Queue Lag
Database Capacity
单 Task Latency
~~~

一起调，而不是只调 Promise 数量。

### 【当前服务状态已经能够区分“接收问题”和“加工问题”】

Analytics Service 的 serviceStatus() 汇总：

~~~text
pending
processing
failed
processedLastMinute
acceptedLastMinute
deadLetters
accepted
duplicate
rejected
recentDeadLetters
~~~

Web 的 ServiceStatusPage 每 15 秒刷新。

因此可以建立一条实用排查链：

~~~text
acceptedLastMinute = 0
↓
先排查 SDK / DSN / Origin / Ingestion

accepted 在涨
但 processedLastMinute 很低
+
pending 持续增加
↓
排查 Worker Throughput / Database

failed / deadLetters > 0
↓
排查单 Task 错误和 Worker 处理逻辑

processed 正常
但看板数据不更新
↓
继续排查 Analytics / Cache / Filter
~~~

这体现的是：监控平台自己也必须具备对内部数据管道的可观测性。

### 【Prometheus 指标当前覆盖 Queue State，但还没有完整 Worker SLO】

API 内部 /internal/metrics 暴露：

~~~text
browser_monitor_outbox_tasks{status=...}
browser_monitor_dead_letter_tasks
browser_monitor_ingestion_events_total
browser_monitor_ingestion_duration_seconds
~~~

其中 Outbox Gauge 在被 Prometheus 拉取时实时查询数据库。

当前已经能够回答 pending、processing、failed 和 dead letter 数量。

但还不能直接从现有 Metrics 得到：

~~~text
Oldest Pending Age
Queue Wait P95
Worker Processing Duration P95
Retry Rate
Attempts Distribution
Stale Lease Count
每个 Worker 的 Active Concurrency
~~~

所以当前生产治理更接近 Queue State Visibility + Service Status，而不是完整的 Worker SLO / Queue Lag Observability。

### 【Queue Lag 比单独 Queue Depth 更值得作为下一阶段指标】

假设：

~~~text
A:
pending = 10000
最老任务等待 2 秒

B:
pending = 300
最老任务等待 20 分钟
~~~

只看 pending 会觉得 A 更严重，实际上 B 已经产生明显处理延迟。

因此当前项目后续最值得增加：

~~~text
oldest_pending_age
queue_wait_duration
processing_duration
retry_rate
stale_processing_count
~~~

它们可以帮助区分瞬时峰值和持续消费能力不足。

### 【当前 Docker Worker 没有单独 Health Check，主要依靠 Restart + 数据管道状态观察】

Compose 中 Worker 配置：

~~~text
restart: unless-stopped
~~~

但不像 API 一样定义 healthcheck。

所以当前 Worker 运行健康主要从 Container 是否持续运行、Outbox 状态、processedLastMinute 和 Dead Letter 间接判断。

这不是错误，但说明当前项目对 Worker 的“业务健康”观察强于独立进程健康检查。

如果未来需要 Kubernetes Readiness / Liveness、自动弹性扩容或更严格 SLO，可以增加独立 Worker Heartbeat / Health Metric。

### 【Database Queue 的演进判断应该由真实容量问题触发】

当前继续使用 PostgreSQL Outbox 的前提是 Task Volume、Polling Cost 和 DB Contention 可控，消费模型主要是一对一投影，也不需要大量 Fan-out。

只有当出现：

~~~text
Outbox 表持续成为数据库热点
大量 Consumer Group
高吞吐独立消息管道
复杂 Routing / Replay / Partition
Worker 扩展明显受主 DB 限制
~~~

才值得评估：

~~~text
Outbox
↓
Relay / CDC
↓
Kafka / RabbitMQ / SQS / Redis Streams ...
~~~

即使引入 Broker，Transactional Outbox 仍可能保留在 Producer 侧，用于解决 Database Business State 与 Message Publish 的 Dual Write。

## 8. 项目知识最终收敛为“可靠产生 → 安全消费 → 正确重复 → 失败恢复 → 运行治理”

### 【把源码重新映射到一张完整知识图】

~~~text
Ingestion API
│
│  202 只承诺 Durable Acceptance
│
▼
PostgreSQL Transaction
│
├── telemetry_events
└── outbox_tasks
        │
        │ Transactional Outbox
        ▼
   pending Task
        │
        │ FOR UPDATE SKIP LOCKED
        ▼
   processing
   locked_by / locked_at
        │
        ├── Worker Crash
        │      ↓
        │   5min Lease Timeout
        │      ↓
        │   Reclaim
        │
        ▼
 EventProcessor
        │
        ├── Unique Constraint
        ├── Advisory Lock
        ├── Sequence
        └── Monotonic Final State
        │
        ▼
 At-least-once 下保持幂等结果
        │
        ├── Success
        │      ↓
        │   processed_at
        │      ↓
        │   completed
        │      ↓
        │   analytics version
        │
        └── Failure
               ↓
             Retry
               ↓
        Exponential Backoff
               ↓
          attempts >= 8
               ↓
         Dead Letter
               ↓
          Owner Replay
~~~

这张图比单独记住 Outbox、Worker、Retry、DLQ 更重要，因为每一个机制都是上一个机制引入的新问题的解决方案。

### 【通用知识与项目源码形成明确的一一映射】

| 通用知识 | Browser Monitor 当前落点 |
| --- | --- |
| Async Boundary | ingestion.controller.ts 的 202 + API / Worker 进程分离 |
| Durable Task | outbox_tasks |
| Transactional Outbox | ingestion.service.ts 同事务写 Raw Event + Outbox |
| Task State Machine | pending / processing / completed / failed |
| Claim | FOR UPDATE SKIP LOCKED |
| Lease | locked_at + 5 分钟 stale reclaim |
| At-least-once | Projection COMMIT 与 completed 更新之间存在 Crash Window |
| Idempotency | Unique Key / ON CONFLICT / Advisory Lock / sequence |
| Retry | available_at + attempts |
| Backoff | min(300, 2 ** attempts) |
| Dead Letter | dead_letter_tasks |
| Manual Replay | ProjectsService.retryDeadLetter() |
| Graceful Shutdown | SIGINT / SIGTERM → stop → drain → close |
| Cache Invalidation | analytics:version:<projectId> |
| Queue Observability | Service Status + Prometheus Outbox Gauge |
| Backpressure / Capacity | 当前主要通过 Batch / 固定并发 / 多 Worker 扩容控制 |

通用定义与设计边界继续阅读：

- [Full-Stack-AI-NOTES · 服务端异步任务与消息处理体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/%E6%9C%8D%E5%8A%A1%E7%AB%AF%E5%BC%82%E6%AD%A5%E4%BB%BB%E5%8A%A1%E4%B8%8E%E6%B6%88%E6%81%AF%E5%A4%84%E7%90%86%E4%BD%93%E7%B3%BB.md)
- [服务端数据管理源码学习-2](./服务端数据管理源码学习-2.md)：继续理解 Transaction、Concurrency Control、Advisory Lock 与 Outbox 的数据库基础。
- [Redis 体系源码学习](./Redis体系源码学习.md)：继续理解 Analytics Version Cache 与 Worker / Redis 的边界。
- [浏览器监控平台 · 服务端全链路](../platform/docs/浏览器监控平台-服务端全链路.md)：把本专题放回完整 SDK → API → Storage → Worker → Analytics → Web 数据生命周期。

### 【面试与答辩可以沿八个连续追问展开】

**1. 为什么 API 和 Worker 要拆开？**

结论：采集接口只承诺可靠接收，复杂投影允许异步完成；分离以后可以隔离延迟、故障和扩容。

**2. 为什么不能 API 写完数据库以后直接启动一个内存任务？**

结论：HTTP 返回以后 Process 可能退出，内存任务没有持久化保障；当前用 Outbox 把 Task 放进数据库 Durable Boundary。

**3. 为什么 telemetry_events 和 outbox_tasks 必须同事务？**

结论：解决 Dual Write，保证 Raw Event 和对应后台任务一起成功或一起回滚。

**4. 多个 Worker 怎么避免同时抢同一个任务？**

结论：PostgreSQL FOR UPDATE SKIP LOCKED 对候选 Row 加锁，其他 Worker 跳过已锁任务；Claim 同时写 locked_by / locked_at。

**5. Worker 崩溃以后任务怎么办？**

结论：processing 超过 5 分钟会被视为 stale，由其他 Worker Reclaim。

**6. 这样是不是 Exactly Once？**

结论：不是。Projection 提交和 Outbox completed 更新之间存在 Crash Window，所以任务可能再次执行；当前靠 Consumer Idempotency 获得接近“业务效果只发生一次”的结果。

**7. 为什么需要 Retry + Dead Letter？**

结论：Retry 处理瞬态故障，指数退避降低持续冲击；超过 8 次以后进入 Dead Letter，避免永久错误无限消耗资源。

**8. 怎么判断 Worker 是否健康？**

结论：不能只看 Process 是否存活，要联合 accepted rate、processed rate、pending / processing、failure、dead letter；下一阶段还应补 Queue Lag、Processing Duration 和 Retry Rate。

### 【当前实现最值得继续演进的四个点】

| 当前实现 | 当前价值 | 可演进方向 |
| --- | --- | --- |
| 固定 5 分钟 stale lease | 实现简单，支持 Crash Recovery | 长任务时增加 Lease Heartbeat / Renewal |
| 指数退避无 Jitter | 已避免立即重试 | 增加 Jitter，降低同源故障同步重试 |
| 所有 Worker Error 共用 Retry Policy | 策略简单统一 | 区分 Retryable / Non-retryable Error |
| 主要观察 Queue Count | 已能看积压和死信 | 增加 Oldest Age、Queue Wait、Processing P95、Retry Rate |

另一个值得专项评估的是：

~~~text
Projection 成功
↓
Outbox completed
↓
Redis analytics version 更新失败
↓
当前仍会进入 Task fail / Retry
~~~

由于 Analytics Cache 只有 15 秒 TTL，后续可以讨论 Cache Invalidation 是否必须继续属于 Task Success Boundary。

这类内容应该作为当前实现真实边界 + 后续演进候选，而不是直接修改成一个“理论上最完美”的方案。项目答辩的价值来自能够解释当前为什么这样做、问题在哪里、什么时候才值得继续复杂化。

## 9. 源码索引与参考资料

### 【项目源码】

- platform/apps/api/src/ingestion/ingestion.controller.ts：202 Accepted 与同步接收边界。
- platform/apps/api/src/ingestion/ingestion.service.ts：协议校验、幂等、Raw Event + Outbox 同事务写入。
- platform/packages/database/src/schema.ts：telemetry_events、outbox_tasks、dead_letter_tasks 与各 Projection Table。
- platform/apps/worker/src/main.ts：Worker 启动、Timer 与 Graceful Shutdown。
- platform/apps/worker/src/outbox-worker.ts：Polling、Claim、Lease、Retry、Dead Letter、Housekeeping。
- platform/apps/worker/src/processor.ts：Projection Transaction、Advisory Lock、Idempotency、Sequence 与 processed_at。
- platform/apps/worker/src/sequence.ts：Performance Sequence 单调更新规则。
- platform/apps/api/src/projects/projects.service.ts：Dead Letter Manual Retry。
- platform/apps/api/src/analytics/analytics.service.ts：Service Status 与 Analytics Version Cache。
- platform/apps/api/src/observability/metrics.controller.ts：Outbox / Dead Letter Prometheus Gauge。
- platform/apps/api/src/observability/metrics.service.ts：运行指标定义。
- platform/packages/shared/src/config.ts：Worker Poll Interval 与 Batch Size。
- platform/infra/docker-compose.yml：API / Worker 独立运行与 Restart 配置。

### 【权威资料】

[1] PostgreSQL Global Development Group. SELECT — SKIP LOCKED. PostgreSQL Documentation. https://www.postgresql.org/docs/current/sql-select.html

[2] Amazon Web Services. Transactional outbox pattern. AWS Prescriptive Guidance. https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

[3] RabbitMQ. Consumer Acknowledgements and Publisher Confirms. https://www.rabbitmq.com/docs/confirms
