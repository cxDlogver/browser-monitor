# 监控 SDK 业务插桩与 Trace/Span 执行链路源码分析

本文以当前 `browser-monitor` 主分支为依据，沿着“**浏览器事实产生 → SDK 创建 Event/Trace/Span → 上下文与关联 → 统一加工 → 内存组批和发送 → 查询还原**”这一数据主线，还原实际代码。业务目标、通用模型和 API 的解释先独立成立，再用项目源码证明行为；**已实现功能、设计限制、进一步改造建议不得混写**。

全文对应的通用知识主入口：[监控 SDK 插桩与 Trace/Span 工程体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/J-%E7%9B%91%E6%8E%A7SDK%E6%8F%92%E6%A1%A9%E4%B8%8ETraceSpan%E5%B7%A5%E7%A8%8B%E4%BD%93%E7%B3%BB.md)。性能指标采集与浏览器 API 另见[性能测量与真实用户监控专项](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/X-%E6%80%A7%E8%83%BD%E6%B5%8B%E9%87%8F%E4%B8%8E%E7%9C%9F%E5%AE%9E%E7%94%A8%E6%88%B7%E7%9B%91%E6%8E%A7%E4%B8%93%E9%A1%B9.md)。本分析引用的代码路径均以 `browser-monitor/` 为起点；官网业务层示例单独标注来源为 `official-network`，不能冒充本仓库 SDK 的内部行为。

## 1. 监控目标、数据入口与 SDK 总链路

### 【先从业务事实区分自动采集与手工插桩】

浏览器能主动提供 PerformanceEntry、错误、路由和页面生命周期事实，但它不知道“某个按钮在业务上代表申请合作”，也不会替业务自动定义有效停留时间。自动采集用于已知浏览器事实，代码插桩用于业务语义；两者最后必须收敛到同一个数据管线。

~~~text
浏览器自动采集 → Instrumentation → SignalHub → Collector
业务手工插桩 → monitor.track / startTrace / startSpan / withSpan
                       ↓
                   TelemetryDraft
                       ↓
MonitorPipeline.emit：生成 eventId，绑定 App/Session/View/关联 ID
                       ↓
ProcessingPipeline：格式→校验→脱敏→过滤→去重→采样→限流
                       ↓
Transport.enqueue：写入有界内存队列
                       ↓
Batch/Flush/Retry/Sender：分批发送
                       ↓
采集服务端 → 已完成的 Trace/Span/Event 记录
~~~

**Trace/Span 属于执行层的语义，Batch 属于传输层的打包单位。** 一个 Trace 的若干 Span 可以在不同时间结束，形成不同批次；不等整条 Trace 完成后才允许上报。

### 【最新 SDK 的组合根已经改为装配 Tracer】

源码：[core/monitor.ts](../sdk/src/core/monitor.ts)、[core/pipeline.ts](../sdk/src/core/pipeline.ts)。

~~~ts
const processing = createProcessingPipeline(this.options.processing);
const pipeline = new MonitorPipeline(this.context, processing, this.transport);
this.tracer = new Tracer(pipeline, this.context);
~~~

`BrowserMonitor` 负责装配业务 Context、Transport、Processing、MonitorPipeline、Tracer 和自动采集模块；公共 API 把 `startTrace()`、`startSpan()`、`withTrace()`、`withSpan()`、`track()` 转交给同一个 Tracer。Tracer 把已结束的 Span 和点事件交回 TelemetryEmitter，由现有管线继续处理。

重构前的 `CustomTelemetryManager` 同时管理 TraceHandle、SpanHandle 和 Event，运行时维护子集合；新版本已经拆成 `Tracer + RecordingSpan + TracingContext + CustomEventCollector`。后续章节只描述**新版本当前行为**，不把历史设计当作现状。

## 2. 最新 Tracer 与 Span：身份、父级、Context 和生命周期

### 【Trace 是具有工作流标记的根 Span，而不是第二套生命周期对象】

源码：[tracing/types.ts](../sdk/src/tracing/types.ts)、[tracing/tracer.ts](../sdk/src/tracing/tracer.ts)、[tracing/span.ts](../sdk/src/tracing/span.ts)、[protocol/constants.ts](../protocol/src/constants.ts)。

~~~ts
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface StartSpanOptions extends CustomSignalInput {
  parent?: SpanContext | null;
}

// 业务 Trace 与普通 Span 使用同一个句柄合同。
export type TraceHandle = SpanHandle;
~~~

