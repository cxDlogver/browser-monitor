import {
  WORKFLOW_ATTRIBUTE,
  telemetryEventV3Schema,
  type CustomSignalPayload,
} from '@cxdlogver/browser-monitor-protocol';
import { createPerformanceEventFixture } from '@cxdlogver/browser-monitor-protocol/fixtures';
import { describe, expect, it, vi } from 'vitest';

import { createMonitorWithDependencies } from '../../src/core/monitor';
import { SamplingStage } from '../../src/processing/sampling';
import { FakeSender } from '../helpers/fake-sender';

function setup(sensitiveKeys = ['token', 'password', 'authorization']) {
  const sender = new FakeSender();
  const monitor = createMonitorWithDependencies(
    {
      app: { name: 'custom-test', version: '1', environment: 'test' },
      view: { resolveRouteName: ({ pathname }) => pathname },
      performance: { enabled: false },
      processing: { sensitiveKeys },
      transport: { dsn: '/collect', batchSize: 100, flushIntervalMs: 60_000 },
    },
    { sender },
  );
  const custom = () =>
    sender
      .events()
      .filter((event): event is typeof event & { payload: CustomSignalPayload } =>
        ['event', 'trace', 'span'].includes(event.type),
      );
  return { monitor, sender, custom };
}

describe('custom Event, Trace and Span SDK API', () => {
  it('freezes start-route context and lets children finish after their root', async () => {
    history.replaceState(null, '', '/checkout/address');
    const { monitor, custom } = setup();
    monitor.start();
    expect(() => monitor.track('legacy', { orderId: 'old-shape' } as never)).toThrow(
      'Unknown custom signal field',
    );
    const trace = monitor.startTrace('checkout.flow', {
      attributes: { token: 'private' },
      metrics: { amount: { value: 10, unit: 'USD' } },
    });
    const address = trace.startSpan('checkout.address');
    address.setMetric('items', 2, 'count');
    address.end();
    history.pushState(null, '', '/checkout/payment');
    const payment = trace.startSpan('checkout.payment');
    payment.addEvent('payment.method.selected', { attributes: { method: 'card' } });
    trace.end();
    trace.end();
    payment.setAttribute('completed', true);
    payment.end();
    const late = trace.startSpan('late.cleanup');
    late.end();
    await monitor.flush();
    const signals = custom();
    const flow = signals.find((item) => item.name === 'checkout.flow');
    const addressSignal = signals.find((item) => item.name === 'checkout.address');
    const paymentSignal = signals.find((item) => item.name === 'checkout.payment');
    expect(signals).toHaveLength(5);
    expect(flow).toMatchObject({
      type: 'span',
      context: { routeName: '/checkout/address' },
      correlation: { traceId: trace.traceId, spanId: trace.spanId },
      payload: {
        status: 'ok',
        metrics: { amount: { value: 10, unit: 'USD' } },
        attributes: { token: '[REDACTED]', [WORKFLOW_ATTRIBUTE]: true },
      },
    });
    expect(addressSignal).toMatchObject({
      context: { routeName: '/checkout/address' },
      correlation: { traceId: trace.traceId, spanId: address.spanId, parentSpanId: trace.spanId },
      payload: { status: 'ok', metrics: { items: { value: 2, unit: 'count' } } },
    });
    expect(paymentSignal).toMatchObject({
      context: { routeName: '/checkout/payment' },
      correlation: { traceId: trace.traceId, spanId: payment.spanId, parentSpanId: trace.spanId },
      payload: { status: 'ok', attributes: { completed: true } },
    });
    expect(signals.indexOf(flow!)).toBeLessThan(signals.indexOf(paymentSignal!));
    expect(signals.find((item) => item.name === 'late.cleanup')?.correlation.parentSpanId).toBe(
      trace.spanId,
    );
    for (const signal of signals.filter((item) => item.payload.type === 'span')) {
      if (signal.payload.type !== 'span') throw new Error('Expected span');
      expect(signal.payload.endedAt).toBeGreaterThanOrEqual(signal.payload.startedAt);
      expect(signal.payload.durationMs).toBeGreaterThanOrEqual(0);
    }
    monitor.destroy();
  });

  it('creates standalone roots, freezes identities and resolves explicit, implicit and null parents', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const standalone = monitor.startSpan('standalone');
    expect(standalone.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(standalone.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(standalone.parentSpanId).toBeUndefined();
    let implicitId = '';
    monitor.withTrace('root', (root) => {
      const implicit = monitor.startSpan('implicit');
      implicitId = implicit.spanId;
      expect(implicit.parentSpanId).toBe(root.spanId);
      const explicit = monitor.startSpan('explicit', { parent: standalone });
      expect(explicit.traceId).toBe(standalone.traceId);
      expect(explicit.parentSpanId).toBe(standalone.spanId);
      const isolated = monitor.startSpan('isolated', { parent: null });
      expect(isolated.traceId).not.toBe(root.traceId);
      expect(isolated.parentSpanId).toBeUndefined();
      const nestedTrace = monitor.startTrace('nested-trace');
      expect(nestedTrace.traceId).not.toBe(root.traceId);
      nestedTrace.end();
      isolated.end();
      explicit.end();
      implicit.end();
    });
    const outside = monitor.startSpan('outside');
    expect(outside.parentSpanId).toBeUndefined();
    expect(() => monitor.startSpan('bad', { parent: { traceId: 'bad', spanId: 'bad' } })).toThrow(
      'Parent requires',
    );
    standalone.end();
    outside.end();
    await monitor.flush();
    expect(custom().find((item) => item.name === 'standalone')?.payload.attributes).toBeUndefined();
    expect(custom().find((item) => item.name === 'implicit')?.correlation.spanId).toBe(implicitId);
    monitor.destroy();
  });

  it('preserves wrapper return values, thrown errors, promise results and nested scopes', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    expect(monitor.trace('sync', (trace) => trace.span('child', () => 42))).toBe(42);
    expect(() =>
      monitor.withSpan('throws', () => {
        throw new Error('sync-error');
      }),
    ).toThrow('sync-error');
    await expect(
      monitor.withTrace('async', (trace) =>
        trace.span('failed', () => Promise.reject(new Error('boom'))),
      ),
    ).rejects.toThrow('boom');
    expect(await monitor.withSpan('resolved', () => Promise.resolve(7))).toBe(7);
    monitor.withTrace('outer', (outer) => {
      monitor.withSpan('inner', (inner) => {
        expect(inner.parentSpanId).toBe(outer.spanId);
        monitor.track('inner.point');
      });
      monitor.track('outer.point');
    });
    monitor.track('outside.point');
    await monitor.flush();
    const events = custom();
    for (const name of ['throws', 'failed', 'async'])
      expect(events.find((item) => item.name === name)?.payload).toMatchObject({ status: 'error' });
    expect(events.find((item) => item.name === 'inner.point')?.correlation.spanId).toBe(
      events.find((item) => item.name === 'inner')?.correlation.spanId,
    );
    expect(events.find((item) => item.name === 'outer.point')?.correlation.spanId).toBe(
      events.find((item) => item.name === 'outer')?.correlation.spanId,
    );
    expect(events.find((item) => item.name === 'outside.point')?.correlation).toEqual({});
    monitor.destroy();
  });

  it('restores scope immediately for overlapping async callbacks and uses explicit parents after await', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const run = (name: string) =>
      monitor.withTrace(name, async (root) => {
        monitor.withSpan(name + '.before', () => undefined);
        await Promise.resolve();
        monitor.withSpan(name + '.after', () => undefined, { parent: root });
        const unrelated = monitor.startSpan(name + '.unrelated');
        expect(unrelated.parentSpanId).toBeUndefined();
        unrelated.end();
      });
    await Promise.all([run('a'), run('b')]);
    await monitor.flush();
    for (const name of ['a', 'b']) {
      const root = custom().find((item) => item.name === name)!;
      for (const suffix of ['before', 'after'])
        expect(
          custom().find((item) => item.name === name + '.' + suffix)?.correlation,
        ).toMatchObject({
          traceId: root.correlation.traceId,
          parentSpanId: root.correlation.spanId,
        });
    }
    monitor.destroy();
  });

  it('run and bind activate a manual handle without ending it and preserve callback this and arguments', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const root = monitor.startTrace('manual');
    expect(root.run(() => monitor.withSpan('run.child', () => 9))).toBe(9);
    const callback = root.bind(function (this: { value: number }, increment: number) {
      monitor.withSpan('bound.child', () => undefined);
      return this.value + increment;
    });
    expect(callback.call({ value: 10 }, 2)).toBe(12);
    const outside = monitor.startSpan('outside');
    expect(outside.parentSpanId).toBeUndefined();
    outside.end();
    await monitor.flush();
    expect(custom().some((item) => item.name === 'manual')).toBe(false);
    root.end();
    await monitor.flush();
    for (const name of ['run.child', 'bound.child'])
      expect(custom().find((item) => item.name === name)?.correlation.parentSpanId).toBe(
        root.spanId,
      );
    monitor.destroy();
  });

  it('stop pauses emission without fabricating cancelled spans, and destroy is final', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const resumed = monitor.startTrace('resumed');
    const dropped = monitor.startSpan('dropped');
    monitor.stop();
    dropped.end();
    monitor.startTrace('inactive').end();
    expect(monitor.withTrace('inactive-wrapper', () => 3)).toBe(3);
    await monitor.flush();
    expect(custom()).toHaveLength(0);
    monitor.start();
    dropped.end();
    resumed.end();
    await monitor.flush();
    const abandoned = monitor.startSpan('abandoned');
    monitor.destroy();
    abandoned.end();
    monitor.start();
    monitor.startSpan('destroyed').end();
    expect(custom().map((item) => item.name)).toEqual(['resumed']);
  });

  it('pagehide only flushes completed spans and leaves open operations to their owner', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const open = monitor.startTrace('open');
    monitor.withSpan('finished', () => undefined);
    window.dispatchEvent(new Event('pagehide'));
    await monitor.flush();
    expect(custom().map((item) => item.name)).toEqual(['finished']);
    open.end({ status: 'cancelled' });
    await monitor.flush();
    expect(custom().find((item) => item.name === 'open')?.payload).toMatchObject({
      status: 'cancelled',
    });
    monitor.destroy();
  });

  it('protects workflow metadata, bounds payloads and allows retrying an invalid end', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    expect(() =>
      monitor.startTrace('spoof', { attributes: { [WORKFLOW_ATTRIBUTE]: false } }),
    ).toThrow('reserved attribute');
    const root = monitor.startTrace('bounded', {
      attributes: Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => ['key' + index, index]),
      ),
    });
    expect(() => root.setAttribute(WORKFLOW_ATTRIBUTE, false)).toThrow('reserved attribute');
    expect(() => root.end({ attributes: { [WORKFLOW_ATTRIBUTE]: false } })).toThrow(
      'reserved attribute',
    );
    expect(() => root.end({ status: 'invalid' } as never)).toThrow('Signal status');
    expect(() => root.end({ metrics: { invalid: { value: Infinity, unit: 'count' } } })).toThrow(
      'finite',
    );
    root.setMetric('amount', 10, 'USD');
    root.end();
    root.end();
    root.setMetric('ignored', 1, 'count');
    root.addEvent('ignored');
    await monitor.flush();
    const event = custom()[0]!;
    expect(custom()).toHaveLength(1);
    expect(Object.keys(event.payload.attributes ?? {})).toHaveLength(50);
    expect(event.payload.attributes?.[WORKFLOW_ATTRIBUTE]).toBe(true);
    expect(event.payload.metrics).toEqual({ amount: { value: 10, unit: 'USD' } });
    monitor.destroy();
  });

  it('preserves the boolean root marker through attribute redaction', async () => {
    const { monitor, custom } = setup([WORKFLOW_ATTRIBUTE, 'token']);
    monitor.start();
    monitor.startTrace('redacted-root', { attributes: { token: 'secret' } }).end();
    await monitor.flush();
    expect(custom()[0]?.payload.attributes).toEqual({
      token: '[REDACTED]',
      [WORKFLOW_ATTRIBUTE]: true,
    });
    monitor.destroy();
  });

  it('keeps initial, setter and end strings within the shared wire schema', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const value = 'x'.repeat(4097);
    const span = monitor.startSpan('strings', { attributes: { initial: value } });
    span.setAttribute('nested', { value });
    span.end({ attributes: { final: value } });
    monitor.track('point.strings', { attributes: { value } });
    await monitor.flush();
    for (const event of custom())
      expect(telemetryEventV3Schema.safeParse(event).success).toBe(true);
    expect(custom()[0]?.payload.attributes).toEqual({
      initial: value.slice(0, 4096),
      nested: { value: value.slice(0, 4096) },
      final: value.slice(0, 4096),
    });
    monitor.destroy();
  });

  it('uses monotonic duration when the wall clock moves backwards', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const wall = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(wall);
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const span = monitor.startSpan('clock');
      clock.mockReturnValue(wall - 100);
      monotonic.mockReturnValue(125);
      span.end();
    } finally {
      clock.mockRestore();
      monotonic.mockRestore();
    }
    await monitor.flush();
    expect(custom()[0]?.payload).toMatchObject({ startedAt: wall, endedAt: wall, durationMs: 25 });
    monitor.destroy();
  });

  it('keeps repeated point events as separate samples', async () => {
    const { monitor, custom } = setup();
    monitor.start();
    const data = { metrics: { value: { value: 1, unit: 'count' } } };
    monitor.track('button.click', data);
    monitor.track('button.click', data);
    await monitor.flush();
    expect(custom().filter((item) => item.name === 'button.click')).toHaveLength(2);
    monitor.destroy();
  });

  it('makes the same sampling decision for every signal sharing a traceId', () => {
    const sampling = new SamplingStage(0.5);
    const base = createPerformanceEventFixture();
    const siblings = ['root', 'child', 'point'].map((name) => ({
      ...base,
      name,
      correlation: { traceId: 'trace-same', spanId: name },
    }));
    const decisions = siblings.map((item) => Boolean(sampling.process(item)));
    expect(new Set(decisions).size).toBe(1);
  });
});
