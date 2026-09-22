import type { MonitorModule } from '../../core/module-registry';
import type { TelemetryEmitter } from '../../core/pipeline';
import type { SignalSubscriber } from '../../signals';
import { createId } from '../../shared/id';

export interface LoAFCollectorOptions {
  minDurationMs: number;
  maxEntriesPerView: number;
}

export class LoAFCollector implements MonitorModule {
  readonly name = 'loaf-collector';
  private readonly unsubscribers: Array<() => void> = [];
  private active = false;
  private emittedEntries = 0;

  constructor(
    private readonly options: LoAFCollectorOptions,
    private readonly signals: SignalSubscriber,
    private readonly emitter: TelemetryEmitter,
  ) {}

  install(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      // 上报额度按 View 隔离，避免一个页面的长任务耗尽后续页面的额度。
      this.signals.subscribe('view.route-change', () => {
        this.emittedEntries = 0;
      }),
      this.signals.subscribe('performance.loaf', (signal) => {
        if (
          !this.active ||
          signal.duration < this.options.minDurationMs ||
          this.emittedEntries >= this.options.maxEntriesPerView
        ) {
          return;
        }

        // 阈值和每 View 上限属于监控语义，应留在 Collector 而不是浏览器采集层。
        this.emittedEntries += 1;
        this.emitter.emit({
          name: 'LoAF',
          timestamp: signal.timestamp,
          payload: {
            type: 'performance',
            name: 'LoAF',
            sampleId: createId('sample'),
            sequence: 0,
            state: 'final',
            value: signal.duration,
            unit: 'ms',
            kind: 'diagnostic',
            source: 'performance-observer',
            detail: {
              startTime: signal.startTime,
              blockingDuration: signal.blockingDuration,
              renderStart: signal.renderStart,
              styleAndLayoutStart: signal.styleAndLayoutStart,
              scriptCount: signal.scriptCount,
            },
          },
        });
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
  }
}
