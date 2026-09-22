/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：把 SPA 的地址变化统一翻译成 `view.route-change` 信号，
 * 让 View 的开启与结算只需面对一种事实来源，而不必关心它究竟来自哪种导航方式。
 *
 * 为什么必须包装 History API：SPA 的路由跳转既不触发 pagehide 也不触发 pageshow，
 * 只靠原生事件无法感知；而 pushState / replaceState 又没有任何原生事件通知。
 * 因此对它们做「调用即发信号」的包装是唯一可行的观测手段。
 *
 * 三条必须守住的风险底线：
 *   1. 包装是可逆的 —— stop 时必须把原生方法还回去，否则会污染宿主路由，
 *      也可能在重复 start 时造成「包装套包装」的指数级放大；
 *   2. 调用转发必须保持原语义 —— 先调用原生方法再发信号，绝不改变参数与返回值，
 *      且用 apply 显式绑定 history 作为接收者；
 *   3. 初始 View 一生只发一次 —— stop/start 循环不应伪造出一次新的页面跳转。
 * ---------------------------------------------------------------------------
 */

import type { MonitorModule } from '../../core/module-registry';
import type { SignalPublisher } from '../../signals';
import { currentUrl } from '../../shared/url';

/**
 * 包装 History API 并监听前进后退，把 SPA 地址变化统一转换为 View 信号。
 * stop 时必须恢复原生方法，防止重复包装或影响宿主路由。
 */
export class HistoryInstrumentation implements MonitorModule {
  readonly name = 'history-instrumentation';
  private active = false;
  // 初始 View 的一次性闸门：与 active 分开记录，因为 active 会随 stop 复位。
  private initialPublished = false;
  // 原生方法备份，卸载时按它还原。
  private originalPushState: History['pushState'] | undefined;
  private originalReplaceState: History['replaceState'] | undefined;
  // 包装体引用，卸载前用它核对「当前挂载的确实是自己」，避免误还原宿主后续替换的方法。
  private wrappedPushState: History['pushState'] | undefined;
  private wrappedReplaceState: History['replaceState'] | undefined;

  // 只注入发布端：本模块负责产生事实，不订阅任何信号。
  constructor(private readonly publisher: SignalPublisher) {}

  // 全局监听随 start / stop 挂卸，安装期无需做任何事。
  install(): void {}

  start(): void {
    if (this.active) return;
    this.active = true;
    // 先包装再发初始信号：保证 initial 事件发生时，后续跳转已经能被观测到。
    this.wrapHistory();
    // popstate 覆盖前进后退，hashchange 覆盖锚点变化，二者与包装后的 History 互为补充。
    window.addEventListener('popstate', this.handlePopState);
    window.addEventListener('hashchange', this.handleHashChange);

    // 初始 View 在 SDK 整个生命周期内只发布一次，stop/start 不应伪造一次页面跳转。
    if (!this.initialPublished) {
      this.initialPublished = true;
      this.publish('initial');
    }
  }

  // 与 start 严格对称：先摘事件监听，再还原原生方法，确保 stop 之后不再产生任何路由信号。
  stop(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('popstate', this.handlePopState);
    window.removeEventListener('hashchange', this.handleHashChange);
    this.restoreHistory();
  }

  // 无额外持久状态，还原 History 即完成销毁。
  destroy(): void {
    this.stop();
  }

  /** 替换 history.pushState / replaceState 为「先转发、再发信号」的包装版本。
   * SPA 路由跳转调用的是 history.pushState()，但这个调用没有任何原生事件（不像 popstate 有事件）。
   * 所以想感知路由变化，只有一个办法：把这个方法本身换掉。
   */
  private wrapHistory(): void {
    // 已包装过则不再包装：这一行是防止「包装套包装」导致信号被重复放大的关键闸门。
    if (this.originalPushState || this.originalReplaceState) return;
    // 原生方法会在包装函数中通过 apply 显式恢复 History 接收者。
    // eslint-disable-next-line @typescript-eslint/unbound-method
    this.originalPushState = history.pushState;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    this.originalReplaceState = history.replaceState;
    const originalPushState = this.originalPushState;
    const originalReplaceState = this.originalReplaceState;

    // 顺序不可颠倒：先让宿主路由完成跳转，再发信号，
    // 这样信号里的 url 才是跳转后的新地址，宿主也不会被观测行为阻塞。
    this.wrappedPushState = (...args: Parameters<History['pushState']>): void => {
      originalPushState.apply(history, args);
      this.publish('history');
    };
    this.wrappedReplaceState = (...args: Parameters<History['replaceState']>): void => {
      originalReplaceState.apply(history, args);
      this.publish('history');
    };

    history.pushState = this.wrappedPushState;
    history.replaceState = this.wrappedReplaceState;
  }

  /** 还原原生方法并清空全部句柄，使下一次 start 能重新干净地包装。 */
  private restoreHistory(): void {
    // 身份核对：只有当前挂载的确实是本模块的包装体时才还原，
    // 否则说明宿主在中间替换过 history 方法，贸然还原会覆盖宿主的改动。
    if (this.originalPushState && history.pushState === this.wrappedPushState) {
      history.pushState = this.originalPushState;
    }
    if (this.originalReplaceState && history.replaceState === this.wrappedReplaceState) {
      history.replaceState = this.originalReplaceState;
    }
    this.originalPushState = undefined;
    this.originalReplaceState = undefined;
    this.wrappedPushState = undefined;
    this.wrappedReplaceState = undefined;
  }

  // 箭头函数属性固定 this，保证 add / remove 引用同一个函数。
  private readonly handlePopState = (): void => this.publish('popstate');
  private readonly handleHashChange = (): void => this.publish('hashchange');

  /** 统一出口：非采集态直接丢弃（例如 stop 之后仍被触发的异步事件）。 */
  private publish(source: 'initial' | 'history' | 'popstate' | 'hashchange'): void {
    if (!this.active) return;
    this.publisher.publish('view.route-change', {
      timestamp: Date.now(),
      url: currentUrl(),
      source,
    });
  }
}
