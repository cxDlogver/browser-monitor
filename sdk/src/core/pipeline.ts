/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：作为所有采集器共用的「数据咽喉」，把「领域数据草稿」加工成
 * 「完整信封（Envelope）」，再依次流过处理管线与发送队列。
 *
 * 它在架构中的位置是一条严格单向的窄路：
 *
 *   Collector ──emit(draft)──> MonitorPipeline ──process──> Processing ──enqueue──> Transport
 *
 * 之所以必须收敛到这里，是为了保证三件事只做一次、且顺序固定：
 *   1. 上下文注入：Collector 不需要、也不应该自己拼接 session / view / runtime；
 *   2. 统一加工：脱敏、采样、去重、限流对任何来源的数据都一视同仁；
 *   3. 唯一出口：不存在绕过 Processing 直达 Transport 的路径。
 *
 * 边界：Pipeline 不认识任何具体指标，不理解业务字段，也不做重试与批处理
 * （那是 Transport 的职责）。它只负责把不完整的数据补成完整，并按顺序递交。
 * ---------------------------------------------------------------------------
 */

import type { ContextManager } from '../context';
import type { ProcessingPipeline } from '../processing';
import { createId } from '../shared/id';
import type { Transport } from '../transport';
import {
  PROTOCOL_VERSION,
  type CorrelationContext,
  type TelemetryContext,
  type TelemetryEventV2 as TelemetryEnvelope,
  type TelemetryPayload,
} from '@browser-monitor/protocol';

/**
 * 采集器递交的「半成品」：只描述领域事实本身，不携带公共上下文。
 * context 与 correlation 均为可选，缺省时由 Pipeline 负责补齐。
 */
export interface TelemetryDraft<T extends TelemetryPayload = TelemetryPayload> {
  /** 事件名，业务埋点时为自定义名称。 */
  name: string;
  /** 事实发生时间，而非进入管线的时间，决定了数据归属哪个 View。 */
  timestamp: number;
  payload: T;
  /** 链路/因果关联信息，缺省为空对象。 */
  correlation?: CorrelationContext;
  /**
   * 调用方显式指定的上下文快照。
   * 仅在特殊情况使用（例如某条数据已被明确绑定到某个历史 View），常规路径交给 Pipeline 解析。
   */
  context?: TelemetryContext;
}

/**
 * 面向 Collector 的窄接口。
 * Collector 只拿到 emit 一个方法，因此既无法接触 Transport，也无感知 Processing 的存在。
 */
export interface TelemetryEmitter {
  emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void;
}

export class MonitorPipeline implements TelemetryEmitter {
  constructor(
    private readonly context: ContextManager,
    private readonly processing: ProcessingPipeline,
    private readonly transport: Transport,
  ) {}

  /**
   * 补齐信封并递交。全过程同步完成，不涉及队列等待；
   * 失败（如 format 异常）也应当在各阶段内部消化，不向调用方抛出。
   */
  emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void {
    // Context 必须按数据实际发生时间解析。延迟回调到达时，当前 View 可能已经变化。
    const envelope: TelemetryEnvelope = {
      // 协议版本号先行，接收端据此决定能否解析，也便于未来灰度升级而不中断旧数据。
      protocolVersion: PROTOCOL_VERSION,
      // 每条数据一个稳定 ID，用于服务端幂等去重与问题定位。
      eventId: createId('event'),
      // type 取自 payload，保证信封分类与负载内容始终一致。
      type: draft.payload.type,
      name: draft.name,
      occurredAt: draft.timestamp,
      // app 身份与会话无关，直接取快照即可。
      app: this.context.app.snapshot(),
      // 常规路径按事件时间解析上下文；若调用方已显式指定，则以指定值为准。
      context: draft.context ?? this.context.snapshotAt(draft.timestamp),
      correlation: draft.correlation ?? {},
      payload: draft.payload,
    } as TelemetryEnvelope;

    // 所有数据先经过统一处理，再进入发送队列；undefined 表示被某个阶段丢弃。
    // 注意丢弃是静默的：这是采样与限流的预期结果，不代表异常。
    const processed = this.processing.process(envelope);
    if (processed) this.transport.enqueue(processed);
  }
}
