# cx-browser-monitor-sdk

`cx-browser-monitor-sdk` 是原生 JavaScript Browser Monitor SDK。所有监控数据都通过同一条链路处理：

```text
Instrumentation → Signal Hub → Collector → Context → Envelope
→ Processing → Transport → Ingestion Endpoint
```

Performance 不再通过独立订阅回调输出。LCP、FCP、INP、CLS、FPS 和 LoAF 会转换为协议 3.0 的统一 `TelemetryEventV3`，经过规范化、校验、脱敏、过滤、去重、采样和限流后，由 Transport 批量发送。

## 快速开始

```ts
import { createMonitor } from 'cx-browser-monitor-sdk';

const monitor = createMonitor({
  app: {
    name: 'checkout-web',
    version: '1.0.0',
    environment: 'production',
  },
  view: {
    // 动态路径应映射为稳定业务名称，供服务端按页面聚合。
    resolveRouteName: ({ pathname }) => pathname,
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
  transport: {
    dsn: 'https://monitor.example.com/api/v3/ingest/bm_pk_xxx/envelopes',
    batchSize: 20,
    flushIntervalMs: 10_000,
    maxQueueSize: 200,
  },
});

monitor.setUser({ id: 'user-123' });
monitor.start();
monitor.setViewName('checkout-confirm');

monitor.track('order_submit', {
  attributes: { orderType: 'normal' },
  metrics: { amount: { value: 199.9, unit: 'CNY' } },
});

// stop() 只暂停监控，后续可以重新 start()。
monitor.stop();
monitor.start();

// 页面或应用彻底销毁时永久释放 SDK 自有资源。
monitor.destroy();
```

浏览器 IIFE 构建中的统一工厂位于 `CXMonitorSDK.createMonitor`。

## 采集服务与 DSN

SDK 不包含数据库、采集 API 或可视化看板。业务应用也不需要自行实现采集接口：在 Browser Monitor Platform 中创建项目、配置允许的 Origin，再把设置页生成的公开 DSN 传给 `transport.dsn` 即可。平台负责协议校验、原始数据与 Outbox 入库、指标计算、TimescaleDB 聚合和 React 看板。

`transport.dsn` 是唯一的采集地址配置，不支持并存的 `transport.endpoint`。URL query 和 fragment 会被整体移除；如需清理自定义埋点属性中的敏感键，使用 `processing.sensitiveKeys`：

```ts
createMonitor({
  app,
  processing: {
    sensitiveKeys: ['token', 'password', 'authorization'],
  },
  transport: {
    dsn: 'https://monitor.example.com/api/v3/ingest/bm_pk_xxx/envelopes',
  },
});
```

服务端部署、接口、数据处理与看板说明见 [Browser Monitor Platform](../platform/README.md)。

## 公开 API

| API                      | 作用                                             |
| ------------------------ | ------------------------------------------------ |
| `createMonitor(options)` | 校验配置并创建统一 Monitor                       |
| `start()`                | 安装并启动已启用的监控模块，重复调用不会重复监听 |
| `stop()`                 | 暂停数据生产并执行受控 Flush，可以再次启动       |
| `destroy()`              | 永久销毁实例，恢复 SDK 包装的全局 API            |
| `track(name, data)`      | 记录带属性和数值指标的自定义事件                 |
| `startTrace(name, data)` | 开始自定义 Trace 并返回可结束句柄                |
| `trace(name, fn, data)`  | 包装同步或异步业务流程并自动结束 Trace           |
| `setUser(user)`          | 更新白名单用户上下文                             |
| `setViewName(name)`      | 显式覆盖当前 View 的稳定业务路由名               |
| `flush()`                | 主动发送队列中的安全数据                         |
| `getCapabilities()`      | 查询浏览器实际支持的监控能力                     |

缺少 App 信息、采集端点无效或数值配置非法时，`createMonitor()` 会立即抛出配置错误。浏览器不支持某项能力时，对应模块静默降级，不伪造零值。

## Performance 指标