现在 `startTrace(name)` 调用 Tracer 的同一创建出口，以 `parent:null` 强制建立新链路，并将 `workflow=true` 传给 `RecordingSpan`；它拥有自己的 traceId、spanId、可选 parentSpanId。终结时 `RecordingSpan.end()` 生成 `type:'span'` 的负载，对业务根额外写入保留标记 `monitor.workflow=true`。Worker 投影时将**无 parentSpanId 且带标记**的根 Span 归类为平台的 `trace`，同时保留它的 Span ID。这个设计让业务根也能成为子节点的明确父 Span。

相比旧版“独立 type=trace 且仅有 traceId”的对象，**新版 Trace 不再有独立的父子对象树；它是根 Span 的业务分类**。

### 【Tracer 负责创建 Span，父级选择具有三态规则】

实际工厂关键逻辑：

~~~ts
const { parent: explicit, ...data } = options ?? {};
const parent = explicit === null
  ? undefined
  : (explicit ?? this.scope.current());

return new RecordingSpan(
  this,
  this.running ? requiredName(name) : name,
  {
    traceId: parent?.traceId ?? createTraceId(),
    spanId: createSpanId(),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
  },
  this.running ? this.context.snapshotAt(Date.now()) : undefined,
  workflow,
  data,
);
~~~

- `parent: null`：明确与活动父级断开，开启新 Trace。
- 传入 `parent: SpanContext`：使用调用者指定的父身份，即使另有活动作用域也优先。
- 不传 `parent`：从当前同步活动上下文读取父级；如果没有则创建新的根 Span。

`createTraceId()` 生成 32 位十六进制 ID，`createSpanId()` 生成 16 位十六进制 ID，并校验显式父级必须使用非全零合法 ID。它们的尺寸兼容 W3C Trace Context 的 ID 要求，但这**不等于项目已经实现了 HTTP traceparent 注入和提取**：单纯 ID 格式兼容不构成跨进程 Tracing。

### 【RecordingSpan 只维护自己的状态，不拥有子 Span 集合】

源码：[tracing/span.ts](../sdk/src/tracing/span.ts)。

~~~ts
export class RecordingSpan implements SpanHandle {
  private readonly startedAt = Date.now();
  private readonly startedMonotonic = monotonicNow();
  private readonly identity: Readonly<SpanContext & CorrelationContext>;
  private ended: boolean;
  // ...
  startSpan(name: string, data?: CustomSignalInput): SpanHandle {
    return this.runtime.startSpan(name, { ...data, parent: this.identity });
  }
}
~~~

每个 Span 保存固定身份、开始时上下文快照、属性/业务指标、时钟和 `ended` 标志。**没有 children Set，没有父对象所有权，不需要 Trace 统计子节点数量**。父 Span `end()` 仅结束自身，不会自动取消业务子任务，也不会给尚未完成的子 Span 伪造 cancelled 状态。业务若要求所有步骤完成后才结束工作流，需要自行等待 Promise 或维护任务状态。

`RecordingSpan.end()` 合并数据、校验状态（ok/error/cancelled）、以 `performance.now()` 等单调时钟计算 durationMs、设置 ended 标志并生成独立完成记录；重复 end 不会再次提交。**end 产生记录，不等于网络已经发送成功**。

### 【活动父级仅在同步作用域生效，跨 await 需要显式关联】

源码：[tracing/context.ts](../sdk/src/tracing/context.ts)。

~~~ts
run<T>(parent: SpanContext, callback: () => T): T {
  const previous = this.active;
  this.active = Object.freeze({ traceId: parent.traceId, spanId: parent.spanId });
  try {
    return callback();
  } finally {
    this.active = previous;
  }
}
~~~

`TracingContext.run()` 进入回调时保存旧活动父级，在 `finally` 恢复；`bind()` 捕获某个父上下文，并在后续回调被调用时临时激活它。

**它不是 Node.js AsyncLocalStorage，也没有自动在浏览器的 await 后续代码中延续 active**。使用 `withTrace(async trace => ...)` 时，包装器会等待回调 Promise 完成才 `end()`，但内部 `run()` 的活动上下文只覆盖同步调用阶段；await 之后新建子 Span 应用 `parent:trace`、`trace.startSpan()`、`trace.span()` 或 `bind()` 显式携带父身份。

~~~ts
await monitor.withTrace('checkout.flow', async (trace) => {
  await loadCart();
  // await 之后不能假定存在隐式当前父级
  const child = monitor.startSpan('checkout.payment', { parent: trace });
  try {
    await submitPayment();
  } finally {
    child.end();
  }
});
~~~

