/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：给一次发送加上重试策略。
 *
 * 三个必须回答的问题：
 *   1. 要不要重试？—— 由 SendResult.retryable 决定（4xx 通常是请求本身有问题，重试无意义）；
 *   2. 重试多久？—— 指数退避，失败越多次等越久，避免持续冲击故障中的服务；
 *   3. 会不会惊群？—— 叠加随机抖动，否则服务恢复瞬间所有客户端会同时打过来。
 *
 * 边界：本模块只管「重试几次、等多久」，不知道 HTTP、也不碰队列。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV3 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { Sender } from '../sender';

export interface RetryOptions {
  /** 最大尝试次数（含首次）。 */
  maxAttempts: number;
  /** 退避基数，实际等待 = baseDelayMs * 2^(n-1) + 抖动。 */
  baseDelayMs: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 发送一批数据并按策略重试。
 * @param preferBeacon 仅首次尝试生效：Beacon 拿不到响应状态，失败后必须回到 fetch
 * @returns 是否发送成功；false 表示数据仍应留在队列中
 */
export async function sendWithRetry(
  sender: Sender,
  batch: readonly TelemetryEnvelope[],
  preferBeacon: boolean,
  options: RetryOptions,
): Promise<boolean> {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    // Beacon 只用于首次：它没有「响应状态」的概念，失败后必须换回 fetch 才能判断是否重试。
    const result = await sender.send(batch, preferBeacon && attempt === 1);
    if (result.success) return true;
    // 不可重试（如 4xx）或已到次数上限 → 放弃，交给调用方决定数据去留。
    if (!result.retryable || attempt === options.maxAttempts) return false;

    // 指数退避叠加随机抖动，避免大量客户端在服务恢复瞬间同时重试。
    // 2^(attempt-1)：500ms → 1000ms → 2000ms；抖动区间 [0, baseDelayMs)。
    const jitter = Math.floor(Math.random() * options.baseDelayMs);
    await delay(options.baseDelayMs * 2 ** (attempt - 1) + jitter);
  }

  return false;
}
