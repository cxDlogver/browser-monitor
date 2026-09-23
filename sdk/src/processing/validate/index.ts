/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：第二道关卡 —— 校验信封结构，拦掉不完整或不合法的数据。
 *
 * 排在 normalize 之后、其余阶段之前：无效数据越早丢弃越好，
 * 免得浪费后面脱敏、指纹、限流等阶段的算力。
 *
 * 校验分两层：
 *   1. 公共层：协议版本、事件 ID、名称、时间、会话与视图是否齐备；
 *   2. 领域层：性能类 payload 的数值与单位是否合法（唯一一处领域感知）。
 * ---------------------------------------------------------------------------
 */

import {
  PROTOCOL_VERSION,
  type PerformancePayload,
  type TelemetryEventV3 as TelemetryEnvelope,
} from '@browser-monitor/protocol';

import type { ProcessingStage } from '../pipeline';

/** 性能指标的领域校验：数值必须有限且非负，单位必须落在协议允许的三类中。 */
function isValidPerformance(payload: PerformancePayload): boolean {
  return (
    Number.isFinite(payload.value) &&
    payload.value >= 0 &&
    (payload.unit === 'ms' || payload.unit === 'score' || payload.unit === 'fps')
  );
}

export class ValidateStage implements ProcessingStage {
  readonly name = 'validate';

  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
    // 公共层：缺少任何一项公共元数据的数据都不具备分析价值，宁缺毋滥。
    if (
      envelope.protocolVersion !== PROTOCOL_VERSION ||
      !envelope.eventId ||
      !envelope.name ||
      !Number.isFinite(envelope.occurredAt) ||
      envelope.occurredAt < 0 ||
      !envelope.context.sessionId ||
      !envelope.context.viewId ||
      !envelope.context.routeName
    ) {
      return undefined;
    }

    // 领域层：只有性能类有额外的数值/单位约束，其余类型不做展开校验。
    if (envelope.payload.type === 'performance' && !isValidPerformance(envelope.payload)) {
      return undefined;
    }

    return envelope;
  }
}
