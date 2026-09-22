/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第三道关卡 —— 脱敏，保证敏感数据与敏感参数不会离开浏览器。
 *
 * 只递归处理业务自定义事件的 properties，因为那是唯一可能含任意用户数据的地方；
 * 性能、View 等结构化 payload 字段固定，不需要递归遍历。
 *
 * 三条防护并存：
 *   1. 键名脱敏：命中敏感键（忽略大小写）即整值替换为 [REDACTED]；
 *   2. 体积防护：递归深度与数组长度截断，避免业务传入巨型对象撑爆监控事件；
 *   3. 纵深防护：URL 在 Context 与 normalize 已处理过，这里进入发送前再处理一次。
 *
 * 本阶段从不返回 undefined —— 脱敏不决定是否发送。
 * ---------------------------------------------------------------------------
 */

import type {
  CustomEventPayload,
  TelemetryEventV2 as TelemetryEnvelope,
} from '@browser-monitor/protocol';
import { isRecord } from '../../shared/type-guards';
import { sanitizeUrl } from '../../shared/url';
import type { ProcessingStage } from '../pipeline';

/** 命中敏感键后的统一占位符，服务端可据此识别「曾有值但被脱敏」。 */
const REDACTED = '[REDACTED]';

function redactValue(
  value: unknown,
  sensitiveKeys: ReadonlySet<string>,
  depth: number = 0,
): unknown {
  // 限制递归深度和数组长度，防止自定义属性造成异常大的监控事件。
  // 用占位符而非直接丢弃，保留「这里有内容但被截断」的信息。
  if (depth > 5) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, sensitiveKeys, depth + 1));
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = sensitiveKeys.has(key.toLowerCase())
      ? REDACTED
      : redactValue(nested, sensitiveKeys, depth + 1);
  }
  return result;
}

export class RedactStage implements ProcessingStage {
  readonly name = 'redact';
  // 预先转小写并放进 Set：把「每次比较都转一次」降为「构造期转一次」。
  private readonly keys: ReadonlySet<string>;

  constructor(private readonly sensitiveKeys: readonly string[]) {
    this.keys = new Set(sensitiveKeys.map((key) => key.toLowerCase()));
  }

  process(envelope: TelemetryEnvelope): TelemetryEnvelope {
    let payload = envelope.payload;
    // 只有业务自定义事件带任意属性，结构化 payload 字段固定无需递归。
    if (payload.type === 'event' && payload.properties) {
      payload = {
        ...payload,
        properties: redactValue(payload.properties, this.keys),
      } as CustomEventPayload;
    }

    // Context 创建时已脱敏，这里再次处理是进入 Transport 前的纵深防护。
    return {
      ...envelope,
      context: {
        ...envelope.context,
        url: sanitizeUrl(envelope.context.url),
      },
      payload,
    };
  }
}
