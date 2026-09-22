/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第一道关卡 —— 只做「格式修正」，不做任何取舍判断。
 *
 * 放在最前面是为了让后面的校验看到的是干净数据：
 * 若先校验再修正，「内容正确但格式脏」（名字带空格、时间戳是浮点）的数据会被误杀。
 *
 * 本阶段**从不返回 undefined**：修格式不决定这条数据该不该发。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';
import { sanitizeUrl } from '../../shared/url';
import type { ProcessingStage } from '../pipeline';

export class NormalizeStage implements ProcessingStage {
  readonly name = 'normalize';

  process(envelope: TelemetryEnvelope): TelemetryEnvelope {
    return {
      ...envelope,
      // 业务埋点可能传入带空白的事件名，去首尾空格保证聚合口径一致。
      name: envelope.name.trim(),
      // 收敛为整数毫秒：浮点时间戳会让服务端的窗口聚合与排序出现边界抖动。
      occurredAt: Math.round(envelope.occurredAt),
      context: {
        ...envelope.context,
        // URL 在这里再脱敏一次：Context 创建时已处理过，这里是进入校验前的补强。
        url: sanitizeUrl(envelope.context.url),
      },
    };
  }
}
