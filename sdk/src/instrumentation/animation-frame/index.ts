import type { MonitorModule } from '../../core/module-registry';
import type { SignalPublisher, SignalSubscriber } from '../../signals';
import { performanceTimeOrigin } from '../../shared/time';

export interface AnimationFrameInstrumentationOptions {
  sampleWindowMs: number;
  sampleIntervalMs: number;
  enabled: boolean;
}

export class AnimationFrameInstrumentation implements MonitorModule {
  readonly name = 'animation-frame-instrumentation';
  private active = false;
  private sampling = false;
  private animationFrameId: number | undefined;
  private intervalTimer: ReturnType<typeof setTimeout> | undefined;
  private firstFrameTime: number | undefined;
  private frameCount = 0;
  private unsubscribeLifecycle: (() => void) | undefined;

  constructor(
    private readonly options: AnimationFrameInstrumentationOptions,
    private readonly publisher: SignalPublisher,
    private readonly signals: SignalSubscriber,
  ) {}

  install(): void {
    if (this.unsubscribeLifecycle) return;
    this.unsubscribeLifecycle = this.signals.subscribe('page.lifecycle', (signal) => {
      if (!this.active) return;
      // 后台标签页中的 rAF 会被浏览器节流，继续采样会得到失真的 FPS。
      if (signal.type === 'hidden' || signal.type === 'pagehide') this.pause();
      if (signal.type === 'visible' || signal.type === 'pageshow') this.resume();
    });
  }

  start(): void {
    if (this.active || !this.options.enabled) return;
    this.active = true;
    if (this.isVisible()) this.startWindow();
  }

  stop(): void {
    this.active = false;
    this.cancelPendingWork();
  }

  destroy(): void {
    this.stop();
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = undefined;
  }

  supported(): boolean {
    return (
      typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'
    );
  }

  private pause(): void {
    this.cancelPendingWork();
  }

  private resume(): void {
    if (!this.active || !this.isVisible()) return;
    this.cancelPendingWork();
    this.startWindow();
  }

  // 每个窗口只聚合帧数与持续时间，FPS 的领域计算留给 Collector。
  private startWindow(): void {
    if (!this.active || this.sampling || !this.supported()) return;
    this.sampling = true;
    this.firstFrameTime = undefined;
    this.frameCount = 0;
    this.animationFrameId = requestAnimationFrame(this.collectFrame);
  }

  private readonly collectFrame: FrameRequestCallback = (timestamp) => {
    if (!this.active || !this.sampling) return;

    // 第一帧用于确定窗口起点，不计入完整帧间隔数量。
    if (this.firstFrameTime === undefined) {
      this.firstFrameTime = timestamp;
    } else {
      this.frameCount += 1;
    }

    const duration = timestamp - this.firstFrameTime;
    if (duration >= this.options.sampleWindowMs) {
      this.sampling = false;
      this.animationFrameId = undefined;
      if (duration > 0 && this.frameCount > 0) {
        // rAF timestamp 是相对时间，转换后才能按事件时间关联 View。
        this.publisher.publish('performance.frame-window', {
          timestamp: performanceTimeOrigin() + timestamp,
          frameCount: this.frameCount,
          sampleDurationMs: duration,
        });
      }

      this.resetWindow();
      this.intervalTimer = setTimeout(() => {
        this.intervalTimer = undefined;
        this.startWindow();
      }, this.options.sampleIntervalMs);
      return;
    }

    this.animationFrameId = requestAnimationFrame(this.collectFrame);
  };

  private cancelPendingWork(): void {
    if (this.animationFrameId !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.intervalTimer !== undefined) clearTimeout(this.intervalTimer);
    this.animationFrameId = undefined;
    this.intervalTimer = undefined;
    this.sampling = false;
    this.resetWindow();
  }

  private resetWindow(): void {
    this.firstFrameTime = undefined;
    this.frameCount = 0;
  }

  private isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }
}
