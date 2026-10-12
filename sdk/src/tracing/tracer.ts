import { CustomEventCollector } from '../collectors/event/custom';
import type { ContextManager } from '../context';
import type { MonitorModule } from '../core/module-registry';
import type { TelemetryDraft, TelemetryEmitter } from '../core/pipeline';
import { requiredName, type CustomSignalInput } from '../shared/custom-signal';
import type { CorrelationContext, CustomSpanPayload } from '@browser-monitor/protocol';

import { TracingContext } from './context';
import { createSpanId, createTraceId } from './id';
import { RecordingSpan } from './span';
import type { SpanContext, SpanHandle, StartSpanOptions, TraceHandle } from './types';

/**
 * 校验外部传入的父级上下文，只有合法的非全零标识才允许挂到链路上。
 * traceId 要求 32 位十六进制、spanId 要求 16 位十六进制；全零值（如 32 个 0）
 * 只是占位符，会让后端无法还原父子关系，因此直接抛错而不是静默接受。
 */
function validateParent(parent: SpanContext): SpanContext {
  if (
    !/^[0-9a-f]{32}$/.test(parent.traceId) ||
    /^0+$/.test(parent.traceId) ||
    !/^[0-9a-f]{16}$/.test(parent.spanId) ||
    /^0+$/.test(parent.spanId)
  ) {
    throw new Error('Parent requires a non-zero 32-hex traceId and 16-hex spanId.');
  }
  // 只回传身份字段，丢弃外部可能携带的其它属性，避免污染内部链路上下文。
  return { traceId: parent.traceId, spanId: parent.spanId };
}

/** 判断回调返回值是否为 thenable，用于区分同步收尾与异步收尾两条路径。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * Factory and lifecycle gate. It keeps no open-span registry or child counts.
 *
 * 链路节点的工厂与生命周期闸门：只负责创建 trace / span 并控制运行开关，
 * 不登记未结束的 span，也不维护子节点计数，因此不会阻止节点被回收，
 * stop / destroy 时可以立即释放，不需要额外清理悬挂节点。
 */
export class Tracer implements MonitorModule {
  readonly name = 'tracer';
  // 当前同步执行链路上的父级上下文；它是同步作用域，跨 await 不会自动延续。
  readonly scope = new TracingContext();
  // 运行开关：为 false 时不创建真实链路，也不上报任何数据。
  private running = false;
  // destroy 是终态标记，置位后不再允许 start 复活。
  private destroyed = false;
  // 自定义事件采集器：track 复用它，保证自定义事件与 span 走同一条上报管线。
  private readonly events: CustomEventCollector;

  constructor(
    private readonly emitter: TelemetryEmitter,
    private readonly context: ContextManager,
  ) {
    this.events = new CustomEventCollector(emitter);
  }

  // 本模块不需要安装全局监听，留空以对齐统一的模块生命周期接口。
  install(): void {}
  start(): void {
    // 已 destroy 的实例不允许复活，避免再次使用已释放的上下文。
    if (!this.destroyed) this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  /**
   * 记录一条自定义事件。
   * 关联上下文按“显式传入 → 当前 span → 空对象”逐级回退。
   */
  track(name: string, data?: CustomSignalInput, correlation?: CorrelationContext): void {
    if (!this.running) return;
    this.events.track(name, data, correlation ?? this.scope.current() ?? {});
  }

  /** 开启一条新的调用链：显式把 parent 置为 null，切断可能继承到的父级。 */
  startTrace(name: string, data?: CustomSignalInput): TraceHandle {
    return this.create(name, { ...data, parent: null }, true);
  }

  /** 开启一个子 span：不传 parent 时默认继承当前作用域中的父级。 */
  startSpan(name: string, options?: StartSpanOptions): SpanHandle {
    return this.create(name, options, false);
  }

  /** withTrace 的语法糖：创建 trace 并交给 wrap，保证回调结束后自动收尾。 */
  withTrace<T>(name: string, callback: (trace: TraceHandle) => T, data?: CustomSignalInput): T {
    return this.wrap(this.startTrace(name, data), callback);
  }

  /** withSpan 的语法糖：创建 span 并交给 wrap，保证回调结束后自动收尾。 */
  withSpan<T>(name: string, callback: (span: SpanHandle) => T, options?: StartSpanOptions): T {
    return this.wrap(this.startSpan(name, options), callback);
  }

  /** 供 RecordingSpan 回传节点数据；只在运行态转发，停止后静默丢弃。 */
  emit(draft: TelemetryDraft<CustomSpanPayload>): void {
    if (this.running) this.emitter.emit(draft);
  }

  /** trace 与 span 共用的创建出口，仅用 workflow 参数区分两者。 */
  private create(
    name: string,
    options: StartSpanOptions | undefined,
    workflow: boolean,
  ): SpanHandle {
    const { parent: explicit, ...data } = options ?? {};
    // parent 有三种语义：null 表示切断继承，具体对象表示显式指定，undefined 表示继承当前上下文。
    const parent = explicit === null ? undefined : (explicit ?? this.scope.current());
    // 运行态下外部传入的父级必须校验；非运行态跳过校验，直接透传。
    const identity = this.running && parent ? validateParent(parent) : parent;
    return new RecordingSpan(
      this,
      // 运行态才强制名称合法；停止态放宽校验，便于调用方复用同一套代码。
      this.running ? requiredName(name) : name,
      {
        // 有父级则沿用其 traceId 并挂上 parentSpanId，否则新开一条链路。
        traceId: identity?.traceId ?? createTraceId(),
        spanId: createSpanId(),
        ...(identity ? { parentSpanId: identity.spanId } : {}),
      },
      // 起始快照只在运行态采集，避免停止后仍然去读取宿主环境。
      this.running ? this.context.snapshotAt(Date.now()) : undefined,
      workflow,
      data,
    );
  }

  /**
   * 统一收尾：回调无论是同步返回、返回 Promise 还是直接抛错，
   * 都保证 span 只结束一次，并在异常路径上标记 error 状态。
   */
  private wrap<T>(span: SpanHandle, callback: (span: SpanHandle) => T): T {
    try {
      const result = span.run(callback);
      if (isPromiseLike(result)) {
        // 异步回调：等 Promise settle 之后再结束 span，避免耗时被截断。
        return Promise.resolve(result).then(
          (value) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            span.end({ status: 'error' });
            throw error;
          },
        ) as T;
      }
      // 同步回调：执行完立即结束。
      span.end();
      return result;
    } catch (error) {
      // 回调同步抛错时同样要结束 span，避免链路节点悬挂。
      span.end({ status: 'error' });
      throw error;
    }
  }
}
