/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：内存队列 —— 发送链路的缓冲区，也是最后一道内存防线。
 *
 * 它解决两个问题：
 *   1. 削峰：采集是突发的，发送是批量的，中间需要一个缓冲；
 *   2. 限容：页面再怎么疯狂产生数据，内存占用也不会突破 capacity。
 *
 * 满的时候不是简单丢弃新数据，而是**按优先级淘汰**：
 * 承担链路还原职责的 view / event 优先保留，可聚合的性能诊断数据先被牺牲。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';

interface QueueItem {
  envelope: TelemetryEnvelope;
  priority: number;
}

// View 与业务事件承担链路还原作用，队列压力下优先于可聚合的性能诊断数据。
function priorityOf(envelope: TelemetryEnvelope): number {
  if (envelope.type === 'view') return 2;
  if (envelope.type === 'event') return 2;
  return 1;
}

export class MemoryQueue {
  // 用数组而非链表：容量有上限（默认 200），线性扫描的成本完全可接受。
  private readonly items: QueueItem[] = [];
  // 累计丢弃数，对外可观测（getDroppedCount）。
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  enqueue(envelope: TelemetryEnvelope): void {
    const incoming: QueueItem = { envelope, priority: priorityOf(envelope) };
    if (this.items.length < this.capacity) {
      this.items.push(incoming);
      return;
    }

    // 只在遇到更低优先级时更新，因此同优先级下淘汰最早进入队列的数据。
    let lowestIndex = 0;
    for (let index = 1; index < this.items.length; index += 1) {
      const item = this.items[index];
      const lowest = this.items[lowestIndex];
      if (item && lowest && item.priority < lowest.priority) lowestIndex = index;
    }

    const lowest = this.items[lowestIndex];
    // 新数据优先级不低于最低者才替换；否则新数据被丢弃（低优先级不能顶掉高优先级）。
    if (lowest && incoming.priority >= lowest.priority) {
      this.items.splice(lowestIndex, 1);
      this.items.push(incoming);
    }
    // 队列已满必然意味着丢了一条：要么淘汰了旧的，要么新数据自己被拒。
    this.dropped += 1;
  }

  /** 从队首取走指定条数，供切批使用。 */
  take(count: number): TelemetryEnvelope[] {
    return this.items.splice(0, count).map((item) => item.envelope);
  }

  // 批处理因字节上限未消费的数据必须放回队首，维持原始事件顺序。
  prepend(envelopes: readonly TelemetryEnvelope[]): void {
    this.items.unshift(
      ...envelopes.map((envelope) => ({ envelope, priority: priorityOf(envelope) })),
    );
    // 回退后可能超出容量：从队尾丢弃（保住队首的顺序与较新的数据）。
    while (this.items.length > this.capacity) {
      this.items.pop();
      this.dropped += 1;
    }
  }

  /** 清空队列，仅由 Transport.destroy 在最后一次冲刷之后调用。 */
  clear(): void {
    this.items.length = 0;
  }
}
