# 03 · Collector 与信封组装

> 本文承接 [02 · 数据采集链路梳理](./02-数据采集链路梳理.md)。
> 上一篇文章讲到 Instrumentation 把浏览器事实发布成 Raw Signal；本文讲**谁在听、听完之后做了什么**，以及所有 Collector 如何经由**同一个 `MonitorPipeline.emit()`** 把领域数据补齐成完整信封。
> 按约定，`processing`（七阶段加工）与 `transport`（队列与发送）在本文中只点出交界，不展开。

---

## 一、Collector 在链路中的位置

```text
① 采集              ② 解释与提交              ③ 补齐信封          ④ 加工与上报
Instrumentation  →     Collector        →   MonitorPipeline  →  Processing → Transport
Raw Signal            领域数据（TelemetryDraft）  TelemetryEnvelope   （本文不展开）
```

Collector 要回答的是「**这条事实对监控意味着什么**」，它关心的是语义，而不是某个 API 怎么被监听：

| 对比项             | Instrumentation | Collector                                                 |
| ------------------ | --------------- | --------------------------------------------------------- |
| 输入               | 浏览器 API      | Raw Signal                                                |
| 输出               | Raw Signal      | `TelemetryDraft`（领域数据草稿）                          |
| 是否触碰浏览器 API | 是              | **否**（唯一例外是 View Collector 通过 Context 间接读写） |
| 是否做业务判断     | 否              | 是（阈值、额度、单位换算、开关）                          |
| 是否知道发送给谁   | 否              | 否（只拿到 `emit` 一个方法）                              |

一句话分工：**Instrumentation 给出「浏览器说了什么」，Collector 决定「这条算不算问题、该记成什么」。**

---

## 二、注册与订阅：与 Instrumentation 同一套契约

Collector 和 Instrumentation 在生命周期上完全同构 —— 同样实现 `MonitorModule`，同样在 `install()` 里订阅、在 `start/stop` 里切换 `active`、在 `destroy()` 里退订。

```ts
// src/collectors/performance/loaf.ts（第 10–74 行，节选）
export class LoAFCollector implements MonitorModule {
  readonly name = 'loaf-collector';
  private readonly unsubscribers: Array<() => void> = [];
  private active = false;
  private emittedEntries = 0;

  constructor(
    private readonly signals: SignalSubscriber, // 只订阅，不能发
    private readonly emitter: TelemetryEmitter, // 只提交，不能发信号也不能直接发送
    private readonly options: LoAFCollectorOptions,
  ) {}

  install(): void {
    if (this.unsubscribers.length > 0) return; // install 幂等
    this.unsubscribers.push(
      this.signals.subscribe('view.route-change', () => {
        this.emittedEntries = 0; // 额度按 View 重置
      }),
      this.signals.subscribe('performance.loaf', (signal) => {
        /* 见第三节 */
      }),
    );
  }

  start(): void {
    this.active = true;
  }
  stop(): void {
    this.active = false;
  }

  destroy(): void {
    this.stop();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe(); // 逐个退订
  }
}
```

这里能看到一个关键约束：**Collector 的构造函数里注入的是 `SignalSubscriber` 与 `TelemetryEmitter` 两个窄接口**。也就是说它：

- 只能订阅信号，不能发布信号（无法反向驱动数据源）；
- 只能提交草稿，既接触不到 `Transport`，也无感知 `Processing` 的存在。

### 注册顺序的另半边理由

```ts
// src/core/monitor.ts（第 136–145 行）
this.registry.register(this.transport); // 1  出口
this.registry.register(viewCollector); // 2  消费者
this.registry.register(webVitalsCollector); // 3
this.registry.register(loafCollector); // 4
this.registry.register(fpsCollector); // 5
this.registry.register(pageLifecycle); // 6  数据源
this.registry.register(history); // 7
this.registry.register(webVitals); // 8
this.registry.register(performanceObserver); // 9
this.registry.register(animationFrame); // 10
```

Collector 之所以排在 Instrumentation 之前，正是因为**它们的 `install()` 要先完成订阅**。等到第 9、10 位的 Instrumentation 启动并发布第一条信号时，第 2–5 位的消费者早已在 Hub 的桶里等着了。

---

## 三、四种处理模式：从 Signal 到 Draft

所有 Collector 的落点都是同一个动作 —— `this.emitter.emit({ name, timestamp, payload, ... })`。区别只在于回调里做了什么。

| 模式       | 代表           | 回调里做的事                             |
| ---------- | -------------- | ---------------------------------------- |
| **直译**   | `web-vitals`   | Signal 字段 → Payload 字段，补单位与分级 |
| **过滤**   | `loaf`         | 阈值 + 每 View 额度，超限直接丢弃        |
| **计算**   | `fps`          | 用帧数与窗口时长算出 FPS                 |
| **状态机** | `view`         | 结束旧 View、开启新 View，并回写 Context |
| **直投**   | `event/custom` | 不经信号，由 `monitor.track()` 直接提交  |

### 3.1 直译：WebVitalsCollector

```ts
// src/collectors/performance/web-vitals.ts（第 45–56 行）
install(): void {
  if (this.unsubscribe) return;
  this.unsubscribe = this.signals.subscribe('performance.web-vital', (signal) => {
    // Instrumentation 负责能力采集，Collector 再根据业务配置决定是否形成监控事件。
    if (!this.active || !this.enabled[signal.name]) return;
    this.emitter.emit({
      name: signal.name,
      timestamp: signal.timestamp,
      payload: toPayload(signal, nextSequence(signal.metricId), 'provisional'),
    });
  });
}
```

`toPayload()` 把第三方库的指标对象翻译成协议内的 Payload，顺带补上单位与分级：

