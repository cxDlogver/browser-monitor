# Browser Monitor SDK 项目知识梳理

## 1. 项目目标与建设背景

### 【项目目标】

Browser Monitor SDK 的建设目标可以归纳为两个闭环：**正常运行时判断项目是否达标，异常发生时快速还原现场并定位问题。**

#### <u>1. 正常运行：用真实线上数据判断项目是否达标</u>

项目在开发环境或测试环境中运行正常，只能说明它在有限条件下能够工作，不能代表真实用户环境中的表现。应用上线后，不同用户的设备性能、浏览器版本、网络质量和操作路径都存在差异，因此项目是否达到预期，需要依赖真实运行数据持续验证。

监控系统首先需要为三类结果提供数据基础：

- **性能指标**：页面加载、内容渲染、交互响应以及持续运行过程是否具有良好的用户体验。
- **稳定性指标**：运行时错误、请求失败、资源加载异常等问题是否控制在合理范围内。
- **业务指标**：用户是否到达关键业务节点、核心业务流程是否完成，以及主要在哪个阶段失败或流失。

因此，正常运行状态下形成的基本闭环是：

```text
应用上线运行 → 采集真实用户运行数据 → 计算性能 / 稳定性 / 业务指标 → 按页面、版本、设备、网络等维度分析 → 判断项目是否达到业务目标和用户体验目标
```

监控的价值不只是得到某一次指标结果，而是建立一套稳定的数据口径，使不同版本、页面和运行环境能够持续进行比较，从而判断一次发布究竟带来了改善还是退化。

#### <u>2. 异常运行：还原线上现场并快速定位问题</u>

第二个目标是解决线上问题难以复现和难以定位的问题。

用户反馈“页面报错”“按钮没有反应”或者“提交失败”时，单独的一条 JavaScript 错误、接口日志或者错误堆栈通常不足以说明问题发生的完整过程。

一次真实的问题可能经历：

```text
进入页面 → 执行关键操作 → 发起业务请求 → 请求失败 → 页面状态异常 → 产生运行时错误
```

如果点击、请求、页面变化和 Error 分散在不同的数据中，并且彼此没有关联，那么最终只能看到“哪里报错了”，很难进一步回答“为什么会报错”。

因此，异常情况下需要记录并关联：

```text
Session → View / 页面 → 用户关键操作 → Network Request → Error / 页面异常
```

最终形成：

```text
线上异常 → 定位页面与运行环境 → 关联关键操作 → 关联请求与页面变化 → 还原问题过程 → 定位可能原因 → 分析影响范围
```

监控系统不仅要帮助找到某一次异常，还要进一步回答问题主要集中在哪些页面、版本、浏览器、设备或者网络环境中，从而判断问题的影响范围。

### 【项目需要解决的问题】

上述两个目标背后，真正需要解决的是**应用上线以后，浏览器端真实运行过程缺少持续、完整的数据记录**。

线上环境与开发环境最大的区别在于不可控。同一份前端代码可能运行在不同的设备性能、浏览器版本、网络环境、页面状态、用户操作路径和应用版本中。测试环境不一定能够覆盖这些组合，因此一些问题只有在线上某类用户、某个版本或者特定网络条件下才会出现。

这会形成两个核心的信息缺口。

#### <u>1. 缺少能够持续评价项目状态的数据</u>

如果没有客户端监控，只能依赖开发阶段测试、人工体验或者零散服务端数据判断项目状态。

但是服务端日志无法完整回答：

- 用户是否真正看到了页面内容；
- 页面加载和交互是否足够快；
- 页面渲染过程中是否发生卡顿；
- 用户是否真正完成了关键业务流程；
- 某些问题是否只发生在特定设备、浏览器或网络环境。

因此，需要在真实用户环境中持续采集性能、稳定性和业务过程数据，形成项目上线后的长期评价依据。

#### <u>2. 缺少能够还原浏览器运行现场的数据</u>

浏览器中的一次完整操作通常横跨多个不同机制。

例如：

```text
用户点击 → DOM Event
页面请求 → Fetch / XMLHttpRequest
运行时异常 → error / unhandledrejection
性能变化 → Performance API
SPA 页面切换 → History API
```

这些信息不会天然组成一条完整的问题链路。

浏览器只分别暴露不同时间发生的事实，而不会自动告诉监控系统：

> 某一次点击触发了哪个请求，这个请求发生在哪个页面，请求失败之后又引发了哪个 Error。

因此，前端监控需要主动记录这些关键事实，并为不同数据建立页面、会话、操作和请求之间的关联。

### 【Browser Monitor SDK的作用】

解决上述问题，并不意味着把各种监听和上报逻辑直接写进业务页面。

如果每个业务页面分别实现：

```text
页面 A
├─ 性能监听
├─ Error 监听
├─ Fetch 监听
└─ 数据上报

页面 B
├─ 性能监听
├─ Error 监听
├─ Fetch 监听
└─ 数据上报
```

那么监控能力就会和业务代码长期绑定。

随着页面和监控需求增加，很容易演变为：

```text
新增一种指标 → 多个页面分别修改
修改数据格式 → 多套监控代码分别修改
调整脱敏规则 → 各业务重新适配
修改发送策略 → 所有采集代码受到影响
```

而监控本身具有明显的公共能力特征。

不同页面虽然业务不同，但都需要处理：

```text
浏览器事实采集 → 形成监控数据 → 补充运行上下文 → 数据校验和脱敏 → 控制数据量 → 缓存和批量发送
```

性能、错误、请求和业务事件虽然数据内容不同，但它们在采集之后都会面对公共上下文、字段校验、敏感信息过滤、采样、限频、缓存和发送等共同问题。

因此，需要把这些能力从具体业务中抽离出来，形成独立的 Browser Monitor SDK。

整体关系可以表示为：

```text
业务应用
├─ 正常业务逻辑
└─ Monitor SDK → 观察浏览器运行过程 → 形成监控数据 → 统一处理和上报
```

业务执行仍然是主流程，监控只是旁路观察。

例如业务调用 `fetch` 时，SDK 可以记录请求开始时间、结束状态和耗时，但是必须把原来的 Response 或异常继续返回给业务代码。**监控失败可以导致少采一条数据，但不能改变业务本身的执行结果。**

SDK 化最终解决的是两个层次的问题：

**业务层：**负责完成用户真正的业务目标。  
**Monitor SDK：**负责统一观察、记录和传递线上运行事实。

这样既能够保证不同页面拥有一致的监控能力，也能够使后续新增监控指标、扩展新的数据类型或调整数据处理方式时，主要在 SDK 内部完成，而不需要让大量业务代码重复修改。

最终形成整个项目的起点：

```text
线上环境不可控
├─ 需要真实数据判断项目是否达标
└─ 需要完整运行事实定位线上异常

两类需求 → 浏览器信息来自不同 API、天然分散 → 持续记录并关联关键运行事实 → 抽离跨页面、跨业务公共能力 → 构建 Browser Monitor SDK
```

## 2. Monitor SDK 的设计思想

Monitor SDK 的设计思想可以按照它需要解决的五类不同问题进行划分：

```text
业务边界问题 → 监控能力如何与业务代码解耦
数据差异问题 → 不同来源、不同结构的数据如何进入统一链路
现场割裂问题 → 分散的数据如何重新关联成一次完整运行过程
工程演进问题 → SDK 内部如何拆分，避免局部变化影响整体
安全与成本问题 → 应该采什么、采多少，以及怎样保证监控不反过来影响业务
```

这五个问题分别对应 **业务边界、数据边界、关联边界、代码边界和资源边界**，因此可以作为 Monitor SDK 设计的五个核心思想。

五个设计思想最终可以收敛为一条完整逻辑：

```text
1. 业务边界：监控不侵入具体业务 → 独立 SDK → 自动采集 + 显式业务埋点
2. 数据边界：数据来源和结构不同 → Instrumentation + Collector → 统一 Processing + Transport
3. 关联边界：一次运行产生多条数据 → Session / View / Action / Request Context → 建立关联 → 还原现场
4. 代码边界：SDK 能力持续变化 → 按变化原因拆分模块 → 统一生命周期与 Hook 管理 → 局部变化不扩散
5. 资源边界：监控不能无限采集 → 最小必要原则 → Redact / Sampling / Rate Limit / Batch → 安全与成本受控
```

最终，Monitor SDK 的整体设计原则可以概括为：

> **在不改变业务执行的前提下，以低侵入方式持续观察浏览器运行事实；通过稳定的数据管线将异构数据转换为可治理的监控数据，通过 Context 保留真实运行关系，再以模块化架构和受控的数据策略保证整个监控能力能够长期、安全地演进。**

### 【设计思想一：监控能力与业务代码解耦】

#### <u>1. 核心问题</u>

如果性能采集、错误监听、请求监听和数据上报逻辑直接散落在具体页面或业务组件中，监控能力就会与业务代码形成强耦合。

例如每个页面分别实现：

```text
业务页面
├─ 业务逻辑
├─ Error 监听
├─ Fetch 监听
├─ Performance 监听
└─ 数据上报
```

随着页面和监控需求增加，会产生几个问题：

- 相同监控逻辑在不同业务页面中重复实现；
- 新增或修改一种监控能力时，需要修改大量业务代码；
- 不同业务可能形成不同的数据采集和处理标准；
- 监控逻辑本身的异常可能影响业务执行。

因此，监控不能成为具体业务逻辑的一部分，而应该作为独立的基础能力存在。

#### <u>2. 核心目标</u>

核心目标是：

> **将通用监控能力从业务代码中抽离，形成独立的 Monitor SDK，使业务负责完成业务目标，SDK 负责旁路观察运行过程。**

业务代码与监控代码形成明确边界：

```text
业务代码 → 完成页面展示、请求、交易等业务逻辑

Monitor SDK → 观察页面运行过程 → 形成监控数据 → 处理并上报
```

即使监控发生异常，也应该最多损失一部分监控数据，而不能改变业务原有执行结果。业务是主流程，监控是旁路观察者。

#### <u>3. 设计思想</u>

业务与监控的解耦主要通过两种接入方式实现。

第一种是 **自动采集 / 自动插装**。

对于所有 Web 应用都具有的通用浏览器事实，可以由 SDK 在初始化后统一监听：

```text
Monitor SDK 初始化 → 注册浏览器 Instrumentation
自动观察：Performance API｜window.error｜unhandledrejection｜fetch / XMLHttpRequest｜History｜Page Lifecycle
```

业务页面只需要初始化 SDK，不需要在每一个请求、异常或性能指标旁边重新编写监控代码。

第二种是 **显式业务埋点**。

浏览器只能知道“发生了 click”，却不知道这个 click 对业务意味着什么。

例如浏览器只能观察到 `click`，但 SDK 无法可靠判断它代表提交订单、领取优惠券、登录成功还是完成支付。

因此，业务特有的语义仍然需要显式表达：

```ts
monitor.track('order_submit', {
  orderType: 'normal',
});
```

最终形成：

```text
通用运行事实 → SDK 自动采集
特定业务语义 → 业务通过监控 API 显式埋点
```

自动采集减少业务侵入，显式埋点补充无法自动推断的业务语义，两者共同完成业务与监控的解耦。

### 【设计思想二：异构数据使用统一监控管线】

#### <u>1. 核心问题</u>

浏览器中需要监控的数据并不是一种数据。

不同数据来自完全不同的浏览器能力：

```text
Performance → PerformanceObserver / web-vitals / rAF
Error → error / unhandledrejection
Network → fetch / XMLHttpRequest / Resource Timing
Event → DOM Event / 业务 API
View → History / Page Lifecycle
```

它们不仅获取方式不同，原始数据结构和最终含义也完全不同。

例如：

```text
LCP → value / rating / navigationType
Error → message / stack / type
Network → method / url / status / duration
Event → name / target / properties
```

如果每一种数据从采集一直独立实现到发送，就会形成多条彼此割裂的监控链路：

```text
Performance → 自己处理 → 自己发送
Error       → 自己处理 → 自己发送
Network     → 自己处理 → 自己发送
```

最终会产生重复逻辑以及不一致的数据标准。

#### <u>2. 核心目标</u>

核心目标不是把所有监控数据变成完全一样的数据结构，而是：

> **允许不同数据保留自己的领域语义，同时让它们进入同一套采集、治理和上报框架。**

因此要区分两个层次：

```text
不同：数据来源｜采集方式｜领域字段｜指标计算逻辑
统一：公共上下文｜基础协议｜脱敏规则｜采样与限频｜队列｜批量发送
```

这就是“**统一不等于抹平差异**”。

#### <u>3. 设计思想</u>

整个 SDK 建立稳定的数据流水线：

```text
浏览器事实 → Instrumentation → Raw Signal → Collector → Context → Protocol → Processing → Transport
```

其中可以进一步理解为三个阶段。

第一阶段解决**怎么获得数据**：

`Instrumentation`：面向不同浏览器 API 捕获原始事实。

例如：`Fetch Instrumentation`、`PerformanceObserver Instrumentation`、`Global Error Instrumentation`、`DOM Event Instrumentation`。

第二阶段解决**这些事实代表什么**：

`Collector`：将浏览器事实转换成具体监控语义。

例如：

```text
PerformanceEntry → Performance Collector → Performance Metric
Fetch Result → Network Collector → Network Record
window.error → Error Collector → Error Record
```

第三阶段解决**所有数据共同如何处理和发送**：

```text
Monitoring Data → Normalize → Redact → Dedupe / Sampling / Rate Limit → Queue / Batch → Transport
```

因此这一层设计可以概括为：

> **多源采集、领域转换、统一治理、统一输出。**

### 【设计思想三：通过 Context 和关联标识还原完整运行现场】

#### <u>1. 核心问题</u>

线上问题通常不是由一条孤立的数据构成的。

一次用户操作可能经历：

```text
用户进入订单页 → 点击提交订单 → 发起 POST /orders → 接口返回 500 → 页面状态处理异常 → JavaScript Error
```

Monitor SDK 可能分别产生：

**可能产生的数据：**View Record、Event Record、Network Record、Error Record、Performance Record。

这些数据表达的是同一次运行过程中的不同侧面。

如果数据之间没有关系，那么后台只能看到：

**此时后台看到的只是：**一个点击、一个请求、一个 Error、一个性能指标。

