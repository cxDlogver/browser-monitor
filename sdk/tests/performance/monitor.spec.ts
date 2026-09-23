import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webVitalsMock = vi.hoisted(() => {
  type Callback = (metric: unknown) => void;
  return {
    callbacks: new Map<string, Callback>(),
    onCLS: vi.fn((callback: Callback) => webVitalsMock.callbacks.set('CLS', callback)),
    onFCP: vi.fn((callback: Callback) => webVitalsMock.callbacks.set('FCP', callback)),
    onINP: vi.fn((callback: Callback) => webVitalsMock.callbacks.set('INP', callback)),
    onLCP: vi.fn((callback: Callback) => webVitalsMock.callbacks.set('LCP', callback)),
  };
});

vi.mock('web-vitals', () => ({
  onCLS: webVitalsMock.onCLS,
  onFCP: webVitalsMock.onFCP,
  onINP: webVitalsMock.onINP,
  onLCP: webVitalsMock.onLCP,
}));

import { createMonitorWithDependencies } from '../../src/core/monitor';
import { FakeSender } from '../helpers/fake-sender';

class MockPerformanceObserver {
  static supportedEntryTypes = [
    'largest-contentful-paint',
    'paint',
    'event',
    'layout-shift',
    'long-animation-frame',
  ];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: PerformanceObserverCallback) {}

  emit(entries: PerformanceEntry[]): void {
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    );
  }
}

function metric(name: 'LCP' | 'FCP' | 'INP' | 'CLS', value: number): object {
  return {
    name,
    value,
    rating: 'good',
    delta: value,
    id: 'metric-' + name,
    entries: [{ startTime: value }],
    navigationType: 'navigate',
    navigationId: 0,
    navigationURL: 'https://secret.test/?token=never-export',
  };
}

function options() {
  return {
    app: {
      name: 'checkout',
      version: '1.2.3',
      environment: 'test',
    },
    performance: {
      metrics: { FPS: false as const },
    },
    processing: {
      rateLimit: { maxEvents: 100, windowMs: 60_000 },
    },
    transport: {
      dsn: '/collect',
      batchSize: 100,
      flushIntervalMs: 60_000,
    },
  };
}