```ts
// src/collectors/performance/web-vitals.ts（第 10–32 行）
function toPayload(
  signal: WebVitalSignal,
  sequence: number,
  state: 'provisional' | 'final',
): WebVitalPerformancePayload {
  const common = {
    type: 'performance' as const,
    sampleId: signal.metricId,
    sequence,
    state,
    value: signal.value,
    delta: signal.delta,
    clientRating: signal.rating,
    source: 'web-vitals' as const,
    navigationType: signal.navigationType,
    navigationId: signal.navigationId,
  };

  switch (signal.name) {
    case 'LCP':
      return { ...common, name: 'LCP', unit: 'ms', kind: 'core-web-vital' };
    case 'FCP':
      return { ...common, name: 'FCP', unit: 'ms', kind: 'diagnostic' };
    case 'INP':
      return { ...common, name: 'INP', unit: 'ms', kind: 'core-web-vital' };
    case 'CLS':
      return { ...common, name: 'CLS', unit: 'score', kind: 'core-web-vital' };
  }
}
```

注意注释里那句「**不把 web-vitals 库对象泄漏进领域协议**」：Signal 是内部边界，Payload 才是对外契约，`kind` / `unit` 这类监控语义正是在这一层补上的。

### 3.2 过滤：LoAFCollector

```ts
// src/collectors/performance/loaf.ts（第 29–59 行）
this.signals.subscribe('performance.loaf', (signal) => {
  if (
    !this.active ||
    signal.duration < this.options.minDurationMs || // 阈值：太短不算长任务
    this.emittedEntries >= this.options.maxEntriesPerView // 额度：每个 View 有上限
  ) {
    return;
  }

  // 阈值和每 View 上限属于监控语义，应留在 Collector 而不是浏览器采集层。
  this.emittedEntries += 1;
  this.emitter.emit({
    name: 'LoAF',
    timestamp: signal.timestamp,
    payload: {
      type: 'performance',
      name: 'LoAF',
      sampleId: createId('sample'),
      sequence: 0,
      state: 'final',
      value: signal.duration,
      unit: 'ms',
      kind: 'diagnostic',
      source: 'performance-observer',
      detail: {
        startTime: signal.startTime,
        blockingDuration: signal.blockingDuration,
        renderStart: signal.renderStart,
        styleAndLayoutStart: signal.styleAndLayoutStart,
        scriptCount: signal.scriptCount,
      },
    },
  });
});
```

配合另一个订阅，额度按 View 隔离：

```ts
// src/collectors/performance/loaf.ts（第 26–28 行）
this.signals.subscribe('view.route-change', () => {
  this.emittedEntries = 0; // 避免一个页面的长任务耗尽后续页面的额度
});
```

**同一条 Signal 被两个 Collector 订阅、且各自关心的维度不同** —— 这正是 Signal Hub 存在的价值：`view.route-change` 既驱动 View 的开合，也重置 LoAF 的上报额度，二者互不知情。

### 3.3 计算：FPSCollector

```ts
// src/collectors/performance/fps.ts（第 15–38 行）
install(): void {
  if (this.unsubscribe) return;
  this.unsubscribe = this.signals.subscribe('performance.frame-window', (signal) => {
    if (!this.active || signal.sampleDurationMs <= 0 || signal.frameCount <= 0) return;

    // frameCount 表示完整帧间隔数，按实际窗口时长换算，避免假设固定采样周期。
    this.emitter.emit({
      name: 'FPS',
      timestamp: signal.timestamp,
      payload: {
        type: 'performance',
        name: 'FPS',
        sampleId: createId('sample'),
        sequence: 0,
        state: 'final',
        value: (signal.frameCount * 1_000) / signal.sampleDurationMs,   // 除法在这里才算
        unit: 'fps',
        kind: 'runtime',
        source: 'request-animation-frame',
        detail: { frameCount: signal.frameCount, sampleDurationMs: signal.sampleDurationMs },
      },
    });
  });
}
```

Instrumentation 只交出「帧数 + 窗口时长」两个原始量，FPS 的换算与单位由 Collector 决定。

### 3.4 状态机：ViewCollector

View Collector 是唯一**会反向影响上下文**的 Collector —— 它不仅上报数据，还负责维护 View 时间线：

```ts
// src/collectors/view/index.ts（第 18–37 行）
install(): void {
  if (this.unsubscribers.length > 0) return;
  this.unsubscribers.push(
    this.signals.subscribe('view.route-change', (signal) => {
      if (!this.active) return;
      this.changeView(signal.url, signal.timestamp, signal.source);
    }),
    this.signals.subscribe('page.lifecycle', (signal) => {
      if (!this.active) return;
      // 进入 BFCache 的页面并未真正销毁；普通 pagehide 才结束当前 View。
      if (signal.type === 'pagehide' && !signal.persisted) {
        const ended = this.context.endView(signal.timestamp);
        if (ended) this.emitEnd(ended);
      }
      if (signal.type === 'pageshow' && signal.persisted) {
        this.changeView(currentUrl(), signal.timestamp, 'bfcache');
      }
    }),
  );
}
```

```ts
// src/collectors/view/index.ts（第 52–73 行）
private changeView(url, timestamp, source): void {
  // 先结束旧 View，再开始并上报新 View，保证时间线连续且事件顺序稳定。
  const changed = this.context.startView(url, timestamp, source);
  if (changed.previous) this.emitEnd(changed.previous);
  this.emitter.emit({
    name: 'view.start',
    timestamp,
    context: this.context.snapshotForView(changed.current),   // ← 显式带上刚生成的 View 快照
    payload: { type: 'view', name: 'view.start', /* ... */ },
  });
}
```

注意这里的 `context` 字段：**它是 `TelemetryDraft` 的可选字段，只有 View Collector 会用**。因为它刚刚创建了新 View，最清楚这条数据属于哪个 View，直接指定比让 Pipeline 按时间去解析更准确（详见 4.3）。