却不知道这些数据是否来自同一个用户、同一次页面访问或者同一次操作。

#### <u>2. 核心目标</u>

核心目标是：

> **让不同监控数据保留它们在真实运行过程中的上下文和关联关系，从孤立的数据记录进一步形成可以追溯的问题链路。**

这里需要特别区分 **关联** 和 **去重**。

同一次请求可能产生：

```text
Network Record → 描述请求状态和耗时
Error Record → 描述一个可检索、可聚合的异常
```

这两条数据不是重复数据，因为它们回答的问题不同。

真正的重复是：

```text
同一个 Error + 重复监听 → Error A / Error A / Error A
```

前者需要**关联**，后者才需要**去重**。

#### <u>3. 设计思想</u>

需要为监控数据建立分层上下文：

```text
Session
└─ View
   └─ Action / Interaction
      ├─ Request
      └─ Error
```

常见关联标识可以包括：

**常见关联标识：**`sessionId`、`viewId`、`actionId / interactionId`、`requestId`、`traceId / spanId`。

不同标识解决不同范围的问题：

```text
sessionId → 同一次连续使用
viewId → 同一次页面访问
actionId → 同一次用户操作
requestId → Error 与具体请求的关系
traceId → 前后端调用链关联
```

同时，Context 必须强调一个关键原则：

> **上下文应该在事件发生时绑定，而不是等到上报时再读取。**

例如：

```text
页面 A → 发起 Request-01 → 用户进入页面 B → Request-01 返回
```

如果发送数据时才读取：

```ts
window.location.href;
```

Request-01 很可能会被错误归到页面 B。

因此需要在事件发生阶段保存当时的上下文快照：

```text
Request-01
{
  sessionId: "S1",
  viewId: "VIEW-A",
  ...
}
```

即使后续经过缓存和批量发送，它仍然属于原来的 View。

同时也不能为了追求关联而强行制造因果关系。

例如 LCP 通常属于 View 级性能指标，并不意味着它一定由某一次 click 引起。因此关联应该按照实际语义逐层建立：

```text
同一 Session ≠ 一定存在因果关系
同一 View ≠ 一定由同一 Action 引起
拥有 requestId / actionId → 才表达更强的直接关联
```

这样才能既支持现场还原，又避免产生错误的因果解释。

### 【设计思想四：按照变化原因拆分 SDK 模块，并统一管理生命周期】

#### <u>1. 核心问题</u>

业务代码需要与监控解耦，Monitor SDK 内部本身同样需要解耦。

例如以下变化的原因完全不同：

**典型变化来源：**浏览器新增 Performance API、发送接口变化、新增 Error 类型、调整敏感信息规则、调整 SPA 路由识别方式。

如果所有逻辑都放在一个大的 Monitor 类中：

```text
Monitor
├─ Hook Fetch
├─ Performance
├─ Error
├─ Context
├─ Redact
├─ Queue
└─ Send
```

那么一次局部修改就可能影响整个 SDK。

此外，浏览器监控需要修改或监听大量全局能力，例如：

**需要统一管理的全局能力包括：**`fetch`、`XMLHttpRequest`、`History`、`window.error`、DOM Event、`PerformanceObserver`。

如果这些全局资源没有统一生命周期，还会产生重复 Hook、监听器残留和资源泄漏等问题。

#### <u>2. 核心目标</u>

这一层的目标是：

> **按照不同的变化原因建立稳定模块边界，使一个能力的变化尽量只影响所属模块，同时统一控制所有全局监控能力的生命周期。**

这里的模块化和第一层“业务解耦”并不是同一个问题。

第一层解决 `业务系统 ↔ Monitor SDK` 之间的边界；这一层解决 `Monitor SDK 内部：Instrumentation / Collector / Context / Processing / Transport` 之间的边界。

#### <u>3. 设计思想</u>

SDK 可以按照变化原因拆分：

```text
core → SDK 生命周期与模块编排
instrumentation → 浏览器 API 和 Hook
collectors → Performance / Event / Error / Network / View 领域语义
context → Session / View / User / Runtime Context
signals → SDK 内部浏览器事实契约
@browser-monitor/protocol → SDK、API 与 Worker 的协议 2.0 数据契约
processing → Normalize / Redact / Dedupe / Sampling / Rate Limit
transport → Queue / Batch / Sender / Retry / Flush
shared → 无领域语义的基础能力
```

这种拆分不是按照“代码长得像什么”，而是按照“什么原因会让代码变化”。

例如：

```text
新增性能指标 → Performance Collector
调整 URL 脱敏规则 → Processing / Redact
改变批量发送机制 → Transport
改变 SPA 路由判断方式 → View / History
```

而不需要修改整条监控链路。

在模块拆分之外，全局能力还必须拥有完整生命周期：

```text
未安装 → install → 已就绪 → start → 正在采集 → stop → 暂停采集 → start → 重新采集
任意可释放状态 → uninstall / destroy → 恢复浏览器环境
```

生命周期至少需要保证：

- `start()` 重复执行不会重复 Hook；
- `stop()` 可以停止继续生产监控数据；
- 再次 `start()` 可以恢复；
- `destroy()` 可以注销监听器、Observer、Timer，并恢复被包装的全局 API；
- 生命周期函数具有幂等性。

因此，这一层最终解决的是两个问题：

```text
代码层 → 局部变化不扩散
运行层 → 全局 Hook 和资源可安装、启停和释放
```

### 【设计思想五：以最小必要数据为原则控制安全和运行成本】

#### <u>1. 核心问题</u>

监控天然存在一个容易出现的误区：

> 为了以后能够排查问题，把能够采集的数据尽可能全部采集下来。

但监控数据越多，并不意味着监控效果一定越好。

**无限制采集会同时增加：**隐私与安全风险、浏览器 CPU / 内存开销、网络上报成本、存储成本、无效数据噪声和后续分析成本。

而 Monitor SDK 本身与业务共享主线程、内存和网络，因此监控开销过大时，甚至会降低它正在监控的用户体验。

#### <u>2. 核心目标</u>

核心目标是：

> **只采集实现监控目标所必要的数据，并使采集、处理、缓存和上报成本始终处于可控范围内。**

因此监控的优先级始终低于业务正确性。

数据完整性应该围绕监控目标定义，而不是围绕“尽可能多记录”定义。

#### <u>3. 设计思想</u>

首先是**数据最小化**。

**默认采集：**事件类型、发生时间、必要目标标识、必要运行环境、页面和 Session 信息、问题定位需要的关联信息。

**默认不采集：**Password、Token、Cookie 中的敏感内容、Authorization、API Secret / API Key、完整表单输入、无明确用途的 DOM 内容、无差别 Request / Response Body。

业务需要额外字段时，应通过明确白名单决定。

其次是**敏感信息必须尽早处理**。

错误方式是：

```text
原始数据 → Queue → Batch → 发送前 Redact
```

因为敏感信息已经进入 SDK 内部缓存。

正确方式应该是：

```text
Collector → Normalize → Redact → 安全数据 → Queue
```

即敏感数据不能进入后续缓存和发送链路。

第三是**按照数据价值决定采集频率**。

不同数据没有必要采用相同策略。

例如：

```text
JavaScript Error → 事件触发时记录
LCP → 页面生命周期中的结果指标
FPS / Frame Time → 高频产生，使用窗口采样
DOM Event → 只记录白名单关键操作
Network → 按请求类型、URL 或采样策略过滤
```

高频数据通常通过 **Sampling、Rate Limit、Aggregation、Window** 等策略控制，而不是逐条发送原始事件。

最后是**控制发送成本**：

```text
单条小数据 → Memory Queue → Batch → 达到数量 / 时间阈值 → 一次发送
```

页面隐藏或离开时，再进行受控 Flush。

## 3. Monitor SDK 的具体设计

这一章进一步回答工程实现中的三个问题：完整的 Browser Monitor SDK 应该由哪些目录和模块组成；这些模块为什么需要彼此独立；一条浏览器事实如何按照固定顺序经过各模块，最终成为能够发送到监控平台的数据。

目录设计不是把代码按照名称分类，而是把不同的变化原因隔离开。浏览器 API 的变化应该停留在 Instrumentation，监控语义的变化应该停留在 Collector，隐私与流量策略的变化应该停留在 Processing，发送方式的变化应该停留在 Transport。只有这样，新增一种监控能力时，才不需要重新修改整条链路。

### 【整体目录结构】

完整的源码目录按照“入口与编排、事实采集、语义转换、上下文、数据契约、公共处理、数据传输、基础能力”八类职责进行拆分：

```text
src/                              # SDK 源码根目录
├─ index.ts                       # npm 包唯一公开入口
├─ core/                          # 配置、编排和生命周期总控
│  ├─ monitor.ts                  # 实现对外 Monitor 门面
│  ├─ config.ts                   # 合并并校验运行配置
│  ├─ lifecycle.ts                # 管理安装、启停和销毁状态
│  ├─ module-registry.ts          # 注册并统一管理内部模块
│  ├─ signal-hub.ts               # 类型化分发内部 Raw Signal
│  └─ pipeline.ts                 # 串联 Context、Processing 与 Transport
├─ instrumentation/               # 捕获浏览器事实，不解释领域语义
│  ├─ fetch/                      # 包装 Fetch 请求生命周期
│  ├─ xhr/                        # 监听 XMLHttpRequest 生命周期
│  ├─ web-vitals/                 # 安装标准 Web Vitals 观察器
│  ├─ performance-observer/       # 订阅各类 PerformanceEntry
│  ├─ animation-frame/            # 管理 RAF 与帧窗口机械统计
│  ├─ global-errors/              # 捕获运行时、资源和 Promise 异常
│  ├─ dom-events/                 # 捕获白名单用户操作
│  ├─ history/                    # 捕获 SPA 路由与 URL 变化
│  └─ page-lifecycle/             # 捕获页面显示、隐藏、离开和恢复
├─ collectors/                    # 将 Raw Signal 转换为监控领域数据
│  ├─ performance/                # 形成加载、交互和运行性能指标
│  │  ├─ index.ts                 # 汇总 Performance 子 Collector
│  │  ├─ web-vitals.ts            # 将 WebVital Signal 转换为 Payload
│  │  ├─ loaf.ts                  # 将 LoAF Signal 转换为 Payload
│  │  └─ fps.ts                   # 将 FrameWindow Signal 转换为 Payload
│  ├─ event/                      # 形成用户行为和业务事件
│  │  ├─ action/                  # 解释允许记录的 DOM 操作
│  │  └─ custom/                  # 接收 monitor.track() 业务埋点
│  ├─ error/                      # 统一不同来源的异常语义
│  ├─ network/                    # 形成请求、资源、状态和耗时记录
│  └─ view/                       # 管理初始页面和 SPA View 边界
├─ context/                       # 保存并快照事件发生时的运行现场
│  ├─ app-context.ts              # 应用、环境、版本和发布信息
│  ├─ user-context.ts             # 用户标识和白名单用户属性
│  ├─ session-context.ts          # 连续使用过程及 sessionId
│  ├─ view-context.ts             # 页面视图状态及 viewId
│  ├─ action-context.ts           # 关键操作状态及 actionId
│  ├─ runtime-context.ts          # 浏览器、设备、网络和 SDK 信息
│  └─ snapshot.ts                 # 生成不可变 Context Snapshot
├─ signals/                       # 定义只在 SDK 内部流动的 Raw Signal
│  ├─ index.ts                    # SignalMap 与发布、订阅接口
│  ├─ performance.ts              # Web Vitals、LoAF 和帧窗口事实
│  └─ view.ts                     # 路由和页面生命周期事实
├─ processing/                    # 统一执行数据质量、安全和流量治理
│  ├─ pipeline.ts                 # 固定并调度公共处理顺序
│  ├─ normalize/                  # 统一字段、时间、URL 和状态表达
│  ├─ validate/                   # 校验协议、类型和字段约束
│  ├─ redact/                     # 删除或替换敏感信息
│  ├─ filter/                     # 按规则决定数据是否保留
│  ├─ dedupe/                     # 控制时间窗口内的重复记录
│  ├─ sampling/                   # 按策略控制总体保留比例
│  └─ rate-limit/                 # 限制异常突发数据量
├─ transport/                     # 对安全数据进行排队、组批和发送
│  ├─ queue/                      # 管理有容量上限的内存队列
│  ├─ batch/                      # 按数量、大小和时间生成批次
│  ├─ sender/                     # 调用浏览器发送能力上报批次
│  ├─ retry/                      # 有限重试可恢复的发送失败
│  └─ flush/                      # 处理主动刷新和页面收尾
└─ shared/                        # 无监控领域语义的基础能力
   ├─ id/                         # 生成稳定唯一标识
   ├─ time/                       # 提供统一时间能力
   ├─ url/                        # 提供基础 URL 解析能力
   ├─ type-guards/                # 提供运行时类型判断
   └─ safe-execute/               # 隔离内部异常，避免影响业务
```

这棵目录树同时表达了两种关系。

- 横向看，`instrumentation → collectors → context → processing → transport` 构成一条监控数据的处理链路；
- 纵向看，每个目录内部又按照具体变化原因继续拆分。例如 Fetch 和 XHR 的 Hook 方式不同，因此属于两个 Instrumentation；Error 和 Network 对同一个失败请求的解释不同，因此属于两个 Collector；采样和脱敏的处理目的不同，因此属于两个 Processing 阶段。

### 【index：稳定的包入口】

`src/index.ts` 是业务应用能够直接依赖的唯一入口。它负责导出创建 SDK 的工厂函数、公开配置类型、Monitor 生命周期接口以及业务埋点需要使用的类型，不导出内部 Collector、Instrumentation 或 Transport 实现。

业务侧面对的接口保持精简：

```ts
interface Monitor {
  start(): void;
  stop(): void;
  destroy(): void;
  track(name: string, properties?: Record<string, unknown>): void;
  setUser(user: { id?: string; properties?: Record<string, unknown> }): void;
  flush(): Promise<void>;
}
```

`createMonitor(options)` 负责创建 Monitor 实例。业务不需要知道 SDK 内部注册了哪些 Instrumentation，也不应该直接启动某个 Collector。这样既能阻止业务绕过 Processing 和 Transport，也能保证内部目录调整时不破坏业务接入方式。

`index.ts` 只负责公开能力，不创建全局监听、不处理数据，也不发送请求。真正的实例创建和模块组合交给 Core 完成。

