/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：把第三方库 web-vitals 采集到的 LCP / FCP / INP / CLS 指标，
 * 翻译成 SDK 内部的 `performance.web-vital` 信号。
 *
 * 为什么不直接用 PerformanceObserver：Web Vitals 的计算口径相当复杂
 * （候选值取舍、交互归因、软导航、页面隐藏时的结算时机等），
 * 自己实现既容易与官方口径不一致，又要承担持续的规范跟进成本。
 * 这里选择复用官方库，本模块只负责「接入 + 翻译 + 兜底」。
 *
 * 因此本模块有三个与其他 Instrumentation 明显不同的特点：
 *   1. 底层监听**无法卸载** —— web-vitals 不返回取消句柄，所以监听只安装一次，
 *      启停与销毁一律靠 active / destroyed 两个状态门控来「软关闭」；
 *   2. 注册发生在 start 而非 install —— 避免 createMonitor 这一纯构造动作产生浏览器副作用；
 *   3. 能力探测与开关解耦 —— capabilities 只看浏览器是否支持，不看用户是否启用。
 * ---------------------------------------------------------------------------
 */

import { onCLS, onFCP, onINP, onLCP, type Metric } from 'web-vitals';

import type { MonitorModule } from '../../core/module-registry';
import type { SignalPublisher } from '../../signals';
import type {
  PerformanceCapabilityMap,
  PerformanceMetricName,
  PerformanceNavigationType,
} from '@browser-monitor/protocol';
import { performanceTimeOrigin } from '../../shared/time';

// 从全局指标名中收敛出本模块负责的四个，避免 register 时传入 TTFB 之类的无效项。
type WebVitalName = Extract<PerformanceMetricName, 'LCP' | 'FCP' | 'INP' | 'CLS'>;

export interface WebVitalsInstrumentationOptions {
  /** 逐项开关：关闭的指标根本不会注册回调，也就不会产生任何监听开销。 */
  enabled: Readonly<Record<WebVitalName, boolean>>;
  /** 是否上报指标的每次变化；false 时只在最终值确定后上报一次。 */
  reportAllChanges: boolean;
  /** 是否按软导航（SPA 路由切换）重新计算指标。 */
  reportSoftNavs: boolean;
}

/** 底层 PerformanceEntry 类型是否可用，用于生成能力表。 */
function supportsEntry(type: string): boolean {
  return (
    typeof PerformanceObserver !== 'undefined' &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes(type)
  );
}

/**
 * 把第三方库的导航类型收敛到本 SDK 的协议枚举。
 * 用白名单比对而非直接断言：未来 web-vitals 新增类型时回落到 'navigate'，
 * 而不是把未知字符串写进上报协议里。
 */
function navigationType(value: Metric['navigationType']): PerformanceNavigationType {
  const allowed: readonly PerformanceNavigationType[] = [
    'navigate',
    'reload',
    'back-forward',
    'back-forward-cache',
    'prerender',
    'restore',
    'soft-navigation',
  ];
  return allowed.includes(value) ? value : 'navigate';
}

/**
 * 取最后一条 entry 的 startTime 作为指标发生时间。
 * web-vitals 条目使用相对 timeOrigin 的时间，这里转换为可与业务事件比较的绝对时间。
 * 取不到有效值时退回 Date.now()：宁可时间略偏，也不能产出 NaN 让下游整条数据报废。
 */
function metricTimestamp(metric: Metric): number {
  const lastEntry = metric.entries.at(-1);
  return lastEntry && Number.isFinite(lastEntry.startTime)
    ? performanceTimeOrigin() + lastEntry.startTime
    : Date.now();
}

export class WebVitalsInstrumentation implements MonitorModule {
  readonly name = 'web-vitals-instrumentation';
  // 采集态门控：stop 时置 false，回调仍会被第三方库触发，但在这里被挡下。
  private active = false;
  // 底层监听是否已安装。由于无法卸载，它一生只能从 false 翻到 true。
  private installed = false;
  // 终态标记：一旦为 true，之后所有回调都被永久丢弃，即使再次 start 也不恢复。
  private destroyed = false;