### 3.5 直投：CustomEventCollector

业务主动埋点不经过 Signal，直接提交：

```ts
// src/collectors/event/custom/index.ts
export class CustomEventCollector {
  constructor(private readonly emitter: TelemetryEmitter) {}

  track(name: string, properties?: Readonly<Record<string, unknown>>): void {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Event name is required.');

    this.emitter.emit({
      name: normalizedName,
      timestamp: Date.now(),
      payload: {
        type: 'event',
        name: normalizedName,
        source: 'custom',
        ...(properties ? { properties } : {}),
      },
    });
  }
}
```

它由 `monitor.track()` 直接调用（而非通过信号），但**落点仍然是同一个 `emitter.emit()`** —— 业务埋点不会绕过任何公共链路。

---

## 四、统一出口：MonitorPipeline.emit()

### 4.1 提交用的草稿：TelemetryDraft

```ts
// src/core/pipeline.ts（第 29–54 行）
export interface TelemetryDraft<T extends TelemetryPayload = TelemetryPayload> {
  name: string;
  timestamp: number; // 事实发生时间，不是提交时间
  payload: T;
  correlation?: CorrelationContext;
  context?: TelemetryContext; // 仅在调用方明确知道归属时使用
}

export interface TelemetryEmitter {
  emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void;
}
```

`TelemetryEmitter` 只有 `emit` 一个方法 —— **Collector 拿到的就是这么窄的接口**，因此它既无法直接发送，也感知不到后面的加工与队列。

### 4.2 补齐信封

```ts
// src/core/pipeline.ts（第 56–91 行）
export class MonitorPipeline implements TelemetryEmitter {
  constructor(
    private readonly context: ContextManager,
    private readonly processing: ProcessingPipeline,
    private readonly transport: Transport,
  ) {}

  emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void {
    // Context 必须按数据实际发生时间解析。延迟回调到达时，当前 View 可能已经变化。
    const envelope: TelemetryEnvelope<T> = {
      protocolVersion: '2.0', // ① 协议版本
      eventId: createId('event'), // ② 事件唯一 ID
      type: draft.payload.type, // ③ 取自 payload，永不与内容脱节
      name: draft.name,
      occurredAt: draft.timestamp,
      app: this.context.app.snapshot(), // ④ 应用身份
      context: draft.context ?? this.context.snapshotAt(draft.timestamp), // ⑤ 运行现场
      correlation: draft.correlation ?? {}, // ⑥ 关联标识
      payload: draft.payload, // ⑦ 领域负载原样保留
    };

    // 所有数据先经过统一处理，再进入发送队列；undefined 表示被某个阶段丢弃。
    const processed = this.processing.process(envelope); // ⑧ 交给 Processing（本文不展开）
    if (processed) this.transport.enqueue(processed); // ⑨ 交给 Transport（本文不展开）
  }
}
```

逐个字段说明：

| 字段              | 来源                                     | 为什么这么设计                                             |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `protocolVersion` | 常量 `'2.0'`                             | 接收端据此决定能否解析；服务端只接受当前明确版本           |
| `eventId`         | `createId('event')`                      | 服务端幂等去重、问题定位                                   |
| `type`            | `draft.payload.type`                     | 分类与负载内容始终一致，不会出现「标着 view 却是性能数据」 |
| `name`            | draft                                    | 事件名                                                     |
| `occurredAt`      | draft                                    | **发生时间**，决定了数据归属哪个 View                      |
| `app`             | `context.app.snapshot()`                 | 应用身份与会话无关，直接取快照                             |
| `context`         | `draft.context ?? snapshotAt(timestamp)` | 运行现场，见 4.3                                           |
| `correlation`     | draft 或 `{}`                            | 关联标识，缺省为空对象                                     |
| `payload`         | draft                                    | 领域差异全部保留在 payload，公共元数据固定在外层           |

信封的最终形态：

```ts
// protocol/src/schemas.ts（共享协议包）
export interface TelemetryEnvelope<T extends TelemetryPayload = TelemetryPayload> {
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

**这就是「全局的 MonitorPipeline 统一包装」的那一步**：无论数据来自 LoAF、Web Vitals、FPS、View 还是业务埋点，走到这里都被补成同一种结构。下游只需要认识一种数据。

### 4.3 Context 如何被解析（关键）

第 ⑤ 步有两种取值路径：

| 路径                            | 触发条件           | 适用                                                           |
| ------------------------------- | ------------------ | -------------------------------------------------------------- |
| `draft.context`                 | Collector 显式给了 | 只有 View Collector 用：它刚创建/结束了某个 View，归属是确定的 |
| `context.snapshotAt(timestamp)` | 缺省               | 其余所有 Collector：按**发生时间**反查归属                     |

```ts
// src/context/snapshot.ts（第 74–96 行）
snapshotAt(timestamp: number): TelemetryContext {
  let view = this.view.resolveAt(timestamp);
  // History Instrumentation 尚未产生初始信号时，保证首条数据仍有合法 View。
  if (!view) view = this.startView(currentUrl(), timestamp, 'initial').current;
  return this.snapshotForView(view);
}

