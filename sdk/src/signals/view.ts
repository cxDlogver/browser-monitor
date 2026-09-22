/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：定义「页面可见性 / 页面存续」领域的 Raw Signal。
 *
 * 它们回答的是同一个问题的两个侧面：这个页面现在还活着吗？它现在指向哪个地址？
 *   - PageLifecycleSignal：页面是否被看到、是否被缓存（BFCache）；
 *   - RouteChangeSignal：页面的地址何时、因何发生了变化。
 *
 * 两者都是「纯事实」：不带 session、user、viewId 等上下文（由 Context 在快照阶段注入），
 * 也不表达任何采集决策（该不该暂停采集由订阅方自行判断）。
 * ---------------------------------------------------------------------------
 */

/**
 * 页面生命周期事实，由 PageLifecycleInstrumentation 发布。
 * 下游可据此暂停后台采集、结束 View 停留、或在页面离开前冲刷发送队列。
 */
export interface PageLifecycleSignal {
  /** 可见性变化走 visible / hidden；页面进出走 pagehide / pageshow。 */
  type: 'visible' | 'hidden' | 'pagehide' | 'pageshow';
  /** 事实发生的墙钟时间（Date.now()）。 */
  timestamp: number;
  /**
   * 是否来自 BFCache：true 表示页面被完整保留，后续可能被原样恢复而非重新加载。
   * visible / hidden 无此概念，统一为 false。
   */
  persisted: boolean;
}

/**
 * 路由变更事实，由 HistoryInstrumentation 发布。
 * 下游的 ViewContext 据此开启新 View，并结算上一个 View 的停留时长。
 */
export interface RouteChangeSignal {
  timestamp: number;
  /** 变更后的地址。 */
  url: string;
  /**
   * 变更来源，决定了 View 是否需要重新计数：
   * initial 首次加载 / history pushState / popstate 前进后退 / hashchange 锚点变化 / bfcache 从缓存恢复。
   */
  source: 'initial' | 'history' | 'popstate' | 'hashchange' | 'bfcache';
}