### 【core：SDK 的运行总控】

Core 位于公开入口和内部模块之间。它知道完整链路由哪些模块组成，负责创建共享依赖、注册模块、协调生命周期并连接数据管线，但不实现具体浏览器 Hook、指标计算、脱敏规则或网络发送。

#### <u>1. monitor：统一对外行为</u>

`monitor.ts` 实现公开的 Monitor 接口。业务调用 `start()`、`stop()`、`destroy()`、`track()`、`setUser()` 和 `flush()` 时，Monitor 将命令交给相应内部模块，而不是亲自完成采集和发送。

例如，`track()` 把业务明确表达的事件交给 Custom Event Collector；`setUser()` 只更新 User Context；`flush()` 只要求 Transport 尽快处理当前队列。Monitor 的作用是提供稳定门面，并隐藏内部模块数量和执行细节。

#### <u>2. config：形成不可歧义的运行配置</u>

`config.ts` 负责合并默认配置和业务配置，校验采样比例、队列容量、批量阈值、URL 规则、采集端点和模块开关，再把配置转换为内部使用的规范形式。

配置只在 Core 中解析一次。其他模块接收已经校验过的局部配置，不能各自重新解释默认值。否则同一个字段可能在 Collector 和 Transport 中产生不同含义，最终导致启停状态和发送策略不一致。

**一、配置模块的职责边界**

`config.ts` 是 SDK 内部唯一有权解释宿主配置的模块。它把大量可选的 `MonitorOptions` 转换为字段已经收敛的 `NormalizedMonitorOptions`，集中完成三类工作：为缺省字段补充默认值；对必填项、数值区间和 DSN 进行 Fail Fast 校验；消除 Collector、Processing 与 Transport 分别解释同一字段的可能。

它只做类型收窄、数值校验和配置归一化。除 DSN 归一化时借用 `location` 作为相对地址的解析基准外，不读取浏览器运行状态，也不安装监听器或执行上报副作用。

**二、两种配置类型的分界**

`MonitorOptions` 面向宿主，除 `app` 与 `transport` 外全部可选，只描述“意图”（我想关掉 FPS、我想提高采样）；`NormalizedMonitorOptions` 面向内部，所有字段必填，描述“确定的行为”。

```ts
// 宿主视角：最小可用配置
createMonitor({ app, transport: { dsn } });

// SDK 内部视角：拿到的必然是全字段有值的结构
type App = NormalizedMonitorOptions['app']; // 无可选、无 undefined
```

这条分界线的意义在于：下游模块可以直接读值，不需要再写 `??` 兜底，因此也就不存在“某个模块自己补了一个默认值”的可能。

**三、窄口校验原语**

`positive` / `nonNegative` / `probability` / `requiredText` 各只认领一种数值语义，新增配置项时直接复用，避免在归一化逻辑里散落临时 `if`：

| 原语           | 适用语义    | 取值约束       | 典型字段                                   |
| -------------- | ----------- | -------------- | ------------------------------------------ |
| `requiredText` | 必填字符串  | 去空白后非空   | `app.name`、`app.version`                  |
| `positive`     | 计数 / 容量 | 有限且 > 0     | `batchSize`、`maxQueueSize`、`maxAttempts` |
| `nonNegative`  | 窗口 / 延迟 | 有限且 ≥ 0     | `dedupeWindowMs`、`sampleIntervalMs`       |
| `probability`  | 比例        | 有限且 ∈ [0,1] | `samplingRate`                             |

配之以 `Math.floor` 收敛整数：条数、批量、重试次数如果出现浮点，会让比较判断和循环边界变得不可预测。

**四、不可变快照**

`app`、`transport.headers` 在归一化时就冻结：它们是每条上报数据的公共标注和每次请求的固定请求头，不允许运行期被业务代码改写。`headers` 先浅拷贝再冻结，既隔离宿主编突变，也防止 SDK 内部意外改写。

`transport.dsn` 在此一次性归一化为绝对 URL。提前计算可以让 Transport 每次发送时不必重复解析，也保证批处理与重试始终使用同一个采集地址。`endpoint` 不再是 SDK 配置字段；文档中出现的 Ingestion Endpoint 仅表示 DSN 最终指向的服务端采集路由。

**五、边界**

`config.ts` 不理解业务语义，不决定“某个指标该不该采”（那属于模块开关与 Collector 的职责），也不参与任何真实的上报动作。它唯一的任务是：把不确定的输入变成确定的、可被整个 SDK 共享引用的运行配置。

#### <u>3. module-registry：管理内部模块注册</u>

`module-registry.ts` 保存所有参与生命周期的模块，并按照统一接口管理它们。新增一种监控能力时，可以注册新的 Instrumentation、Collector 或 Processing Stage，而不是在 Monitor 中不断增加条件分支。

```ts
interface MonitorModule {
  readonly name: string;
  install(): void;
  start(): void;
  stop(): void;
  destroy(): void;
}
```

这套接口是 SDK 内部扩展契约，不直接作为第三方插件 API 暴露。内部模块可以独立注册、测试和启停，但公开 API 不需要承诺任意外部代码都能进入核心链路。

#### <u>4. signal-hub：分发短暂存在的浏览器事实</u>

`signal-hub.ts` 实现类型化的内部发布订阅机制。Instrumentation 捕获浏览器事实后发布 Raw Signal，订阅该信号的 Collector 同步获得事实并进行领域解释。

Signal Hub 解决的是“一份浏览器事实可能被多个领域使用”的问题。例如 Fetch 返回 500 时，Network Collector 需要生成请求记录，Error Collector 也可能生成可聚合的请求错误。二者订阅同一个 Request End Signal，不需要互相调用，也不需要重复包装 Fetch。

Raw Signal 只在 SDK 内部短暂传递，不进入发送队列，也不作为最终上报协议。Signal Hub 不保存历史事件，不承担重试和缓存，更不能演变为业务使用的全局事件总线。

#### <u>5. pipeline：连接领域数据和公共处理链路</u>

`pipeline.ts` 接收 Collector 输出的领域数据草稿，绑定发生时的 Context 快照，然后依次执行 Normalize、Validate、Redact、Filter、Dedupe、Sampling 和 Rate Limit。通过全部处理的数据才会进入 Transport Queue。

Core 负责建立这条连接，但每个处理阶段的规则仍然属于 Processing。Core 只知道执行顺序和模块接口，不应该知道某个 URL 如何脱敏或某类 Error 如何去重。

#### <u>6. lifecycle：保证安装、启停和释放可控</u>

`lifecycle.ts` 维护 SDK 的状态机，并拒绝不合法的状态转换：

```text
created ──install──→ installed ──start──→ running
                           ↑                 │
                           └────restart──── stopped
                                             │
任意未销毁状态 ───────────destroy──────────→ destroyed
```

`install` 建立内部模块和全局 Hook；`start` 允许产生监控数据；`stop` 暂停采集但保留可恢复结构；再次 `start` 可以继续运行；`destroy` 永久释放监听器、Observer、Timer、队列和 Signal 订阅，并恢复被包装的全局 API。

生命周期必须具备幂等性。重复 `start()` 不能重复 Hook，重复 `stop()` 不能重复释放，`destroy()` 之后不能重新启动。安装按照依赖顺序执行，销毁按照相反顺序执行，保证下游模块不会在上游已经消失后继续接收数据。

### 【instrumentation：捕获浏览器原始事实】

Instrumentation 是 SDK 与浏览器 API 直接接触的边界。它只回答“浏览器发生了什么”，不回答“这件事对监控平台意味着什么”。

| 子目录                 | 面对的浏览器能力                           | 产生的 Raw Signal                       | 主要使用者                   |
| ---------------------- | ------------------------------------------ | --------------------------------------- | ---------------------------- |
| `fetch`                | `window.fetch`                             | 请求开始、成功、拒绝、结束              | Network、Error               |
| `xhr`                  | `XMLHttpRequest`                           | open、send、load、error、abort、timeout | Network、Error               |
| `web-vitals`           | `web-vitals`                               | LCP、FCP、INP、CLS 指标事实             | Performance                  |
| `performance-observer` | `PerformanceObserver`                      | LoAF、Resource 等 PerformanceEntry      | Performance、Network         |
| `animation-frame`      | `requestAnimationFrame`、Timer             | 帧数与采样窗口时长                      | Performance                  |
| `global-errors`        | `error`、`unhandledrejection`              | 运行时错误、资源错误、Promise 拒绝      | Error                        |
| `dom-events`           | DOM Event                                  | 白名单点击、提交等最小操作事实          | Event                        |
| `history`              | History、`popstate`、`hashchange`          | URL 和路由变化                          | View                         |
| `page-lifecycle`       | `visibilitychange`、`pagehide`、`pageshow` | 页面隐藏、离开、恢复                    | View、Performance、Transport |

Instrumentation 不直接生成最终数据，是因为同一个事实可能有多个解释。HTTP 500 首先是一条请求事实，它可以产生 Network Record，也可能产生 Error Record；Resource Timing 同时包含资源和性能信息，但资源请求的权威记录仍然应该由 Network Collector 负责。

对 Fetch、XHR 和 History 的包装必须保存原始引用，保持原有参数、返回值、异常和调用上下文；SDK 内部错误不能传播给业务；销毁时必须恢复原始实现。全局事件监听、SDK 自己创建的 PerformanceObserver、RAF 和 Timer 同样需要保存对应的取消函数，不能只注册而不释放。对于没有公开取消句柄的第三方页面级观察器，必须只安装一次，通过状态门控制输出，并在 `destroy()` 后进入永久静默状态。

Instrumentation 通过注入的 Signal Publisher 发布事实，不直接导入 Core，也不直接调用 Collector。它可以依赖 Protocol 中定义的 Signal 类型和 Shared 中的基础能力，但不能依赖 Context、Processing 或 Transport。

### 【collectors：把事实解释成监控语义】

Collector 位于浏览器事实和监控数据之间。它关心的不是某个 API 怎样被监听，而是这条事实最终应该回答什么问题。

| 子目录         | 回答的问题                       | 输入                                                    | 输出                              |
| -------------- | -------------------------------- | ------------------------------------------------------- | --------------------------------- |
| `performance`  | 页面加载、交互和持续运行体验如何 | Performance Signal、页面生命周期信号                    | Performance Payload               |
| `event/action` | 用户执行了什么关键操作           | DOM Event Signal                                        | Action Event Payload              |
| `event/custom` | 业务明确表达了什么事件           | `monitor.track()`                                       | Custom Event Payload              |
| `error`        | 页面出现了什么异常               | Global Error、Promise、Resource、Request Failure Signal | Error Payload                     |
| `network`      | 请求了什么、持续多久、结果如何   | Fetch、XHR、Resource Signal                             | Network Payload                   |
| `view`         | 用户正在访问哪个页面视图         | History、Page Lifecycle Signal                          | View Payload，并更新 View Context |

Performance Collector 按指标语义拆分。`web-vitals.ts` 把 WebVital Signal 转换为 LCP、FCP、INP 和 CLS Payload；`loaf.ts` 过滤 LoAF Signal 并生成长动画帧摘要；`fps.ts` 根据 FrameWindow Signal 计算 FPS。Observer、RAF、Timer 和页面生命周期资源都留在 Instrumentation，Collector 不直接操作浏览器 API。

Event 下继续区分 Action 和 Custom，是因为二者的语义来源不同。Action 来自浏览器行为，需要白名单、目标归一化和频率控制；Custom Event 来自业务主动调用，名称和属性由业务明确提供，但仍然必须经过字段校验和脱敏。不能把任意 DOM click 自动解释成“提交订单”，也不能因为业务主动埋点就绕过公共处理链路。

Collector 之间保持并列，不能互相调用。Error 不向 Network 查询请求详情，Performance 不从 View 获取内部状态，Event 也不直接驱动路由模块。它们通过共同的 Raw Signal、Context 服务和关联标识协作，从而能够独立启停和测试。

Collector 输出的是领域数据草稿，不负责排队或发送。只要 Collector 直接调用 Sender，就意味着该类型的数据绕过了统一脱敏、采样和限流规则，破坏了整条架构的安全边界。

### 【context：固定事件发生时的运行现场】

Context 管理监控数据共有的运行环境，并在事实发生时提供不可变快照。它不是一个存放全局变量的目录，而是 Session、View、Action 和异步请求能够正确归属的基础。

| 模块              | 保存的信息                          | 生命周期                     |
| ----------------- | ----------------------------------- | ---------------------------- |
| `app-context`     | 应用名称、环境、版本、发布标识      | Monitor 实例级               |
| `user-context`    | 经过允许的用户标识和白名单属性      | 登录状态或业务主动更新       |
| `session-context` | `sessionId`、开始时间、最近活动时间 | 一次连续使用过程             |
| `view-context`    | `viewId`、URL、路由名称、来源 View  | 初始页面或一次 SPA 视图      |
| `action-context`  | `actionId`、操作名称、目标摘要      | 一次关键交互及其短期后续过程 |
| `runtime-context` | 浏览器、设备、网络和 SDK 信息       | 实例级或能力变化时更新       |
| `snapshot`        | 汇总上述上下文并形成只读副本        | 每条数据产生时               |

上下文必须在事实发生阶段绑定，而不能等发送时读取。例如页面 A 发起请求后，用户切换到页面 B，请求才返回。Network Collector 在 Request Start Signal 到达时就要保存页面 A 的 Context Snapshot，并用 `requestId` 关联后续 Request End Signal。即使数据在页面 B 才进入队列，它仍然属于页面 A。

```text
Request Start
├─ 创建 requestId
├─ 读取 Session / View / Action Snapshot
└─ 保存 Request Context
        │
        └─→ Request End 使用同一份 Snapshot 形成 Network / Error 数据
```

View Collector 与 Context 的关系需要保持清楚：View Collector 负责判断何时开始或结束一个 View，View Context 负责保存当前 View 状态并提供快照。Context 不监听 History，View Collector 也不拥有 Session、User 等其他上下文。

Action 关联同样不能被无限扩大。一次点击可以为紧随其后的请求提供 `actionId`，但不能把同一 View 中此后发生的所有错误都强行解释为该点击造成。Context 负责保留可验证的关联，不负责推断没有证据的因果关系。