  constructor(
    private readonly options: WebVitalsInstrumentationOptions,
    private readonly publisher: SignalPublisher,
  ) {}

  install(): void {
    // web-vitals 在首次 start 时才注册，避免 createMonitor 本身产生浏览器副作用。
  }

  start(): void {
    // destroyed 优先：销毁后即使被误调用 start，也不允许重新打开数据出口。
    if (this.destroyed) return;
    this.active = true;
    // 已安装过就只恢复 active，不再重复注册 —— 重复注册会让同一个指标被上报多次。
    if (this.installed) return;

    // web-vitals 不返回取消句柄，因此底层监听只安装一次，后续启停依靠状态门控。
    this.installed = true;
    const reportOptions = {
      reportAllChanges: this.options.reportAllChanges,
      reportSoftNavs: this.options.reportSoftNavs,
    };
    // 四个指标共用一个回调：上报逻辑完全一致，只有类型收窄与开关过滤不同。
    const report = (metric: Metric): void => {
      // 三重门控：当前是否在采集、是否已销毁、是否为本 SDK 支持的指标。
      if (!this.active || this.destroyed) return;
      if (
        metric.name !== 'LCP' &&
        metric.name !== 'FCP' &&
        metric.name !== 'INP' &&
        metric.name !== 'CLS'
      ) {
        return;
      }

      // 到此处 metric.name 已被收窄为 WebVitalName，可以安全地作为 Signal 发布。
      this.publisher.publish('performance.web-vital', {
        name: metric.name,
        metricId: metric.id,
        value: metric.value,
        delta: metric.delta,
        rating: metric.rating,
        navigationType: navigationType(metric.navigationType),
        navigationId: metric.navigationId,
        timestamp: metricTimestamp(metric),
      });
    };

    // 惰性注册：传的是 thunk 而非调用结果，未启用的指标连第三方库函数都不会被执行。
    this.register('LCP', () => onLCP(report, reportOptions));
    this.register('FCP', () => onFCP(report, reportOptions));
    this.register('INP', () => onINP(report, reportOptions));
    this.register('CLS', () => onCLS(report, reportOptions));
  }

  // 软停止：底层监听仍在，但回调出口被关闭；再次 start 可以零成本恢复采集。
  stop(): void {
    this.active = false;
  }

  destroy(): void {
    // web-vitals 无法物理卸载监听；destroy 后永久关闭回调出口，保证不再产生 SDK 数据。
    this.active = false;
    this.destroyed = true;
  }

  /**
   * 能力表示当前浏览器是否具备底层 API，与用户是否启用该指标无关。
   * INP 的判断最严格：除 event 条目外，还要求 PerformanceEventTiming 存在且带 interactionId 原型属性，
   * 因为缺少 interactionId 的浏览器无法完成交互归因，算出来的 INP 不可信。
   */
  capabilities(): Pick<PerformanceCapabilityMap, WebVitalName> {
    return Object.freeze({
      LCP: supportsEntry('largest-contentful-paint'),
      FCP: supportsEntry('paint'),
      INP:
        supportsEntry('event') &&
        typeof PerformanceEventTiming !== 'undefined' &&
        'interactionId' in PerformanceEventTiming.prototype,
      CLS: supportsEntry('layout-shift'),
    });
  }

  /**
   * 按开关注册单个指标，并把第三方库的异常吞掉。
   * 监控库绝不能因为自身注册失败而让宿主页面崩溃，这是所有 Instrumentation 的共同底线。
   */
  private register(name: WebVitalName, callback: () => void): void {
    if (!this.options.enabled[name]) return;
    try {
      callback();
    } catch {
      // 浏览器能力缺失或实现不完整时静默降级，不能影响宿主页面。
    }
  }
}