snapshotForView(view: ViewRecord): TelemetryContext {
  const user = this.user.snapshot();
  return Object.freeze({                       // 冻结：下游无法改写
    sessionId: this.session.snapshot().sessionId,
    viewId: view.viewId,
    url: view.url,
    runtime: this.runtime.snapshot(),
    ...(user ? { user } : {}),                 // 未登录时不产生空对象
  });
}
```

**为什么必须按时间反查，而不是取「当前 View」？**
因为很多指标是延迟到达的：INP 往往在交互后若干秒才结算，LoAF 条目也可能在批处理时抵达。若取当前 View，一条属于页面 A 的数据会被错误地记到页面 B 头上。按 `timestamp` 反查，才能把数据钉回它发生时所在的页面。

```ts
// src/context/view-context.ts（第 66–77 行）
resolveAt(timestamp: number): ViewRecord | undefined {
  for (let index = this.history.length - 1; index >= 0; index -= 1) {   // 从最新往回找
    const view = this.history[index];
    if (!view) continue;
    const endsAfterTimestamp = view.endedAt === undefined || timestamp <= view.endedAt;
    if (timestamp >= view.startedAt && endsAfterTimestamp) return view;
  }
  return this.current();   // 超出保留窗口时降级到当前 View，保证 Envelope 仍完整
}
```

---

## 五、ContextManager：信封里那半壁江山的来源

`app / session / view / runtime / user` 五个维度各有各的职责与生命周期：

| Context           | 提供什么                         | 何时确定          | 特点                                 |
| ----------------- | -------------------------------- | ----------------- | ------------------------------------ |
| `app-context`     | 应用名、版本、环境               | 构造期            | 冻结一次，与会话无关                 |
| `session-context` | `sessionId`、`startedAt`         | 实例创建时        | 一生不变                             |
| `view-context`    | `viewId`、脱敏后的 `url`、时间线 | 路由/可见性变化时 | 保存最近 20 条，支持按时间反查       |
| `runtime-context` | UA、语言、平台、网络、SDK 版本   | 每次取快照        | 读 `navigator`，缺失字段直接省略     |
| `user-context`    | `id`、`properties`               | `setUser()` 后    | 冻结存储，未设置则快照为 `undefined` |

几个实现要点：

```ts
// src/context/session-context.ts —— 会话 ID 一次性生成，之后只读
private readonly value: SessionSnapshot = Object.freeze({
  sessionId: createId('session'),
  startedAt: now(),
});
```

```ts
// src/context/runtime-context.ts —— 环境信息按字段存在与否逐个展开，不留 null
return Object.freeze({
  ...(navigatorValue?.userAgent ? { userAgent: navigatorValue.userAgent } : {}),
  ...(navigatorValue?.language ? { language: navigatorValue.language } : {}),
  ...(navigatorValue?.platform ? { platform: navigatorValue.platform } : {}),
  ...(typeof navigatorValue?.onLine === 'boolean' ? { online: navigatorValue.onLine } : {}),
  sdk: Object.freeze({ name: SDK_NAME, version: SDK_VERSION }),
});
```

```ts
// src/context/view-context.ts —— URL 在进入 Context 时就脱敏，且历史有上限
const current: ViewRecord = Object.freeze({
  viewId: createId('view'),
  url: sanitizeUrl(url), // query 与 fragment 不扩散
  startedAt: timestamp,
  source,
});
this.history.push(current);
this.trim(); // 超过 maxHistorySize 丢弃最旧的
```

最终组装出的 `TelemetryContext`：

```ts
// protocol/src/schemas.ts（共享协议包）
export interface TelemetryContext {
  sessionId: string;
  viewId: string;
  url: string;
  runtime: RuntimeContextData;
  user?: UserContextData;
}
```

**注意 `user` 是可选的**：没调用 `setUser()` 就不产生这个字段，避免上报体里出现空对象噪声。

---

## 六、五类上下文数据详解

`ContextManager` 把五个维度的上下文攒在一起：

```ts
// src/context/snapshot.ts（第 30–41 行）
export class ContextManager {
  readonly app: AppContext; // ① 应用身份
  readonly user = new UserContext(); // ② 当前用户
  readonly session = new SessionContext(); // ③ 本次会话
  readonly runtime = new RuntimeContext(); // ④ 运行环境
  readonly view: ViewContext; // ⑤ 页面视图（需构造参数，在构造函数里创建）

  constructor(options: ContextManagerOptions) {
    this.app = new AppContext(options.app);
    this.view = new ViewContext(options.resolveRouteName);
  }
}
```

它们最终在信封里的落位：

```text
TelemetryEnvelope
├── app        ← ① 应用身份（顶层字段）
├── context    ← TelemetryContext
│     ├── sessionId  ← ③
│     ├── viewId     ← ⑤
│     ├── url        ← ⑤（已脱敏）
│     ├── runtime    ← ④
│     └── user?      ← ②（未设置则无此字段）
└── payload
```

---

### 6.1 App Context：这条数据来自哪个应用

**① 含义**：应用身份三元组，回答「这是哪个应用、哪个版本、哪个环境产生的数据」。它是所有数据的公共标注，用于服务端按版本/环境做对比与灰度分析。

**② 结构**：

```ts
// protocol/src/schemas.ts（共享协议包）
export interface AppContextData {
  name: string;
  version: string;
  environment: string; // 如 prod / staging / dev
}
```

**③ 生成时机**：`createMonitor()` → `normalizeOptions()` → `new AppContext()`，**构造期一次性确定**，之后永不变化。

**④ 如何被生成**：

```ts
// src/core/config.ts（normalizeOptions 内）
app: Object.freeze({
  name: requiredText(options.app.name, 'app.name'),           // 空字符串直接抛错
  version: requiredText(options.app.version, 'app.version'),
  environment: requiredText(options.app.environment, 'app.environment'),
}),
```

```ts
// src/context/app-context.ts
export class AppContext {
  private readonly value: AppContextData;
  constructor(value: AppContextData) {
    this.value = Object.freeze({ ...value }); // 浅拷贝后冻结
  }
  snapshot(): AppContextData {
    return this.value;
  }
}
```

**⑤ 如何被获取**：`MonitorPipeline.emit()` 里 `app: this.context.app.snapshot()` —— 直接返回那一份冻结对象，不重新计算。

**特点**：实例级常量；不随 session、view、用户变化；`setUser`、路由跳转、`stop/start` 都与它无关。

---

### 6.2 Session Context：这一次访问的统一标识

**① 含义**：一次连续访问的会话标识，回答「哪些数据属于同一次访问」。它把分散在多个页面、多种类型的数据串成一条可回溯的访问线。

**② 结构**：

```ts
// src/context/session-context.ts
export interface SessionSnapshot {
  sessionId: string;
  startedAt: number;
}
```

**③ 生成时机**：`new SessionContext()` 时（即 Monitor 构造期），用**字段初始化器**在实例化那一刻生成。

**④ 如何被生成**：

```ts
// src/context/session-context.ts
export class SessionContext {
  private readonly value: SessionSnapshot = Object.freeze({
    sessionId: createId('session'),
    startedAt: now(),
  });