### 【signals 与共享 Protocol：区分内部事实和线上协议】

`src/signals` 保存 Instrumentation 与 Collector 共同理解的 SDK 内部事实；monorepo 根目录的 `protocol/` 则发布 `@browser-monitor/protocol`，保存 SDK、采集 API 与 Worker 共同遵守的线上协议。两者都只定义形状和语义，不访问浏览器、不处理数据，也不保存运行状态，但作用范围不同，因此不能放在同一个 SDK 转发目录中。

#### <u>1. Raw Signal：描述浏览器刚刚发生的事实</u>

`src/signals` 下的类型面向 SDK 内部通信。例如 Web Vitals Signal 保留浏览器回调中的指标变化，View Signal 描述路由和页面生命周期事实。它可以贴近浏览器 API，但生命周期只覆盖 Instrumentation 到 Collector。

Raw Signal 不等于上报数据。它可能缺少完整 Context，也没有经过脱敏、采样和限流，因此不能直接进入 Transport。

#### <u>2. 共享 Envelope：统一公共字段</u>

所有 Collector 输出的数据最终进入 `@browser-monitor/protocol` 定义的统一 Envelope。统一的是公共身份、时间、上下文和关联方式，不是把所有领域字段压成同一种结构。SDK 源码直接导入协议包，不再通过 `src/protocol` 二次导出。

```ts
interface TelemetryEnvelope<T extends TelemetryPayload> {
  protocolVersion: '2.0';
  eventId: string;
  type: T['type'];
  name: string;
  occurredAt: number;
  app: AppContext;
  context: RuntimeContextSnapshot;
  correlation: CorrelationContext;
  payload: T;
}
```

`protocolVersion` 让采集端与服务端按同一协议解释字段；`eventId` 用于识别单条数据；`occurredAt` 表示事实发生时间，而不是发送时间；`context` 保存当时的运行环境；`correlation` 保存 Action、Request 和 Trace 等关联标识；`payload` 保留各领域自己的内容。

#### <u>3. Payload：保留各监控领域的语义</u>

共享协议包中的 Payload 按 Performance、Event、Error、Network 和 View 领域扩展。当前实现的 Performance 需要指标名、值、单位、sampleId、sequence 和 state；Event 需要事件名称和允许的属性；View 需要视图开始、结束和路由信息。后续接入 Error 与 Network 时继续扩展同一个协议包，而不是在 SDK 中建立本地副本。

这些 Payload 通过 `type` 形成判别联合类型，使 Processing 和平台消费端能够先识别数据类别，再读取对应字段。某个类型如果只在单个模块内部使用，就应留在该模块，不应该因为它是 TypeScript 类型就放进 Protocol。

### 【processing：统一治理所有监控数据】

Processing 接收已经具有领域语义和 Context 的数据，对所有监控类型执行一致的数据质量、安全和流量规则。处理顺序固定为：

```text
Telemetry Draft + Context Snapshot
              ↓
Normalize → Validate → Redact → Filter → Dedupe → Sampling → Rate Limit
              ↓
Safe Telemetry Envelope → Transport Queue
```

| 阶段         | 主要职责                                        | 不应该做的事情           |
| ------------ | ----------------------------------------------- | ------------------------ |
| `normalize`  | 统一时间、URL、方法、状态、名称和空值表达       | 监听浏览器事件           |
| `validate`   | 检查必填字段、类型、长度和协议版本              | 修复无法解释的领域语义   |
| `redact`     | 删除或替换 Token、Cookie、用户输入等敏感内容    | 等到发送前才处理敏感数据 |
| `filter`     | 根据环境、URL、事件名称和业务白名单决定是否保留 | 修改原始业务行为         |
| `dedupe`     | 在时间窗口内控制同一问题的重复数据              | 合并语义不同但相关的数据 |
| `sampling`   | 按数据类型、规则或稳定哈希控制保留比例          | 伪造未采集数据           |
| `rate-limit` | 在异常高频时限制单位时间内的数据量              | 让队列无限增长           |

Normalize 位于前面，是为了让后续规则面对稳定字段；Validate 在数据继续流动前拒绝不符合协议的数据；Redact 必须早于任何缓存和去重状态，避免敏感信息进入 SDK 的长期内存边界；Dedupe 使用已经规范化、脱敏的数据生成稳定指纹；Sampling 和 Rate Limit 位于后段，分别控制总体数据比例和突发流量。

处理失败时应丢弃当前数据并记录受控的内部诊断，不能把 Processing Error 再作为普通 Error 送回同一条管线。否则“处理错误 → 产生错误数据 → 再次处理失败”会形成递归。

---

### 【transport：把安全数据可靠地送出页面】

Transport 只接收已经完成 Processing 的安全数据。它不需要理解 LCP、错误堆栈或点击语义，只负责等待、组批、发送和收尾。

#### <u>1. queue：建立有边界的内存缓冲区</u>

Queue 保存等待发送的 Envelope，并设置最大条数或最大字节数。达到上限时必须执行明确的丢弃策略，例如优先丢弃低优先级数据或最早进入的数据，同时累计内部丢弃计数。Queue 不能无限增长，也不保存未经脱敏的原始事实。

传输层只使用内存队列，不把数据持久化到 IndexedDB。这样可以避免离线数据长期保存带来的过期、隐私、跨用户和容量治理问题。

#### <u>2. batch：按照数量、大小和时间形成批次</u>

Batch 根据条数阈值、字节阈值和等待时间决定何时发送。批次构建需要保证单次请求体不会无限扩大，并保留每条 Envelope 的独立身份。批量发送降低网络请求数量，但不能为了凑满批次而无限延迟高优先级错误。

#### <u>3. sender：统一浏览器发送能力</u>

Sender 负责调用 Fetch 等浏览器网络能力，并统一设置采集端点、认证方式、超时和序列化格式。页面进入隐藏或离开状态时，Flush 可以优先使用适合页面收尾的发送方式；如果该方式不可用或数据超过限制，则执行受控降级，而不是阻塞页面卸载。

SDK 的采集端点必须被 Network Instrumentation 排除。可以在 Core 初始化时把上报 URL 注册到忽略规则，也可以对内部请求增加不可枚举标记。否则发送监控数据会产生新的 Network Signal，新信号再次进入 Transport，最终形成递归上报。

#### <u>4. retry：只重试可能恢复的失败</u>

Retry 只处理超时、临时网络错误和可恢复的服务端状态，并设置最大次数、退避时间和随机抖动。协议错误、鉴权错误和明显不可恢复的请求不能无限重试。重试复用已经完成 Processing 的批次，不重新采样，也不重新读取当前 Context。

#### <u>5. flush：处理主动发送和页面生命周期</u>

Flush 可以由四类条件触发：达到批量阈值；等待时间到期；业务主动调用 `monitor.flush()`；页面进入隐藏或离开状态。`stop()` 可以执行受控 Flush 后暂停生产数据，`destroy()` 则在最终尝试后清理队列和定时器。

Transport 的终点是服务端采集接口。服务端怎样存储数据、计算指标、建立索引和触发告警不属于 Browser SDK 的内部职责；SDK 只承诺输出符合 Protocol 的安全批次，并正确处理浏览器侧发送状态。

---

### 【shared：受约束的基础能力】

Shared 保存多个模块稳定复用、但不包含监控领域语义的纯能力。它可以提供 ID 生成、时间读取、URL 基础解析、类型守卫和安全执行包装，但不能变成没有边界的 `utils` 目录。

一段代码进入 Shared，需要同时满足三个条件：至少被两个模块稳定复用；不理解 Performance、Error、Network 等领域类型；不持有 Session、队列或生命周期等业务状态。

例如，生成随机 ID 可以属于 Shared，但决定 `viewId` 何时更新属于 Context；解析 URL 的基础函数可以属于 Shared，但决定哪些查询参数需要脱敏属于 Processing；安全执行一个回调的通用包装可以属于 Shared，但决定 Collector 异常如何降级属于 Core。

Shared 位于依赖关系的最底部，不反向导入 Core、Collector、Context、Processing 或 Transport。只要 Shared 开始识别具体监控类型，就说明这段能力应回到所属领域。

---

### 【模块依赖关系与数据流向】

模块之间同时存在控制关系和数据关系。Core 负责创建和控制模块，因此它可以看到各模块；监控数据则从浏览器事实开始，只能沿处理链路向前流动。

```text
公开依赖
index → core

组合依赖
core → instrumentation / collectors / context / processing / transport

基础依赖
instrumentation → signals / shared
collectors      → context / signals / @browser-monitor/protocol / shared
context         → @browser-monitor/protocol / shared
processing      → @browser-monitor/protocol / shared
transport       → @browser-monitor/protocol / shared
signals         → @browser-monitor/protocol（只复用枚举与字段类型）
shared          → 不依赖任何监控业务模块
```

Signal Hub 的实现由 Core 创建，但 Instrumentation 和 Collector 只接收 `src/signals` 定义的 Publisher 或 Subscriber 接口。这样它们可以使用通信能力，却不需要反向依赖具体 Core 实现。形成线上事件后，各模块直接使用共享协议包的类型和 Schema。

数据主链路保持单向：

```text
Browser / Business
        ↓
Instrumentation ──Raw Signal──→ Signal Hub
                                      ↓
                                  Collector
                                      ↓
                              Context Snapshot
                                      ↓
                                  Protocol
                                      ↓
                                 Processing
                                      ↓
                                  Transport
                                      ↓
                              Ingestion Endpoint
```

Collector 之间不形成调用链，Processing 不回头访问浏览器对象，Transport 不重新生成普通 Error。内部故障进入独立、限量的诊断通道，不能重新进入普通监控链路。

---

### 【SDK 生命周期与模块执行顺序】

生命周期解决的是全局 Hook、监听器、Observer、Timer 和发送队列何时存在，以及重复调用时如何保持幂等。

| 阶段      | Core 的动作                                               | 模块状态               | 关键保证                            |
| --------- | --------------------------------------------------------- | ---------------------- | ----------------------------------- |
| `create`  | 解析配置，创建 Context、Signal Hub、Pipeline 和 Transport | 尚未接触浏览器全局能力 | 创建实例不改变业务环境              |
| `install` | 注册模块，安装 Hook 和监听器，保存取消函数                | 已安装但不生产普通数据 | 同一实例只安装一次                  |
| `start`   | 依次建立 Context、启动 Collector 与 Instrumentation       | 正在采集               | 先建立上下文，再接收其他事实        |
| `stop`    | 停止生产新数据，暂停 Observer 和 Timer，执行受控 Flush    | 可再次启动             | 不重复安装 Hook，不丢失生命周期状态 |
| `restart` | 恢复 Collector、Observer、Timer 和数据入口                | 再次采集               | 不产生重复监听和重复订阅            |
| `destroy` | 逆序注销订阅、恢复全局 API、清空队列和上下文              | 永久销毁               | 页面环境恢复，实例不可再启动        |

启动时需要先建立 App、Session 和初始 View Context，再启动依赖这些上下文的 Event、Network、Error 和 Performance Collector，最后打开数据入口。销毁时顺序相反：先阻止新数据进入，再停止 Collector，取消 Signal 订阅，释放 Instrumentation，处理 Transport 收尾，最后销毁 Context 和 Core 状态。

```text
启动：Config → Context → Transport → Processing → Collectors → Instrumentation
销毁：关闭数据入口 → Instrumentation → Collectors → Processing → Transport → Context
```

这里的先后顺序表达的是可用性约束，而不是要求每个模块同步完成所有工作。例如 Transport 可以在采集前创建，但只有安全 Envelope 才能入队；Instrumentation 可以在安装阶段完成 Hook，但只有进入 Running 状态后才发布普通监控事实。

`web-vitals` 不提供公开的取消句柄，因此它只在第一次启动时安装。`stop()` 通过状态门暂停 Signal 发布，再次 `start()` 只恢复出口而不重复注册；`destroy()` 后出口永久静默。该限制需要在生命周期契约中明确，不能把第三方内部 Observer 描述为已经由 SDK 主动释放

### 【目录边界的判断方法】

当新增功能或修改逻辑时，可以按照问题来源判断代码归属：

| 要解决的问题                                  | 应进入的目录      |
| --------------------------------------------- | ----------------- |
| 怎样安全监听或包装某个浏览器 API              | `instrumentation` |
| 浏览器事实在监控领域中代表什么                | `collectors`      |
| 数据属于哪个 Session、View、Action 或 Request | `context`         |
| SDK 内部 Raw Signal 必须包含哪些字段           | `signals`         |
| 线上事件和批次必须包含哪些字段                 | 根目录 `protocol` |
| 数据是否安全、有效、重复或超量                | `processing`      |
| 数据怎样排队、组批、发送和重试                | `transport`       |
| 模块怎样创建、注册、启停和销毁                | `core`            |
| 是否是无领域语义、可稳定复用的纯能力          | `shared`          |

几个容易破坏边界的做法需要明确避免：Collector 直接发送数据；多个 Collector 分别包装同一个全局 API；Transport 在发送前才补 Context；Error Collector 调用 Network Collector；Shared 保存领域状态；Core 实现具体脱敏规则；SDK 把自己的上报请求再次记录为普通 Network 数据。

完整架构最终形成两条相互配合的主线：Core 通过生命周期和模块注册控制“系统怎样运行”，数据管线通过 Instrumentation、Collector、Context、Processing 和 Transport 控制“数据怎样前进”。前者保证全局能力可安装、启停和释放，后者保证异构数据能够以统一、安全且可关联的方式到达采集端点。

## 4. Performance 性能监控的完整实现链路

Performance 监控不是调用一个浏览器 API、得到一个数值后立即发送。当前实现同时采集 Web Vitals、Long Animation Frame 和帧率窗口，它们的浏览器来源、回调时机与计算方式都不同；这些差异保留在各自的 Instrumentation 和 Collector 中，而 Context、Processing 与 Transport 则由所有指标共同复用。

一条性能数据从产生到离开页面，要经历配置规范化、模块装配、浏览器事实采集、Raw Signal 分发、领域语义转换、发生时上下文绑定、统一协议封装、公共数据治理、内存排队、批量发送和失败重试。任何一层越过自己的边界，都会让某类指标形成特殊链路，最终导致生命周期、隐私规则和发送策略彼此冲突。

### 【Performance 链路全景】

