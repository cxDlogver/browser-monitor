import type { RouteLocation } from '../core/config';
import { currentUrl } from '../shared/url';
import type { AppContextData, TelemetryContext, UserContextData } from '@browser-monitor/protocol';

import { AppContext } from './app-context';
import { RuntimeContext } from './runtime-context';
import { SessionContext } from './session-context';
import { UserContext } from './user-context';
import { ViewContext, type ViewRecord, type ViewSource } from './view-context';

/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：作为「上下文的门面」，把散落在 app / user / session / runtime / view
 * 五个独立上下文对象里的数据，在某一时刻聚合成一份可直接附在上报数据上的快照。
 *
 * 设计要点：
 *   1. 上下文是「随取随用」的活数据，快照才是「上报那一刻的定格」，
 *      因此外部永远通过 snapshotAt / snapshotForView 取值，而不是直接读取上下文字段；
 *   2. 所有快照携带的 timestamp 是事件发生时间而非处理时间，保证延迟上报的数据仍归属正确的 View；
 *   3. Manager 自身不感知易变的浏览器 API（除 URL 兜底），具体取值策略下沉到各 Context 类。
 * ---------------------------------------------------------------------------
 */

export interface ContextManagerOptions {
  app: AppContextData;
  resolveRouteName?: (location: RouteLocation) => string | undefined;
}

/** 上下文门面：统一持有各维度的 Context，并负责把它们组装成上报用的 TelemetryContext。 */
export class ContextManager {
  // 以下四项与单元同生共死，不随启停变化：应用身份、用户、会话、运行时环境。
  readonly app: AppContext;
  readonly user = new UserContext();
  readonly session = new SessionContext();
  readonly runtime = new RuntimeContext();
  // View 需要业务路由解析器，因此在构造函数中创建。
  readonly view: ViewContext;

  constructor(options: ContextManagerOptions) {
    this.app = new AppContext(options.app);
    this.view = new ViewContext(options.resolveRouteName);
  }

  /**
   * 开启一个新 View，返回新记录与被打断的旧记录（无则返回 undefined）。
   * 通常由 History / Page Lifecycle Instrumentation 在导航或可见性变化时调用。
   */
  startView(
    url: string,
    timestamp: number,
    source: ViewSource,
  ): {
    current: ViewRecord;
    previous?: ViewRecord;
  } {
    return this.view.start(url, timestamp, source);
  }

  /** 结束当前 View，返回被结束的记录供调用方补齐停留时长等指标。 */
  endView(timestamp: number): ViewRecord | undefined {
    return this.view.end(timestamp);
  }

  /** 更新用户身份；允许在 start 之前调用，因此不受生命周期状态限制。 */
  setUser(user: UserContextData): void {
    this.user.set(user);
  }

  /**
   * 按事件发生时间取快照，是绝大多数采集路径的入口。
   * 用事件时间而非处理时间去匹配 View，队列积压或延迟上报的数据才不会被挂到错误的页面上。
   */
  // timestamp 是数据发生时间，而不是进入处理管线的时间。
  snapshotAt(timestamp: number): TelemetryContext {
    let view = this.view.resolveAt(timestamp);
    // History Instrumentation 尚未产生初始信号时，保证首条数据仍有合法 View。
    if (!view) view = this.startView(currentUrl(), timestamp, 'initial').current;
    return this.snapshotForView(view);
  }

  /**
   * 针对已知 View 组装快照：调用方已经确定归属页面时走这条路径，省去一次时间匹配。
   */
  snapshotForView(view: ViewRecord): TelemetryContext {
    const user = this.user.snapshot();
    // 冻结后作为不可变载荷下发，防止下游管线加工时被中途改写。
    return Object.freeze({
      sessionId: this.session.snapshot().sessionId,
      viewId: view.viewId,
      routeName: view.routeName,
      url: view.url,
      runtime: this.runtime.snapshot(),
      // 未登录时不产生 user 字段，避免上报体里出现空对象噪声。
      ...(user ? { user } : {}),
    });
  }

  /** 清理可变的用户态数据；session 与 runtime 属于进程级信息，随实例回收即可。 */
  destroy(): void {
    this.view.clear();
    this.user.clear();
  }
}
