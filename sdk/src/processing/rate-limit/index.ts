/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第七道关卡（最后一道闸门）——限制单位时间内的事件数量。
 *
 * 它是 SDK 的自我保护的最后防线：无论上游产生多少数据，
 * 进入发送队列的量都不会超过「每窗口 maxEvents 条」。
 *
 * 两个关键取舍：
 *   1. 窗口按 envelope.timestamp（数据发生时间）划分，而不是 Date.now()，
 *      这样被限的是「某一段时间的数据」，而不是「某一段处理时间」；
 *   2. 显式处理「时间倒流」（时钟回拨、手工构造数据），否则 windowStartedAt
 *      可能永远不复位，造成计数永久卡死的死窗口。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV3 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { ProcessingStage } from '../pipeline';

export class RateLimitStage implements ProcessingStage {
  readonly name = 'rate-limit';
  // 当前窗口起点；0 表示尚未开启任何窗口。
  private windowStartedAt = 0;
  private count = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
  ) {}

  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
    // 三个条件任一成立就开启新窗口：首次进入 / 时间倒流 / 已超出当前窗口。
    if (
      this.windowStartedAt === 0 ||
      envelope.occurredAt < this.windowStartedAt ||
      envelope.occurredAt - this.windowStartedAt >= this.windowMs
    ) {
      this.windowStartedAt = envelope.occurredAt;
      this.count = 0;
    }

    // 额度用尽即丢弃；注意额度只被「通过前面六关的数据」消耗。
    if (this.count >= this.maxEvents) return undefined;
    this.count += 1;
    return envelope;
  }
}