当前 Performance 实现有三条采集支线。Web Vitals 支线负责 LCP、FCP、INP 和 CLS；PerformanceObserver 支线负责 LoAF；AnimationFrame 支线负责 FPS。三条支线只在“怎样接触浏览器”和“怎样形成领域 Payload”上不同，进入 MonitorPipeline 后使用同一条公共链路。

```text
Browser Performance Sources
├─ web-vitals
│  └─→ WebVitalsInstrumentation
│      └─ performance.web-vital → WebVitalsCollector
│                                   └─ LCP / FCP / INP / CLS Payload
├─ PerformanceObserver: long-animation-frame
│  └─→ PerformanceObserverInstrumentation
│      └─ performance.loaf → LoAFCollector
│                             └─ LoAF Payload
└─ requestAnimationFrame
   └─→ AnimationFrameInstrumentation
       └─ performance.frame-window → FPSCollector
                                       └─ FPS Payload

三类 Performance Payload
          ↓
MonitorPipeline → Context Snapshot → TelemetryEnvelope
          ↓
Normalize → Validate → Redact → Filter → Dedupe → Sampling → Rate Limit
          ↓
MemoryQueue → Batch → Retry → HttpSender → Ingestion Endpoint
```

除了数据主链路，还有两条控制支线。<code>HistoryInstrumentation → ViewCollector → ViewContext</code> 维护 SPA 页面时间线，决定指标属于哪个 View；PageLifecycleInstrumentation 将页面显示、隐藏、离开和 BFCache 恢复转换成生命周期信号，通知 Performance Instrumentation 暂停或恢复采集，并通知 Transport 在页面离开前刷新队列。

| 阶段           | 当前实现模块                                                                                | 输入                          | 输出或状态变化                         |
| -------------- | ------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------- |
| 实例装配       | BrowserMonitor、normalizeOptions()                                                          | 业务配置                      | 规范配置、模块实例和依赖关系           |
| 浏览器事实采集 | WebVitalsInstrumentation、PerformanceObserverInstrumentation、AnimationFrameInstrumentation | 浏览器 API 或 web-vitals 回调 | 三类 Performance Raw Signal            |
| 事实分发       | SignalHub                                                                                   | 带类型的 Raw Signal           | 同步通知对应 Collector                 |
| 语义转换       | WebVitalsCollector、LoAFCollector、FPSCollector                                             | Raw Signal                    | Performance Payload 草稿               |
| 上下文绑定     | ContextManager、ViewContext                                                                 | 指标发生时间                  | Session、View、URL、Runtime、User 快照 |
| 协议封装       | MonitorPipeline                                                                             | Payload 草稿和 Context        | Performance TelemetryEnvelope          |
| 公共处理       | 七个 Processing Stage                                                                       | Envelope                      | 可发送 Envelope 或丢弃结果             |
| 排队上报       | Transport、MemoryQueue、HttpSender                                                          | 安全 Envelope                 | 批次请求或受控失败                     |

---

### 【createMonitor：创建实例并装配完整链路】

业务通过 <code>src/index.ts</code> 导出的 <code>createMonitor(options)</code> 创建 SDK。入口函数本身不安装监听器，它只把配置交给 BrowserMonitor 构造函数。构造过程是整条链路的组合根：所有共享对象只创建一次，各模块通过接口获得依赖，不在运行过程中自行查找全局单例。

#### <u>1. 配置先规范化，再创建任何模块</u>

<code>normalizeOptions()</code> 首先检查 app 和 transport 是否存在，应用名称、版本、环境和上报地址是否为空，并校验采样率、时间窗口、队列容量、批次大小和重试参数。校验失败会直接抛出错误，此时尚未包装 History、注册页面事件或创建 Observer，避免页面进入只安装了一部分模块的状态。

Performance 默认处于启用状态，LCP、FCP、INP、CLS、FPS 和 LoAF 也默认启用；某个指标只有被显式配置为 false 才会关闭。当前关键默认值如下：

| 配置                                   |         默认值 | 运行含义                             |
| -------------------------------------- | -------------: | ------------------------------------ |
| performance.webVitals.reportAllChanges |          false | 不要求 web-vitals 报告指标的每次变化 |
| performance.webVitals.reportSoftNavs   |          false | 默认不启用 Soft Navigation 报告      |
| performance.fps.sampleWindowMs         |           5000 | 每个 FPS 采样窗口持续 5 秒           |
| performance.fps.sampleIntervalMs       |          30000 | 一个窗口结束后等待 30 秒再采样       |
| performance.loaf.minDurationMs         |             50 | 小于 50 ms 的 LoAF 不形成 Payload    |
| performance.loaf.maxEntriesPerView     |             20 | 单个 View 最多上报 20 条 LoAF        |
| processing.dedupeWindowMs              |           1000 | 完全相同的数据在 1 秒内去重          |
| processing.samplingRate                |              1 | 默认保留全部数据                     |
| processing.rateLimit                   | 120 / 60000 ms | 每个时间窗口最多通过 120 条数据      |
| transport.batchSize                    |             20 | 队列达到 20 条时触发刷新             |
| transport.maxBatchBytes                |          64000 | 单批使用序列化长度控制体积           |
| transport.flushIntervalMs              |          10000 | 每 10 秒尝试刷新队列                 |
| transport.maxQueueSize                 |            200 | 内存队列最多保存 200 条 Envelope     |
| transport.retry                        |  3 次 / 500 ms | 最多尝试 3 次，退避基数为 500 ms     |

如果 performance.enabled 为 false，Core 会把六个指标开关统一改为 false，而不是让不同 Instrumentation 自己解释总开关。这样所有模块面对的都是没有歧义的局部配置。

#### <u>2. Core 创建共享对象并连接模块</u>

BrowserMonitor 依次创建 ContextManager、HttpSender、Transport、Processing Pipeline 和 MonitorPipeline。随后创建 View、Web Vitals、LoAF、FPS Collector，以及 Page Lifecycle、History、Web Vitals、PerformanceObserver、AnimationFrame Instrumentation。

其中 SignalHub 同时以 SignalPublisher 和 SignalSubscriber 接口注入模块。Instrumentation 只看到发布接口，Collector 只需要订阅接口；MonitorPipeline 则持有 Context、Processing 和 Transport。模块因此知道自己的下一跳，却不需要导入完整 Monitor 或彼此直接调用。

```ts
// 只保留组合关系，省略具体配置字段。
const signals = new SignalHub();
const context = new ContextManager(contextOptions);
const transport = new Transport(transportOptions, sender, signals);
const processing = createProcessingPipeline(processingOptions);
const pipeline = new MonitorPipeline(context, processing, transport);

const webVitalsCollector = new WebVitalsCollector(signals, pipeline, enabledMetrics);
const webVitals = new WebVitalsInstrumentation(webVitalsOptions, signals);
```

<code>createMonitorWithDependencies()</code> 允许测试注入 FakeSender，但它没有从包入口公开。生产接入只面对 createMonitor() 和统一 Monitor API，测试则可以在不发送真实网络请求的情况下检查最终批次。

#### <u>3. 注册顺序同时决定启动顺序和销毁顺序</u>

当前模块按以下顺序注册：

<code>Transport → ViewCollector → WebVitalsCollector → LoAFCollector → FPSCollector → PageLifecycleInstrumentation → HistoryInstrumentation → WebVitalsInstrumentation → PerformanceObserverInstrumentation → AnimationFrameInstrumentation</code>

这个顺序保证 Transport 和 Collector 先进入可工作状态，浏览器数据入口最后打开。History 启动时会立即发布初始路由信号，此时 ViewCollector 已经订阅；Web Vitals 注册时可能收到已有指标，初始 View 也已经建立。stop() 和 destroy() 使用逆序调用，先停止 RAF、Observer 和 Web Vitals 输出，再停止 Collector，最后处理 Transport，避免消费者已经释放后数据源仍继续发布。

ModuleRegistry 对每个模块分别调用 install()、start()、stop() 和 destroy()。单个模块抛出的异常会被隔离，不会继续传播到宿主业务，也不会阻断其他模块完成生命周期操作。

---

### 【start：从静态实例进入可采集状态】

createMonitor() 只完成对象创建。真正接触浏览器全局能力发生在 <code>monitor.start()</code> 之后。Lifecycle 的初始状态为 created，第一次启动会先执行一次 registry.install()，再执行 registry.start()；从 stopped 状态重新启动时只执行 start()，不会重复安装订阅。

#### <u>1. install 建立内部订阅，不生产普通性能数据</u>

Transport 在 install 阶段订阅 page.lifecycle；各 Collector 订阅自己需要的 Performance Signal；LoAF Collector 额外订阅路由变化，用于重置单 View 上报计数；PerformanceObserver 和 AnimationFrame Instrumentation 订阅页面生命周期，用于暂停和恢复资源。

PageLifecycle、History 的 install() 当前为空，Web Vitals 也故意延迟到首次 start() 才向第三方库注册回调。此时 SDK 已建立内部通信关系，但还没有包装 History、注册 DOM 生命周期事件、创建 PerformanceObserver 或启动 RAF。

#### <u>2. start 先打开消费者，再打开浏览器数据源</u>

Transport 首先启动定时刷新器，随后 View 和 Performance Collector 把 active 设为 true。PageLifecycle 开始监听 visibilitychange、pagehide 和 pageshow；History 保存并包装原始 pushState、replaceState，监听 popstate、hashchange，然后发布唯一一次 initial 路由信号。

ViewCollector 收到初始信号后创建首个 View Record。接下来 Web Vitals 才安装指标回调，PerformanceObserver 才开始观察 LoAF，AnimationFrame 才启动帧窗口。这一顺序保证任何性能回调到达时，Collector、Pipeline、Transport 和初始 View 都已经可用。

#### <u>3. 能力检测和配置开关是两种不同判断</u>

<code>getCapabilities()</code> 返回的是浏览器能力，而不是当前配置是否启用指标。LCP、FCP、CLS 根据 PerformanceObserver.supportedEntryTypes 判断；INP 还要求存在 PerformanceEventTiming，并且原型中包含 interactionId；FPS 要求同时存在 requestAnimationFrame 和 cancelAnimationFrame；LoAF 要求支持 long-animation-frame Entry。

能力为 true 只能说明浏览器提供底层条件。是否真正启动采集，还要同时通过 performance.enabled 和单项 metrics 配置。能力不足时相应 Instrumentation 静默降级，不能因为监控 API 不可用而影响页面业务。

---

### 【三条指标支线：从浏览器事实形成 Performance Payload】

三条支线都遵循同一个分层原则：Instrumentation 负责拥有浏览器资源、提取最小必要字段并发布 Raw Signal；Collector 负责应用阈值、计算指标并形成 Performance Payload。它们不能合并成一个通用 Observer，因为三个数据源根本不是同一种生命周期和数据模型。

#### <u>1. Web Vitals：标准指标回调支线</u>

WebVitalsInstrumentation 使用 onLCP()、onFCP()、onINP() 和 onCLS() 安装回调。首次 start() 将 installed 标记为 true，后续 stop → start 只重新打开 active 状态，不再次调用这些注册函数。

回调收到第三方 Metric 后会执行四步处理：检查实例仍处于 active 且未销毁；拒绝当前协议之外的指标名称；从最后一条 PerformanceEntry.startTime 计算绝对发生时间；只挑选安全且稳定的字段组成 WebVitalSignal。

浏览器 Performance Entry 的 startTime 是相对 performance.timeOrigin 的时间。为了让指标与使用 Date.now() 的路由事件进入同一时间轴，实现使用：

<code>指标绝对时间 = performance.timeOrigin + 最后一条 Entry.startTime</code>

没有合法 Entry 时降级为 Date.now()。Raw Signal 包含 name、metricId、value、delta、rating、navigationType、navigationId 和绝对 timestamp，但不会携带完整 entries、navigationURL 或其他第三方对象。

```text
web-vitals Metric
├─ 保留：id、name、value、delta、rating、navigationType、navigationId
├─ 转换：Entry.startTime → 绝对 timestamp
└─ 丢弃：entries、navigationURL 及其他原始对象
        ↓
performance.web-vital Signal
        ↓
WebVitalsCollector
        ↓
LCP / FCP / INP / CLS Payload
```

WebVitalsCollector 再次检查指标配置，然后把 Signal 映射为判别联合类型。LCP 和 INP 使用 ms，CLS 使用 score；LCP、INP、CLS 的 kind 为 core-web-vital，FCP 在当前协议中标记为 diagnostic。Collector 把内部 metricId 映射为稳定的 sampleId，把 rating 映射为仅供诊断的 clientRating，并为同一观测维护递增 sequence。数值变化先形成 provisional Payload，View 结束时再提交最高序号的 final 快照。

**<u>生命周期限制：web-vitals 当前不提供 SDK 可使用的统一清理句柄。</u>** 实现只能保证回调安装一次；stop() 通过 active=false 暂停 Signal 发布，重新启动时恢复出口；destroy() 设置永久 destroyed 状态，使残留回调永远不再产生 SDK 数据。这里的销毁是“永久切断输出”，不是声称已经物理移除第三方内部 Observer。

#### <u>2. LoAF：PerformanceObserver 条目支线</u>

PerformanceObserverInstrumentation 先检查 supportedEntryTypes 是否包含 long-animation-frame。首次启动调用 <code>observe({ type: 'long-animation-frame', buffered: true })</code>，这样可以补齐 Observer 建立前浏览器已经缓存的条目；停止后再次启动时使用 buffered: false，避免重复回放历史 LoAF。

每个 LongAnimationFrameEntry 会被机械提取为 LoAFSignal。startTime 被转换为绝对 timestamp；duration 保留原值；blockingDuration、renderStart 和 styleAndLayoutStart 只接受有限且非负的数字，否则降级为 0；scripts 不向后传递，只记录 scriptCount。因此潜在脚本 URL、函数详情或其他大对象不会进入 Collector。

LoAFCollector 才负责解释哪些条目值得上报。当前规则要求 <code>duration >= minDurationMs</code>，并且当前 View 已发送数量小于 maxEntriesPerView。每次收到 view.route-change 时，emittedEntries 重置为 0，防止页面 A 的高频长帧占用页面 B 的额度。

