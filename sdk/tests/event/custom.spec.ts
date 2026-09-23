import { createPerformanceEventFixture } from '@browser-monitor/protocol/fixtures';
import { describe, expect, it } from 'vitest';

import { createMonitorWithDependencies } from '../../src/core/monitor';
import { SamplingStage } from '../../src/processing/sampling';
import { FakeSender } from '../helpers/fake-sender';

function setup() {
  const sender = new FakeSender();
  const monitor = createMonitorWithDependencies(
    {
      app: { name: 'custom-test', version: '1', environment: 'test' },
      view: { resolveRouteName: ({ pathname }) => pathname },
      performance: { enabled: false },
      transport: { dsn: '/collect', batchSize: 100, flushIntervalMs: 60_000 },
    },
    { sender },
  );
  return { monitor, sender };
}

describe('custom Event, Trace and Span SDK API', () => {
  it('freezes start-route context, records nested metrics, redacts attributes and cancels open spans', async () => {
    history.replaceState(null, '', '/checkout/address');
    const { monitor, sender } = setup();
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
    payment.end();
    await monitor.flush();

    const signals = sender
      .events()
      .filter((item) => ['event', 'trace', 'span'].includes(item.type));
    const flow = signals.find((item) => item.type === 'trace');
    const addressSignal = signals.find((item) => item.name === 'checkout.address');
    const paymentSignal = signals.find((item) => item.name === 'checkout.payment');
    const selected = signals.find((item) => item.name === 'payment.method.selected');
    expect(signals).toHaveLength(4);
    expect(flow).toMatchObject({
      type: 'trace',
      context: { routeName: '/checkout/address' },
      correlation: { traceId: trace.traceId },
      payload: {
        status: 'ok',
        metrics: { amount: { value: 10, unit: 'USD' } },
        attributes: { token: '[REDACTED]' },
      },
    });
    expect(addressSignal).toMatchObject({
      context: { routeName: '/checkout/address' },
      correlation: { traceId: trace.traceId, spanId: address.spanId },
      payload: { status: 'ok', metrics: { items: { value: 2, unit: 'count' } } },
    });
    expect(paymentSignal).toMatchObject({
      context: { routeName: '/checkout/payment' },
      correlation: { traceId: trace.traceId, spanId: payment.spanId },
      payload: { status: 'cancelled' },
    });
    expect(selected?.correlation).toMatchObject({ traceId: trace.traceId, spanId: payment.spanId });
    expect(signals.indexOf(paymentSignal!)).toBeLessThan(signals.indexOf(flow!));
    for (const signal of [flow, addressSignal, paymentSignal]) {
      const payload = signal?.payload;
      if (payload?.type !== 'trace' && payload?.type !== 'span')
        throw new Error('Expected a timed signal');
      expect(typeof payload.startedAt).toBe('number');
      expect(typeof payload.endedAt).toBe('number');
      expect(typeof payload.durationMs).toBe('number');
      expect(payload.endedAt).toBeGreaterThanOrEqual(payload.startedAt);
    }
    monitor.destroy();
  });

  it('preserves wrapper values and errors and cancels on stop', async () => {
    const { monitor, sender } = setup();
    monitor.start();
    expect(monitor.trace('sync', (trace) => trace.span('child', () => 42))).toBe(42);
    await expect(
      monitor.trace('async', (trace) =>
        trace.span('failed', () => Promise.reject(new Error('boom'))),
      ),
    ).rejects.toThrow('boom');
    const open = monitor.startTrace('open');
    open.startSpan('still-open');
    monitor.stop();
    await monitor.flush();
    const custom = sender.events().filter((item) => ['trace', 'span'].includes(item.type));
    expect(custom.find((item) => item.name === 'failed')?.payload).toMatchObject({
      status: 'error',
    });
    expect(custom.find((item) => item.name === 'async')?.payload).toMatchObject({
      status: 'error',
    });
    expect(custom.find((item) => item.name === 'still-open')?.payload).toMatchObject({
      status: 'cancelled',
    });
    expect(custom.find((item) => item.name === 'open')?.payload).toMatchObject({
      status: 'cancelled',
    });
    const count = custom.length;
    monitor.startTrace('inactive').end();
    await monitor.flush();
    expect(sender.events().filter((item) => ['trace', 'span'].includes(item.type))).toHaveLength(
      count,
    );
    monitor.destroy();
  });

  it('keeps identical repeated events as separate samples for accurate aggregation', async () => {
    const { monitor, sender } = setup();
    monitor.start();
    const data = { metrics: { value: { value: 1, unit: 'count' } } };
    monitor.track('button.click', data);
    monitor.track('button.click', data);
    await monitor.flush();
    expect(sender.events().filter((item) => item.name === 'button.click')).toHaveLength(2);
    monitor.destroy();
  });
  it('samples every signal in a trace as one unit', () => {
    const sampling = new SamplingStage(0.5);
    const base = createPerformanceEventFixture();
    const siblings = [
      { ...base, name: 'flow', type: 'trace', correlation: { traceId: 'trace-same' } },
      {
        ...base,
        name: 'page',
        type: 'span',
        correlation: { traceId: 'trace-same', spanId: 'span-1' },
      },
      {
        ...base,
        name: 'click',
        type: 'event',
        correlation: { traceId: 'trace-same', spanId: 'span-1' },
      },
    ];
    const decisions = siblings.map((item) => Boolean(sampling.process(item as never)));
    expect(new Set(decisions).size).toBe(1);
  });
});
