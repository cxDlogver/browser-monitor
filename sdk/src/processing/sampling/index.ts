/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第六道关卡 —— 按比例抽样，且必须是「稳定抽样」。
 *
 * 为什么不能用 Math.random()：随机采样会让同一次访问里出现碎片数据
 * （有 view.start 却没有 view.end、有请求却没有结果），服务端无法还原任何完整链路。
 *
 * 稳定抽样的做法：把「会话 + 类型 + 名称」拼成键做哈希，映射到 [0,1]。
 * 于是同一次会话里的同类事件要么全采、要么全不采 ——
 * 牺牲的是样本数，保住的是「每次访问内部的数据完整性」。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { ProcessingStage } from '../pipeline';

/** FNV-1a 32 位哈希：确定性、分布均匀、实现极简，适合做稳定分桶。 */
function stableRatio(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

export class SamplingStage implements ProcessingStage {
  readonly name = 'sampling';

  /** @param rate 采样率，取值 [0,1]，由归一化配置保证 */
  constructor(private readonly rate: number) {}

  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
    if (this.rate >= 1) return envelope; // 全采：直接短路，省掉哈希计算
    if (this.rate <= 0) return undefined; // 全不采

    // 键里刻意不含 eventId 与 timestamp：保证同一会话同类事件的判定结果恒定。
    const key = [envelope.context.sessionId, envelope.type, envelope.name].join(':');
    return stableRatio(key) < this.rate ? envelope : undefined;
  }
}