describe('createMonitor performance vertical slice', () => {
  beforeEach(() => {
    webVitalsMock.callbacks.clear();
    webVitalsMock.onCLS.mockClear();
    webVitalsMock.onFCP.mockClear();
    webVitalsMock.onINP.mockClear();
    webVitalsMock.onLCP.mockClear();
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    class MockPerformanceEventTiming {}
    Object.defineProperty(MockPerformanceEventTiming.prototype, 'interactionId', {
      value: 0,
    });
    vi.stubGlobal('PerformanceEventTiming', MockPerformanceEventTiming);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    history.replaceState({}, '', '/checkout?token=secret#private');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    history.replaceState({}, '', '/');
  });

  it('moves Web Vitals through context, processing, envelope, and transport', async () => {
    const sender = new FakeSender();
    const monitor = createMonitorWithDependencies(options(), { sender });

    monitor.setUser({
      id: 'user-1',
      properties: { role: 'buyer', token: 'private-value' },
    });
    monitor.start();
    webVitalsMock.callbacks.get('LCP')?.(metric('LCP', 1_800));
    monitor.track('order_submit', { attributes: { orderType: 'normal', token: 'secret' } });
    await monitor.flush();

    const events = sender.events();
    const lcp = events.find((event) => event.name === 'LCP');
    const custom = events.find((event) => event.name === 'order_submit');

    expect(lcp).toMatchObject({
      protocolVersion: '3.0',
      type: 'performance',
      app: {
        name: 'checkout',
        version: '1.2.3',
        environment: 'test',
      },
      payload: {
        type: 'performance',
        name: 'LCP',
        value: 1_800,
        unit: 'ms',
        source: 'web-vitals',
        sampleId: 'metric-LCP',
        sequence: 0,
        state: 'provisional',
      },
    });
    expect(lcp?.context.sessionId).toBeTruthy();
    expect(lcp?.context.viewId).toBeTruthy();
    expect(new URL(lcp!.context.url).pathname).toBe('/checkout');
    expect(new URL(lcp!.context.url).search).toBe('');
    expect(lcp?.context.routeName).toBe('/checkout');
    expect(JSON.stringify(lcp)).not.toContain('navigationURL');
    expect(JSON.stringify(lcp)).not.toContain('never-export');

    expect(custom?.context.user?.id).toBe('user-1');
    expect(custom?.payload).toMatchObject({
      type: 'event',
      name: 'order_submit',
      attributes: { orderType: 'normal', token: '[REDACTED]' },
    });

    monitor.destroy();
  });

  it('supports stop and restart without duplicate web-vitals registration', async () => {
    const sender = new FakeSender();
    const monitor = createMonitorWithDependencies(options(), { sender });

    monitor.start();
    monitor.start();
    expect(webVitalsMock.onLCP).toHaveBeenCalledOnce();

    webVitalsMock.callbacks.get('LCP')?.(metric('LCP', 1_700));
    monitor.stop();
    webVitalsMock.callbacks.get('LCP')?.(metric('LCP', 1_800));

    monitor.start();
    expect(webVitalsMock.onLCP).toHaveBeenCalledOnce();
    webVitalsMock.callbacks.get('LCP')?.(metric('LCP', 1_900));
    await monitor.flush();

    const values = sender
      .events()
      .filter((event) => event.name === 'LCP')
      .map((event) => (event.payload.type === 'performance' ? event.payload.value : undefined));

    expect(values).toEqual([1_700, 1_900]);

    monitor.destroy();
    webVitalsMock.callbacks.get('LCP')?.(metric('LCP', 2_000));
    expect(sender.events().filter((event) => event.name === 'LCP')).toHaveLength(2);
  });

  it('reports unified capabilities', () => {
    const monitor = createMonitorWithDependencies(options(), {
      sender: new FakeSender(),
    });

    expect(monitor.getCapabilities()).toEqual({
      performance: {
        LCP: true,
        FCP: true,
        INP: true,
        CLS: true,
        FPS: true,
        LoAF: true,
      },
    });

    monitor.destroy();
  });

  it('binds metrics to the view active at the metric occurrence time', async () => {
    const sender = new FakeSender();
    const monitor = createMonitorWithDependencies(options(), { sender });

    monitor.start();
    const firstMetric = metric('LCP', 100) as {
      entries: Array<{ startTime: number }>;
      [key: string]: unknown;
    };
    firstMetric.entries = [{ startTime: 0 }];
    webVitalsMock.callbacks.get('LCP')?.(firstMetric);

    history.pushState({}, '', '/payment');
    webVitalsMock.callbacks.get('CLS')?.(metric('CLS', 0.05));
    await monitor.flush();

    const performanceEvents = sender.events().filter((event) => event.type === 'performance');
    expect(performanceEvents).toHaveLength(3);
    // Route changes finalize the previous view's latest Web Vital before binding
    // the next metric to the newly created view.
    expect(performanceEvents[0]?.context.viewId).toBe(performanceEvents[1]?.context.viewId);
    expect(performanceEvents[1]?.context.viewId).not.toBe(performanceEvents[2]?.context.viewId);
    expect(performanceEvents[1]?.payload).toMatchObject({ state: 'final', sequence: 1 });

    monitor.destroy();
  });

  it('queues final metric and view snapshots before pagehide flushes', async () => {
    const sender = new FakeSender();
    const monitor = createMonitorWithDependencies(options(), { sender });

    monitor.start();
    webVitalsMock.callbacks.get('LCP')?.(metric('LCP', 1_800));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));

    await vi.waitFor(() => {
      expect(
        sender
          .events()
          .some((event) => event.payload.type === 'performance' && event.payload.state === 'final'),
      ).toBe(true);
      expect(sender.events().some((event) => event.name === 'view.end')).toBe(true);
    });

    monitor.destroy();
  });
});
