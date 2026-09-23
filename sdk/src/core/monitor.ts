import {
  CustomTelemetryManager,
  type CustomSignalInput,
  type TraceHandle,
} from '../collectors/event/custom';
import { FPSCollector, LoAFCollector, WebVitalsCollector } from '../collectors/performance';
import { ViewCollector } from '../collectors/view';
import { ContextManager } from '../context';
import { AnimationFrameInstrumentation } from '../instrumentation/animation-frame';
import { HistoryInstrumentation } from '../instrumentation/history';
import { PageLifecycleInstrumentation } from '../instrumentation/page-lifecycle';
import { PerformanceObserverInstrumentation } from '../instrumentation/performance-observer';
import { WebVitalsInstrumentation } from '../instrumentation/web-vitals';
import { createProcessingPipeline } from '../processing';
import { HttpSender, Transport, type Sender } from '../transport';
import type { PerformanceCapabilityMap, UserContextData } from '@browser-monitor/protocol';

import { normalizeOptions, type MonitorOptions, type NormalizedMonitorOptions } from './config';
import { Lifecycle } from './lifecycle';
import { ModuleRegistry } from './module-registry';
import { MonitorPipeline } from './pipeline';
import { SignalHub } from './signal-hub';

/** 各采集能力在当前运行环境下的支持情况，宿主可据此跳过不支持的指标或做降级处理。 */
export interface MonitorCapabilities {
  performance: PerformanceCapabilityMap;
}

/**
 * SDK 对外暴露的最小 API 契约。
 * 所有方法都被设计成幂等且可在非法状态下安全调用（退化为空操作），
 * 避免宿主在 React StrictMode、路由重挂载等场景下重复调用时报错。
 */
export interface Monitor {
  start(): void;
  stop(): void;
  destroy(): void;
  track(name: string, data?: CustomSignalInput): void;
  startTrace(name: string, data?: CustomSignalInput): TraceHandle;
  trace<T>(name: string, callback: (trace: TraceHandle) => T, data?: CustomSignalInput): T;
  setUser(user: UserContextData): void;
  setViewName(name: string): void;
  flush(): Promise<void>;
  getCapabilities(): MonitorCapabilities;
}

export interface MonitorDependencies {
  // 仅用于测试或宿主环境注入发送实现，不作为包的公共配置暴露。
  sender?: Sender;
}

/**
 * SDK 的组合根：只负责创建模块、连接依赖和驱动生命周期，
 * 不在这里实现具体指标计算或浏览器 API 包装。
 */
class BrowserMonitor implements Monitor {
  private readonly options: NormalizedMonitorOptions;
  // 生命周期状态机：统一守卫 install / start / stop / destroy 的合法状态迁移。
  private readonly lifecycle = new Lifecycle();
  // 模块注册表：按注册顺序统一 install/start，stop/destroy 时自动反向执行。
  private readonly registry = new ModuleRegistry();
  // 模块间唯一的通信通道，使 Collector 与 Instrumentation 解耦互不直接依赖。
  private readonly signals = new SignalHub();
  private readonly context: ContextManager;
  private readonly transport: Transport;
  private readonly customTelemetry: CustomTelemetryManager;
  private readonly capabilities: MonitorCapabilities;

