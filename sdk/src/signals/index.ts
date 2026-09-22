/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：定义 SDK 内部的「Raw Signal 协议」，即 Signal Hub 上传递的事实的类型总表。
 *
 * Raw Signal 表达的是「浏览器刚刚发生了什么」（一次 LoAF 产生了、路由变了、页面被隐藏了），
 * 它只是 Instrumentation 与 Collector 之间的内部边界，**不等同于最终上报协议**：
 * 上报体还要经过 Collector 的领域解释、Processing 的加工与上下文注入才成形。
 *
 * 因此这里刻意保持「薄」：信号只携带原始数据，不带会话、用户、View 等上下文，
 * 也不做任何采样或脱敏决策。所有信号类型都登记在 SignalMap 中，
 * 新增一种事实 = 在这里加一行映射，发布端与订阅端的类型安全随之自动获得。
 * ---------------------------------------------------------------------------
 */

// 先对外转发各领域的信号类型，再由下方 SignalMap 汇总成一张表。
export type { FrameWindowSignal, LoAFSignal, WebVitalSignal } from './performance';
export type { PageLifecycleSignal, RouteChangeSignal } from './view';

// 仅供本文件拼接 SignalMap 使用，与上面的转发语句互不冲突。
import type { FrameWindowSignal, LoAFSignal, WebVitalSignal } from './performance';
import type { PageLifecycleSignal, RouteChangeSignal } from './view';

/**
 * 信号类型 → 负载类型的总映射表，是类型安全的唯一来源。
 * key 命名遵循「领域.事实」两段式，避免出现无归类的扁平常量。
 */
// Raw Signal 是 Instrumentation 与 Collector 的内部边界，不等同于最终上报协议。
export interface SignalMap {
  'performance.web-vital': WebVitalSignal;
  'performance.loaf': LoAFSignal;
  'performance.frame-window': FrameWindowSignal;
  'page.lifecycle': PageLifecycleSignal;
  'view.route-change': RouteChangeSignal;
}

/**
 * 发布端视图：只暴露 publish。
 * Instrumentation 注入的是这个类型，因此它在类型层面就没有「读取他人数据」的能力。
 */
export interface SignalPublisher {
  publish<K extends keyof SignalMap>(type: K, signal: SignalMap[K]): void;
}

/**
 * 订阅端视图：只暴露 subscribe。
 * Collector 注入的是这个类型，因此无法反向驱动数据源，依赖方向始终是单向的。
 * 泛型 K 保证监听器拿到的负载类型与订阅的信号类型严格对应。
 */
export interface SignalSubscriber {
  subscribe<K extends keyof SignalMap>(
    type: K,
    listener: (signal: SignalMap[K]) => void,
  ): () => void;
}
