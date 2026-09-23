/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：定义加工阶段的统一契约，并提供一条严格串行的执行管道。
 *
 * 契约刻意保持极简：一个阶段 = 收一个信封、吐一个信封或 undefined。
 * 返回 undefined 表示「这条数据不该发」，管道随即短路，后续阶段不再执行。
 *
 * 两条铁律：
 *   1. 前一阶段的输出是后一阶段的输入，因此「装配顺序」本身就是数据规范；
 *   2. 任一阶段抛错即丢弃该条数据 —— 监控代码宁可少报一条，也绝不把异常抛回业务调用栈。
 *
 * 边界：管道自身不认识任何具体阶段，也不理解业务字段；它只按数组顺序逐个调用。
 * ---------------------------------------------------------------------------
 */

import type { TelemetryEventV3 as TelemetryEnvelope } from '@browser-monitor/protocol';

/**
 * 单个加工阶段的契约。
 * @returns 通过时返回信封（可返回新对象），丢弃时返回 undefined
 */
export interface ProcessingStage {
  /** 阶段名，用于日志与调试定位。 */
  readonly name: string;
  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined;
}

export class ProcessingPipeline {
  // 用数组保存顺序：与 ModuleRegistry 同理，顺序在这里就是一种语义。
  constructor(private readonly stages: readonly ProcessingStage[]) {}

  /** 依次执行所有阶段；返回 undefined 表示数据被丢弃。 */
  process(input: TelemetryEnvelope): TelemetryEnvelope | undefined {
    let current: TelemetryEnvelope | undefined = input;

    // 阶段严格串行，前一阶段的输出就是后一阶段的输入；顺序本身属于数据规范。
    for (const stage of this.stages) {
      // 上一阶段返回 undefined 时立即短路，后续阶段不再消耗算力。
      if (!current) return undefined;
      try {
        current = stage.process(current);
      } catch {
        // 处理失败时丢弃单条数据，监控代码不得把异常传播到业务调用栈。
        return undefined;
      }
    }

    return current;
  }
}
