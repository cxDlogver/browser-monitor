# 读取文档 马会

**User:** Anonymous  
**Created:** 9/22/2026 18:11:56  
**Updated:** 9/22/2026 18:49:29  
**Exported:** 9/23/2026 0:47:24  
**Link:** [https://chatgpt.com/c/6ab2546b-7c1c-83ea-a738-2bab17b453df](https://chatgpt.com/c/6ab2546b-7c1c-83ea-a738-2bab17b453df)  

## Prompt:
2026/9/22 18:14:38

浏览器 SDK → 批量上报 以后  的处理是什么， 讲清楚处理链路和理由

## Response:
2026/9/22 18:14:47

我按“**批次到达服务端以后，每一层做什么、为什么不能省**”来讲，重点放在服务端链路，不再重复 SDK 内部采集逻辑。

> **梳理处理链路**
>
> 我会把“浏览器 SDK 到批量上报后的处理”拆成采集、缓存、触发、发送、服务端接收与后续消费几段，并说明每一步存在的原因，避免只描述表面流程。
>
> **梳理处理链路**
>
> 
>
> **梳理批处理与浏览器批量上报后处理链路**
>
> 
>
> 思考了 35s

可以把“**浏览器 SDK 完成批量上报以后**”理解成：服务端先解决“**这批数据能不能安全可靠地收下**”，再解决“**这些事件分别代表什么业务样本**”，最后解决“**大量样本怎么变成 p75、覆盖率和趋势图**”。

整个链路是：

```text
浏览器 SDK
   ↓ TelemetryBatchV2
POST /api/v2/ingest/:publicKey/envelopes
   ↓
① Ingestion API：批次级校验
   ↓
② 单事件校验 / 脱敏 / eventId 去重
   ↓
③ 数据库事务
   ├─ telemetry_events   原始事实
   └─ outbox_tasks       待处理任务
   ↓
HTTP 202 返回给 SDK
   ↓
④ Worker 异步领取 Outbox
   ↓
⑤ 领域投影
   ├─ performance_samples
   ├─ view_records
   └─ custom_event_samples
   ↓
⑥ Performance 样本修订 + 服务端评级
   ↓
⑦ TimescaleDB 分钟 / 小时聚合
   ↓
⑧ Analytics API 查询
   ↓
p75 / 覆盖率 / 良好率 / 页面排名 / 趋势图
```

这里最重要的是：**批次只是网络传输单位，不是统计单位。**

---

## 1. 第一道：Ingestion API 先判断“这批数据能不能接收”

SDK 可能一次发送几十条事件，比如：

```text
一个 HTTP Batch
├─ LCP
├─ CLS
├─ INP
├─ view.start
├─ view.end
├─ LoAF
└─ custom event
```

服务端不会收到以后马上计算 p75，而是先做接收边界检查。

当前处理顺序是：

```text
协议版本
 → 批次结构 / 数量限制
 → public key 对应项目
 → Origin 白名单
 → 项目 / IP 限流
 → 每条事件 Schema
 → app.name
 → occurredAt
 → 服务端脱敏
 → eventId 幂等
 → 持久化
```

这是文档当前实现中的固定顺序。`02-采集API与事务Outbox.md`

为什么先干这些？

因为浏览器上传的数据属于**公开输入**，服务端不能直接相信。

例如：

```text
SDK 发来：
{
  app: "guanwang",
  metric: "LCP",
  value: 2500
}
```

服务端不能因为 JSON 长得正确就直接入统计。

它首先要确定：

```text
这个协议版本我认识吗？
这个 publicKey 属于哪个项目？
这个网站 Origin 有权限往这里写吗？
有没有恶意高频灌数据？
这个事件格式合法吗？
它真的是这个项目的数据吗？
时间戳合理吗？
```

因此这一层本质上解决的是：

> **Trust Boundary：什么数据允许进入监控平台。**

---

# 2. 第二道：批次通过后，再逐条处理事件

这里有一个非常重要的区别：

```text
Batch 校验
≠
Event 校验
```

例如一次发送 20 条：

```text
20 events
   ↓
18 accepted
 1 duplicate
 1 rejected
```

不需要因为第 7 条事件格式有问题，就把其他 19 条全部丢掉。

所以服务端进入逐事件阶段后，会分别进行：

```text
schema validation
        ↓
app / timestamp validation
        ↓
server-side redact
        ↓
eventId dedupe
```

这样就形成了三个结果：

| 状态 | 含义 |
|---|---|
| accepted | 第一次合法接收 |
| duplicate | eventId 已经处理过 |
| rejected | 事件本身非法 |

因此批量上报只是：

> **减少 HTTP 请求次数。**

它并不意味着服务端把一个 Batch 当成一个统计样本。

---

# 3. 第三道：为什么不是收到数据直接计算，而要先落 `telemetry_events`

合法事件首先进入：

```text
telemetry_events
```

它代表的是：

> **浏览器到底上传过什么。**

比如同一个 LCP：

```text
event A
sampleId = lcp-001
sequence = 0
value = 1800

event B
sampleId = lcp-001
sequence = 1
value = 2300

event C
sampleId = lcp-001
sequence = 2
value = 2600
```

原始事件层会保留这些事实。

为什么要留？

因为以后出现：

```text
为什么平台显示 2600？
为什么这个 sample 被修改了？
是不是 SDK 重复上报？
是不是 Worker 算错了？
```

可以回头检查原始事实。

所以：

```text
telemetry_events
```

主要承担：

```text
审计
排障
重放
追溯
```

它不是最终拿来算 p75 的表。

文档明确把数据分成**原始事实、领域样本、聚合状态、页面指标**几个层次，而不是让原始 JSON 直接承担所有查询。`04-TimescaleDB聚合与查询链路.md`

---

# 4. 第四道：为什么同时还要写 `outbox_tasks`

这里是整个服务端设计中很重要的一步。

接收一个合法事件时，数据库事务不是只写：

```text
telemetry_events
```

而是同时写：

```text
BEGIN

telemetry_events
+
outbox_tasks

COMMIT
```

`telemetry_events` 表示：

```text
数据已经保存
```

`outbox_tasks` 表示：

```text
这条数据以后还需要 Worker 处理
```

两者必须在**同一个数据库事务**完成。`02-采集API与事务Outbox.md`

为什么？

假设不用 Outbox，而是：

```text
① 写数据库
② 发 MQ 消息
```

如果发生：

```text
① 数据库写成功

        ↓

服务进程崩了

        ↓

② MQ 消息没发出去
```

结果就是：

```text
telemetry_events 有数据

但是

Worker 永远不知道要处理它
```

这条数据就断链了。

所以采用：

```text
同一个事务

Raw Event
+
Processing Task
```

要么一起成功：

```text
COMMIT
```

要么一起失败：

```text
ROLLBACK
```

这就是 Transactional Outbox 解决的问题：

> **保证“数据已经接收”和“未来一定有机会被处理”之间不会断链。**

---

# 5. 到这里为什么就可以返回 HTTP 202

只要：

```text
telemetry_events
+
outbox_tasks
```

事务提交成功，Ingestion API 就可以告诉 SDK：

```http
202 Accepted
```

这里非常容易误解。

`202` **不是说：**

```text
p75 已经计算完成
图表已经更新
```

而是：

```text
数据已经可靠保存
+
后续处理任务已经可靠保存
```

所以此时请求链路就结束了。

浏览器不用等待：

```text
Worker
→ 样本处理
→ 聚合
→ p75
→ 看板
```

全部完成。

这也是为什么系统把：

```text
接收
```

和

```text
计算
```

分离。

否则如果在 HTTP 请求里同步完成所有计算：

```text
浏览器
 → 接收
 → 写库
 → LCP merge
 → rating
 → 聚合
 → cache
 → response
```

服务端处理时间会明显增长，而且其中任何一个计算步骤故障都会影响数据接收。

现在变成：

```text
同步链路：
校验 → 可靠保存 → 202

异步链路：
Worker → 投影 → 聚合 → 查询
```

接收 API 可以保持“**快而可靠**”。

---

# 6. 第五道：Worker 从 Outbox 领取任务

202 返回以后，真正的数据加工才开始。

Worker 不处理浏览器 HTTP 请求，而是不断读取：

```text
outbox_tasks
```

状态大致变化：

```text
pending
   ↓
processing
   ↓
completed
```

多个 Worker 可以同时运行。

领取任务时使用：

```sql
FOR UPDATE SKIP LOCKED
```

假设：

```text
Worker A
拿走 task 1 ~ 100

Worker B
看到这些已经被锁
直接跳过
拿 task 101 ~ 200
```

这样可以横向扩容，而不会所有 Worker 互相等待。

如果 Worker 拿到任务以后挂掉：

```text
processing
   ↓
超过 5 分钟
   ↓
允许其他 Worker 再次领取
```

因此这里采用的不是“绝对只执行一次”，而是：

```text
At-least-once
+
幂等处理
```

即：

> **允许任务重新执行，但重复执行不能改变最终结果。**

这是为什么后面 `sampleId / sequence` 等幂等机制非常重要。`03-Worker投影与性能指标计算.md`

---

# 7. 第六道：Worker 把“事件”变成“领域数据”

Worker 不会把所有 Event 放在一张表里直接统计。

而是根据事件类型进行投影：

| 原始事件 | Worker 转换后 |
|---|---|
| performance | `performance_samples` |
| view | `view_records` |
| custom event | `custom_event_samples` |

原因是三种数据的语义完全不同。

例如：

```text
performance
```

关心：

```text
value
sampleId
sequence
rating
```

而：

```text
view
```

关心：

```text
view start
view end
route
session
duration
```

所以：

```text
telemetry_events
```

回答：

> 浏览器发来了什么？

而：

```text
performance_samples
view_records
custom_event_samples
```

回答：

> 平台应该怎么理解这些数据？

这一步就叫：

> **Projection，领域投影。**

---

# 8. LCP 在 Worker 这里发生了什么

这是理解整个链路最关键的例子。

假设一个页面访问过程中 SDK 上报：

```text
LCP sampleId = A

sequence 0
1800 ms

sequence 1
2300 ms

sequence 2
2600 ms
```

注意：

```text
3 个原始 Event
```

但它们描述的是：

```text
1 个 LCP Sample
```

因此 Worker 处理时不是：

```text
INSERT 1800
INSERT 2300
INSERT 2600
```

否则平台会认为有三个用户样本。

而是：

```text
第一次：

sample A = 1800

sequence 1 到达：

sample A = 2300

sequence 2 到达：

sample A = 2600
```

最后：

```text
telemetry_events

1800
2300
2600
```

但是：

```text
performance_samples

A → 2600
```

Worker 只接受更大的 `sequence`；旧 sequence 或乱序更新不会覆盖新值。这样一个真实用户的一次 LCP 观测在统计中始终只占一个样本。`03-Worker投影与性能指标计算.md`

这一步非常重要，因为：

> **服务端聚合的不是“LCP 上报事件”，而是“最终形成的 LCP 样本”。**

---

# 9. Worker 还会统一计算 Server Rating

例如 LCP：

```text
1800 ms
```

服务端会根据项目当前阈值判断：

```text
good
```

而：

```text
4500 ms
```

可能得到：

```text
poor
```

为什么客户端已经有 `clientRating`，服务端还要重新计算？

因为不同 SDK 版本可能使用不同规则，而项目还可能配置自己的阈值。

如果直接相信客户端：

```text
SDK v1 → good
SDK v2 → needs-improvement
```

最后平台统计口径可能不一致。

所以：

```text
clientRating
    ↓
保留用于排查

serverRating
    ↓
作为平台统计口径
```

这样所有样本最终统一到服务端定义。

---

# 10. 第七道：为什么还要做 TimescaleDB 聚合

Worker 现在已经得到：

```text
performance_samples

用户 A LCP = 1800
用户 B LCP = 2100
用户 C LCP = 2500
用户 D LCP = 4200
...
```

少量数据可以直接查。

但如果一天有：

```text
100 万
1000 万
1 亿
```

性能样本，每次打开页面都重新扫描所有行：

```sql
SELECT percentile(...)
FROM performance_samples
WHERE ...
```

成本会越来越高。

因此 TimescaleDB 会进一步做：

```text
performance_samples
      ↓
1 minute rollup
      ↓
1 hour rollup
```

一分钟聚合并不是只存：

```text
p75 = 2300
```

而是保存：

```text
count
min
max
average
percentile aggregate state
good count
needs-improvement count
poor count
session HLL
view HLL
...
```

尤其是 percentile 保存的是**可继续合并的分布状态**。

原因是：

```text
10:01 p75 = 1000
10:02 p75 = 3000
```

不能：

```text
(1000 + 3000) / 2
```

得到这一小时的 p75。

真正正确的是：

```text
10:01 distribution
        +
10:02 distribution
        ↓
合并整体 distribution
        ↓
重新取 p75
```

当前实现就是通过 Timescale Toolkit 的 percentile aggregate state 来支持这种合并。`04-TimescaleDB聚合与查询链路.md`

---

# 11. 最后一层：Analytics API 才把这些数据解释成页面指标

到了这里，数据库里已经有：

```text
Raw Event
领域 Sample
分钟 Rollup
小时 Rollup
```

但是浏览器看板不会直接访问数据库。

它调用：

```text
/api/v1/projects/:projectId/analytics/...
```

Analytics API 再根据：

```text
from
to
environment
version
routeName
metric
```

查询对应数据。`04-TimescaleDB聚合与查询链路.md`

然后才得到最终用户看到的：

```text
LCP p75

LCP good rate

LCP poor rate

LCP coverage

route ranking

LoAF / 1000 views

View 数

Session 数
```

例如：

```text
1000 个 View

其中
800 个 View 产生 LCP

Coverage
= 800 / 1000
= 80%
```

又例如这 800 个 LCP：

```text
从小到大排序

第 75% 位置
= 2400ms
```

于是：

```text
LCP p75 = 2400ms
```

---

# 12. 最终把整条链路压缩成四句话

你现在可以把“**SDK 批量发送以后**”理解成四层：

```text
第一层：接收

Batch
→ 校验 / 脱敏 / eventId 去重
→ telemetry_events + Outbox
→ 202
```

解决：

> **数据能不能安全、可靠地收下来。**

```text
第二层：解释

Outbox
→ Worker
→ performance_samples / view_records / custom_event_samples
```

解决：

> **这条原始事件在监控系统里到底代表什么。**

```text
第三层：统计

领域样本
→ minute rollup
→ hour rollup
```

解决：

> **大量用户样本怎么高效形成可查询的统计分布。**

```text
第四层：展示

Analytics API
→ p75 / coverage / rating / route ranking
→ Dashboard
```

解决：

> **最终用户怎么看这些数据。**

所以这条链路最核心的设计思想其实是：

```text
SDK 负责产生“事实”
        ↓
API 负责可靠“接收事实”
        ↓
Worker 负责解释“事实的业务语义”
        ↓
TimescaleDB 负责汇总“大量事实”
        ↓
Analytics API 负责生成“用户能理解的指标”
```

而且有一个边界一定要记住：**服务端不是拿普通事件重新推导 LCP、INP、CLS。SDK 已经形成性能指标样本，服务端负责样本修订、统一评级以及跨大量访问进行统计聚合。** `官网性能监控服务端聚合与可视化全链路.md`

## Prompt:
2026/9/22 18:41:59

web-vital 计算的LCP不能保证是 最终的LCP嘛？为什么Worker 只接受更大的 `sequence`；  

clientRating   是什么时候计算的 SDK不是指计算最终值吗

TimescaleDB 聚合  没有理解

## Response:
2026/9/22 18:42:08

你这里其实卡在三个层次混在一起了：**浏览器侧“当前指标值”**、**服务端“当前样本”**、**大量样本的“统计聚合”**。我分开讲，先把 LCP 和 `clientRating` 讲清楚，再单独解释 TimescaleDB。

> **澄清指标时机**
>
> 我会依据现有资料解释：`clientRating` 通常随每次回调的当前指标一起传递；采集器仍区分临时与最终状态，因为路由切换、页面隐藏或视图结束可能改变发送时机，即使当前评分已经可用。
>
> **澄清了指标时机**
>
> 
>
> **解析 Web Vitals 最终值、上报与评分流程**
>
> 
>
> 思考了 25s

对，你的理解有一部分是对的：**`web-vitals` 确实负责计算 LCP，SDK 并不是重新计算 LCP。** 现在容易混淆的是“`web-vitals` 得出的最终指标值”和“我们协议里的 `final` 状态”不是完全同一个概念。

## 1. `web-vitals` 算出来的 LCP，不就是最终 LCP 吗？

对于当前默认配置 `reportAllChanges=false`，可以近似理解为：**是的，`web-vitals` 通常会等到 LCP 候选已经应该结算时，再把指标回调给 SDK。**

浏览器实际上可能经历：

```text
页面加载

1200ms：当前最大内容 A
    ↓
1800ms：出现更大的内容 B
    ↓
2600ms：出现更大的内容 C
    ↓
用户首次交互 / 页面隐藏
    ↓
LCP 候选停止
    ↓
web-vitals 回调：
LCP = 2600ms
```

当前 `reportAllChanges=false` 时，`web-vitals` 不会把 1200、1800、2600 每次变化都回调给 SDK，而是内部持续维护当前 metric，主要在指标结算时回调。`官网性能监控全流程链路.md`

所以这里你的理解应该是：

> **LCP 的计算和候选筛选，是 `web-vitals` 完成的；SDK 不负责再次判断哪个 DOM 元素才是 LCP。**

---

但当前项目又自己加了一层：

```text
web-vitals 的 metric
        ↓
SDK Collector
        ↓
provisional / final
```

这两个“最终”其实是两层概念。

文档明确说明：`web-vitals` 每次回调进来以后，Collector **统一先标记为 `provisional`**；SDK 自己在 `view.route-change` 或 `pagehide` 时，再把缓存的最新值发一次 `final`。`官网性能监控全流程链路.md`

所以可能出现：

```text
web-vitals：
LCP = 2600ms
它认为这个指标已经可以报告

        ↓

SDK：

sampleId=A
sequence=0
value=2600
state=provisional

        ↓ pagehide

sampleId=A
sequence=1
value=2600
state=final
```

注意：

**值没变。**

这里只是 SDK 自己定义的样本生命周期从：

```text
provisional
→
final
```

发生变化。

因此可以把两层含义区分成：

```text
web-vitals
“我认为 LCP 的值应该是 2600ms”

SDK
“这条监控样本在我的 View 生命周期中是否已经关闭”
```

这也是文档所说的“两层完成语义”。`官网性能监控全流程链路.md`

---

## 2. 那为什么还需要 `sequence`？

如果永远都是：

```text
2600 provisional
2600 final
```

确实看起来 `sequence` 没什么意义。

但协议需要支持另一种配置：

```text
reportAllChanges=true
```

这时 `web-vitals` 的 metric 每次真正变化，都可能回调。

例如 LCP：

```text
1200
  ↓
1800
  ↓
2600
```

SDK 可能形成：

```text
sampleId=A, sequence=0, value=1200, provisional

sampleId=A, sequence=1, value=1800, provisional

sampleId=A, sequence=2, value=2600, provisional

sampleId=A, sequence=3, value=2600, final
```

这些不是 4 个 LCP。

而是：

```text
同一个 LCP Sample A
经历了 4 个版本
```

文档中的完整算例也是这个结构。`官网性能监控全流程链路.md`

所以：

```text
sampleId
```

回答：

> 这是哪个指标实例？

而：

```text
sequence
```

回答：

> 这是这个指标实例的第几个版本？

---

### Worker 为什么“只接受更大的 sequence”

因为网络不能保证这些 HTTP 批次严格按顺序到达。

比如 SDK 发：

```text
seq=0  1200
seq=1  1800
seq=2  2600
```

理论发送顺序是：

```text
0 → 1 → 2
```

但实际服务端可能收到：

```text
seq=0
seq=2
seq=1
```

如果 Worker 不检查 sequence：

```text
先写：

2600
```

之后迟到：

```text
1800
```

数据库可能被错误覆盖成：

```text
LCP = 1800
```

所以 Worker 做：

```text
当前数据库 sequence = 2

收到 sequence = 1

因为：
1 < 2

忽略
```

只有：

```text
newSequence > currentSequence
```

才能更新。

因此 sequence 本质解决：

> **同一个性能样本发生多次修订时，如何处理乱序、重复和迟到更新。**

文档中的规则就是：相同或更低 sequence 不更新，更高 sequence 才修订当前样本。`03-Worker投影与性能指标计算.md`

所以在当前 `reportAllChanges=false` 下，你可以认为：

```text
sequence 的价值没有那么明显

但协议设计支持：
reportAllChanges
+ final snapshot
+ 网络乱序
+ 重试
```

---

# 3. `clientRating` 是什么时候算出来的？

这里也要修正一个理解：

> `clientRating` 不是 SDK 在“最终阶段额外计算出来”的。

当前 SDK 使用：

```ts
onLCP()
onFCP()
onINP()
onCLS()
```

调用 `web-vitals@6.2.1`。

而 `web-vitals` 返回的 metric 对象本身就包含：

```text
id
value
delta
rating
entries
navigationType
navigationId
```

SDK 只是把其中的：

```text
metric.rating
```

翻译成协议里的：

```text
clientRating
```

文档对此有明确说明。`官网性能监控全流程链路.md`

比如：

```text
web-vitals callback

{
  name: "LCP",
  value: 2600,
  rating: "needs-improvement"
}
```

SDK 转换：

```text
{
  name: "LCP",
  value: 2600,
  clientRating: "needs-improvement"
}
```

所以：

```text
value
rating
```

实际上来自同一个 metric。

---

### 如果开启 `reportAllChanges` 呢？

那就可能每一个当前值都有当前 rating：

```text
1200ms → good

1800ms → good

2600ms → needs-improvement
```

所以 rating 也会跟着 revision 一起变化。

因此不能理解成：

```text
先算最终 LCP
      ↓
再算 clientRating
```

更准确是：

```text
web-vitals 当前 metric
├─ value = 2600
├─ rating = needs-improvement
├─ id = A
└─ delta = ...

        ↓ SDK 翻译

value = 2600
clientRating = needs-improvement
sampleId = A
```

---

# 4. 那为什么服务端还要 `serverRating`？

因为 `clientRating` 表示：

> **客户端按照它当时使用的规则，对这个值做出的评级。**

但是平台希望统一统计口径。

比如：

```text
项目规定：

LCP <= 2000 good
2000~3500 needs-improvement
>3500 poor
```

而某 SDK 自己可能还是：

```text
<=2500 good
<=4000 needs-improvement
>4000 poor
```

对于：

```text
LCP = 2300
```

就可能出现：

```text
clientRating = good

serverRating = needs-improvement
```

所以：

```text
clientRating
→ 留下来排查

serverRating
→ 真正用于 Dashboard 统计
```

当前文档明确规定，看板使用 Worker 根据有效阈值版本重新计算的 `serverRating`，而不是采信客户端评级。`官网性能监控全流程链路.md`

---

# 5. 最后讲你没理解的 TimescaleDB 聚合

这个其实先不要想数据库。

先想一个问题：

假设今天有 **100 万次页面访问**。

每次访问最终有一个 LCP：

```text
用户1    1900
用户2    2400
用户3    2600
用户4    3100
用户5    4200
...
用户100万
```

Worker 最终把这些保存为：

```text
performance_samples
```

这时候如果你问：

> 最近半年 `/home` 页的 LCP p75 是多少？

最原始的方法是：

```text
把半年所有 LCP 样本全部找出来
        ↓
全部排序
        ↓
取第 75% 位置
```

数据很少时没问题。

但数据量巨大以后，每次打开 Dashboard 都这样扫描：

```text
几千万 / 几亿条 performance_samples
```

成本会非常高。

所以才需要 TimescaleDB 聚合。

---

# 6. 聚合最简单的理解：提前把数据“压缩成统计摘要”

假设 10:01 这一分钟有 5 个 LCP：

```text
1000
1500
2000
2500
3000
```

如果我们未来不需要逐条看这 5 个用户，只需要统计，那么可以提前生成：

```text
10:01 LCP Summary

count = 5
min = 1000
max = 3000
avg = 2000

分布摘要 = [这 5 个值的大致分布]

good = 4
needs-improvement = 1
poor = 0
```

实际系统中的一分钟聚合大致就是：

```sql
count(*)
min(value)
max(value)
avg(value)

percentile_agg(value)

good_count
needs_improvement_count
poor_count

session_hll
view_hll
```

而不是只保存一个 p75。`06-指标聚合与评分计算全解.md`

所以你可以把：

```text
performance_samples
```

理解为：

> 每一个用户体验样本。

而：

```text
performance_rollup_1m
```

理解为：

> 这一分钟所有用户体验的统计摘要。

---

# 7. 为什么不直接存一分钟的 p75？

这是 TimescaleDB 聚合最重要的一点。

假设：

```text
10:01

100 个用户
p75 = 1000ms
```

然后：

```text
10:02

10000 个用户
p75 = 3000ms
```

你不能说：

```text
整个两分钟 p75
=
(1000 + 3000) / 2
=
2000
```

这是错误的。

因为第一分钟只有：

```text
100 个样本
```

第二分钟有：

```text
10000 个样本
```

而且 **p75 本身也不能直接平均**。

正确方式是：

```text
10:01 的完整分布
       +
10:02 的完整分布
       ↓
得到 10100 个样本的整体分布
       ↓
重新求 p75
```

但我们又不想保存所有原始值。

于是 Timescale Toolkit 使用：

```text
percentile_agg(value)
```

生成一个：

> **可以继续合并的“分布摘要”。**

所以：

```text
10:01

percentile state A
```

```text
10:02

percentile state B
```

一小时的时候：

```text
A
+
B
+
C
+
...
+
60分钟
    ↓
rollup()
    ↓
一个小时的分布摘要
```

然后：

```text
小时分布摘要
      ↓
求 p50 / p75 / p90 / p95
```

不是：

```text
p75(10:01)
+
p75(10:02)
+
...
```

文档特别强调 `percentile_agg(value)` 保存的是**中间状态，而不是已经算好的 p75 数字**。`06-指标聚合与评分计算全解.md`

---

# 8. 所以 TimescaleDB 在整个系统里的位置

你现在可以把它想成三层：

```text
第一层
performance_samples

A用户 LCP = 1900
B用户 LCP = 2400
C用户 LCP = 2600
D用户 LCP = 3100
...
```

这是：

> **用户级样本。**

然后：

```text
第二层
performance_rollup_1m

10:01
1000个样本
分布摘要 A

10:02
1200个样本
分布摘要 B

10:03
900个样本
分布摘要 C
```

这是：

> **分钟级统计摘要。**

再：

```text
第三层
performance_rollup_1h

10:00~11:00

A+B+C+...
    ↓ rollup

一个小时整体分布摘要
```

这是：

> **小时级统计摘要。**

所以它解决的问题不是：

> “怎么算 LCP？”

LCP 早就在浏览器算完了。

也不是：

> “哪个 sequence 才是最新？”

Worker 已经处理了。

TimescaleDB 解决的是：

> **当我已经拥有百万、千万个不同用户的 LCP 样本后，如何高效地统计这些样本的整体分布。**

---

## 9. 把三块重新串起来

这样整个逻辑就非常清楚了：

```text
浏览器
PerformanceObserver
      ↓
web-vitals
      ↓
计算“一次访问”的 LCP

例如：
2600ms
rating = needs-improvement
      ↓

SDK
      ↓
sampleId=A
sequence=0
value=2600
clientRating=needs-improvement
provisional
      ↓
pagehide
      ↓
sequence=1
value=2600
final

────────────────────────

Worker
      ↓
按 sampleId 找到 A
      ↓
只接受更高 sequence
      ↓
最终 performance_samples

A = 2600ms

同时：
serverRating = needs-improvement

────────────────────────

大量用户

A = 2600
B = 1900
C = 3100
D = 2200
E = 4200
...

      ↓

TimescaleDB

按分钟聚合这些用户样本
      ↓
保存 count + rating counts + 分布摘要
      ↓
分钟摘要继续 rollup 成小时摘要

      ↓

Analytics

从整体分布中取：
p50
p75
p90
p95
```

因此你只需要记住三个不同的问题：

**`web-vitals`：一次用户访问的 LCP 是多少？**

**Worker：这个 LCP 样本的最新版本是哪一个？**

**TimescaleDB：成千上万个用户的 LCP 放在一起，整体分布是什么样？**

这三个层次一旦分开，`sequence`、`clientRating`、`p75` 就不会混在一起了。

## Prompt:
2026/9/22 18:48:47

分布摘要 = [这 5 个值的大致分布]    是什么意思， 计算一个小时是怎么计算，  数据库存储的是分钟的分布摘要吗

## Response:
2026/9/22 18:48:57

对，**当前实现里数据库确实会保存“分钟级分布摘要”**，而不是只保存这一分钟的 p75 数字。然后一小时的数据，是把 60 个分钟摘要继续 `rollup()` 合并成一个小时摘要。`06-指标聚合与评分计算全解.md` `06-指标聚合与评分计算全解.md`

你可以先把“分布摘要”理解成一句话：

> **它是对这一批原始数值分布的压缩表示，保留了足够的信息，使后面还能继续合并，并重新计算 p50、p75、p90、p95。**

## 1. “分布摘要”到底是什么意思

假设 10:01 这一分钟有 5 个 LCP：

```text
1000
1500
2000
2500
3000
```

最原始的方式，是数据库完整保存这 5 个值。

但做分钟聚合时，TimescaleDB 会生成类似：

```text
10:01 LCP

sample_count = 5
min = 1000
max = 3000
avg = 2000

value_percentiles = 某个 percentile aggregate 状态
```

这里的：

```text
value_percentiles
```

不是：

```text
p75 = 2500
```

而是类似：

```text
“这 5 个数整体大概是怎样分布的”
```

的一个**压缩状态**。

文档明确说，`percentile_agg(value)` 保存的是“可再合并的中间状态”，而不是已经算好的单个数字。`06-指标聚合与评分计算全解.md`

---

## 2. 为什么不能直接存 p75

假设两分钟：

```text
10:01
100 个样本
p75 = 1000
```

```text
10:02
10000 个样本
p75 = 3000
```

如果只保存：

```text
1000
3000
```

那你以后想算 10:01~10:02 的整体 p75，就没法正确算了。

因为：

```text
(1000 + 3000) / 2
```

完全不是整体 p75。

原因有两个：

```text
10:01 只有 100 个样本
10:02 有 10000 个样本
```

流量权重不同。

更重要的是：

> **分位数本身不可直接平均。**

所以系统不能只保存：

```text
minute.p75
```

而要保存：

```text
minute.distribution_state
```

这样以后还能恢复“整体分布”。

---

# 3. 一个更直观的例子

假设：

```text
10:01

1000
1100
1200
1300
1400
```

第二分钟：

```text
10:02

4000
4100
4200
4300
4400
```

如果直接算每分钟：

```text
10:01 p75 ≈ 1300
10:02 p75 ≈ 4300
```

然后平均：

```text
(1300 + 4300) / 2
= 2800
```

但正确方法其实应该是把所有样本放在一起：

```text
1000
1100
1200
1300
1400
4000
4100
4200
4300
4400
```

然后从**这 10 个值整体**重新找第 75% 位置。

这才叫：

```text
整体 p75
```

所以真实系统希望做到：

```text
10:01 分布
     +
10:02 分布
     ↓
整体分布
     ↓
重新求 p75
```

而不是：

```text
10:01 p75
+
10:02 p75
```

---

# 4. 但是数据库又不想保存所有原始值

问题就在这里。

如果半年有：

```text
1 亿个 LCP
```

为了算半年 p75，难道一直保存并扫描：

```text
1 亿个 double
```

当然可以，但查询成本会越来越高。

所以 Timescale Toolkit 使用：

```sql
percentile_agg(value)
```

把：

```text
1000
1100
1200
...
```

压缩成：

```text
一个 percentile aggregate state
```

文档里把它解释为**可合并的分布状态**。`官网性能监控服务端聚合与可视化全链路.md`

你可以暂时把它想象成：

```text
不是：

[1000, 1100, 1200, 1300, 1400]

而是：

“1000~1400 这个区间有多少数据，
数据大致集中在哪里”
```

当然数据库内部不是简单存几个区间计数，而是 Timescale Toolkit 的近似分位数结构。

---

# 5. 数据库具体存什么

当前分钟 Rollup 大致是：

```sql
SELECT
  time_bucket('1 minute', observed_at),

  count(*)                AS sample_count,
  min(value)              AS minimum,
  max(value)              AS maximum,
  avg(value)              AS average,

  percentile_agg(value)   AS value_percentiles,

  good_count,
  needs_improvement_count,
  poor_count,

  session_hll,
  view_hll
FROM performance_samples
```

所以数据库里的分钟表可以想象成：

| minute | count | min | max | avg | distribution |
|---|---:|---:|---:|---:|---|
| 10:01 | 100 | 900 | 3500 | 1800 | Sketch A |
| 10:02 | 120 | 1000 | 4200 | 2100 | Sketch B |
| 10:03 | 80 | 800 | 3800 | 1900 | Sketch C |

这里：

```text
Sketch A
Sketch B
Sketch C
```

就是你说的“分布摘要”。

所以答案是：

> **是的，分钟级聚合表会保存分钟分布摘要。**

---

# 6. 那一个小时具体怎么算

假设 10:00~11:00 有：

```text
10:00 → Sketch A
10:01 → Sketch B
10:02 → Sketch C
...
10:59 → Sketch Z
```

小时聚合不是重新去查所有原始 LCP。

而是：

```text
Sketch A
+
Sketch B
+
Sketch C
+
...
+
Sketch Z

      ↓ rollup()

Hour Sketch
```

SQL 中就是：

```sql
rollup(value_percentiles)
```

文档中的小时聚合就是这么做的。`06-指标聚合与评分计算全解.md`

然后如果 Dashboard 要：

```text
p50
p75
p90
p95
```

就从：

```text
Hour Sketch
```

里面分别取：

```text
approx_percentile(0.50)
approx_percentile(0.75)
approx_percentile(0.90)
approx_percentile(0.95)
```

可以理解成：

```text
60 个分钟分布
      ↓
合成 1 个小时分布
      ↓
再从这个整体分布里问：

50% 在哪里？
75% 在哪里？
90% 在哪里？
95% 在哪里？
```

---

# 7. 一个小时不只是“分布”要合并

一分钟表里还有其他字段。

例如：

```text
10:01
count = 100
avg = 1000
```

```text
10:02
count = 900
avg = 3000
```

小时平均值不能：

```text
(1000 + 3000) / 2
```

而应该：

```text
(100 × 1000 + 900 × 3000)
/
(100 + 900)
```

所以小时聚合的规则是：

```text
sample_count
→ 直接相加

min
→ 取所有分钟 min 的最小值

max
→ 取所有分钟 max 的最大值

average
→ 按 sample_count 加权

percentile
→ rollup 分布摘要

good / poor count
→ 直接相加

session / view
→ rollup HLL 去重摘要
```

文档也明确说明，小时聚合中平均值需要按样本量加权，分位数必须合并中间状态，不能平均各分钟 p75。`04-TimescaleDB聚合与查询链路.md`

---

# 8. 所以数据库实际上存在两级“摘要”

你可以这样理解：

```text
performance_samples
```

存：

```text
每一个真实用户样本

A → 1900
B → 2400
C → 2600
D → 3100
...
```

然后：

```text
performance_rollup_1m
```

存：

```text
一分钟的统计摘要

count
avg
distribution sketch
rating counts
HLL
...
```

再：

```text
performance_rollup_1h
```

存：

```text
一小时的统计摘要

count
weighted avg
merged distribution sketch
rating counts
merged HLL
...
```

因此：

```text
原始样本
      ↓
分钟摘要
      ↓
小时摘要
      ↓
p75
```

注意最后这点尤其重要：

> **数据库聚合层主要保存的是“可继续计算的状态”，而不是提前把所有最终指标都算死。**

这样：

```text
同一个 Hour Sketch
```

以后既可以问：

```text
p50?
```

也可以问：

```text
p75?
```

还可以问：

```text
p95?
```

而不需要为每个分位数单独维护一份聚合。

---

## 9. 你现在可以把“分布摘要”记成这个模型

```text
原始：

1000 1100 1200 1300 1400
```

经过：

```text
percentile_agg()
```

得到：

```text
Distribution Sketch
```

它不是一个 p75，而是：

> **对整组数值分布的压缩表示。**

然后：

```text
Minute Sketch A
Minute Sketch B
Minute Sketch C
        ↓
      rollup()
        ↓
Hour Sketch
```

最后：

```text
Hour Sketch
   ├─ p50
   ├─ p75
   ├─ p90
   └─ p95
```

这就是当前 TimescaleDB 聚合的核心。



---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)