/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：把浏览器的 PerformanceObserver 包装成 SDK 内部的 LoAF 数据源。
 *
 * 它属于纯粹的「事实生产者」：只负责安全地订阅 long-animation-frame 条目、
 * 提取其中的时间字段，并把其转换成 Raw Signal 发布出去。
 * 阈值过滤、每条View 的上报上限、是否最终上报等策略全部留给下游 Collector，
 * 这里不做任何业务判断，也不感知用户与环境信息。
 *
 * 之所以要单独封装一层：
 *   1. PerformanceObserver 的可用性在不同浏览器差异很大（LoAF 目前仍非全平台支持），
 *      需要统一的能力检测与静默降级；
 *   2. 页面进入后台后不应继续持有 Observer，避免无谓开销与跨页面的条目串扰；
 *   3. `buffered` 历史补齐只在首次启动时使用一次，重入时必须关闭，否则会重复回放历史数据。
 * ---------------------------------------------------------------------------
 */

import type { MonitorModule } from '../../core/module-registry';
import type { SignalPublisher, SignalSubscriber } from '../../signals';
import { performanceTimeOrigin } from '../../shared/time';

/**
 * 性能条目（PerformanceEntry）的回调函数类型。
 * @param entry 由 PerformanceObserver 推送的单条性能条目
 */
export type PerformanceEntryHandler = (entry: PerformanceEntry) => void;

/**
 * 判断当前运行环境是否支持指定的性能条目类型。
 * 采集前先做能力检测，避免调用 observe 时抛错。
 */
export function supportsPerformanceEntry(type: string): boolean {
  if (typeof PerformanceObserver === 'undefined') return false;
  const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes(type);
}

/**
 * 订阅指定类型的性能条目，并返回可逆的取消函数。
 */
export function observePerformanceEntries(
  type: string,
  handler: PerformanceEntryHandler,
  buffered: boolean,
): () => void {
  if (!supportsPerformanceEntry(type)) return () => undefined;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) handler(entry);
    });
    observer.observe({ type, buffered });
    return () => observer.disconnect();
  } catch {
    return () => undefined;
  }
}

/**
 * LoAF 条目的本地类型补充。
 * 标准 PerformanceEntry 尚未覆盖这些字段（不同浏览器实现也有差异），
 * 因此全部声明为可选，取值时统一走 safeTiming 兜底。
 */
interface LongAnimationFrameEntry extends PerformanceEntry {
  /** 主线程被长任务阻塞的时长。 */
  readonly blockingDuration?: number;
  /** 渲染阶段起点，可能因浏览器实现缺失。 */
  readonly renderStart?: number;
  /** 样式计算与布局阶段起点。 */
  readonly styleAndLayoutStart?: number;
  /** 归因脚本列表，这里只需要数量，不解析具体内容。 */
  readonly scripts?: readonly unknown[];
}

/**
 * 时间字段收敛：非法值统一回落为 0，让下游无需反复判断 NaN / undefined / 负数。
 * 用 0 而非 null 是为了让 payload 保持数值类型，避免联合类型扩散到后续所有处理环节。
 */
function safeTiming(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

export class PerformanceObserverInstrumentation implements MonitorModule {
  readonly name = 'performance-observer-instrumentation';
  // 是否在采集态。它同时充当 publish 前的闸门，stop 之后迟到的回调会被直接丢弃。
  private active = false;
  // 记录「是否曾经启动过」，用来保证 buffered 历史补齐一生只发生一次。
  private everStarted = false;
  // Observer 的卸载句柄；同时用它判断当前是否已经挂载，避免重复 observe。
  private disconnect: (() => void) | undefined;
  // 页面生命周期订阅的退订句柄，在 destroy 时释放。
  private unsubscribeLifecycle: (() => void) | undefined;

  /**
   * @param publisher 只用于发布信号
   * @param signals 只用于订阅页面可见性信号
   * @param loafEnabled LoAF 功能开关，由归一化后的配置透传进来
   */
  constructor(
    private readonly publisher: SignalPublisher,
    private readonly signals: SignalSubscriber,
    private readonly loafEnabled: boolean,
  ) {}

  // 订阅页面可见性：这是后续所有启停决策的依据，与是否正在采集无关，因此放在 install 完成。
  install(): void {
    if (this.unsubscribeLifecycle) return;
    this.unsubscribeLifecycle = this.signals.subscribe('page.lifecycle', (signal) => {
      if (!this.active) return;
      // 后台页面不继续持有 Observer；恢复时只观察新条目，防止重复读取 buffered 数据。
      if (signal.type === 'hidden' || signal.type === 'pagehide') this.disconnectObserver();
      if (signal.type === 'visible' || signal.type === 'pageshow') this.observe(false);
    });
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    // buffered 仅用于首次启动补齐启动前条目，stop/start 后不能再次回放历史数据。
    this.observe(!this.everStarted);
    this.everStarted = true;
  }

  stop(): void {
    this.active = false;
    this.disconnectObserver();
  }

  destroy(): void {
    this.stop();
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = undefined;
  }

  /** 能力探测结果，供 Core 收集 capabilities；不改变任何内部状态。 */
  supportsLoAF(): boolean {
    return supportsPerformanceEntry('long-animation-frame');
  }

  /**
   * 建立 Observer，四重前置校验缺一不可：处于采集态、功能已开启、环境支持、尚未挂载。
   * 最后一项保证重复调用 observe 是幂等的（例如后台恢复时连续触发两次 pageshow）。
   */
  private observe(buffered: boolean): void {
    if (!this.active || !this.loafEnabled || !this.supportsLoAF() || this.disconnect) return;
    this.disconnect = observePerformanceEntries(
      'long-animation-frame',
      (entry) => this.publishLoAF(entry as LongAnimationFrameEntry),
      buffered,
    );
  }

  /**
   * 把一条条目转换为 LoAF Signal。
   * duration 非法时整体丢弃：连耗时都不可信的条目对下游没有分析价值。
   */
  private publishLoAF(entry: LongAnimationFrameEntry): void {
    if (!this.active || !Number.isFinite(entry.duration)) return;
    const startTime = safeTiming(entry.startTime);
    // Instrumentation 只做浏览器字段的安全提取，不在这里判断业务阈值或上报次数。
    this.publisher.publish('performance.loaf', {
      timestamp: performanceTimeOrigin() + startTime,
      startTime,
      duration: entry.duration,
      blockingDuration: safeTiming(entry.blockingDuration),
      renderStart: safeTiming(entry.renderStart),
      styleAndLayoutStart: safeTiming(entry.styleAndLayoutStart),
      scriptCount: Array.isArray(entry.scripts) ? entry.scripts.length : 0,
    });
  }

  /** 卸载 Observer 并清空句柄，使下一次 observe 能通过「尚未挂载」的幂等校验。 */
  private disconnectObserver(): void {
    this.disconnect?.();
    this.disconnect = undefined;
  }
}