```text
long-animation-frame Entry
        ↓ 安全提取字段，不执行阈值判断
LoAFSignal
        ↓ duration ≥ 50 ms，且当前 View 未达到 20 条
LoAFPayload
├─ value / unit：duration / ms
├─ kind / source：diagnostic / performance-observer
└─ detail：startTime、blockingDuration、renderStart、styleAndLayoutStart、scriptCount
```

页面隐藏或触发 pagehide 时，Instrumentation 断开当前 Observer；页面重新可见或 pageshow 时，重新观察新条目。这样既不在后台持续占用资源，也不会把恢复后的旧缓存再次当作新数据。

#### <u>3. FPS：AnimationFrame 窗口支线</u>

FPS 没有可直接读取的单个 Performance Entry。AnimationFrameInstrumentation 必须在一个时间窗口中持续请求 requestAnimationFrame，记录第一帧时间、后续完整帧间隔数量和窗口实际持续时间。

第一帧只确定窗口起点，不计为完整帧间隔。每次后续 RAF 回调令 frameCount 加一；当 <code>timestamp - firstFrameTime</code> 达到 sampleWindowMs 时发布 FrameWindowSignal。Signal 的发生时间同样使用 <code>performance.timeOrigin + RAF timestamp</code> 转成绝对时间。

Instrumentation 不直接计算 FPS，只发布窗口事实：

```ts
interface FrameWindowSignal {
  timestamp: number;
  frameCount: number;
  sampleDurationMs: number;
}
```

FPSCollector 过滤持续时间或帧数不大于零的窗口，并按实际窗口计算：

<code>FPS = frameCount × 1000 / sampleDurationMs</code>

例如 1000 ms 内存在 10 个完整帧间隔，当前实现得到 10 FPS。Payload 的 kind 为 runtime，source 为 request-animation-frame，并在 detail 中保留 frameCount 和 sampleDurationMs，便于平台理解该值的采样基础。

窗口结束后，Instrumentation 等待 sampleIntervalMs 再开启下一轮。页面隐藏或 pagehide 时会取消 RAF 和等待 Timer、清空未完成窗口；页面重新可见时开启全新窗口，而不是把前后台时间拼接成一个失真的 FPS 样本。

---

### 【SignalHub：让浏览器事实与指标语义解耦】

三种 Instrumentation 都不直接引用 Collector，而是向 <code>SignalHub.publish(type, signal)</code> 发布事实。SignalMap 把事件名与数据类型固定对应：

| Signal 名称              | 发布者                             | 订阅者                            | 数据含义                       |
| ------------------------ | ---------------------------------- | --------------------------------- | ------------------------------ |
| performance.web-vital    | WebVitalsInstrumentation           | WebVitalsCollector                | 第三方指标已经转换后的稳定事实 |
| performance.loaf         | PerformanceObserverInstrumentation | LoAFCollector                     | 单条长动画帧的安全字段         |
| performance.frame-window | AnimationFrameInstrumentation      | FPSCollector                      | 一个采样窗口的帧数和持续时间   |
| view.route-change        | HistoryInstrumentation             | ViewCollector、LoAFCollector      | 初始页面或 SPA 路由边界        |
| page.lifecycle           | PageLifecycleInstrumentation       | View、Performance、Transport 模块 | 页面显示、隐藏、离开或恢复     |

SignalHub 同步调用当前订阅者，不保存历史、不重试也不缓存。发布时复制监听器集合，允许某个订阅者在回调期间退订而不破坏本轮遍历；单个订阅者抛出异常时只终止该订阅者，不把异常回传给 Instrumentation 或业务页面。

同步分发意味着 Raw Signal 不会在 Hub 中形成第二个队列。需要持久存在的数据必须由 Collector 转成 Payload，并在公共处理后进入 Transport；需要跨时间关联的状态必须进入 Context，而不是偷偷保存在 SignalHub。

---

### 【View 时间线：把性能指标绑定到发生时的页面】

Performance 回调到达的时间不一定等于指标发生的时间。SPA 中尤其容易出现这种情况：页面 A 产生性能条目，用户已经跳转到页面 B，第三方库或 Observer 才执行回调。如果 Pipeline 直接读取“当前 View”，页面 A 的性能问题就会错误归入页面 B。

#### <u>1. History 和 Page Lifecycle 定义 View 边界</u>

HistoryInstrumentation 包装 pushState 和 replaceState，监听 popstate、hashchange，并在首次启动时发布一次 initial Signal。调用原生 History 方法后才发布路由变化，保证业务路由已经完成。stop() 会移除事件监听并恢复原始 History 方法，重新启动时重新包装，但不会再次伪造 initial View。

PageLifecycleInstrumentation 负责发布 visible、hidden、pagehide 和 pageshow。普通 pagehide 会让 ViewCollector 结束当前 View；如果 event.persisted=true，说明页面进入 BFCache，当前 View 不在 pagehide 时直接结束。BFCache 页面通过 pageshow 恢复后，ViewCollector 以 bfcache 来源切换 View。

#### <u>2. ViewContext 保存有界时间线</u>

<code>ViewCollector.changeView()</code> 先调用 <code>ContextManager.startView()</code>。ViewContext 会在同一时间结束旧 View，随后创建包含 viewId、安全 URL、startedAt 和 source 的新记录。URL 在写入 Context 时就替换敏感查询参数并删除 hash，避免原始地址继续扩散。

ViewContext 默认保留最近 20 个 View Record。<code>resolveAt(timestamp)</code> 从最新记录反向查找满足以下区间的 View：

<code>view.startedAt <= timestamp <= view.endedAt</code>

尚未结束的 View 没有 endedAt，其区间延续到当前。找不到历史区间时降级到当前 View；如果系统还没有任何 View，ContextManager 会使用当前 URL 创建 initial View，保证 Envelope 始终拥有 viewId。

#### <u>3. 晚到回调按照发生时间归属</u>

```text
时间 t1：页面 A 建立 View-A
时间 t2：LCP Entry 在页面 A 发生，startTime 对应绝对时间 t2
时间 t3：history.pushState() 切换到页面 B
         View-A.endedAt = t3，创建 View-B
时间 t4：web-vitals 执行 LCP 回调
         metricTimestamp = t2
         ContextManager.snapshotAt(t2)
         ViewContext.resolveAt(t2) → View-A
```

关键点不是回调在 t4 执行，而是 Signal 保存了由 Performance Entry 还原出的 t2。<code>MonitorPipeline.emit()</code> 使用 draft.timestamp 调用 context.snapshotAt()，因此最终 Envelope 的 viewId 和 URL 仍属于 View-A。

Context Snapshot 还包含 Session、Runtime 和可选 User。App 信息位于 Envelope 的公共 app 字段中。快照一旦建立就不会在发送时重新读取当前页面状态，因此排队和重试不会改变指标归属。

#### <u>4. ContextManager 汇总其他运行上下文</u>

ContextManager 不把所有状态塞进一个对象，而是组合多个生命周期不同的 Context：

| Context 模块   | 当前职责                                               | 快照行为                                      |
| -------------- | ------------------------------------------------------ | --------------------------------------------- |
| AppContext     | 保存经过配置校验的应用名称、版本和环境                 | 构造时冻结，所有事件复用同一份值              |
| SessionContext | 创建本 Monitor 实例的 sessionId 和 startedAt           | 构造时生成一次；Envelope 当前只读取 sessionId |
| ViewContext    | 保存最近 20 个 View 的时间区间和安全 URL               | 按指标发生时间选择记录                        |
| UserContext    | 保存 setUser() 最近一次写入的 id 和浅拷贝 properties   | 没有用户时不写入 Envelope；destroy 时清空     |
| RuntimeContext | 读取 userAgent、language、platform、online 和 SDK 信息 | 每次形成快照时重新读取 navigator 状态         |
| ContextManager | 组合上述模块并提供 snapshotAt()、snapshotForView()     | 输出冻结的 TelemetryContext                   |

这些模块都不监听性能 API。Instrumentation 决定事实何时发生，ViewCollector 决定 View 边界，Context 只负责保存状态并在指定时间生成快照。

---

### 【Performance Payload 与统一 Envelope】

Collector 输出的不是完整发送对象，而是 TelemetryDraft：指标名称、发生时间、Performance Payload，以及可选的预绑定 Context 和关联标识。MonitorPipeline 为它生成 eventId、读取 App 和发生时 Context、补上空的 correlation，最终形成 Schema 1.0 的 Envelope。

#### <u>1. Payload 保留不同指标的领域差异</u>

所有 Performance Payload 都包含 type、name、value、unit、kind 和 source，但三条支线拥有不同扩展字段：

| Payload   | 公共值                          | 特有字段                                                                     |
| --------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Web Vital | source: web-vitals              | sampleId、sequence、state、delta、clientRating、navigationType、navigationId |
| LoAF      | source: performance-observer    | 长帧各阶段时间与 scriptCount                                                 |
| FPS       | source: request-animation-frame | frameCount、sampleDurationMs                                                 |

这样的联合类型没有强迫 FPS 伪造 rating，也没有让 LCP 携带不存在的帧窗口。平台可以先通过 type: performance 识别领域，再通过 name 读取对应 Payload。

#### <u>2. Envelope 统一跨领域字段</u>

```ts
interface TelemetryEnvelope<T extends TelemetryPayload> {
  protocolVersion: '2.0';
  eventId: string;
  type: T['type'];
  name: string;
  occurredAt: number;
  app: AppContextData;
  context: TelemetryContext;
  correlation: CorrelationContext;
  payload: T;
}
```

occurredAt 始终表示指标发生时间；eventId 标识本条 Envelope；app 描述应用和发布环境；context 固定 Session、View、routeName、URL、Runtime 和 User；correlation 为后续 Action、Request 或 Trace 关联保留统一位置；payload 保存 Performance 自身语义。

统一 Envelope 让 Processing 和 Transport 不需要为 LCP、LoAF、FPS 分别设计入口。它们只面对同一种公共外壳，领域差异留在 Payload 中。

---

### 【Processing：七个阶段统一治理性能数据】

<code>createProcessingPipeline()</code> 按固定顺序创建七个 Stage。每个 Stage 接收一个 Envelope，返回处理后的 Envelope 或 undefined；返回 undefined 表示当前数据被丢弃。任何 Stage 抛出异常时，Pipeline 也会丢弃当前数据并停止本轮处理，异常不会回到业务调用栈。

<code>Normalize → Validate → Redact → Filter → Dedupe → Sampling → Rate Limit</code>

#### <u>1. Normalize：先形成稳定字段</u>

Normalize 会去除 Envelope name 两端空白，把 occurredAt 四舍五入为整数，并再次规范 Context URL。后续校验、过滤和去重因此面对相同表示，不会因为空格、时间小数或 URL 敏感参数的表达差异产生不同判断。

#### <u>2. Validate：拒绝无法进入协议的数据</u>

Validate 检查 <code>protocolVersion === '2.0'</code>，要求 eventId、name、sessionId、viewId 和 routeName 非空，要求 occurredAt 是有限且非负的整数。Performance Payload 还要求 sampleId、sequence、state、value 和单位满足协议约束。不满足约束的数据直接返回 undefined，而不是猜测一个修复值。

#### <u>3. Redact：在入队前建立第二道安全边界</u>

Performance Instrumentation 已经执行最小字段提取，不会把 Web Vitals Entries、LoAF scripts 内容或页面 hash 放进 Payload。Redact Stage 仍会再次处理 Context URL，形成纵深防护。对于 Custom Event，它还会递归替换敏感属性、限制递归深度为 5 层并把数组截断到 50 项。

当前 Redact 对 Performance Payload 没有额外字段重写，因为这些 Payload 已由类型和 Collector 限定；UserContextData.properties 也不会在该 Stage 中递归处理，调用 setUser() 时必须只传允许进入监控系统的白名单属性。这是当前实现边界，不能把它描述成任意用户对象都会自动脱敏。

#### <u>4. Filter：排除不应监控的页面</u>

Filter 使用 excludeUrls 中的字符串片段匹配 envelope.context.url。只要 URL 包含任一片段，当前 Envelope 就被丢弃。因为过滤发生在 URL 规范化和脱敏之后，规则面对的是稳定、安全的地址。

#### <u>5. Dedupe：只删除完全相同的数据</u>

Dedupe 的指纹包含 type、name、sessionId、viewId、correlation 和完整 payload，不包含 eventId 与 timestamp。同一 View 内只有语义和 Payload 完全相同、且发生时间差不超过去重窗口的数据才会丢弃。

这意味着 LCP 从 1700 ms 更新到 1900 ms 时 Payload 已变化，两条数据都会保留；不同 View 中即使数值相同，因为 viewId 不同也不会互相去重。指纹表小于 500 项时不主动全表扫描，达到阈值后才清理窗口外记录，降低常规路径的遍历成本。

#### <u>6. Sampling：对同类数据执行稳定采样</u>

Sampling 使用 <code>sessionId:type:name</code> 生成稳定哈希比例。采样率为 1 时全部保留，为 0 时全部丢弃；中间比例让同一 Session 的同类型同名称数据得到稳定判断，而不是每条数据都重新调用随机数造成会话内部忽留忽丢。

#### <u>7. Rate Limit：限制最终通过量</u>

Rate Limit 按 Envelope 的发生时间维护窗口。首次数据、时间倒退或超过 windowMs 时重置窗口；达到 maxEvents 后，后续数据返回 undefined。当前限流器位于共享 Pipeline 中，因此限制的是通过该 Pipeline 的总事件数，不是为 LCP、LoAF 和 FPS 分别建立独立额度。

Processing 的顺序不能任意交换：先规范化才能稳定校验和匹配；校验通过后才值得继续处理；脱敏必须早于去重状态和 Transport Queue；去重应使用已经安全且规范的字段；采样与限流放在后段，控制最终进入队列的数据量。

---

### 【Transport：从内存队列到采集接口】

Processing 返回安全 Envelope 后，MonitorPipeline 调用 <code>transport.enqueue()</code>。Transport 不理解 LCP、LoAF 或 FPS 的指标语义，只根据统一 Envelope 执行容量控制、组批、刷新、发送和重试。

#### <u>1. MemoryQueue：容量有界并按优先级淘汰</u>

队列未满时按进入顺序追加。当前优先级中 View 和 Event 为 2，Performance 为 1，因为 View 和业务事件承担链路还原作用，而 Performance 诊断数据通常可以聚合。队列满时查找最早出现的最低优先级项：如果新数据优先级不低于该项，就淘汰旧项并加入新数据；如果新数据优先级更低，则直接丢弃新数据。每次容量淘汰都会增加 droppedCount。

