import type { MonitorModule } from '../../core/module-registry';
import type { TelemetryEmitter } from '../../core/pipeline';
import type { SignalSubscriber } from '../../signals';
import { createId } from '../../shared/id';

export class FPSCollector implements MonitorModule {
  readonly name = 'fps-collector';
  private unsubscribe: (() => void) | undefined;
  private active = false;

  constructor(
    private readonly signals: SignalSubscriber,
    private readonly emitter: TelemetryEmitter,
  ) {}

  install(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.signals.subscribe('performance.frame-window', (signal) => {
      if (!this.active || signal.sampleDurationMs <= 0 || signal.frameCount <= 0) return;

      // frameCount 表示完整帧间隔数，按实际窗口时长换算，避免假设固定采样周期。
      this.emitter.emit({
        name: 'FPS',
        timestamp: signal.timestamp,
        payload: {
          type: 'performance',
          name: 'FPS',
          sampleId: createId('sample'),
          sequence: 0,
          state: 'final',
          value: (signal.frameCount * 1_000) / signal.sampleDurationMs,
          unit: 'fps',
          kind: 'runtime',
          source: 'request-animation-frame',
          detail: {
            frameCount: signal.frameCount,
            sampleDurationMs: signal.sampleDurationMs,
          },
        },
      });
    });
  }

  start(): void {
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  destroy(): void {
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