  constructor(options: MonitorOptions, dependencies: MonitorDependencies = {}) {
    // 在安装任何全局监听前完成配置校验，避免半初始化状态污染宿主页面。
    this.options = normalizeOptions(options);
    this.context = new ContextManager({
      app: this.options.app,
      ...(this.options.view.resolveRouteName
        ? { resolveRouteName: this.options.view.resolveRouteName }
        : {}),
    });

    // 依赖注入优先：注入存在时用它替换真实网络发送，便于测试或宿主自定义上报通道。
    const sender =
      dependencies.sender ??
      new HttpSender({
        dsn: this.options.transport.dsn,
        headers: this.options.transport.headers,
      });
    this.transport = new Transport(this.options.transport, sender, this.signals);

    // 加工管线（采样/脱敏/限流）与数据管线对所有采集器共享，
    // 保证任何来源的数据都经过同一套上下文注入与清洗规则。
    const processing = createProcessingPipeline(this.options.processing);
    const pipeline = new MonitorPipeline(this.context, processing, this.transport);
    this.customTelemetry = new CustomTelemetryManager(pipeline, this.context, this.signals);

    // 总开关关闭时逐项置 false，而非跳过创建，保持能力表的结构完整。
    const enabledMetrics = this.options.performance.enabled
      ? this.options.performance.metrics
      : {
          LCP: false,
          FCP: false,
          INP: false,
          CLS: false,
          FPS: false,
          LoAF: false,
        };

    // Collector 负责把原始信号翻译成数据并送入管线；Instrumentation 只负责产生信号。
    const viewCollector = new ViewCollector(this.signals, this.context, pipeline);
    const webVitalsCollector = new WebVitalsCollector(this.signals, pipeline, enabledMetrics);
    const loafCollector = new LoAFCollector(this.options.performance.loaf, this.signals, pipeline);
    const fpsCollector = new FPSCollector(this.signals, pipeline);

    const pageLifecycle = new PageLifecycleInstrumentation(this.signals);
    const history = new HistoryInstrumentation(this.signals);
    const webVitals = new WebVitalsInstrumentation(
      {
        enabled: {
          LCP: enabledMetrics.LCP,
          FCP: enabledMetrics.FCP,
          INP: enabledMetrics.INP,
          CLS: enabledMetrics.CLS,
        },
        reportAllChanges: this.options.performance.reportAllChanges,
        reportSoftNavs: this.options.performance.reportSoftNavs,
      },
      this.signals,
    );
    const performanceObserver = new PerformanceObserverInstrumentation(
      this.signals,
      this.signals,
      enabledMetrics.LoAF,
    );
    const animationFrame = new AnimationFrameInstrumentation(
      {
        ...this.options.performance.fps,
        enabled: enabledMetrics.FPS,
      },
      this.signals,
      this.signals,
    );

    // 启动顺序很重要：Transport 和 Collector 必须先就绪，随后
    // Instrumentation 才能发布信号，避免启动瞬间产生的数据无人消费。
    // stop/destroy 会按相反顺序执行，使数据源先停止、消费者后释放。
    this.registry.register(webVitalsCollector);
    this.registry.register(loafCollector);
    this.registry.register(fpsCollector);
    this.registry.register(viewCollector);
    // Transport installs after lifecycle-aware Collectors so pagehide first
    // emits final metric/View snapshots and only then flushes the queue.
    this.registry.register(this.customTelemetry);
    this.registry.register(this.transport);
    this.registry.register(pageLifecycle);
    this.registry.register(history);
    this.registry.register(webVitals);
    this.registry.register(performanceObserver);
    this.registry.register(animationFrame);

    // 能力表在构造期一次性快照并冻结，运行期间不随环境状态变化。
    const webVitalCapabilities = webVitals.capabilities();
    this.capabilities = Object.freeze({
      performance: Object.freeze({
        ...webVitalCapabilities,
        FPS: animationFrame.supported(),
        LoAF: performanceObserver.supportsLoAF(),
      }),
    });
  }

  start(): void {
    // destroyed 已被 canStart() 排除，无需重复判断。
    if (!this.lifecycle.canStart()) return;

    // install 一生只执行一次；start 可以在 stop 之后安全重入。
    if (this.lifecycle.current === 'created') {
      this.registry.install();
      this.lifecycle.markInstalled();
    }

    this.registry.start();
    this.lifecycle.markRunning();
  }

  // 暂停采集但保留 install 的全局监听，可通过再次 start 快速恢复。
  stop(): void {
    if (!this.lifecycle.isRunning()) return;
    this.customTelemetry.cancelOpen();
    this.registry.stop();
    this.lifecycle.markStopped();
  }

  destroy(): void {
    if (this.lifecycle.isDestroyed()) return;
    if (this.lifecycle.isRunning()) this.stop();

    // destroy 是终态：释放订阅、上下文和模块引用，之后所有公开操作退化为空操作。
    this.registry.destroy();
    this.signals.clear();
    this.context.destroy();
    this.lifecycle.markDestroyed();
  }

  track(name: string, data?: CustomSignalInput): void {
    this.customTelemetry.track(name, data);
  }

  startTrace(name: string, data?: CustomSignalInput): TraceHandle {
    return this.customTelemetry.startTrace(name, data);
  }

  trace<T>(name: string, callback: (trace: TraceHandle) => T, data?: CustomSignalInput): T {
    return this.customTelemetry.trace(name, callback, data);
  }

  // setUser 不要求处于运行态：允许在 start 之前预置用户身份。
  setUser(user: UserContextData): void {
    if (this.lifecycle.isDestroyed()) return;
    this.context.setUser(user);
  }

  setViewName(name: string): void {
    if (this.lifecycle.isDestroyed()) return;
    this.context.view.setName(name);
  }

  // 立即冲刷队列（false 表示非卸载场景），用于页面跳转前保证数据不丢。
  flush(): Promise<void> {
    if (this.lifecycle.isDestroyed()) return Promise.resolve();
    return this.transport.flush(false);
  }

  getCapabilities(): MonitorCapabilities {
    return this.capabilities;
  }
}

/** 生产入口：使用默认的 HttpSender 上报。 */
export function createMonitor(options: MonitorOptions): Monitor {
  return new BrowserMonitor(options);
}

/** 测试与宿主集成入口：支持注入自定义 Sender 等依赖。 */
export function createMonitorWithDependencies(
  options: MonitorOptions,
  dependencies: MonitorDependencies,
): Monitor {
  return new BrowserMonitor(options, dependencies);
}
