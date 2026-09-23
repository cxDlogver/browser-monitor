/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：把队列里的数据切成「一批」。
 *
 * 为什么要切批：一条一个请求会把网络打满，也会把服务端压垮；攒批发送是监控 SDK 的通行做法。
 *
 * 两个上限同时生效：
 *   - maxCount：条数上限，避免一次取出太多；
 *   - maxBytes：字节上限，避免请求体过大被网关直接拒绝。
 *
 * 关键细节是「首条豁免」：第一条即使超过字节上限也必须发出去，
 * 否则它会被反复放回队首，造成队首阻塞（head-of-line blocking），后面所有数据永远发不出去。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV3 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { MemoryQueue } from '../queue';

/**
 * 从队列切出一批。
 * @param maxCount 单批最大条数
 * @param maxBytes 单批最大字节（按 JSON 序列化后的长度估算）
 */
export function takeBatch(
  queue: MemoryQueue,
  maxCount: number,
  maxBytes: number,
): TelemetryEnvelope[] {
  // 先按条数取出候选，再逐条按字节筛选：条数是硬切，字节是软切。
  const candidates = queue.take(maxCount);
  const batch: TelemetryEnvelope[] = [];
  let bytes = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const envelope = candidates[index];
    if (!envelope) continue;

    // 以序列化后的长度估算体积；简单可靠，代价是多一次 stringify。
    const nextBytes = JSON.stringify(envelope).length;
    // 首条即使超限也必须发送，否则它会被永久放回队首并阻塞后续事件。
    if (batch.length > 0 && bytes + nextBytes > maxBytes) {
      queue.prepend(candidates.slice(index));
      break;
    }

    batch.push(envelope);
    bytes += nextBytes;
  }

  return batch;
}