  snapshot(): SessionSnapshot {
    return this.value;
  }
}
```

**⑤ 如何被获取**：`snapshotForView()` 里 `sessionId: this.session.snapshot().sessionId`。

**特点**：`stop()` / `start()` **不会重置**会话（只有重建 Monitor 才会产生新 sessionId）；`destroy()` 也不清空 —— 会话是实例级概念。

---

### 6.3 Runtime Context：在什么条件下发生的

**① 含义**：运行环境快照，回答「用户的浏览器、语言、平台、网络状况如何，以及这条数据由哪个版本的 SDK 产生」。用于按环境维度分析问题影响范围。

**② 结构**：

```ts
// protocol/src/schemas.ts（共享协议包）
export interface RuntimeContextData {
  userAgent?: string;
  language?: string;
  platform?: string;
  online?: boolean;
  sdk: { name: string; version: string };
}
```

**③ 生成时机**：**每次取快照时实时读取，不缓存**。这样网络状态变化（断网/恢复）能被后续数据真实反映。

**④ 如何被生成**：

```ts
// src/context/runtime-context.ts
snapshot(): RuntimeContextData {
  const navigatorValue = typeof navigator === 'undefined' ? undefined : navigator;

  return Object.freeze({
    ...(navigatorValue?.userAgent ? { userAgent: navigatorValue.userAgent } : {}),
    ...(navigatorValue?.language ? { language: navigatorValue.language } : {}),
    ...(navigatorValue?.platform ? { platform: navigatorValue.platform } : {}),
    ...(typeof navigatorValue?.onLine === 'boolean' ? { online: navigatorValue.onLine } : {}),
    sdk: Object.freeze({ name: SDK_NAME, version: SDK_VERSION }),
  });
}
```

三个细节：

- **字段缺失就整个省略**，不写 `null` / `undefined`，避免上报体里出现一堆空字段；
- `typeof navigator === 'undefined'` 守卫，SSR 或测试环境不会抛错；
- `sdk` 是编译期常量，冻结后复用。

**⑤ 如何被获取**：`snapshotForView()` 里 `runtime: this.runtime.snapshot()`。

---

### 6.4 User Context：是谁

**① 含义**：当前登录用户，回答「这条数据属于谁」。用于按用户维度还原问题过程。

**② 结构**：

```ts
// protocol/src/schemas.ts（共享协议包）
export interface UserContextData {
  id?: string;
  properties?: Readonly<Record<string, unknown>>;
}
```

**③ 生成时机**：业务调用 `monitor.setUser()` 时；**允许在 `start()` 之前调用**（生命周期上只排除了 `destroyed`）。

**④ 如何被生成**：

```ts
// src/context/user-context.ts
export class UserContext {
  private value: UserContextData | undefined;

  set(user: UserContextData): void {
    const next: UserContextData = {
      ...(user.id !== undefined ? { id: user.id } : {}),
      ...(user.properties !== undefined
        ? { properties: Object.freeze({ ...user.properties }) } // 浅拷贝后冻结
        : {}),
    };
    this.value = Object.freeze(next); // 整份替换并冻结，不是增量合并
  }

  snapshot(): UserContextData | undefined {
    return this.value;
  }
  clear(): void {
    this.value = undefined;
  }
}
```

调用链：

```ts
// src/core/monitor.ts
setUser(user: UserContextData): void {
  if (this.lifecycle.isDestroyed()) return;
  this.context.setUser(user);
}
```

**⑤ 如何被获取**：

```ts
// src/context/snapshot.ts（snapshotForView 内）
const user = this.user.snapshot();
return Object.freeze({
  ...
  ...(user ? { user } : {}),   // 未登录时连字段都不产生
});
```

**特点**：整份替换而非合并（换账号不会残留上一个用户的字段）；`destroy()` 里 `user.clear()`。

---

### 6.5 View Context：发生在哪个页面

**① 含义**：页面视图，回答「这条数据发生在哪个页面、哪一段时间」。它是五类里**唯一的活数据、也是唯一需要按时间匹配的一类**。

**② 结构**：

```ts
// src/context/view-context.ts
export interface ViewRecord {
  viewId: string;
  url: string; // 进入 Context 时已脱敏
  startedAt: number;
  source: ViewSource; // 'initial' | 'history' | 'popstate' | 'hashchange' | 'bfcache'
  endedAt?: number; // undefined 表示仍在进行中
}
```

**③ 生成时机**（由 ViewCollector 写入，见 3.4）：

| 触发                                                                       | 动作                                  |
| -------------------------------------------------------------------------- | ------------------------------------- |
| `view.route-change`（initial / history / popstate / hashchange / bfcache） | `startView()` 开新 View               |
| `page.lifecycle` 的 `pagehide` 且非 persisted                              | `endView()` 结束当前 View             |
| 冷启动尚无 View                                                            | `snapshotAt()` 兜底现开一个 `initial` |

**④ 如何被生成**：

```ts
// src/context/view-context.ts（start / end）
start(url, timestamp, source) {
  const previous = this.end(timestamp);                 // ① 先结束上一个 View，时间线连续
  const current: ViewRecord = Object.freeze({
    viewId: createId('view'),
    url: sanitizeUrl(url),     // ② URL 进门即移除 query 与 fragment
    startedAt: timestamp,
    source,
  });
  this.history.push(current);
  this.trim();                                          // ③ 超过 maxHistorySize(20) 丢最旧
  return { current, ...(previous ? { previous } : {}) };
}