并发执行不会共享一个长期存活的可变全局活动父级，避免误把其它并发操作当作父级。此设计解决的是**浏览器端受控同步上下文与显式传递**，不是端到端 HTTP Trace Context 的全部能力。

### 【瞬时 Event 可显式关联，也可以读取同步活动上下文】

~~~ts
track(name: string, data?: CustomSignalInput, correlation?: CorrelationContext): void {
  if (!this.running) return;
  this.events.track(name, data, correlation ?? this.scope.current() ?? {});
}
~~~

当回调处于 `span.run()`、`withSpan()` 的同步活动作用域中，`monitor.track()` 可以自动继承 traceId/spanId；否则它是一条不带 Trace 关联的普通 Event。句柄 `span.addEvent()` 会显式以该 Span 身份记录 Event，即使业务稍后返回到无活动作用域，也不依赖隐式上下文。

**这里 `addEvent` 仍产生独立 Event 信封**，不是把事件对象写入 `SpanRecord.events[]`；事件通常引用发生时所属的 Span ID，而不是自己创建额外的 Span。

## 3. 业务代码插桩：什么时候用 Event、什么时候需要 Span

关于业务接入点、页面计时与关键行为的完整生命周期，可继续阅读[业务代码插桩与页面可见时长统计源码分析](./业务代码插桩与页面可见时长统计源码分析.md)。本篇继续聚焦 SDK 内部记录形成、关联、加工、发送与查询；专项则以真实客户端插件与业务计时器为主，避免在此维护第二份同样的项目实现。



### 【从分析问题反向决定采集模型】

业务接入前先确定需要回答的问题，而不是为了使用 Trace/Span 把每个按钮包装为 Span。

| 需要回答的业务问题 | 最小必要表示 | 为什么 |
| --- | --- | --- |
| 某按钮被点击多少次 | Event | 只关心时间点和业务属性 |
| 某页面的最终有效可见时长 | Event + 业务计时器 | 单条完成记录即可携带 `visibleMs` |
| 一个操作从开始到结束经历多久、如何失败 | Span | 需要时间区间、状态及执行上下文 |
| 一次访问跨页面和操作的完整轨迹 | Trace + 页面 Span + Event | 要表达阶段间的关联和时间轴 |

业务可见时长通常不等于 `Span.end() - Span.start()`。例如用户浏览 20 秒、标签页后台 30 秒、返回 10 秒，墙钟 60 秒，但业务可见时长 30 秒。**额外的可暂停计时器不可省略；Span 只是可选的时间区间容器。**

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

此处 `createVisibleTimer` 是业务侧假想抽象，需要单独实现；事件里必须携带**原始页面身份**，否则在切换路由后才触发的 `monitor.track()` 可能按当前 View 归属到新页面。该示例只演示 Event 的业务设计，不包含严格的页面退出可靠性保证。

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

这里的 `30000` 仅为说明 API 形状的示例值，不是 SDK 自动计算的业务时长。官网级可见时长还需要独立访问计时器，不能直接累加整站 Trace duration 与所有子 Span duration。

### 【实际官网插件接入属于业务层，不等于 SDK 自动功能】