| 指标 | 事实来源                            | 单位  | 语义                         |
| ---- | ----------------------------------- | ----- | ---------------------------- |
| LCP  | Web Vitals Instrumentation          | ms    | Core Web Vital，加载体验     |
| FCP  | Web Vitals Instrumentation          | ms    | 首次内容绘制诊断指标         |
| INP  | Web Vitals Instrumentation          | ms    | Core Web Vital，交互响应体验 |
| CLS  | Web Vitals Instrumentation          | score | Core Web Vital，布局稳定性   |
| FPS  | Animation Frame Instrumentation     | fps   | 页面可见期间的窗口帧率       |
| LoAF | PerformanceObserver Instrumentation | ms    | 长动画帧诊断摘要             |

Instrumentation 只管理浏览器资源和源头级机械聚合；Performance Collector 只负责把 Raw Signal 转换为 Performance Payload。原始 `PerformanceEntry`、DOM 节点、脚本 URL 和 `navigationURL` 不会进入 Transport。

## 生命周期

```text
create → install → start → stop → restart → destroy
```

- `start()`、`stop()` 和 `destroy()` 均具有幂等行为。
- History、Page Lifecycle、PerformanceObserver、RAF 和 Timer 都有对应释放路径。
- View Context 完全移除 URL query/fragment，保存稳定 `routeName`，并按照指标真实发生时间解析所属 View。
- `web-vitals` 只安装一次。该依赖不提供公开的取消句柄，因此 `stop()` 通过状态门暂停发布，`destroy()` 后永久静默；SDK 自己创建的 Observer、监听器和 Timer 仍会完整释放。

## 数据处理与发送

统一处理顺序为：

`Normalize → Validate → Redact → Filter → Dedupe → Sampling → Rate Limit`。

Transport 使用有界内存队列，按照数量、字节数和时间组成批次。页面隐藏或离开时会尝试受控 Flush；发送失败只对可恢复状态执行有限重试。队列达到容量上限时优先丢弃低优先级旧数据，不使用 IndexedDB 持久化监控数据。

发送体固定为 `TelemetryBatchV3`：外层包含 `protocolVersion: '3.0'`、`sentAt`、SDK 身份和 `events`。Web Vitals 使用稳定 `sampleId` 与递增 `sequence`，普通回调为 `provisional`，View 结束时发送 `final` 快照。FPS 与 LoAF 每个采样窗口都是独立 final 样本。

## 目录边界

| 目录              | 职责                                                 |
| ----------------- | ---------------------------------------------------- |
| `core`            | 配置、生命周期、模块注册、Signal Hub 和链路编排      |
| `instrumentation` | 管理浏览器 API、监听器、Observer、RAF 与 Timer       |
| `collectors`      | 将 Raw Signal 转换为 Performance、View 和 Event 语义 |
| `context`         | 管理 App、User、Session、View 和 Runtime 快照        |
| `signals`         | 定义只在 SDK 内部流动的浏览器 Raw Signal             |
| `processing`      | 执行数据质量、安全和流量治理                         |
| `transport`       | 队列、批处理、发送、重试和 Flush                     |
| `shared`          | 无监控领域语义的基础能力                             |

跨 SDK、API 和 Worker 的协议 3.0 类型直接来自 workspace 中的 `@browser-monitor/protocol`。SDK 不保留 `src/protocol` 转发目录，避免本地包装类型与共享 Schema 形成两个协议来源。

自定义事件、页面停留与跨路由链路示例见 [自定义 Trace 与 Span](./docs/07-自定义Trace与Span.md)。`track()` 的第二个参数已改为 `{ attributes, metrics }`。

更完整的目标、设计思想和目录说明见 [Browser Monitor SDK 项目知识梳理](./docs/Browser-Monitor-SDK-项目知识梳理.md)。

## 本地开发

在 `sdk/` 目录执行 SDK 自身的完整发布检查：

```bash
pnpm install
pnpm check
```

`pnpm check` 会依次执行格式检查、Lint、类型检查、测试、构建和发布包检查。

在 monorepo 根目录执行 `pnpm check`，则会统一验证 Protocol、SDK 和 Platform 的类型、核心测试与生产构建。

## 构建产物

`pnpm build` 生成：

- `dist/index.js`：ESM 入口；
- `dist/index.global.js`：IIFE 入口，全局名称为 `CXMonitorSDK`；
- `dist/index.d.ts`：TypeScript 类型声明；
- 对应 Source Map。

## License

[MIT](./LICENSE)

IIFE 构建内联的第三方依赖及许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
