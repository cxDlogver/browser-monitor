import type { SpanContext } from './types';

/** Browser scope is synchronous. Never keep a global parent across an await. */
export class TracingContext {
  private active: SpanContext | undefined;

  current(): SpanContext | undefined {
    return this.active;
  }

  run<T>(parent: SpanContext, callback: () => T): T {
    const previous = this.active;
    this.active = Object.freeze({ traceId: parent.traceId, spanId: parent.spanId });
    try {
      return callback();
    } finally {
      this.active = previous;
    }
  }

  bind<Args extends unknown[], Result>(
    parent: SpanContext,
    callback: (...args: Args) => Result,
  ): (...args: Args) => Result {
    const captured = Object.freeze({ traceId: parent.traceId, spanId: parent.spanId });
    const invoke = (receiver: unknown, args: Args): Result =>
      this.run(captured, () => callback.apply(receiver, args));
    return function (this: unknown, ...args: Args): Result {
      return invoke(this, args);
    };
  }
}
