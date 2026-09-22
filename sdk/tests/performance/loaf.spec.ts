import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoAFCollector } from '../../src/collectors/performance/loaf';
import type { TelemetryDraft, TelemetryEmitter } from '../../src/core/pipeline';
import { SignalHub } from '../../src/core/signal-hub';
import { PerformanceObserverInstrumentation } from '../../src/instrumentation/performance-observer';
import type { TelemetryPayload } from '@browser-monitor/protocol';

class Recorder implements TelemetryEmitter {
  readonly drafts: TelemetryDraft[] = [];

  emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void {
    this.drafts.push(draft as TelemetryDraft);
  }
}

class MockPerformanceObserver {
  static supportedEntryTypes = ['long-animation-frame'];
  static instances: MockPerformanceObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: PerformanceObserverCallback) {
    MockPerformanceObserver.instances.push(this);
  }

  emit(entries: PerformanceEntry[]): void {
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    );
  }
}

function loaf(startTime: number, duration: number): PerformanceEntry {
  return {
    name: 'long-animation-frame',
    entryType: 'long-animation-frame',
    startTime,
    duration,
    blockingDuration: Math.max(0, duration - 50),
    renderStart: startTime + 10,
    styleAndLayoutStart: startTime + 20,
    scripts: [{ sourceURL: '/private?token=secret' }],
  } as unknown as PerformanceEntry;
}

describe('LoAF instrumentation and collector', () => {
  afterEach(() => {
    MockPerformanceObserver.instances = [];
    vi.unstubAllGlobals();
  });

  it('separates observer ownership from filtering and payload conversion', () => {
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    const signals = new SignalHub();
    const recorder = new Recorder();
    const collector = new LoAFCollector(
      { minDurationMs: 50, maxEntriesPerView: 1 },
      signals,
      recorder,
    );
    const instrumentation = new PerformanceObserverInstrumentation(signals, signals, true);

    collector.install();
    instrumentation.install();
    collector.start();
    instrumentation.start();

    const observer = MockPerformanceObserver.instances[0];
    expect(observer?.observe).toHaveBeenCalledWith({
      type: 'long-animation-frame',
      buffered: true,
    });
    observer?.emit([loaf(10, 40), loaf(20, 60), loaf(30, 80)]);

    expect(recorder.drafts).toHaveLength(1);
    expect(recorder.drafts[0]?.payload).toMatchObject({
      type: 'performance',
      name: 'LoAF',
      value: 60,
      detail: { scriptCount: 1 },
    });
    expect(JSON.stringify(recorder.drafts)).not.toContain('sourceURL');
    expect(JSON.stringify(recorder.drafts)).not.toContain('secret');

    signals.publish('view.route-change', {
      timestamp: Date.now(),
      url: 'https://example.test/next',
      source: 'history',
    });
    observer?.emit([loaf(40, 90)]);
    expect(recorder.drafts).toHaveLength(2);

    instrumentation.stop();
    expect(observer?.disconnect).toHaveBeenCalledOnce();
    collector.destroy();
  });
});
