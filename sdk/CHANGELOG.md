# Changelog

本项目的重要变更会记录在此文件中。

## 0.3.0 - Unreleased

### Added

- 增加统一的 `createMonitor()` 工厂及 `start()`、`stop()`、`destroy()` 生命周期。
- 通过 `web-vitals`、PerformanceObserver 和 requestAnimationFrame 采集 LCP、FCP、INP、CLS、FPS 和 LoAF。
- 增加自定义 `track()` 埋点，以及 Trace/Span 的创建、回调包装和关联 API。
- 使用协议 3.0 的统一事件与批次，提供上下文、数据治理和有界队列发送链路。
- 提供 ESM、浏览器 IIFE 和 TypeScript 声明文件，以及第三方依赖许可证说明。

### Changed

- SDK 包名调整为 `@cxdlogver/browser-monitor-sdk`，共享协议包使用 `@cxdlogver/browser-monitor-protocol`。
- Performance 数据进入统一 Processing 和 Transport 链路。
- 采集地址统一使用 `transport.dsn`，业务字段通过 `attributes` 和 `metrics` 表达。
- 打包前自动构建，并在发布前执行完整检查。

## 0.1.0 - 2026-09-11

### Added

- 初始化 TypeScript 浏览器 SDK 工程。
- 配置 ESM、IIFE 和类型声明构建。
- 配置格式化、静态检查、测试与 npm 发布校验。
- 预留浏览器监控 SDK 模块目录。
