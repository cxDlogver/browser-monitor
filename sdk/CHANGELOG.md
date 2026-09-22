# Changelog

本项目的重要变更会记录在此文件中。

## Unreleased

### Added

- 增加 `createPerformanceMonitor()` 实例式 Performance 采集 API。
- 使用 `web-vitals` 采集 LCP、FCP、INP 和 CLS。
- 使用 PerformanceObserver 采集安全、限量的 LoAF 数值摘要。
- 使用 requestAnimationFrame 周期采样 FPS，并响应页面可见性与 bfcache 生命周期。
- 增加统一 Performance Metric 协议、能力检测与订阅出口。
- 增加 Performance 采集单元测试和第三方依赖许可证说明。

### Changed

- 将目录调整为 Instrumentation、Collector、Context、Processing、Transport、Protocol 分层架构。
- 将 Collector 扩展为 Performance、Event、Error、Network、View 五个语义领域。
- 使用 `protocol` 取代泛化的 `types`，使用受约束的 `shared` 取代泛化的 `utils`。
- 增加 Monitor SDK 目标、完整监控链路和现有目录划分说明。
- README 和项目规范更新为当前 Performance 内核实现状态。

## 0.1.0 - 2026-09-11

### Added

- 初始化 TypeScript 浏览器 SDK 工程。
- 配置 ESM、IIFE 和类型声明构建。
- 配置格式化、静态检查、测试与 npm 发布校验。
- 预留浏览器监控 SDK 模块目录。
