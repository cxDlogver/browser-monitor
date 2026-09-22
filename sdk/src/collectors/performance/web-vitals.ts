import type { MonitorModule } from '../../core/module-registry';
import type { TelemetryEmitter } from '../../core/pipeline';
import type { PerformanceMetricName, WebVitalPerformancePayload } from '@browser-monitor/protocol';
import type { SignalSubscriber, WebVitalSignal } from '../../signals';

// Collector 只接收稳定的 Raw Signal，不把 web-vitals 库对象泄漏进领域协议。
function toPayload(
  signal: WebVitalSignal,
  sequence: number,
  state: 'provisional' | 'final',
): WebVitalPerformancePayload {
  const common = {
    type: 'performance' as const,
    sampleId: signal.metricId,
    sequence,
    state,
    value: signal.value,
    delta: signal.delta,
    clientRating: signal.rating,
    source: 'web-vitals' as const,
    navigationType: signal.navigationType,
    navigationId: signal.navigationId,
  };

  switch (signal.name) {
    case 'LCP':
      return { ...common, name: 'LCP', unit: 'ms', kind: 'core-web-vital' };
    case 'FCP':
      return { ...common, name: 'FCP', unit: 'ms', kind: 'diagnostic' };
    case 'INP':
      return { ...common, name: 'INP', unit: 'ms', kind: 'core-web-vital' };
    case 'CLS':
      return { ...common, name: 'CLS', unit: 'score', kind: 'core-web-vital' };
  }
}

export class WebVitalsCollector implements MonitorModule {
  readonly name = 'web-vitals-collector';
  private readonly unsubscribers: Array<() => void> = [];
  private readonly sequenceBySample = new Map<string, number>();
  private readonly latestBySample = new Map<string, WebVitalSignal>();
  private active = false;

  constructor(
    private readonly signals: SignalSubscriber,
    private readonly emitter: TelemetryEmitter,
    private readonly enabled: Readonly<Record<PerformanceMetricName, boolean>>,
  ) {}

  install(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      this.signals.subscribe('performance.web-vital', (signal) => {
        if (!this.active || !this.enabled[signal.name]) return;
        this.latestBySample.set(signal.metricId, signal);
        this.emit(signal, 'provisional', signal.timestamp);
      }),
      // This subscriber is installed before ViewCollector. Final snapshots are
      // therefore still bound to the view that is about to end.
      this.signals.subscribe('view.route-change', (signal) => {
        if (this.active) this.finalize(signal.timestamp);
      }),
      this.signals.subscribe('page.lifecycle', (signal) => {
        if (this.active && signal.type === 'pagehide' && !signal.persisted) {
          this.finalize(signal.timestamp);
        }
      }),
    );
  }

  start(): void {
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  destroy(): void {
    this.stop();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.latestBySample.clear();
    this.sequenceBySample.clear();
  }

  private emit(signal: WebVitalSignal, state: 'provisional' | 'final', timestamp: number): void {
    const sequence = this.sequenceBySample.get(signal.metricId) ?? 0;
    this.sequenceBySample.set(signal.metricId, sequence + 1);
    this.emitter.emit({
      name: signal.name,
      timestamp,
      payload: toPayload(signal, sequence, state),
    });
  }

  private finalize(timestamp: number): void {
    for (const signal of this.latestBySample.values()) this.emit(signal, 'final', timestamp);
    this.latestBySample.clear();
  }
}