因此，当队列中存在旧 Performance 时，新 View 可以替换它；新 Performance 不会挤掉只包含 View 和 Event 的高优先级队列；同为 Performance 时保留较新的数据。Queue 只保存在内存中，刷新失败后不会写入 IndexedDB 或跨页面持久化。

#### <u>2. Batch：同时控制条数和序列化长度</u>

<code>takeBatch()</code> 先从队首取出不超过 batchSize 的候选项，再逐条累加 <code>JSON.stringify(envelope).length</code>。加入下一条会超过 maxBatchBytes 时，未消费候选项按原顺序放回队首。

当前 maxBatchBytes 实际使用 JavaScript 字符串长度估算，并不是精确 UTF-8 字节数。第一条数据即使单独超过限制也会进入批次，否则它会不断被放回队首并永久阻塞后续数据。

#### <u>3. Flush：合并触发条件并避免并发消费</u>

以下条件会触发刷新：队列数量达到 batchSize；flushIntervalMs 定时器到期；业务调用 monitor.flush()；SDK 执行 stop()；页面进入 hidden 或 pagehide；SDK 执行 destroy()。

Transport 用 <code>flushing: Promise&lt;void&gt;</code> 合并并发请求。如果刷新正在进行，新的调用复用同一个 Promise，不会启动第二个 drain 循环同时从队列取数据。<code>drain()</code> 持续发送批次，直到队列为空或某一批发送失败。

#### <u>4. Sender：页面收尾优先 Beacon，常规路径使用 Fetch</u>

HttpSender 把批次序列化为统一请求体：

```ts
{
  protocolVersion: '2.0',
  sentAt: Date.now(),
  sdk: { name: 'cx-browser-monitor-sdk', version: '0.2.0' },
  events: batch
}
```

常规定时刷新和主动 flush 使用 fetch POST；页面隐藏或离开时设置 preferBeacon=true，优先调用 navigator.sendBeacon()。浏览器返回 true 表示已经接收待发送数据，此时视为成功；Beacon 不存在、返回 false 或抛错时，降级到 fetch，并设置 keepalive: true。

Fetch 的 408、429 和 5xx 被标记为可重试；其他非成功状态被视为不可恢复；网络异常被视为可重试；运行环境没有 Fetch 时直接返回不可重试失败。

#### <u>5. Retry：有限指数退避，不重新处理数据</u>

<code>sendWithRetry()</code> 对同一个已完成 Processing 的批次最多尝试 maxAttempts 次。只有首次尝试可能使用 Beacon，后续尝试使用可判断响应状态的 Fetch。可恢复失败后等待：

<code>baseDelayMs × 2^(attempt - 1) + [0, baseDelayMs) 随机抖动</code>

重试不会重新生成 eventId、重新读取 Context、重新采样或重新限流。当前 drain 在发送前已经把批次从 MemoryQueue 取出；达到最大次数或遇到不可重试失败后，该批次不会重新放回队列，drain 结束。实现提供的是当前页面生命周期内的有限尽力发送，不是持久化可靠消息队列。

Transport 的边界到采集接口接收上述批次为止。服务端如何落库、聚合指标、建立索引和告警不在当前 Browser SDK 代码中。

---

### 【stop、重新启动与 destroy】

Lifecycle 维护 <code>created → installed → running → stopped → destroyed</code> 状态。重复 start()、stop() 和 destroy() 都会先检查状态，防止重复监听、重复 Timer 或重复释放。

| 操作         | Performance 数据源                                              | Collector 与 Context                   | Transport               | 是否可恢复 |
| ------------ | --------------------------------------------------------------- | -------------------------------------- | ----------------------- | ---------- |
| start()      | 安装或恢复 Web Vitals、Observer、RAF                            | 打开 Signal 消费并建立 View            | 启动定时刷新            | 是         |
| stop()       | 逆序暂停 RAF、断开 Observer、关闭 Web Vitals 输出、恢复 History | Collector 进入 inactive，保留实例结构  | 停止 Timer 并尝试 flush | 是         |
| 再次 start() | 不重复注册 Web Vitals；新建 Observer/RAF 窗口；重新包装 History | 重新打开已有订阅                       | 重新启动 Timer          | 是         |
| destroy()    | 永久静默或释放浏览器资源                                        | 退订 Signal，清空 View 和 User Context | 最终尝试刷新后清空队列  | 否         |

Page Lifecycle 对运行中的采集还有局部控制：hidden/pagehide 暂停 RAF 并断开 LoAF Observer，同时要求 Transport 进行页面收尾刷新；visible/pageshow 创建新的 RAF 窗口并恢复非 buffered LoAF 观察。BFCache 的 persisted 状态还会参与 View 边界判断。

**<u>当前重启边界：stop() 会恢复原始 History 方法，停止期间发生的路由变化不会被记录；再次 start() 也不会重新发布 initial Signal。</u>** 如果业务允许 SDK 暂停期间继续导航，重新启动后的 View 会保持停止前记录，直到下一次可观察的路由变化到来。

Web Vitals 是唯一不能通过当前接口主动断开第三方内部监听的支线，因此采用“一次注册、状态门控、销毁后永久静默”。PerformanceObserver、RAF、Timer、DOM 事件和 History 包装则都具有明确的取消或恢复路径。

---

### 【一条 LCP 数据的端到端追踪】

下面使用测试中的结账页面场景，把分散模块串成一条实际链路。假设应用配置为 <code>checkout / 1.2.3 / test</code>，当前地址为 <code>/checkout?token=secret#private</code>，上报地址为 /collect，Web Vitals 返回 LCP 值 1800。

#### <u>1. 初始 View 先于 LCP 建立</u>

monitor.start() 先建立性能快照与 View 生命周期订阅，再启动 HistoryInstrumentation。History 发布 initial Signal，ViewContext 创建 viewId，并从 URL 中移除 query 与 fragment。随后 WebVitalsInstrumentation 注册 onLCP()。

#### <u>2. Metric 被缩减为 Raw Signal</u>

Web Vitals 回调读取最后一条 Entry 的 startTime，加上 performance.timeOrigin 得到绝对时间，并只发布以下内部事实：

```ts
{
  name: 'LCP',
  metricId: 'metric-LCP',
  value: 1800,
  delta: 1800,
  rating: 'good',
  navigationType: 'navigate',
  navigationId: 0,
  timestamp: performance.timeOrigin + 1800
}
```

原始 entries 和可能包含敏感地址的 navigationURL 不会进入 Signal。

#### <u>3. Collector 形成领域 Payload</u>

SignalHub 同步通知 WebVitalsCollector。Collector 确认 LCP 已启用后，输出 unit: ms、kind: core-web-vital、source: web-vitals 的 Performance Payload，将内部 rating 保存为 clientRating，并补齐 sampleId、sequence 与 provisional 状态；View 结束时再发出 final 快照。

#### <u>4. Pipeline 绑定发生时 Context 并形成 Envelope</u>

MonitorPipeline 根据 Signal timestamp 查找当时的 View，生成 eventId，并组合 App、Context、Correlation 与 Payload：

```ts
{
  protocolVersion: '2.0',
  eventId: 'event-…',
  type: 'performance',
  name: 'LCP',
  occurredAt: 绝对发生时间,
  app: {
    name: 'checkout',
    version: '1.2.3',
    environment: 'test'
  },
  context: {
    sessionId: 'session-…',
    viewId: 'view-…',
    routeName: 'checkout',
    url: 'https://host/checkout',
    runtime: {
      sdk: {
        name: 'cx-browser-monitor-sdk',
        version: '0.2.0'
      }
    }
  },
  correlation: {},
  payload: {
    type: 'performance',
    name: 'LCP',
    value: 1800,
    unit: 'ms',
    kind: 'core-web-vital',
    source: 'web-vitals',
    sampleId: 'metric-LCP',
    sequence: 0,
    state: 'provisional',
    delta: 1800,
    clientRating: 'good',
    navigationType: 'navigate',
    navigationId: 0
  }
}
```

#### <u>5. Processing 决定它是否可以进入队列</u>

该 Envelope 依次完成名称和时间规范化、Schema 与数值校验、URL 再脱敏、排除 URL 检查、精确重复检查、稳定采样和窗口限流。只有七个阶段全部返回 Envelope，Transport 才接收到它。

#### <u>6. Transport 形成批次并发送</u>

LCP 以低于 View/Event 的 Performance 优先级进入 MemoryQueue。达到批次数量、定时器到期或业务主动调用 flush() 后，Transport 构造批次并交给 HttpSender。服务端最终收到的外层请求包含 protocolVersion、sentAt、sdk 和 events 数组，而不是浏览器原始 PerformanceEntry。

整条链路可以压缩为：

<code>LCP Metric → WebVitalSignal → LCP Payload → Context Snapshot → Envelope → Processing → Queue → Batch → Sender → Ingestion Endpoint</code>

---

### 【实现验证】

当前测试不是只验证某个计算函数，而是分别检查模块边界、生命周期和端到端链路。

| 测试文件                          | 覆盖内容                                                       | 关键保证                                                                 |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| tests/performance/monitor.spec.ts | Web Vitals 纵向链路、stop/restart、Capabilities、View 时间归属 | 指标能穿过 Context、Processing、Envelope 和 Transport，且不会重复注册    |
| tests/performance/loaf.spec.ts    | Observer 与 LoAF Collector 分层                                | Instrumentation 不执行阈值语义，脚本详情不进入 Payload，额度按 View 重置 |
| tests/performance/fps.spec.ts     | 帧窗口机械统计、FPS 计算、页面隐藏和恢复                       | RAF 资源可取消，FPS 计算留在 Collector，后台数据不进入窗口               |
| tests/processing/pipeline.spec.ts | URL 脱敏、精确去重、指标值变化                                 | 重复数据丢弃，发生变化的指标保留                                         |
| tests/transport/transport.spec.ts | 队列、批次和 Sender 注入                                       | Envelope 能按批发送，队列和丢弃计数可检查                                |
| tests/smoke/index.spec.ts         | 公共入口和配置失败                                             | 只公开统一 Monitor 工厂，非法必填配置在创建阶段失败                      |

monitor.spec.ts 使用 FakeSender 捕获最终批次，并确认 LCP Envelope 具有 App、Session、View 和安全 URL，原始 navigationURL 不会泄漏；生命周期用例确认 stop 期间的回调被忽略，restart 后继续采集，destroy 后永久静默；View 用例确认路由切换前后发生的两个指标拥有不同 viewId。

在 `sdk/` 目录执行完整 SDK 发布检查：

```bash
pnpm check
```

该命令依次执行格式检查、ESLint、TypeScript 类型检查、Vitest、构建和 publint。若要从 monorepo 根目录同时验证协议、SDK 和 Platform，则执行根目录的 `pnpm check`，它只运行三者的类型检查、核心测试和生产构建，避免重复执行各包的发布格式检查。测试覆盖 Web Vitals、LoAF、FPS、Processing、Transport 和公共入口，但不在文档中固化容易过期的用例数量。通过这些检查只能证明当前约束下的实现行为一致；新增指标、修改 Payload 或调整处理顺序时，仍需要为新的模块边界和端到端链路补充核心测试。

## 5. 监控服务端与可视化平台的完整实现链路

SDK 解决的是“怎样在浏览器内安全、低侵入地形成遥测数据”，但它不能独立完成监控闭环。真正能够回答“线上性能是否达标、哪个页面出现退化、采集链路是否积压”的系统，还需要协议、采集服务、异步计算、时序存储、查询接口和可视化平台共同参与。

完整系统位于独立的 `browser-monitor/` monorepo：`sdk/` 在浏览器内产生协议事件；`protocol/` 是 SDK 与服务端共同使用的协议权威；`platform/` 接收、处理、聚合并展示数据。三者共享 pnpm workspace 的本地依赖，但各自拥有独立职责和构建边界，不再把 workspace 文件和项目目录散落在 `cx-learn-notes` 根目录。

### 【SDK 与平台的责任边界】

#### <u>1. 业务应用不需要实现采集接口</u>

业务应用接入 SDK 时只需要提供平台生成的 DSN。DSN 指向 Browser Monitor Platform 的公开采集路由，服务端 API 和可视化页面已经包含在平台项目中，因此业务层不需要再实现一套 `endpoint`，也不需要为每个被监控项目单独开发看板。

```ts
const monitor = createMonitor({
  app: {
    name: 'customer-center',
    version: '1.4.0',
    environment: 'production',
  },
  view: {
    resolveRouteName({ pathname }) {
      return pathname.startsWith('/users/') ? 'user-detail' : pathname;
    },
  },
  performance: {
    enabled: true,
    metrics: {
      LCP: true,
      FCP: true,
      INP: true,
      CLS: true,
      FPS: true,
      LoAF: true,
    },
    webVitals: {
      reportAllChanges: false,
      reportSoftNavs: true,
    },
    fps: {
      sampleWindowMs: 5_000,
      sampleIntervalMs: 30_000,
    },
    loaf: {
      minDurationMs: 50,
      maxEntriesPerView: 20,
    },
  },
  processing: {
    sensitiveKeys: ['token', 'password', 'authorization'],
    excludeUrls: ['/health'],
    dedupeWindowMs: 1_000,
    samplingRate: 1,
    rateLimit: {
      maxEvents: 120,
      windowMs: 60_000,
    },
  },
  transport: {
    dsn: 'https://monitor.example.com/api/v2/ingest/bm_pk_xxx/envelopes',
    batchSize: 20,
    maxBatchBytes: 64_000,
    flushIntervalMs: 10_000,
    maxQueueSize: 200,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 500,
    },
  },
});
```

这里的 `app` 是平台进行项目身份校验和环境、版本筛选的依据；`view` 把动态 URL 映射为稳定业务页面；`performance` 决定采集哪些指标以及 FPS、LoAF 的浏览器侧成本；`processing` 控制自定义属性脱敏、排除、采样和页面内限流；`transport` 只控制已经处理完成的数据怎样组批、排队和发送。

