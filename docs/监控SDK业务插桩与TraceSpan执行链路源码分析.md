# 监控 SDK 业务插桩与 Trace/Span 执行链路源码分析

本文以当前 \`browser-monitor\` 主分支为依据，沿着“**浏览器事实产生 → SDK 创建 Event/Trace/Span → 上下文与关联 → 统一加工 → 内存组批和发送 → 查询还原**”这一数据主线，还原实际代码。业务目标、通用模型和 API 的解释先独立成立，再用项目源码证明行为；**已实现功能、设计限制、进一步改造建议不得混写**。

全文对应的通用知识主入口：[监控 SDK 插桩与 Trace/Span 工程体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/J-%E7%9B%91%E6%8E%A7SDK%E6%8F%92%E6%A1%A9%E4%B8%8ETraceSpan%E5%B7%A5%E7%A8%8B%E4%BD%93%E7%B3%BB.md)。性能指标采集与浏览器 API 另见[性能测量与真实用户监控专项](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/X-%E6%80%A7%E8%83%BD%E6%B5%8B%E9%87%8F%E4%B8%8E%E7%9C%9F%E5%AE%9E%E7%94%A8%E6%88%B7%E7%9B%91%E6%8E%A7%E4%B8%93%E9%A1%B9.md)。本分析引用的代码路径均以 \`browser-monitor/\` 为起点；官网业务层示例单独标注来源为 \`official-network\`，不能冒充本仓库 SDK 的内部行为。

## 1. 监控目标与 SDK 数据路径

### 【业务事实与统一数据结构属于两个不同层次】

业务代码能识别“用户点击购买”“进入页面”“一次请求完成”等语义，浏览器 API 能产生 PerformanceEntry、错误、页面生命周期信号。SDK 的任务不是凭空推断业务含义，而是**将这些事实转成一致的遥测记录，并用 Context 和 Correlation 保留发生位置与因果归属**。

~~~text
自动采集：PerformanceObserver / web-vitals / History / 生命周期
            ↓ 内部 Raw Signal
         SignalHub（内部事件分发）
            ↓ Collector（把浏览器事实解释为遥测类型）
业务手工插桩：monitor.track() / monitor.startTrace() / trace.startSpan()
            ↓ 自定义 Event / Trace / Span 数据草稿
        MonitorPipeline.emit(draft)
            ↓ 补 Event ID、协议版本、App、Session、View、关联 ID
        ProcessingPipeline（七阶段校验和治理）
            ↓ 只有通过的数据进入队列
        Transport.enqueue()（同步、非阻塞）
            ↓ 内存排队 / 批次阈值 / 定时 / 生命周期触发
        flush → takeBatch → sendWithRetry → HttpSender
            ↓ HTTP / Beacon
        Ingestion API → 存储、查询与展示
~~~

关键是 **Event/Trace/Span 的创建** 与 **Batch 的组织** 完全独立。一次 Trace 中的 Span 可以先结束先发送，也可以被拆进不同 Batch；服务端以后通过 ID 关联，不等待“同一条 Trace 的所有 Span 都收齐”。

### 【组合根负责模块连接，不在每个页面重复实现采集】

源码：[sdk/src/core/monitor.ts](../sdk/src/core/monitor.ts)、[sdk/src/core/pipeline.ts](../sdk/src/core/pipeline.ts)。

在 \`BrowserMonitor\` 构造函数中先归一化配置，创建业务 \`ContextManager\`，然后创建 \`HttpSender → Transport → ProcessingPipeline → MonitorPipeline\`，并将同一个 \`pipeline\` 传给各 Collector 和 \`CustomTelemetryManager\`。这是所有监控数据的唯一处理入口。

核心真实代码片段：

~~~ts
const sender =
  dependencies.sender ??
  new HttpSender({
    dsn: this.options.transport.dsn,
    headers: this.options.transport.headers,
  });
this.transport = new Transport(this.options.transport, sender, this.signals);

const processing = createProcessingPipeline(this.options.processing);
const pipeline = new MonitorPipeline(this.context, processing, this.transport);
this.customTelemetry = new CustomTelemetryManager(pipeline, this.context, this.signals);
~~~

说明：这解决了业务代码只需要调用 \`Monitor\` 的接入问题，也允许测试注入 \`Sender\` 而无需真正发网络请求。它不保证任何业务点击都能自动获得业务名称；无法自动理解的动作仍需手工插桩。

## 2. Event、Trace、Span 在当前 SDK 中如何创建

### 【对外 API 将瞬时事实与时间区间分离】

通用模型中，Event 是某时刻发生的事实，Span 是有开始和结束的操作，Trace 表示一条相互关联的执行链路。当前自定义 API 已提供这三类表达，但采用**自定义 Trace 对象及父对象引用**，不是标准 OpenTelemetry Tracer API。

源码：[sdk/src/collectors/event/custom/index.ts](../sdk/src/collectors/event/custom/index.ts)、[sdk/src/core/monitor.ts](../sdk/src/core/monitor.ts)。

~~~ts
export interface TraceHandle {
  readonly traceId: string;
  startSpan(name: string, data?: CustomSignalInput): SpanHandle;
  addEvent(name: string, data?: CustomSignalInput): void;
  end(options?: CustomSignalEndInput): void;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  startSpan(name: string, data?: CustomSignalInput): SpanHandle;
  addEvent(name: string, data?: CustomSignalInput): void;
  end(options?: CustomSignalEndInput): void;
}
~~~

实际行为：

- \`monitor.track('business.action', data)\` 产生独立 Event；默认调用时的 \`correlation\` 为空。
- \`monitor.startTrace('business.flow')\` 创建 \`TraceHandleImpl\`，具有 Trace ID 和起始时间；\`trace.end()\` 产生 Trace 完成记录。
- \`trace.startSpan('stage')\` 产生第一层 Span；\`span.startSpan('substage')\` 创建下一层 Span；\`span.end()\` 产生该操作的时间区间记录。
- \`span.addEvent(...)\` 调用同一个 \`track\` 方法，**显式传入当前 Span 的关联信息**；其事件是单独的 Event Envelope，不等同于 OTel 在单个 SpanRecord 内嵌的 Span Event 数组。

### 【当前父子关系既保留对象引用，也进入独立关联字段】

源码中 \`TraceHandleImpl\` 与 \`SpanHandleImpl\` 都持有未结束的子对象：

~~~ts
class TraceHandleImpl extends TimedHandle implements TraceHandle {
  readonly traceId = createId('trace');
  readonly children = new Set<SpanHandleImpl>();
  // ...
}

class SpanHandleImpl extends TimedHandle implements SpanHandle {
  readonly spanId = createId('span');
  readonly traceId: string;
  readonly children = new Set<SpanHandleImpl>();
  // ...
  private correlation(): CorrelationContext {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parent ? { parentSpanId: this.parent.spanId } : {}),
    };
  }
}
~~~

\`children\` 的作用是生命周期管理，不是服务端重建树的必要字段。当前 \`TraceHandleImpl.end()\` 会递归 \`cancelTree()\` 取消仍然开放的子 Span，Span 结束后还会从父对象的 \`children\` 删除自己。**这一“父结束则取消子”的行为属于当前业务 SDK 的具体约束，不能描述为所有 Trace/Span 系统的标准语义**。通用 OpenTelemetry Span 生命周期可独立结束，是否取消业务子任务应由业务 Runtime 控制。

与此并行，已完成 Span 的记录里使用 \`traceId\`、\`spanId\`、\`parentSpanId\` 这组 ID，不需要上传整个对象树。当前 \`createId\` 是前缀+时间+序列+随机数的自定义生成方法；这并不是 W3C \`traceparent\` 规定的 32 位十六进制 Trace ID、16 位 Span ID，因此不能直接用作标准跨进程传播字段。

### 【当前 Context 不是 AsyncLocalStorage 的活动 Span Context】

源码：[sdk/src/context/snapshot.ts](../sdk/src/context/snapshot.ts)。

~~~ts
snapshotAt(timestamp: number): TelemetryContext {
  let view = this.view.resolveAt(timestamp);
  if (!view) view = this.startView(currentUrl(), timestamp, 'initial').current;
  return this.snapshotForView(view);
}
~~~

这个 \`ContextManager\` 解决的是 **App / User / Session / View 的环境归属**，尤其是延迟数据应归属哪个页面；它不保存当前活跃 Span，也没有 Node.js \`AsyncLocalStorage\`。因此现在的父子 Span 是由 \`trace.startSpan()\` / \`span.startSpan()\` 传递对象引用确定，而不是调用 \`tracer.startSpan()\` 自动读取隐式活动上下文。通用设计中两类 Context 可以同时存在，但负责不同问题。

## 3. 业务代码插桩：什么时候用 Event、什么时候需要 Span

### 【从分析问题反向决定采集模型】

业务接入前先确定需要回答的问题，而不是为了使用 Trace/Span 把每个按钮包装为 Span。

| 需要回答的业务问题 | 最小必要表示 | 为什么 |
| --- | --- | --- |
| 某按钮被点击多少次 | Event | 只关心时间点和业务属性 |
| 某页面的最终有效可见时长 | Event + 业务计时器 | 单条完成记录即可携带 \`visibleMs\` |
| 一个操作从开始到结束经历多久、如何失败 | Span | 需要时间区间、状态及执行上下文 |
| 一次访问跨页面和操作的完整轨迹 | Trace + 页面 Span + Event | 要表达阶段间的关联和时间轴 |

业务可见时长通常不等于 \`Span.end() - Span.start()\`。例如用户浏览 20 秒、标签页后台 30 秒、返回 10 秒，墙钟 60 秒，但业务可见时长 30 秒。**额外的可暂停计时器不可省略；Span 只是可选的时间区间容器。**

最小化方案可以仅使用：

~~~ts
// 业务侧示意：不属于 SDK 原有实现
const timer = createVisibleTimer();

function onPageHidden() {
  timer.pause();
}

function onPageVisible() {
  timer.resume();
}

function onPageLeave(pageId: string) {
  monitor.track('page.stay.completed', {
    attributes: { pageId },
    metrics: { visibleMs: { value: timer.elapsed(), unit: 'ms' } },
  });
}
~~~

此处 \`createVisibleTimer\` 是业务侧假想抽象，需要单独实现；事件里必须携带**原始页面身份**，否则在切换路由后才触发的 \`monitor.track()\` 可能按当前 View 归属到新页面。该示例只演示 Event 的业务设计，不包含严格的页面退出可靠性保证。

### 【可关联的访问轨迹是 Trace/Span 的增量价值】

当产品希望在同一条访问轨迹中看到进入首页、进入产品、提交表单等阶段，就可以以一次访问 Trace 为父级，对每次独立页面访问建立 Span：

~~~ts
// 业务侧示意，与当前 SDK 的真实 API 形态一致
const visitTrace = monitor.startTrace('site.visit');
let pageSpan = visitTrace.startSpan('site.page.stay', {
  attributes: { page: '/home' },
});

// 点击动作与当前页面停留 Span 显式关联。
pageSpan.addEvent('site.cta.click', {
  attributes: { buttonId: 'start-trial' },
});

// 切换路由时结束旧页面，附加业务层计算的有效可见时长。
pageSpan.end({
  metrics: { visibleMs: { value: 30000, unit: 'ms' } },
});

pageSpan = visitTrace.startSpan('site.page.stay', {
  attributes: { page: '/product' },
});
~~~

这里的 \`30000\` 仅为说明 API 形状的示例值，不是 SDK 自动计算的业务时长。官网级可见时长还需要独立访问计时器，不能直接累加整站 Trace duration 与所有子 Span duration。

### 【实际官网插件接入作为跨仓库实践，不等于 SDK 内部自动功能】

在关联项目 \`official-network\` 中，已实现 Nuxt Client Plugin 组合 \`createMonitor → createStayTracker → monitor.start → stayTracker.begin\`。链接：[插件](https://github.com/cxDlogver/official-network/blob/main/app/plugins/monitor.client.ts)、[业务停留编排](https://github.com/cxDlogver/official-network/blob/main/app/utils/monitor/stay-tracking.ts)、[可见时长计时器](https://github.com/cxDlogver/official-network/blob/main/app/utils/monitor/visible-stopwatch.ts)。

该业务计时器在 \`visibilitychange: hidden\` 时 \`pause()\`，可见时 \`resume()\`；路由变化时结算上一段 \`site.route.stay\`；\`pagehide\` 时先结束停留 Span 和访问 Trace，再由 SDK 尝试冲刷；\`pageshow.persisted\` 重新开启一段。这是**业务层驱动 SDK API** 的例子，不是 SDK 自动推断页面停留时间。当前官网真实可核实的是这套停留时长链路；首页按钮和联系页的逐项 \`track()\` 埋点属于可扩展设计方向，不能写为已经上线完成。

## 4. 统一 Envelope 与 Processing 如何把数据送入队列

### 【每个数据源都经过同一个 MonitorPipeline】

源码：[sdk/src/core/pipeline.ts](../sdk/src/core/pipeline.ts)。

~~~ts
const envelope: TelemetryEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  eventId: createId('event'),
  type: draft.payload.type,
  name: draft.name,
  occurredAt: draft.timestamp,
  app: this.context.app.snapshot(),
  context: draft.context ?? this.context.snapshotAt(draft.timestamp),
  correlation: draft.correlation ?? {},
  payload: draft.payload,
} as TelemetryEnvelope;

const processed = this.processing.process(envelope);
if (processed) this.transport.enqueue(processed);
~~~

这里同时解决两件事：用 \`occurredAt\` 而不是“上报时刻”确定数据应归属的 View；给独立 Event、Trace、Span 统一构造协议记录。生成的 \`eventId\` 是记录级去重身份，与追踪模型的 \`spanId\` 用途不同。

### 【七阶段处理的顺序及 Trace 特例】

源码：[sdk/src/processing/index.ts](../sdk/src/processing/index.ts)。

~~~ts
return new ProcessingPipeline([
  new NormalizeStage(),
  new ValidateStage(),
  new RedactStage(options.sensitiveKeys),
  new FilterStage(options.excludeUrls),
  new DedupeStage(options.dedupeWindowMs),
  new SamplingStage(options.samplingRate),
  new RateLimitStage(options.rateLimit.maxEvents, options.rateLimit.windowMs),
]);
~~~

先统一格式和结构，再消除敏感信息/无关页面，然后才消耗去重、采样与限流资源；任一阶段返回 \`undefined\` 时，记录就不会进入 Transport。需要关注两个真实特例：

1. \`DedupeStage\` 对自定义 \`event/trace/span\` 直接放行；同名同属性的两次点击不应被当作同一事实去重。其他信号按 Session/View/类型/名称/关联/Payload 指纹及时间窗口去重。
2. \`SamplingStage\` 对有 Trace ID 的记录以 \`sessionId + traceId\` 构成稳定键，让同条 Trace 内的记录倾向于一起采样或一起排除。但限流、队列容量和发送失败仍可能破坏一条 Trace 的实际完整性，不能把“稳定采样”说成“完整 Trace 保证”。

## 5. Transport 的队列、批次、时机与发送保证

### 【MemoryQueue 是有容量限制的缓冲，不是持久可靠队列】

源码：[sdk/src/transport/queue/index.ts](../sdk/src/transport/queue/index.ts)、[sdk/src/core/config.ts](../sdk/src/core/config.ts)。

当前默认值：\`maxQueueSize=200\`、\`batchSize=20\`、\`maxBatchBytes=64000\`、\`flushIntervalMs=10000\`、\`maxAttempts=3\`、\`baseDelayMs=500\`。这些配置分别代表队列容量、达到阈值就尝试冲刷、每批尺寸预算、定时冲刷和有限重试，彼此独立。

~~~ts
function priorityOf(envelope: TelemetryEnvelope): number {
  if (envelope.type === 'view') return 2;
  if (envelope.type === 'event') return 2;
  return 1;
}
~~~

队列满时先淘汰最低优先级的旧记录，且新记录优先级不能低于已有最低优先级；这使 \`trace/span\` 与 Performance 一样默认处于优先级 1。入队操作本身同步且不等待网络；队列并非持久化缓存，不保证页面异常关闭或网络长期故障后保留所有记录。

### 【flush 合并并发触发，drain 串行取批发送】

源码：[sdk/src/transport/flush/index.ts](../sdk/src/transport/flush/index.ts)。

~~~ts
flush(preferBeacon: boolean = false): Promise<void> {
  if (this.flushing) return this.flushing;

  this.flushing = this.drain(preferBeacon).finally(() => {
    this.flushing = undefined;
  });
  return this.flushing;
}
~~~

触发条件是：达到 \`batchSize\`、周期定时、页面 \`hidden/pagehide\`、\`stop()\` 和 \`destroy()\`。只有一个共享的 \`flushing\` Promise，保证不会同时有两个 drain 消费同一队列。

~~~ts
private async drain(preferBeacon: boolean): Promise<void> {
  while (this.queue.size > 0) {
    const batch = takeBatch(this.queue, this.options.batchSize, this.options.maxBatchBytes);
    if (batch.length === 0) return;

    const sent = await sendWithRetry(this.sender, batch, preferBeacon, this.options.retry);
    if (!sent) return;
    preferBeacon = false;
  }
}
~~~

该循环**一批发送结束后才处理下一批**。假设队列有 45 条，且每条很小，会依次产生 20/20/5 三批。当前 \`takeBatch\` 先按条数 \`splice\` 出队，再使用 \`JSON.stringify(envelope).length\` 累计长度，超出预算的后续候选 \`prepend\` 到队首；第一条不受长度上限阻止，以避免队首死锁。由于字符串长度不是 UTF-8 字节数，且没有计入最终包装对象，\`maxBatchBytes\` 不是严格的网络载荷字节上限。

### 【失败批次的实际行为与源代码注释不一致】

这是源码验证所得的**明确现存问题**，不能根据注释说“失败后保留本批等待下次 Flush”：

~~~ts
// queue.take 已用 splice 从原队列移除当前批次
const batch = takeBatch(this.queue, this.options.batchSize, this.options.maxBatchBytes);

const sent = await sendWithRetry(this.sender, batch, preferBeacon, this.options.retry);
if (!sent) return; // 没有 queue.prepend(batch)，所以本批丢失
~~~

\`sendWithRetry()\` 最多尝试三次，遇网络问题、408、429 或 5xx 时按指数退避和抖动重试；永久性失败直接停止。在尝试耗尽后，**当前失败批次没有重新入队**，仅此前因“字节预算溢出”被 \`prepend\` 的候选、以及未取出的队列尾部仍保留。 \`getDroppedCount()\` 主要统计队列满的淘汰，不能把它当作全部上报失败数。

建议用显式 \`inFlightBatch\`、受控回队或可重试状态机维护“已出队但尚未确认”的批次；还应区分永久错误与临时错误，否则把永久 4xx 反复塞回队列会造成无限重发与阻塞。在引入修复前，文档不得承诺失败数据不丢。

### 【Beacon 只负责尽力发送，不能证明服务端已经收到】

源码：[sdk/src/transport/sender/index.ts](../sdk/src/transport/sender/index.ts)。

~~~ts
if (navigator.sendBeacon(this.options.dsn, body)) {
  return { success: true, retryable: false };
}
~~~

\`sendBeacon()\` 返回 true 表示浏览器已经接受并排队请求，**不是服务端持久化成功的确认**。当前页面隐藏时 \`flush(true)\` 仅使该次 drain 的第一批优先使用 Beacon，后续批次转向 fetch；如果正在运行另一轮普通 drain，新来的 \`flush(true)\` 复用已有 Promise，无法自动将其升级成 Beacon。窗口关闭等情况下的最终上报仍是 best-effort。

## 6. 平台怎样凭扁平记录恢复 Trace 关系

### 【Span 不靠“同一个对象树”或“同时到达”形成关系】

当前服务端按 Trace ID 查询独立记录，返回 \`{traceId, incomplete, records}\`，并检查是否缺少根 Trace 或某个父 Span。前端：

~~~ts
const bySpan = new Map(
  data.records
    .filter((item) => item.kind === 'span' && item.spanId)
    .map((item) => [item.spanId, item])
);
~~~

然后沿 \`parentSpanId\` 查找父级，计算层级和瀑布图位置。这种实现**不是先从后端获得一棵嵌套对象树**，前端也没有建立独立的 \`SpanNode.children[]\` 对象树；当前只为了渲染层级借助 Map 顺着父 ID 找父级。

源码：[custom-signals.service.ts](../platform/apps/api/src/analytics/custom-signals.service.ts)、[CustomSignalDetailPage.tsx](../platform/apps/web/src/pages/CustomSignalDetailPage.tsx)。

缺失节点、乱序到达都不应靠时间排序推测真实父子关系；显示不完整链路和局部根更诚实。若业务要支持跨服务 Trace，仍需引入标准 Trace ID、传播器及 HTTP Client/Server 插桩，不能只依赖同一个服务端接收平台。

## 7. 验证范围与改进顺序

### 【已有测试证明什么、尚未覆盖什么】

源码：[sdk/tests/transport/transport.spec.ts](../sdk/tests/transport/transport.spec.ts)、[sdk/tests/event/custom.spec.ts](../sdk/tests/event/custom.spec.ts)、[sdk/src/transport/flush/index.ts](../sdk/src/transport/flush/index.ts)。

当前 Transport 测试验证在 \`batchSize=2\` 时，两条 Envelope 可以形成一个发送批次，队列清空且 \`droppedCount=0\`。官网关联项目的 [monitor-stay.test.ts](https://github.com/cxDlogver/official-network/blob/main/tests/monitor-stay.test.ts) 验证一级路由收敛与计时器 pause/resume，但不能据此声称真实浏览器页面生命周期顺序或线上 DSN 已经端到端通过。

建议按风险排序补充针对性测试：

1. \`sendWithRetry\` 全部失败时，断言失败批次的去向与 \`droppedCount\` 是否符合约定；永久错误不得无限循环。
2. 页面 \`pagehide/hidden\` 与 SDK 生命周期的注册顺序、重复结束、Beacon 降级、并发中途退出。
3. 自定义 Trace/Span 的父对象取消语义与未来“父结束不取消子 Span”改造的兼容性。
4. 真实 UTF-8 大小、浏览器 Beacon 配额、Flush 并发回调、Sender 注入实现抛错等异常边界。
5. 用 Event-only 与 Trace+Span 两种业务插桩实现同一可见时长需求，验证统计口径一致；仅在需要执行轨迹和瀑布图时增加 Span。

### 【当前设计与通用体系的边界】

- **已实现**：显式 Trace/Span 对象链、自定义 Event、完成记录的扁平 ID 关联、会话/页面上下文、七阶段 Processing、有界队列、串行 Batch、有限重试、页面退出时的尽力冲刷、服务端按 Trace ID 查询及前端关联展示。
- **尚非通用 Tracer 模型**：当前 SDK 没有 \`Tracer.startActiveSpan()\` + 异步 ActiveContext 的隐式父级继承，没有 W3C 标准 Trace Context 的端到端注入/提取；跨进程需要另行实现。
- **待修正**：失败批次出队后丢失；队列级/发送级丢失指标未统一；如果把 Trace 作为超长生命周期的容器，当前终止时递归取消子 Span 的行为需由业务语义确认。
- **进一步设计**：业务页面停留只需要最终可见时长时，可以使用 Event-only；当目标包含操作嵌套、执行阶段归因或轨迹分析时才引入 Span，而不是要求所有埋点使用 Trace+Span。

把这几个边界分开，才能在面试中既解释设计思想，也经得起源码追问。
