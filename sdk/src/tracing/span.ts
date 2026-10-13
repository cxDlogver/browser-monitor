import type { TelemetryDraft } from '../core/pipeline';
import {
  mergeData,
  normalizeData,
  presentData,
  requiredName,
  type CustomSignalEndInput,
  type CustomSignalInput,
} from '../shared/custom-signal';
import {
  WORKFLOW_ATTRIBUTE,
  type CorrelationContext,
  type CustomSpanPayload,
  type MetricUnit,
  type TelemetryContext,
} from '@cxdlogver/browser-monitor-protocol';

import type { TracingContext } from './context';
import type { SpanContext, SpanHandle, StartSpanOptions } from './types';

/**
 * span 运行期真正依赖的最小宿主能力。
 * 只声明用得到的几个方法，避免 RecordingSpan 直接依赖整个 Tracer：
 * 既方便替换实现，也便于测试时注入桩对象。
 */
interface SpanRuntime {
  readonly scope: TracingContext;
  startSpan(name: string, options?: StartSpanOptions): SpanHandle;
  withSpan<T>(name: string, callback: (span: SpanHandle) => T, options?: StartSpanOptions): T;
  track(name: string, data?: CustomSignalInput, correlation?: CorrelationContext): void;
  emit(draft: TelemetryDraft<CustomSpanPayload>): void;
}

/** 单调时钟：优先使用 performance.now()，不可用时退化为 Date.now()。 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Owns one operation only: fixed identity, start snapshot, mutable data and one end flag.
 *
 * 一个 RecordingSpan 只描述一次操作，职责边界很窄：
 * 固定的身份标识、起始上下文快照、可逐步累加的属性/指标数据，以及唯一的结束标记。
 * 它不管理其它 span，也不参与上报过程，只在 end() 时把结果交给 runtime。
 */
export class RecordingSpan implements SpanHandle {
  // 墙上时钟起点：用于 payload 中的 startedAt / endedAt（对外可见的时间戳）。
  private readonly startedAt = Date.now();
  // 单调时钟起点：只用于计算 durationMs，避免系统时间被校正时出现跳跃或负值。
  private readonly startedMonotonic = monotonicNow();
  // 累积的属性与指标，setAttribute / setMetric 会逐步合并进来。
  private readonly data;
  // 身份标识快照，构造时冻结，之后不再受外部对象变化影响。
  private readonly identity: Readonly<SpanContext & CorrelationContext>;
  // 结束标记：所有写操作与 end() 都以它为闸门，保证只结束一次。
  private ended: boolean;

  constructor(
    private readonly runtime: SpanRuntime,
    private readonly name: string,
    identity: SpanContext & CorrelationContext,
    private readonly context: TelemetryContext | undefined,
    private readonly workflow: boolean,
    initialData?: CustomSignalInput,
  ) {
    // 冻结一份副本，防止调用方事后修改传入对象而篡改本 span 的链路标识。
    this.identity = Object.freeze({ ...identity });
    // 没有上下文说明 tracer 未处于运行态，此时直接丢弃初始数据、不做加工。
    this.data = normalizeData(context ? initialData : undefined, this.attributeLimit);
    // 无上下文即“出生即结束”：后续所有写操作短路，end() 也不会再上报。
    this.ended = !context;
  }

  // 对外暴露链路标识；根节点的 parentSpanId 为 undefined。
  get traceId(): string {
    return this.identity.traceId;
  }
  get spanId(): string {
    return this.identity.spanId;
  }
  get parentSpanId(): string | undefined {
    return this.identity.parentSpanId;
  }
  private get attributeLimit(): number {
    // workflow 节点在 end() 时会额外追加一个流程标记属性，所以这里预留一个位置。
    return this.workflow ? 49 : 50;
  }

  /** 以当前 span 为父级开启一个子 span。 */
  startSpan(name: string, data?: CustomSignalInput): SpanHandle {
    return this.runtime.startSpan(name, { ...data, parent: this.identity });
  }

  /** 在“当前 span 为父级”的作用域内执行回调，回调中创建的节点会自动挂在它下面。 */
  span<T>(name: string, callback: (span: SpanHandle) => T, data?: CustomSignalInput): T {
    return this.runtime.withSpan(name, callback, { ...data, parent: this.identity });
  }

  /** 把本 span 设为作用域父级后再执行回调，使回调内产生的节点自动归属到它下面。 */
  run<T>(callback: (span: SpanHandle) => T): T {
    return this.runtime.scope.run(this.identity, () => callback(this));
  }

  /**
   * 把回调绑定到本 span 的作用域。
   * 适合传给事件回调、定时器等异步入口，使其执行时仍能继承正确的父级，
   * 而不会因为脱离同步调用链而丢失链路关系。
   */
  bind<Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result {
    return this.runtime.scope.bind(this.identity, callback);
  }

  /** 记录一条与本 span 关联的事件；已结束后静默忽略。 */
  addEvent(name: string, data?: CustomSignalInput): void {
    if (!this.ended) this.runtime.track(name, data, this.identity);
  }

  /** 写入一个属性；键名会先校验并规范化，已结束后忽略。 */
  setAttribute(key: string, value: unknown): void {
    if (this.ended) return;
    const normalized = requiredName(key, 'Attribute name');
    mergeData(this.data, { attributes: { [normalized]: value } }, this.attributeLimit);
  }

  /** 写入一个指标（数值 + 单位）；已结束后忽略。 */
  setMetric(name: string, value: number, unit: MetricUnit): void {
    if (this.ended) return;
    mergeData(this.data, { metrics: { [name]: { value, unit } } }, this.attributeLimit);
  }

  /** 结束 span 并上报。整体是幂等的：重复调用只生效一次。 */
  end(options?: CustomSignalEndInput): void {
    // 已经结束过就直接返回，保证不会重复上报。
    if (this.ended) return;
    // status 缺省为 ok，其余字段作为附加数据合并进本次结果。
    const { status = 'ok', ...data } = options ?? {};
    // 只接受约定的三种状态，避免非法值污染数据。
    if (!['ok', 'error', 'cancelled'].includes(status))
      throw new Error('Signal status is invalid.');
    mergeData(this.data, data, this.attributeLimit);
    // 取两者较大值，保证 endedAt 不早于 startedAt（即使期间系统时间被回拨）。
    const endedAt = Math.max(this.startedAt, Date.now());
    const payload: CustomSpanPayload = {
      type: 'span',
      name: this.name,
      source: 'custom',
      startedAt: this.startedAt,
      endedAt,
      // 耗时用单调时钟计算并钳制为非负，避免时钟调整导致负时长。
      durationMs: Math.max(0, monotonicNow() - this.startedMonotonic),
      status,
      ...presentData(this.data),
      // 流程节点额外打上 workflow 标记，供下游区分普通 span 与流程 span。
      ...(this.workflow
        ? { attributes: { ...this.data.attributes, [WORKFLOW_ATTRIBUTE]: true } }
        : {}),
    };
    // Commit before emitting: duplicate end or reentrant callbacks cannot emit twice.
    // 先置位、再上报：即使上报过程重入调用 end()，也不会产生第二条数据。
    this.ended = true;
    this.runtime.emit({
      name: this.name,
      timestamp: endedAt,
      // ended 为 false 时必然存在 context（见构造函数），此处断言是安全的。
      context: this.context!,
      correlation: this.identity,
      payload,
    });
  }
}
