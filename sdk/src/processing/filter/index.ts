/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第四道关卡 —— 按 URL 排除不希望采集的页面。
 *
 * 排在 redact 之后：先用脱敏后的 URL 再做匹配，避免排除规则本身出现敏感串。
 * 排在 dedupe 之前：先排除再算指纹，省掉一轮 JSON.stringify 的成本。
 *
 * 典型用途：内部后台、健康检查页、埋点自校验页等不参与监控分析的地址。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { ProcessingStage } from '../pipeline';

export class FilterStage implements ProcessingStage {
  readonly name = 'filter';

  /** @param excludedUrlParts 只要 URL 包含其中任意一个子串即被排除（无需完整匹配） */
  constructor(private readonly excludedUrlParts: readonly string[]) {}

  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
    // 空配置时 some() 恒为 false，天然放行，无需额外分支。
    return this.excludedUrlParts.some((part) => envelope.context.url.includes(part))
      ? undefined
      : envelope;
  }
}
