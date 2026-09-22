/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：为 SDK 内部提供一条类型化的发布订阅通道，把「浏览器里发生的事实」
 * （Raw Signal）从产生它的 Instrumentation 传给解释它的 Collector。
 *
 * 为什么需要它：同一份浏览器事实往往被多个领域消费。例如一次请求返回 500，
 * Network Collector 要生成请求记录，Error Collector 要生成可聚合错误。
 * 有了统一的 Signal 通道，二者只需各自订阅同一信号，既不用互相调用，也不会重复包装浏览器 API。
 *
 * 三条硬性边界：
 *   1. 只同步分发，不做队列、不缓存、不重放历史事件 —— Signal 表达「刚刚发生」的事实；
 *   2. Raw Signal 只在内部短暂传递，既不入发送队列，也不作为上报协议的一部分；
 *   3. 它不是业务用的全局事件总线，不承担重试与持久化，订阅关系随 SDK 生命周期结束而清空。
 * ---------------------------------------------------------------------------
 */

import type { SignalMap, SignalPublisher, SignalSubscriber } from '../signals';

/**
 * 监听器在 Map 中的存储形态。
 * 由于 Map 无法为每个 key 保存各自的具体负载类型，这里用联合类型做「类型擦除」，
 * 具体的信号负载类型由 publish / subscribe 的泛型在对外接口上重新保证。
 */
type AnySignalListener = (signal: SignalMap[keyof SignalMap]) => void;

/**
 * 同时实现发布端与订阅端两个视图：
 * Instrumentation 拿到的是 SignalPublisher（只能发），Collector 拿到的是 SignalSubscriber（只能订），
 * 从类型层面切断「消费者反向驱动数据源」的可能。
 */
export class SignalHub implements SignalPublisher, SignalSubscriber {
  // 按信号类型分桶，每桶一个 Set：天然去重，避免同一个监听器被重复登记导致重复消费。
  private readonly listeners = new Map<keyof SignalMap, Set<AnySignalListener>>();

  /** 广播一条刚刚发生的浏览器事实。没有订阅者时是廉价空操作。 */
  publish<K extends keyof SignalMap>(type: K, signal: SignalMap[K]): void {
    const current = this.listeners.get(type);
    if (!current) return;

    // 同步分发且不缓存 Raw Signal：它只表达刚刚发生的浏览器事实。
    // 复制集合可以避免监听器在回调中退订时影响本轮遍历。
    for (const listener of [...current]) {
      try {
        listener(signal);
      } catch {
        // 一个订阅者的异常不应回传给数据源或宿主页面。
      }
    }
  }

  /**
   * 订阅指定类型的信号，返回退订函数。
   * 退订函数交给调用方自行持有（Collector 通常在 destroy 中调用），Hub 不追踪谁订阅了什么。
   */
  subscribe<K extends keyof SignalMap>(
    type: K,
    listener: (signal: SignalMap[K]) => void,
  ): () => void {
    // 首次订阅时才创建桶，避免为空信号类型常驻一堆空 Set。
    const current = this.listeners.get(type) ?? new Set<AnySignalListener>();
    this.listeners.set(type, current);
    const stored = listener as unknown as AnySignalListener;
    current.add(stored);

    return () => {
      current.delete(stored);
      // 桶空即回收，防止长期运行后 Map 里残留大量空 Set。
      if (current.size === 0) this.listeners.delete(type);
    };
  }

  /** 清空全部订阅关系，由 Monitor.destroy 调用，确保销毁后没有任何回调还能被触发。 */
  clear(): void {
    this.listeners.clear();
  }
}
