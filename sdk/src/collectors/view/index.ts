import type { ContextManager, ViewRecord } from '../../context';
import type { MonitorModule } from '../../core/module-registry';
import type { TelemetryEmitter } from '../../core/pipeline';
import type { SignalSubscriber } from '../../signals';
import { currentUrl } from '../../shared/url';

export class ViewCollector implements MonitorModule {
  readonly name = 'view-collector';
  private readonly unsubscribers: Array<() => void> = [];
  private active = false;

  constructor(
    private readonly signals: SignalSubscriber,
    private readonly context: ContextManager,
    private readonly emitter: TelemetryEmitter,
  ) {}

  install(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      this.signals.subscribe('view.route-change', (signal) => {
        if (!this.active) return;
        this.changeView(signal.url, signal.timestamp, signal.source);
      }),
      this.signals.subscribe('page.lifecycle', (signal) => {
        if (!this.active) return;
        // 进入 BFCache 的页面并未真正销毁；普通 pagehide 才结束当前 View。
        if (signal.type === 'pagehide' && !signal.persisted) {
          const ended = this.context.endView(signal.timestamp);
          if (ended) this.emitEnd(ended);
        }
        if (signal.type === 'pageshow' && signal.persisted) {
          this.changeView(currentUrl(), signal.timestamp, 'bfcache');
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
  }

  private changeView(
    url: string,
    timestamp: number,
    source: 'initial' | 'history' | 'popstate' | 'hashchange' | 'bfcache',
  ): void {
    // 先结束旧 View，再开始并上报新 View，保证时间线连续且事件顺序稳定。
    const changed = this.context.startView(url, timestamp, source);
    if (changed.previous) this.emitEnd(changed.previous);
    this.emitter.emit({
      name: 'view.start',
      timestamp,
      context: this.context.snapshotForView(changed.current),
      payload: {
        type: 'view',
        name: 'view.start',
        viewId: changed.current.viewId,
        routeName: changed.current.routeName,
        url: changed.current.url,
        startedAt: changed.current.startedAt,
        source: changed.current.source,
      },
    });
  }

  private emitEnd(view: ViewRecord): void {
    if (view.endedAt === undefined) return;
    this.emitter.emit({
      name: 'view.end',
      timestamp: view.endedAt,
      context: this.context.snapshotForView(view),
      payload: {
        type: 'view',
        name: 'view.end',
        viewId: view.viewId,
        routeName: view.routeName,
        url: view.url,
        startedAt: view.startedAt,
        endedAt: view.endedAt,
        source: view.source,
      },
    });
  }
}