end(timestamp: number) {
  const current = this.current();
  if (!current || current.endedAt !== undefined) return undefined;   // 已结束的不重复结束
  const ended = Object.freeze({
    ...current,
    endedAt: Math.max(timestamp, current.startedAt),    // ④ 防结束时间早于开始时间
  });
  this.history[this.history.length - 1] = ended;        // 就地补 endedAt
  return ended;
}
```

**⑤ 如何被获取**：按发生时间反查区间（详见第七章）：

```ts
// src/context/view-context.ts（resolveAt）
for (let index = this.history.length - 1; index >= 0; index -= 1) {
  // 从最新往回找
  const view = this.history[index];
  const endsAfterTimestamp = view.endedAt === undefined || timestamp <= view.endedAt;
  if (timestamp >= view.startedAt && endsAfterTimestamp) return view;
}
return this.current(); // 兜底
```

**特点**：有界队列（默认 20 条）；是唯一会增长、会过期的一类；`destroy()` 里 `view.clear()`。

---

### 6.6 五类汇总对照表

| 维度        | 回答什么       | 结构                                               | 生成时机                   | 是否会变         | 谁写入             | 谁读取                            |
| ----------- | -------------- | -------------------------------------------------- | -------------------------- | ---------------- | ------------------ | --------------------------------- |
| **app**     | 来自哪个应用   | `{name, version, environment}`                     | 构造期（归一化校验后冻结） | 不变             | `normalizeOptions` | `emit()` 直接取                   |
| **session** | 属于哪次访问   | `{sessionId, startedAt}`                           | `new SessionContext()` 时  | 不变             | 内部 `createId`    | `snapshotForView`                 |
| **runtime** | 什么环境下发生 | `{userAgent?, language?, platform?, online?, sdk}` | **每次取快照时现读**       | 可能变（网络等） | 读 `navigator`     | `snapshotForView`                 |
| **user**    | 属于谁         | `{id?, properties?}`                               | `setUser()` 调用时         | 会变（换账号）   | 业务调用           | `snapshotForView`（未设置则省略） |
| **view**    | 发生在哪个页面 | `{viewId, url, startedAt, source, endedAt?}`       | 路由/生命周期事件时        | 会变（跳转）     | ViewCollector      | `resolveAt(ts)` 反查              |

### 6.7 一次快照的完整组装

```ts
// src/context/snapshot.ts（第 74–96 行）
snapshotAt(timestamp: number): TelemetryContext {
  let view = this.view.resolveAt(timestamp);
  if (!view) view = this.startView(currentUrl(), timestamp, 'initial').current;  // 兜底
  return this.snapshotForView(view);
}

snapshotForView(view: ViewRecord): TelemetryContext {
  const user = this.user.snapshot();
  return Object.freeze({                                  // 冻结 = 定格
    sessionId: this.session.snapshot().sessionId,         // ← session
    viewId: view.viewId,                                  // ← view
    url: view.url,                                        // ← view（已脱敏）
    runtime: this.runtime.snapshot(),                     // ← runtime（现读）
    ...(user ? { user } : {}),                            // ← user（可选）
  });
}
```

`app` 不在这里，因为它属于信封顶层的固定字段，由 `emit()` 单独取。

---

## 七、详解：快照什么时候生成？数据怎么匹配到上下文？

这是最容易混淆的一节。先给结论：

> **快照不是「提前保存好、用时取出」，而是每条数据提交时当场生成、当场冻结、当场塞进信封。**
> 平时存在的是「活数据」（View 时间线、用户信息），快照只是对活数据的一次定格。

### 6.1 两类东西要分清

| 类别       | 是什么                           | 存在多久           | 例子                                                              |
| ---------- | -------------------------------- | ------------------ | ----------------------------------------------------------------- |
| **活数据** | ContextManager 里可变的状态      | 长期存在，会被更新 | `ViewContext.history`（View 时间线）、`UserContext.value`         |
| **快照**   | 某条数据提交时生成的一份冻结副本 | 只在那个信封里     | `TelemetryContext`（`sessionId`/`viewId`/`url`/`runtime`/`user`） |

SDK 里**没有任何地方缓存过「某条事件对应的快照」**，也不存在「事件与上下文的映射表」。匹配是**每次现算**的。

### 6.2 五个维度的快照时机各不相同

| Context   | 何时确定                  | 生成方式                                   |
| --------- | ------------------------- | ------------------------------------------ |
| `app`     | `createMonitor()` 构造期  | 冻结一次，之后只读                         |
| `session` | `new SessionContext()` 时 | `sessionId` 一次性生成，永不变化           |
| `view`    | 路由 / 页面可见性变化时   | 由 ViewCollector 往时间线里追加、结束      |
| `runtime` | **每次取快照时实时读**    | 读 `navigator`，不缓存                     |
| `user`    | `monitor.setUser()` 时    | 整份替换并冻结；未设置则快照为 `undefined` |

也就是说：**只有 view 与 user 是「会变的活数据」，app / session / runtime 要么不变、要么现读现算。**

### 6.3 快照的生成时机：`emit()` 那一行

```ts
// src/core/pipeline.ts（第 67–84 行）
emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void {
  const envelope: TelemetryEnvelope<T> = {
    ...
    app: this.context.app.snapshot(),                                  // ← ① 现在取
    context: draft.context ?? this.context.snapshotAt(draft.timestamp), // ← ② 现在取
    ...
  };
  ...
}
```

时序上是这样的：

```text
数据发生（t0）  →  Instrumentation 发布（t0+Δ1）  →  Collector 提交（t0+Δ2）
                                                          │
                                                          └─ 此刻调用 snapshotAt(t0)
                                                             用「发生时间 t0」去反查
                                                             生成快照 → 冻结 → 塞进信封
