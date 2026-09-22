/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第五道关卡 —— 在时间窗口内抑制完全重复的数据。
 *
 * 解决的场景：同一个事实被重复触发（抖动的长任务、连续相同的采样窗口、
 * 被重复包装的 API），导致同一份数据在短时间内刷屏。
 *
 * 关键取舍：
 *   1. 指纹不含 timestamp / eventId —— 否则每条都独一无二，去重永远不生效；
 *   2. 指纹含 sessionId + viewId —— 只在「同一次会话、同一个页面」内判重，
 *      不同页面上的相同指标各自保留；
 *   3. 窗口可配置为 0 —— 表示关闭去重，直接放行。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { ProcessingStage } from '../pipeline';

// timestamp 和 eventId 不参与指纹；同一 View 内语义与 payload 完全相同才视为重复。
function fingerprint(envelope: TelemetryEnvelope): string {
  return JSON.stringify([
    envelope.type,
    envelope.name,
    envelope.context.sessionId,
    envelope.context.viewId,
    envelope.correlation,
    envelope.payload,
  ]);
}

export class DedupeStage implements ProcessingStage {
  readonly name = 'dedupe';
  // 指纹 → 上次出现的时间戳。只存时间不存信封，避免长时间持有已上报数据阻碍回收。
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
    if (this.windowMs === 0) return envelope; // 窗口为 0 即关闭去重

    const key = fingerprint(envelope);
    const previous = this.seen.get(key);
    // 先记录本次时间，再清理、再判断：保证窗口计算始终基于「上一次出现」。
    this.seen.set(key, envelope.occurredAt);
    this.prune(envelope.occurredAt);

    // 距离上次出现仍在窗口内 → 视为重复，丢弃。
    return previous !== undefined && envelope.occurredAt - previous <= this.windowMs
      ? undefined
      : envelope;
  }

  /** 清理过期指纹，防止 Map 无限增长。 */
  private prune(now: number): void {
    // 小规模时不主动扫描；超过阈值后再清理过期项，控制高频场景的常态成本。
    // 扫描成本 O(n) 但摊薄到每 500 条以上才发生一次。
    if (this.seen.size < 500) return;
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp > this.windowMs) this.seen.delete(key);
    }
  }
}
