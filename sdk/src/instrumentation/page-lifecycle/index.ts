/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：把浏览器分散的页面生命周期事件（visibilitychange / pagehide / pageshow）
 * 统一翻译成一种内部信号 `page.lifecycle`，让下游模块不必各自去监听同一批原生事件。
 *
 * 它是 SDK 里少数「所有模块都会关心」的公共事实源：
 *   - 采集器据此暂停后台页面的采集（如关闭 PerformanceObserver）；
 *   - View 据此处理 BFCache 往返（persisted）与停留时长；
 *   - Transport 据此在页面离开前立即冲刷队列，避免数据丢失。
 *
 * 设计约定：
 *   1. 只做事件到信号的直译，不判断「该不该采」，也不携带上下文；
 *   2. 时间戳统一取 Date.now()（墙钟时间），与性能类信号的时间基准由下游自行对齐；
 *   3. 监听器用箭头函数属性固定 this，保证 add / remove 引用的是同一个函数；
 *   4. 不在 install 阶段注册（install 只在首启一次性执行），而是在 start / stop 中随采集状态挂卸，
 *      这样 stop 之后不会再有任何信号产生。
 * ---------------------------------------------------------------------------
 */

import type { MonitorModule } from '../../core/module-registry';
import type { SignalPublisher } from '../../signals';

/**
 * 将 visibility/Page Transition API 统一成内部信号，供采集器暂停工作、
 * View 处理 BFCache，并让 Transport 在页面离开前刷新队列。
 */
export class PageLifecycleInstrumentation implements MonitorModule {
  readonly name = 'page-lifecycle-instrumentation';
  // 挂卸状态的唯一标志：既防重复注册，也保证 stop 时确实解绑过。
  private active = false;

  // 只注入发布端：本模块无权订阅，职责被限制为「产生事实」。
  constructor(private readonly publisher: SignalPublisher) {}

  // 无全局副作用需要在安装期完成：监听器随 start / stop 挂卸，故此处为空实现。
  install(): void {}

  start(): void {
    if (this.active) return;
    this.active = true;
    // 三个事件各司其职：visibilitychange 覆盖切后台/切回，pagehide/pageshow 覆盖离开与 BFCache 往返。
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);
  }

  // 严格对称解绑：必须传入与注册时同一个函数引用，这也是监听器写成箭头函数属性的原因。
  stop(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('pagehide', this.handlePageHide);
    window.removeEventListener('pageshow', this.handlePageShow);
  }

  // 本模块没有需要显式清理的持久状态，解除监听即完成销毁。
  destroy(): void {
    this.stop();
  }

  /** 可见性变化。visibilitychange 不携带 persisted 概念，此处统一填 false。 */
  private readonly handleVisibility = (): void => {
    this.publisher.publish('page.lifecycle', {
      type: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      timestamp: Date.now(),
      persisted: false,
    });
  };

  /** 页面离开。persisted 为 true 表示进入 BFCache，页面后续可能被原样恢复。 */
  private readonly handlePageHide = (event: PageTransitionEvent): void => {
    this.publisher.publish('page.lifecycle', {
      type: 'pagehide',
      timestamp: Date.now(),
      persisted: event.persisted,
    });
  };

  /** 页面展示，包含首次加载与从 BFCache 恢复两种情况，靠 persisted 区分。 */
  private readonly handlePageShow = (event: PageTransitionEvent): void => {
    this.publisher.publish('page.lifecycle', {
      type: 'pageshow',
      timestamp: Date.now(),
      persisted: event.persisted,
    });
  };
}