```

**关键点**：快照是在**处理时刻**生成的，但查询用的是**发生时刻** `draft.timestamp`。这就是「延迟到达的数据仍能归属正确页面」的全部秘密。

### 6.4 View 时间线是怎么被维护的（谁在写）

```ts
// src/context/view-context.ts
export class ViewContext {
  private readonly history: ViewRecord[] = []; // ← 活数据：最近若干条 View

  start(url, timestamp, source) {
    const previous = this.end(timestamp); // ① 先把上一个 View 结束掉
    const current = Object.freeze({
      viewId: createId('view'),
      url: sanitizeUrl(url),
      startedAt: timestamp,
      source,
    });
    this.history.push(current); // ② 追加新 View
    this.trim(); // ③ 超出上限丢最旧
    return { current, ...(previous ? { previous } : {}) };
  }

  end(timestamp: number) {
    const current = this.current();
    if (!current || current.endedAt !== undefined) return undefined; // 已结束则不再重复结束
    const ended = Object.freeze({
      ...current,
      endedAt: Math.max(timestamp, current.startedAt), // 防止结束时间早于开始时间
    });
    this.history[this.history.length - 1] = ended; // ④ 就地补上 endedAt
    return ended;
  }
}
```

写入者只有一个 —— **ViewCollector**，它订阅两类信号：

| 信号                                           | 动作                                          | 代码            |
| ---------------------------------------------- | --------------------------------------------- | --------------- |
| `view.route-change`                            | `startView(url, timestamp, source)` 开新 View | `changeView()`  |
| `page.lifecycle` 的 `pagehide`（非 persisted） | `endView(timestamp)` 结束当前 View            | `emitEnd()`     |
| `page.lifecycle` 的 `pageshow`（persisted）    | `startView(currentUrl(), ts, 'bfcache')`      | 从 BFCache 恢复 |

于是时间线长这样（每条记录都有明确的起止区间）：

```text
history: [
  { viewId: 'view_1', url: '/home',  startedAt: 1000, endedAt: 5000,  source: 'initial' },
  { viewId: 'view_2', url: '/list',  startedAt: 5000, endedAt: 12000, source: 'history' },
  { viewId: 'view_3', url: '/detail',startedAt: 12000, endedAt: undefined, source: 'history' },  ← 当前
]
```

`endedAt: undefined` 表示「这个 View 还在进行中」。

### 6.5 匹配算法：拿时间戳去时间线里找区间

```ts
// src/context/view-context.ts（第 66–77 行）
resolveAt(timestamp: number): ViewRecord | undefined {
  for (let index = this.history.length - 1; index >= 0; index -= 1) {  // 从最新往回找
    const view = this.history[index];
    if (!view) continue;

    const endsAfterTimestamp = view.endedAt === undefined || timestamp <= view.endedAt;
    if (timestamp >= view.startedAt && endsAfterTimestamp) return view;  // 命中区间
  }

  return this.current();   // 找遍了都没有：降级到当前 View，保证信封仍完整
}
```

判断条件翻译成人话：

```text
view.startedAt <= 数据发生时间 <= (view.endedAt 或 +∞)
                                  ↑ 未结束的 View 视为延伸到无穷远
```

从最新往回找是有讲究的：**绝大多数数据都属于最近的 View**，倒序查找通常第一条就命中；同时它也能正确处理「迟到的历史数据」。

### 6.6 兜底：连当前 View 都没有时

```ts
// src/context/snapshot.ts（第 74–78 行）
snapshotAt(timestamp: number): TelemetryContext {
  let view = this.view.resolveAt(timestamp);
  // History Instrumentation 尚未产生初始信号时，保证首条数据仍有合法 View。
  if (!view) view = this.startView(currentUrl(), timestamp, 'initial').current;
  return this.snapshotForView(view);
}
```

冷启动时可能一条 View 记录都还没有（History Instrumentation 的首条 `initial` 信号还没发出），此时**现开一个 View**，保证首条数据也有合法的 `viewId` 与 `url`，不会出现上下文缺失的脏数据。

### 6.7 组装并冻结

```ts
// src/context/snapshot.ts（第 84–96 行）
snapshotForView(view: ViewRecord): TelemetryContext {
  const user = this.user.snapshot();
  return Object.freeze({                    // ← 冻结：这条数据的上下文就此定格
    sessionId: this.session.snapshot().sessionId,
    viewId: view.viewId,
    url: view.url,                          // 注意：是进入 Context 时就脱敏过的 url
    runtime: this.runtime.snapshot(),       // 现读 navigator
    ...(user ? { user } : {}),              // 未登录则不产生该字段
  });
}
```

**冻结之后，这条数据就与活数据脱钩了**：即使随后用户跳转页面、切换账号，这个信封里的 `viewId` / `url` / `user` 也永远是生成那一刻的值。

### 6.8 一个具体例子：迟到的 INP

```text
t=1000   页面 A 打开        → startView('/a', 1000)          view_1 [1000, ?]
t=3000   用户在 A 上点击    → INP 开始计时（尚未结算）
t=5000   用户跳转到 B       → startView('/b', 5000)
                              → view_1 结束 [1000, 5000]，view_2 [5000, ?]
t=8000   INP 结算完成       → publish + emit
                              → snapshotAt(3000) 用「点击发生的时刻」去查
                              → 命中 view_1（1000 ≤ 3000 ≤ 5000）
                              → 信封里写的是 view_1 / '/a'