在关联项目 `official-network` 中，已实现 Nuxt Client Plugin 组合 `createMonitor → createStayTracker → monitor.start → stayTracker.begin`。链接：[插件](https://github.com/cxDlogver/official-network/blob/main/app/plugins/monitor.client.ts)、[业务停留编排](https://github.com/cxDlogver/official-network/blob/main/app/utils/monitor/stay-tracking.ts)、[可见时长计时器](https://github.com/cxDlogver/official-network/blob/main/app/utils/monitor/visible-stopwatch.ts)。

该业务计时器在 `visibilitychange: hidden` 时 `pause()`，可见时 `resume()`；路由变化时结算上一段 `site.route.stay`；`pagehide` 时先结束停留 Span 和访问 Trace，再由 SDK 尝试冲刷；`pageshow.persisted` 重新开启一段。这是**业务层驱动 SDK API** 的例子，不是 SDK 自动推断页面停留时间。当前官网真实可核实的是这套停留时长链路；首页按钮和联系页的逐项 `track()` 埋点属于可扩展设计方向，不能写为已经上线完成。

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

这里同时解决两件事：用 `occurredAt` 而不是“上报时刻”确定数据应归属的 View；给独立 Event、Trace、Span 统一构造协议记录。生成的 `eventId` 是记录级去重身份，与追踪模型的 `spanId` 用途不同。

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

先统一格式和结构，再消除敏感信息/无关页面，然后才消耗去重、采样与限流资源；任一阶段返回 `undefined` 时，记录就不会进入 Transport。需要关注两个真实特例：

1. `DedupeStage` 对自定义 `event/trace/span` 直接放行；同名同属性的两次点击不应被当作同一事实去重。其他信号按 Session/View/类型/名称/关联/Payload 指纹及时间窗口去重。
2. `SamplingStage` 对有 Trace ID 的记录以 `sessionId + traceId` 构成稳定键，让同条 Trace 内的记录倾向于一起采样或一起排除。但限流、队列容量和发送失败仍可能破坏一条 Trace 的实际完整性，不能把“稳定采样”说成“完整 Trace 保证”。

## 5. Transport 的队列、批次、时机与发送保证

### 【MemoryQueue 是有容量限制的缓冲，不是持久可靠队列】

源码：[sdk/src/transport/queue/index.ts](../sdk/src/transport/queue/index.ts)、[sdk/src/core/config.ts](../sdk/src/core/config.ts)。

当前默认值：`maxQueueSize=200`、`batchSize=20`、`maxBatchBytes=64000`、`flushIntervalMs=10000`、`maxAttempts=3`、`baseDelayMs=500`。这些配置分别代表队列容量、达到阈值就尝试冲刷、每批尺寸预算、定时冲刷和有限重试，彼此独立。

~~~ts
function priorityOf(envelope: TelemetryEnvelope): number {
  if (envelope.type === 'view') return 2;
  if (envelope.type === 'event') return 2;
  return 1;
}
~~~

队列满时先淘汰最低优先级的旧记录，且新记录优先级不能低于已有最低优先级；这使 `trace/span` 与 Performance 一样默认处于优先级 1。入队操作本身同步且不等待网络；队列并非持久化缓存，不保证页面异常关闭或网络长期故障后保留所有记录。

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

触发条件是：达到 `batchSize`、周期定时、页面 `hidden/pagehide`、`stop()` 和 `destroy()`。只有一个共享的 `flushing` Promise，保证不会同时有两个 drain 消费同一队列。

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

该循环**一批发送结束后才处理下一批**。假设队列有 45 条，且每条很小，会依次产生 20/20/5 三批。当前 `takeBatch` 先按条数 `splice` 出队，再使用 `JSON.stringify(envelope).length` 累计长度，超出预算的后续候选 `prepend` 到队首；第一条不受长度上限阻止，以避免队首死锁。由于字符串长度不是 UTF-8 字节数，且没有计入最终包装对象，`maxBatchBytes` 不是严格的网络载荷字节上限。

### 【失败批次的实际行为与源代码注释不一致】

这是源码验证所得的**明确现存问题**，不能根据注释说“失败后保留本批等待下次 Flush”：

~~~ts
// queue.take 已用 splice 从原队列移除当前批次
const batch = takeBatch(this.queue, this.options.batchSize, this.options.maxBatchBytes);

const sent = await sendWithRetry(this.sender, batch, preferBeacon, this.options.retry);
if (!sent) return; // 没有 queue.prepend(batch)，所以本批丢失
~~~

`sendWithRetry()` 最多尝试三次，遇网络问题、408、429 或 5xx 时按指数退避和抖动重试；永久性失败直接停止。在尝试耗尽后，**当前失败批次没有重新入队**，仅此前因“字节预算溢出”被 `prepend` 的候选、以及未取出的队列尾部仍保留。 `getDroppedCount()` 主要统计队列满的淘汰，不能把它当作全部上报失败数。

建议用显式 `inFlightBatch`、受控回队或可重试状态机维护“已出队但尚未确认”的批次；还应区分永久错误与临时错误，否则把永久 4xx 反复塞回队列会造成无限重发与阻塞。在引入修复前，文档不得承诺失败数据不丢。

### 【Beacon 只负责尽力发送，不能证明服务端已经收到】

源码：[sdk/src/transport/sender/index.ts](../sdk/src/transport/sender/index.ts)。

~~~ts
if (navigator.sendBeacon(this.options.dsn, body)) {
  return { success: true, retryable: false };
}
~~~

`sendBeacon()` 返回 true 表示浏览器已经接受并排队请求，**不是服务端持久化成功的确认**。当前页面隐藏时 `flush(true)` 仅使该次 drain 的第一批优先使用 Beacon，后续批次转向 fetch；如果正在运行另一轮普通 drain，新来的 `flush(true)` 复用已有 Promise，无法自动将其升级成 Beacon。窗口关闭等情况下的最终上报仍是 best-effort。

## 6. 后端如何用 Span ID 和工作流标记还原链路

### 【Worker 将根 Span 识别为平台的 Trace 类别】

当前线上遥测的业务根仍发送 `payload.type='span'` 并保留根 Span ID；Worker 通过 `monitor.workflow` 标记和无父级条件转换为报表的 Trace 类别：

~~~ts
const kind =
  payload.type === 'span' &&
  payload.attributes?.[WORKFLOW_ATTRIBUTE] === true &&
  !event.correlation.parentSpanId
    ? 'trace'
    : payload.type;
~~~

源码：[platform/apps/worker/src/processor.ts](../platform/apps/worker/src/processor.ts)、[protocol/src/constants.ts](../protocol/src/constants.ts)。

这条规则是协议层“一个根 Span 兼作业务 Trace”向分析层转换的关键。不能再使用旧版“Trace 记录没有 spanId”的口径解释当前新根记录。

### 【后端按 Trace ID 查询扁平记录，前端按父级 ID 还原展示】

源码：[custom-signals.service.ts](../platform/apps/api/src/analytics/custom-signals.service.ts)、[CustomSignalDetailPage.tsx](../platform/apps/web/src/pages/CustomSignalDetailPage.tsx)。

~~~ts
const spanIds = new Set(
  records.filter(row => row.kind !== 'event' && row.spanId).map(row => row.spanId)
);
const hasRoot = records.some(
  row => row.kind === 'trace' || (row.kind === 'span' && !row.parentSpanId)
);
~~~

后端还检查事件的 `spanId` 所指向的父操作是否存在、请求结果是否超出 1000 条、以及有无缺失父节点，将 `incomplete` 提示给前端。

~~~ts
const bySpan = new Map(
  data.records
    .filter(item => item.kind !== 'event' && item.spanId)
    .map(item => [item.spanId, item])
);
~~~

瀑布图中，事件如果有 `spanId` 会先找到所属 Span 再计算显示层级；Span 则沿 `parentSpanId` 查找父级并计算深度。数据库存的是按关联 ID 可以拼接的独立记录，服务端不要求父 Span 先到；前端也无需拥有真实运行时 Span 对象。

## 7. 测试证据、现有边界与改进顺序

### 【新 Trace 重构已有的测试范围】

源码：[sdk/tests/event/custom.spec.ts](../sdk/tests/event/custom.spec.ts)、[sdk/tests/transport/transport.spec.ts](../sdk/tests/transport/transport.spec.ts)。

现有测试覆盖业务根 Span 保留 traceId/spanId、父级结束不取消子 Span、显式 parent / parent:null / 同步隐式 parent 的优先级、`run/bind`、withTrace/withSpan 同步和 Promise 收尾、已结束句柄幂等、跨 await 后显式继承、Event 在活动作用域中的归属，以及同一 Trace 的稳定采样选择。它们证明**当前 SDK 采用独立 Span 和受控同步 Context**，而不是旧的 children Set。

Transport 测试验证两条 Envelope 达到阈值时可以合成一个 Batch 并清空队列，但没有证明网络失败后不丢批次，也没有证明页面关闭能够可靠发送所有积压数据。

### 【对当前代码应如何划定事实与设计边界】

- **已实现**：Tracer/RecordingSpan/TracingContext 模型；业务根以带 `monitor.workflow` 标记的 Span 表达；Span 只管理自身，父结束不递归取消子；显式/同步隐式上下文；统一 Envelope/Processing/Transport；后端按 Trace ID 查询，前端关联展示。
- **未实现的通用自动能力**：跨 await 自动保留活动父级（当前需要显式 parent 或 bind）；W3C `traceparent` 的完整 HTTP 注入、提取与跨服务 Trace（合法十六进制 ID 还不够）。
- **待完善的可靠性**：Transport 的失败批次在 `takeBatch` 后没有重新入队；Beacon 排队状态不能证明服务端已接收；队列容量淘汰可能使 Trace 不完整，且丢弃指标尚需区分失败类型。
- **业务建模选择**：最终可见时长可以只由 Event 携带；Span 更适合有阶段、时间区间与因果结构的过程；不要让 Trace API 的存在决定业务统计的观测口径。

### 【建议验收顺序】

第一，修复或明确“已出队但发送失败”的批次状态，用专门的失败/重试单测验证，不只依赖代码注释。第二，验证业务 `pagehide` 结算、最终 Flash/Beacon、BFCache 恢复、重复监听和异常停止行为。第三，如要完善跨服务追踪，增加标准传播器及 Client/Server 插桩测试；如要支持跨 await 隐式父级，再选择可靠的浏览器异步上下文机制，而不是简单维护全局 active。

