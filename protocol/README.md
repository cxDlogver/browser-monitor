# Browser Monitor Protocol

`@browser-monitor/protocol` 是 Browser Monitor SDK 与监控平台之间唯一的协议来源。它同时导出 Zod 运行时 Schema、由 Schema 推导的 TypeScript 类型、协议常量，以及合法和非法请求夹具。

## 1. 协议职责

### 【为什么独立成包】

SDK 需要在发送前构造确定的数据，API 需要在不信任浏览器输入的前提下重新校验，Worker 需要根据 payload 类型安全地完成投影。如果三端各自声明接口，同名字段会逐渐出现可选性、枚举或版本差异。独立协议包让这三个项目依赖同一份可执行契约。

协议只描述数据，不监听浏览器 API、不连接数据库，也不包含指标计算。浏览器采集属于 SDK，服务端评级与投影属于 Worker。

## 2. 协议 3.0 结构

### 【批次外层】

```ts
interface TelemetryBatchV3 {
  protocolVersion: '3.0';
  sentAt: number;
  sdk: {
    name: string;
    version: string;
  };
  events: TelemetryEventV3[];
}
```

批次最多包含 100 条事件。`telemetryBatchHeaderV3Schema` 只校验批次身份和 `events` 容器，供采集 API 实现事件级部分接收；`telemetryBatchV3Schema` 校验完整批次，适合 SDK、测试夹具和不允许部分失败的调用方。

### 【事件 Envelope】

每条事件包含 `eventId`、`occurredAt`、`type/name`、App、Context、Correlation 和领域 Payload。`type` 必须与 `payload.type` 一致，`name` 必须与 `payload.name` 一致；View 事件的 `context.viewId` 还必须与 `payload.viewId` 一致。

当前 Payload 包含 Performance、View，以及统一规范的自定义 Event、Trace 和 Span。自定义数据可携带 `attributes` 和多个 `{ value, unit }` 数值指标；Trace/Span 还携带起止时间、耗时与状态，并通过关联 ID 组成链路。Performance 的 Web Vitals 使用稳定 `sampleId`、递增 `sequence` 和 `provisional | final` 状态；FPS 与 LoAF 每个窗口都是独立 final 样本。

## 3. 版本与边界

### 【只接受明确版本】

平台只接收 `protocolVersion: '3.0'`。协议 1.0 不做静默兼容或字段猜测，采集接口返回 `unsupported_protocol`，避免同一字段在不同版本下产生冲突口径。

URL 最多 2048 个字符，且 SDK 与服务端都删除 query 和 fragment；routeName、事件名、标识符和 JSON 属性也有明确长度或数量限制。协议限制是第一层结构边界，服务端仍会执行项目身份、Origin、发生时间、属性字节数和隐私校验。

## 4. 本地验证

```bash
pnpm --filter @browser-monitor/protocol typecheck
pnpm --filter @browser-monitor/protocol test
pnpm --filter @browser-monitor/protocol build
```

SDK 生成的数据必须通过完整 Schema；采集 API 使用批次头 Schema 配合逐事件 Schema 实现部分接收。修改协议字段时，应先修改本包，再同步 SDK 生产逻辑、API 校验、Worker 投影和文档，不在任意一端增加私有同名字段。
