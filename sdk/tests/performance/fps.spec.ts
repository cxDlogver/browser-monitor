import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FPSCollector } from '../../src/collectors/performance/fps';
import type { TelemetryDraft, TelemetryEmitter } from '../../src/core/pipeline';
import { SignalHub } from '../../src/core/signal-hub';
import { AnimationFrameInstrumentation } from '../../src/instrumentation/animation-frame';
import type { TelemetryPayload } from '@browser-monitor/protocol';

class Recorder implements TelemetryEmitter {
  readonly drafts: TelemetryDraft[] = [];

  emit<T extends TelemetryPayload>(draft: TelemetryDraft<T>): void {
    this.drafts.push(draft as TelemetryDraft);
  }
}

describe('FPS instrumentation and collector', () => {
  let callbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  const frame = (timestamp: number): void => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(timestamp);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = new Map();
    nextId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => callbacks.delete(id)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps frame-window mechanics in instrumentation and FPS semantics in collector', () => {
    const signals = new SignalHub();
    const recorder = new Recorder();
    const collector = new FPSCollector(signals, recorder);
    const instrumentation = new AnimationFrameInstrumentation(
      { enabled: true, sampleWindowMs: 1_000, sampleIntervalMs: 30_000 },
      signals,
      signals,
    );

    collector.install();
    instrumentation.install();
    collector.start();
    instrumentation.start();

    for (let timestamp = 0; timestamp <= 1_000; timestamp += 100) frame(timestamp);

    expect(recorder.drafts).toHaveLength(1);
    expect(recorder.drafts[0]?.payload).toMatchObject({
      type: 'performance',
      name: 'FPS',
      value: 10,
      detail: {
        frameCount: 10,
        sampleDurationMs: 1_000,
      },
    });

    instrumentation.stop();
    collector.stop();
    expect(callbacks.size).toBe(0);
  });

  it('pauses and resumes through page lifecycle signals', () => {
    const signals = new SignalHub();
    const recorder = new Recorder();
    const collector = new FPSCollector(signals, recorder);
    const instrumentation = new AnimationFrameInstrumentation(
      { enabled: true, sampleWindowMs: 1_000, sampleIntervalMs: 30_000 },
      signals,
      signals,
    );

    collector.install();
    instrumentation.install();
    collector.start();
    instrumentation.start();
    frame(0);
    frame(100);

    signals.publish('page.lifecycle', {
      type: 'hidden',
      timestamp: 100,
      persisted: false,
    });
    expect(callbacks.size).toBe(0);

    signals.publish('page.lifecycle', {
      type: 'visible',
      timestamp: 200,
      persisted: false,
    });
    for (let timestamp = 2_000; timestamp <= 3_000; timestamp += 100) frame(timestamp);

    expect(recorder.drafts).toHaveLength(1);
    instrumentation.destroy();
    collector.destroy();
  });
});