若错误地取「当前 View」：      → 会被记到 view_2 / '/b'  ← 这是 bug
```

### 6.9 两种取值路径的对比

| 路径                    | 触发条件                     | 谁在用             | 适用场景                                       |
| ----------------------- | ---------------------------- | ------------------ | ---------------------------------------------- |
| `snapshotAt(timestamp)` | Collector 没有指定 `context` | 绝大多数 Collector | 按发生时间反查归属                             |
| `snapshotForView(view)` | Collector 显式传了 `context` | 只有 ViewCollector | 它刚创建/结束这个 View，归属是确定的，无需反查 |

```ts
// src/collectors/view/index.ts（第 60–63 行）
this.emitter.emit({
  name: 'view.start',
  timestamp,
  context: this.context.snapshotForView(changed.current),  // ← 直接指定刚生成的 View
  payload: { ... },
});
```

### 6.10 一句话总结这段逻辑

> `ViewContext` 维护一条**带起止区间的 View 时间线**（由 ViewCollector 负责开合）；每条数据提交时，`MonitorPipeline` 拿着它的**发生时间戳**去这条时间线上查区间，命中哪个 View 就用哪个 View 生成快照；快照当场冻结并写进信封，此后与活数据再无关系。

---

## 八、端到端：一条 LoAF 数据如何变成信封

把三篇文章的内容串起来，看一次完整流动：

```text
① 浏览器推送 long-animation-frame 条目
     PerformanceObserverInstrumentation.publishLoAF(entry)
     └─ publish('performance.loaf', { timestamp, startTime, duration, blockingDuration,
                                       renderStart, styleAndLayoutStart, scriptCount })

② SignalHub 同步分发
     └─ 'performance.loaf' 桶 → LoAFCollector 的监听器

③ LoAFCollector 做监控语义判断
     ├─ active? 是否在运行
     ├─ duration ≥ minDurationMs?        （阈值）
     ├─ emittedEntries < maxEntriesPerView?（每 View 额度）
     └─ emitter.emit({
          name: 'LoAF',
          timestamp: signal.timestamp,             ← 用发生时间，不用处理时间
          payload: { type:'performance', name:'LoAF', value: duration, unit:'ms',
                     kind:'diagnostic', source:'performance-observer', detail:{...} }
        })

④ MonitorPipeline.emit(draft) 统一补齐
     ├─ protocolVersion = '2.0'
     ├─ eventId       = createId('event')
     ├─ type          = draft.payload.type         → 'performance'
     ├─ occurredAt    = draft.timestamp            → 发生时间
     ├─ app           = context.app.snapshot()
     ├─ context       = context.snapshotAt(timestamp)
     │                    ├─ sessionId ← SessionContext
     │                    ├─ viewId/url ← ViewContext.resolveAt(timestamp)
     │                    ├─ runtime   ← RuntimeContext
     │                    └─ user      ← UserContext（未设置则省略）
     ├─ correlation   = {}
     └─ payload       = draft.payload

⑤ 冻结后的 TelemetryEnvelope 交给 Processing → Transport（本文不展开）
```

数据流形态的三次变化：

```text
PerformanceEntry（浏览器对象）
   → LoAFSignal（内部事实，无上下文）
   → TelemetryDraft（领域数据，可选带 context）
   → TelemetryEnvelope（完整上报体，上下文齐备）
```

每一次变化都在收窄与补全：**越来越标准，越来越完整，也越来越脱离浏览器的具体实现。**

---

## 九、为什么必须收敛到一个 emit()

| 目标         | 如果各 Collector 自己发                          | 收敛到 MonitorPipeline.emit()         |
| ------------ | ------------------------------------------------ | ------------------------------------- |
| 上下文一致性 | 每个 Collector 各自拼 session/view，口径必然漂移 | 只在一处按时间解析，口径统一          |
| 加工不遗漏   | 新增一种数据要记得补脱敏/采样，迟早会漏          | 任何数据都必然经过同一条加工链        |
| 协议演进     | 改协议要改 N 处                                  | 只改 Envelope 一处                    |
| 可测试性     | 要 mock 整个发送链路                             | 注入一个内存 Emitter 即可断言完整信封 |
| 出口可控     | 无法统一限流/丢弃                                | 唯一的丢弃与限流入口                  |

---

## 十、小结

| 关注点         | 做法                                                        | 代码位置                     |
| -------------- | ----------------------------------------------------------- | ---------------------------- |
| 谁在听信号     | Collector 在 `install()` 里订阅，注册顺序保证先订阅后产生   | `src/collectors/*/install()` |
| 听完之后       | 直译 / 过滤 / 计算 / 状态机 / 直投五种模式                  | 各 Collector 回调            |
| 交到哪里       | 一律 `emitter.emit(draft)`，Collector 只拿到这一个方法      | `TelemetryEmitter`           |
| 谁补齐信封     | 全局唯一的 `MonitorPipeline.emit()`                         | `src/core/pipeline.ts`       |
| 上下文哪来     | `ContextManager.snapshotAt(发生时间)` 或 Collector 显式指定 | `src/context/snapshot.ts`    |
| 归属怎么定     | 按 `timestamp` 反查 View 时间线，而非取当前 View            | `ViewContext.resolveAt()`    |
| 为什么不自己发 | 保证上下文一致、加工不遗漏、出口可控                        | —                            |

**一句话**：Collector 是「浏览器事实」到「监控语义」的翻译层，它们各自订阅关心的信号、按自己的规则决定是否形成事件，然后**全部提交到同一个 `MonitorPipeline.emit()`**；这条唯一的出口负责结合 `ContextManager` 补齐 session / view / runtime / user，把五花八门的领域数据包装成结构统一的 `TelemetryEnvelope`，之后才交给加工与发送环节。