`transport.dsn` 是唯一采集地址字段。旧的 `transport.endpoint` 不作为兼容字段保留，避免两个字段同时存在时产生优先级冲突。URL query 和 fragment 无条件从协议中删除；`processing.sensitiveKeys` 只负责递归清理自定义属性中的敏感键，不再承担“选择性保留 query”的含义。

#### <u>2. SDK 不包含服务端和看板</u>

SDK 必须能够独立发布并嵌入任意前端应用，所以不能把数据库连接、账号系统、指标聚合和 React 管理后台打入浏览器包。平台也不直接监听浏览器 API，它只相信协议校验通过的事件。边界划开后，SDK 可以按浏览器兼容性演进，服务端可以按容量和数据产品需求独立扩容。

---

### 【三个项目怎样协作】

```text
browser-monitor/
├─ sdk/
│  └─ 浏览器事实 → Collector → Context → Processing → Transport
├─ protocol/
│  └─ 协议常量、Zod Schema、TypeScript 类型和测试夹具
└─ platform/
   ├─ apps/api/       # 公开采集、账号项目管理和分析查询
   ├─ apps/worker/    # Outbox 消费、投影、评级和失败恢复
   ├─ apps/web/       # 项目设置与监控看板
   ├─ packages/database/ # Drizzle 模型和 TimescaleDB migration
   ├─ packages/shared/   # 配置、安全、隐私和指标阈值
   └─ infra/          # Compose、Caddy、镜像和容量测试配置
```

Protocol 位于 SDK 和平台之间，不属于任意一端的内部实现。SDK 使用它生成事件，API 使用它执行运行时校验，Worker 使用它区分 payload 并获得类型约束。协议版本、字段枚举和大小限制只在这里定义，避免三处各自维护一个“看起来相同”的接口。

当前协议 2.0 接受 Performance、View 和 Custom Event。后续新增 Error 或 Network 时，扩展的是共享 Schema 和 Worker 投影，不为新领域另建绕过 Processing、Transport 或 Outbox 的旁路。

---

### 【从 DSN 到采集 API】

#### <u>1. DSN 如何定位项目</u>

平台为每个项目生成形如 `/api/v2/ingest/bm_pk_xxx/envelopes` 的地址。`bm_pk_xxx` 是公开写入键，用于定位项目、检查项目状态并选择用户散列盐值。它不是管理密钥，拿到写入键不能查询监控数据、修改 Origin 或变更阈值。

项目 Owner 轮换写入键后，新键立即可用，旧键保留 24 小时过渡期。业务可以先发布新 DSN，再等待旧版本页面自然退出，避免直接切断仍在运行的客户端。

#### <u>2. API 按什么顺序接收数据</u>

采集入口是 `POST /api/v2/ingest/:publicKey/envelopes`。Fastify 将请求体限制为 256 KiB，协议将单批事件数限制为 100。API 依次执行：

`协议版本 → 批次头 → 写入键 → Origin → 项目/IP 限流 → 单事件 Schema → app.name → 发生时间 → 二次脱敏 → eventId 幂等 → 事务写入`。

协议或身份错误会拒绝整批，因为服务端无法确认怎样解释或归属事件；某一条事件结构错误则允许部分接收。响应中的 `accepted`、`duplicate` 和 `rejected` 让 SDK 重试和平台运维都能区分“首次写入”“已处理过”和“数据本身无效”。

#### <u>3. 页面离开时为什么仍走同一校验链路</u>

常规发送使用 Fetch；页面隐藏或离开时优先使用 `sendBeacon`。Beacon 发送字符串时常以 `text/plain` 到达，因此 API 允许把文本解析为 JSON，但解析完成后仍进入相同的协议、Origin、限流和事务逻辑，不建立一个校验更弱的卸载专用接口。

---

### 【原始事件与 Outbox 为什么必须同事务】

采集接口不能在返回 `202` 后才临时尝试创建处理任务。如果原始事件已经写入而任务创建失败，数据会永久停留在“已接收但不会被计算”的状态；如果任务先被 Worker 看见而原始事件尚未提交，查询和追踪又会出现不一致。

API 使用同一个 PostgreSQL 事务批量插入 `telemetry_events` 和 `outbox_tasks`。只有两个写入都成功才提交并返回。`eventId` 幂等检查也在事务内完成：同一请求先去重，重叠请求再通过项目与事件 ID 的事务咨询锁串行化，最终只为首次插入的事件创建 Outbox。

原始事件的价值不仅是故障排查。它还是协议接收事实和领域投影之间的稳定审计边界：即使某次 Worker 投影失败，平台仍能查看最初接收的 Envelope，并通过死信重新执行。

---

### 【Worker 如何把协议事件变成监控数据】

#### <u>1. 任务领取和并发</u>

Worker 使用 `FOR UPDATE SKIP LOCKED` 领取 pending 任务。多个 Worker 并发时，一个实例已经锁住的任务会被其他实例跳过，适合队列表这种允许消费者处理不同记录的场景。[[2]](https://www.postgresql.org/docs/current/sql-select.html)

领取后任务进入 processing 并记录 `lockedBy` 和 `lockedAt`。Worker 异常退出不会永久占住任务；锁定超过五分钟后，其他实例可以重新领取。每轮任务按小组并发处理，避免单批数量直接转化为无边界数据库连接压力。

#### <u>2. 三类投影各自回答什么问题</u>

| 协议事件     | 投影表                 | 主要用途                                     |
| ------------ | ---------------------- | -------------------------------------------- |
| Performance  | `performance_samples`  | 当前指标值、服务端评级、分位数和页面性能     |
| View         | `view_records`         | 页面访问数、会话数、路由归因和 View 结束时间 |
| Custom Event | `custom_event_samples` | 业务事件趋势、页面分布和属性明细             |

投影成功后，Worker 更新原始事件的 `processed_at`，把 Outbox 标记为 completed，并递增 Redis 中的项目分析版本。查询缓存键包含这个版本，因此新数据到达后旧缓存会自然失效，不需要扫描删除所有筛选组合。

#### <u>3. Performance 的 sequence 与 final</u>

Web Vitals 回调可能在一个页面生命周期中多次返回同一指标。官方 `web-vitals` 也明确说明 `reportAllChanges` 会在指标值发生变化时再次调用回调，而不是为每个底层输入都产生独立指标。[[1]](https://github.com/GoogleChrome/web-vitals/blob/main/README.md)

协议使用稳定 `sampleId` 表示同一次指标观测，使用递增 `sequence` 表示修订顺序。Worker 对同一项目与 sampleId 加事务咨询锁，只应用更高 sequence；重复或乱序事件不会形成多个样本。更高序号的迟到事件可以修正数值，但样本一旦进入 final 就不会重新变成 provisional。

final 有三条收口路径：SDK 在 View 结束时发送当前 Web Vitals 的 final 快照；Worker 处理 `view.end` 时关闭该 View 下仍为 provisional 的样本；浏览器异常退出没有结束事件时，后台任务把五分钟没有更新的 provisional 样本兜底设为 final。

#### <u>4. 重试和死信</u>

投影失败后，Worker 按指数退避重新安排任务，并保存最后一次错误。达到八次尝试后，任务进入 `dead_letter_tasks`，原 Outbox 标记为 failed。服务状态页展示死信的事件 ID、尝试次数、失败时间和错误信息；Owner 点击重试后，平台删除死信记录并把同一个 Outbox 重置为 pending，而不是复制一条新任务。

---

### 【服务端怎样形成最终指标口径】

SDK 中的 `clientRating` 只能描述采集时使用的客户端阈值，不能成为平台的最终统计口径。Worker 根据项目当前激活的阈值版本重新计算 `serverRating`，并把阈值版本 ID 固定在样本上。项目修改阈值后，新样本使用新版本，历史样本不被静默改写。

默认阈值如下：

| 指标 |      Good | Needs improvement |      Poor | 方向     |
| ---- | --------: | ----------------: | --------: | -------- |
| LCP  | ≤ 2500 ms |         ≤ 4000 ms | > 4000 ms | 越低越好 |
| INP  |  ≤ 200 ms |          ≤ 500 ms |  > 500 ms | 越低越好 |
| CLS  |     ≤ 0.1 |            ≤ 0.25 |    > 0.25 | 越低越好 |
| FCP  | ≤ 1800 ms |         ≤ 3000 ms | > 3000 ms | 越低越好 |
| FPS  |      ≥ 50 |              ≥ 30 |      < 30 | 越高越好 |

每个时间窗口计算 count、min、max、average、p50、p75、p90、p95，以及三个等级的数量和占比。View 投影提供页面访问数和会话数，Performance 的去重 View 数除以页面访问数得到样本覆盖率。

LoAF 不强行套用 Good/Poor。它统计发生次数、每千次页面访问的 LoAF 数量、duration 分位数、blocking duration 总量和 script count，再按 routeName 找到受影响页面。

---

### 【TimescaleDB 如何连接实时明细与长期趋势】

`telemetry_events`、`performance_samples`、`view_records` 和 `custom_event_samples` 按各自时间列转换为 Hypertable。原始和投影明细保留 30 天，超过 24 小时的旧分区执行压缩；分钟级与小时级聚合保留 180 天。

数据库先形成一分钟连续聚合，再从分钟结果形成一小时层级聚合。近 29 天查询直接读取明细以获得最新结果；查询范围跨越更早数据时改读小时聚合，避免长期看板扫描大量分钟记录。连续聚合的目的正是把后台预计算结果与后续时间范围查询连接起来。[[3]](https://docs.tigerdata.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)

分位数不能简单平均，因此聚合表保存 Timescale Toolkit 的 percentile 中间状态；会话和 View 去重数也不能把每分钟 distinct count 相加，因此保存 HyperLogLog 中间状态并在更大窗口 rollup。只有可合并的中间状态，才能让小时结果与直接扫描明细保持同一统计含义。

---

### 【查询 API 与可视化页面怎样对应】

| 页面       | 查询入口                    | 回答的问题                                       |
| ---------- | --------------------------- | ------------------------------------------------ |
| 总览       | `/analytics/overview`       | 有多少访问、会话、事件，整体性能是否健康         |
| 性能看板   | `/analytics/performance`    | 指标分位数、等级分布和时间趋势如何变化           |
| 页面排名   | `/analytics/routes`         | 哪个 routeName 的 p75 或异常率最高               |
| 自定义事件 | `/analytics/events`         | 业务事件在什么时间和页面发生                     |
| 原始事件   | `/analytics/raw-events`     | 某 eventId、sessionId 或 viewId 的原始内容是什么 |
| 服务状态   | `/analytics/service-status` | 接收、处理、积压、拒绝和死信是否异常             |

主要分析接口统一接受 `from`、`to`、`environment`、`version`、`routeName` 和 `metric`。环境和版本让同一项目可以比较生产/测试或发布前后，routeName 避免动态 pathname 导致页面维度无限增长。

原始事件采用 `(occurredAt, eventId)` 游标分页，不使用不断增大的 offset。看板默认每 15 秒刷新；当前阶段的数据延迟目标是约 10～15 秒，因此不需要为了“看起来实时”引入 WebSocket 和额外连接状态。

服务状态页把链路分段展示：最近一分钟接收量反映 API 是否收到数据；最近一分钟处理量和 pending 数反映 Worker 是否跟上；rejected 反映协议、Origin 或事件质量问题；dead-letter 反映某条投影持续失败。只有把这些状态分开，才能避免把所有“看板没数据”都误判为 SDK 故障。

---

### 【账号、项目与安全边界】

平台采用开放注册加邮箱验证。未验证账号不能登录；登录会话保存在 Redis，通过 HttpOnly Cookie 传递，管理写请求再校验 CSRF。owner 可以管理 Origin、写入键、成员、阈值和死信，member 只能查看监控数据。

采集接口与管理接口使用两套身份边界。采集接口依赖公开写入键、Origin、限流和配额，不能读取平台数据；管理接口依赖 Session、项目成员关系和 CSRF。Prometheus `/internal/metrics` 由 Caddy 限制为私有网络访问，不暴露给普通业务页面。

隐私防护也分成两层。SDK 在进入队列前删除 URL query/fragment，并递归清理自定义属性；API 再执行一次 URL 规范化、敏感键清理、属性深度/字段数/字节数限制，并用项目盐值与服务端密钥散列用户 ID。任意一端配置错误都不应让原始凭据直接进入长期存储。

---

### 【从创建项目到看见指标的实际顺序】

1. 用户注册账号，通过 SMTP 邮件完成验证并登录平台。
2. 创建项目并确定唯一 `app.name`，平台同时创建 owner、默认写入键、默认 Origin 和全局阈值引用。
3. 在项目设置中填写业务应用的完整 Origin，复制平台生成的 DSN。
4. 业务接入 `createMonitor()`，配置 app、routeName 解析和 `transport.dsn`，然后调用 `monitor.start()`。
5. SDK 产生 View、Performance 或 Custom Event，经过统一 Processing 后组成协议 2.0 批次。
6. API 校验、二次脱敏并在同一事务中写入原始事件和 Outbox，返回 `202` 接收结果。
7. Worker 领取任务，应用 sequence、final 与服务端阈值规则，生成领域投影。
8. TimescaleDB 连续聚合刷新窗口；Analytics API 读取明细或小时聚合，并按项目版本缓存结果。
9. React 看板下一次 15 秒轮询读取新结果，服务状态页同时显示接收和处理状态。

如果第 6 步没有 accepted，检查 DSN、Origin、`app.name`、协议版本和限流；如果 accepted 增长但第 7 步不增长，检查 Outbox pending、Worker 日志和 dead-letter；如果处理正常但页面为空，再检查时间范围、环境、版本、routeName 和指标筛选。这个排查顺序与数据实际经过的边界一致。

平台目录、运行命令、接口列表和环境变量见 [Browser Monitor Platform README](../../platform/README.md)，端到端处理细节见 [Platform 完整链路报告](../../platform/docs/01-平台架构与端到端链路.md)。

## 6. 参考文献

[1] GOOGLE CHROME TEAM. [web-vitals](https://github.com/GoogleChrome/web-vitals/blob/main/README.md)[EB/OL]. [2026-09-21].

[2] POSTGRESQL GLOBAL DEVELOPMENT GROUP. [SELECT](https://www.postgresql.org/docs/current/sql-select.html)[EB/OL]. [2026-09-21].

[3] TIGER DATA. [About continuous aggregates](https://docs.tigerdata.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)[EB/OL]. [2026-09-21].
