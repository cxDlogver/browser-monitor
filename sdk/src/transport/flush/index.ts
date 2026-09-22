/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：Transport 本体 —— 发送链路的调度中心。
 *
 * 它自己不产生数据、也不知道数据怎么发出去，只负责四件事：
 *   1. 接收：enqueue 同步入队，绝不阻塞调用方；
 *   2. 调度：定时、攒够一批、页面进入后台、stop、destroy 五个时机触发冲刷；
 *   3. 冲刷：把队列按批次取干净并交给 Sender，失败则保留数据等下次；
 *   4. 清理：stop/destroy 时关定时器、退订信号、必要时清空队列。
 *
 * 两条硬约束：
 *   - 任何异常都不允许传播到业务调用栈（这里的 flush 全部用 void 吞掉 Promise）；
 *   - 同一时刻只允许一个 drain 循环消费队列（由 flushing 单一 Promise 保证）。
 *
 * 边界：它认识队列与批次，但不认识 HTTP；怎么发由注入的 Sender 决定。
 * ---------------------------------------------------------------------------
 */

import type { MonitorModule } from '../../core/module-registry';
import type { SignalSubscriber } from '../../signals';
import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';
import { takeBatch } from '../batch';
import { MemoryQueue } from '../queue';
import { sendWithRetry, type RetryOptions } from '../retry';
import type { Sender } from '../sender';

/** 全部字段来自归一化配置，这里不再做任何默认值兜底。 */
export interface TransportOptions {
  /** 队列容量上限：内存兜底，超过后按优先级淘汰。 */
  maxQueueSize: number;
  /** 单批最大条数：攒够即触发一次冲刷。 */
  batchSize: number;
  /** 单批最大字节：防止请求体过大被网关拒绝。 */
  maxBatchBytes: number;
  /** 周期冲刷间隔。 */
  flushIntervalMs: number;
  retry: RetryOptions;
}

export class Transport implements MonitorModule {
  readonly name = 'transport';
  private readonly queue: MemoryQueue;
  // 周期冲刷定时器句柄；start 时创建，stop/destroy 时必须清理，否则会泄漏。
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeLifecycle: (() => void) | undefined;
  // 采集态闸门：false 时 enqueue 直接丢弃，保证 destroy 之后不再产生任何网络请求。
  private active = false;
  // 进行中的冲刷 Promise，用于合并并发调用；非空表示「正在 drain」。
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly options: TransportOptions,
    private readonly sender: Sender,
    private readonly signals: SignalSubscriber,
  ) {
    this.queue = new MemoryQueue(options.maxQueueSize);
  }

  // 订阅页面生命周期：这是「页面要没了」的唯一可靠信号，放在 install 里一生只建立一次。
  install(): void {
    if (this.unsubscribeLifecycle) return;
    this.unsubscribeLifecycle = this.signals.subscribe('page.lifecycle', (signal) => {
      // 页面即将进入后台或离开时优先尝试 Beacon，提高尾部数据送达概率。
      if (signal.type === 'hidden' || signal.type === 'pagehide') void this.flush(true);
    });
  }

  // 开启周期冲刷；stop 之后可以再次 start 恢复。
  start(): void {
    if (this.active) return;
    this.active = true;
    // void 而非 await：定时任务里的异常绝不能冒泡成未处理的 Promise 拒绝。
    this.timer = setInterval(() => void this.flush(false), this.options.flushIntervalMs);
  }

  // 暂停：先关定时器再冲刷残留，之后 enqueue 会直接丢弃，但队列里的数据仍会保留。
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.clearTimer();
    void this.flush(false);
  }

  // 终态：关定时器、退订信号，用 Beacon 做最后一次抢救，无论成败都清空队列。
  destroy(): void {
    this.active = false;
    this.clearTimer();
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = undefined;
    void this.flush(true).finally(() => this.queue.clear());
  }

  /**
   * 入队：唯一的写入口，必须保持同步且廉价，因为它在数据的采集调用栈上执行。
   */
  enqueue(envelope: TelemetryEnvelope): void {
    if (!this.active) return; // 未启动或已销毁 → 直接丢弃
    this.queue.enqueue(envelope);
    // 攒够一批立即冲刷，避免低频数据白等一个定时周期。
    if (this.queue.size >= this.options.batchSize) void this.flush(false);
  }

  /**
   * 冲刷队列。
   * @param preferBeacon true 表示页面即将离开，优先用 sendBeacon 提高送达概率
   * @returns 同一个冲刷 Promise（并发调用会被合并，不会重复消费队列）
   */
  flush(preferBeacon: boolean = false): Promise<void> {
    // 合并并发 flush，确保同一队列不会被多个 drain 循环同时消费。
    if (this.flushing) return this.flushing;

    this.flushing = this.drain(preferBeacon).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  getDroppedCount(): number {
    return this.queue.droppedCount;
  }

  /** 循环把队列取空：每轮切一批、发一批，直到队列为空或发送失败。 */
  private async drain(preferBeacon: boolean): Promise<void> {
    while (this.queue.size > 0) {
      const batch = takeBatch(this.queue, this.options.batchSize, this.options.maxBatchBytes);
      if (batch.length === 0) return; // 切不出批次 → 退出，避免死循环

      const sent = await sendWithRetry(this.sender, batch, preferBeacon, this.options.retry);
      // 失败即停：剩余数据留在队列里等下一个冲刷时机，而不是继续消耗重试配额。
      if (!sent) return;
      // Beacon 只用于离开页面时的第一批；后续批次回到可判断响应状态的 fetch。
      preferBeacon = false;
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
