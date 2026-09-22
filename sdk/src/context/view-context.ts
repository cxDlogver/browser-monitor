import type { RouteLocation } from '../core/config';
import { createId } from '../shared/id';
import { sanitizeUrl } from '../shared/url';
import type { ViewPayload } from '@browser-monitor/protocol';

export type ViewSource = ViewPayload['source'];

export interface ViewRecord {
  viewId: string;
  routeName: string;
  url: string;
  startedAt: number;
  source: ViewSource;
  endedAt?: number;
}

/**
 * 保存一段有界的 View 时间线，使晚到的性能数据仍可归属到发生时的页面，
 * 而不是错误地绑定到回调执行时的当前页面。
 */
export class ViewContext {
  private readonly history: ViewRecord[] = [];
  private pendingRouteName: string | undefined;

  constructor(
    private readonly resolveRouteName?: (location: RouteLocation) => string | undefined,
    private readonly maxHistorySize: number = 20,
  ) {}

  start(
    url: string,
    timestamp: number,
    source: ViewSource,
  ): {
    current: ViewRecord;
    previous?: ViewRecord;
  } {
    const previous = this.end(timestamp);
    // URL 在进入 Context 时移除完整 query 与 fragment，避免敏感信息和高基数扩散。
    const sanitizedUrl = sanitizeUrl(url);
    const current: ViewRecord = Object.freeze({
      viewId: createId('view'),
      routeName: this.pendingRouteName ?? this.resolveName(sanitizedUrl),
      url: sanitizedUrl,
      startedAt: timestamp,
      source,
    });
    this.pendingRouteName = undefined;
    this.history.push(current);
    this.trim();

    return {
      current,
      ...(previous ? { previous } : {}),
    };
  }

  end(timestamp: number): ViewRecord | undefined {
    const current = this.current();
    if (!current || current.endedAt !== undefined) return undefined;

    const ended = Object.freeze({ ...current, endedAt: Math.max(timestamp, current.startedAt) });
    this.history[this.history.length - 1] = ended;
    return ended;
  }

  current(): ViewRecord | undefined {
    return this.history.at(-1);
  }

  /** Override the current view's stable aggregation name, or the next view before start. */
  setName(name: string): void {
    const normalized = name.trim();
    if (!normalized) return;
    const routeName = normalized.slice(0, 160);
    const current = this.current();
    if (!current) {
      this.pendingRouteName = routeName;
      return;
    }
    this.history[this.history.length - 1] = Object.freeze({ ...current, routeName });
  }

  // 从最新记录反向查找，常见情况下可直接命中且能正确处理历史 View。
  resolveAt(timestamp: number): ViewRecord | undefined {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const view = this.history[index];
      if (!view) continue;

      const endsAfterTimestamp = view.endedAt === undefined || timestamp <= view.endedAt;
      if (timestamp >= view.startedAt && endsAfterTimestamp) return view;
    }

    // 超出保留窗口时降级到当前 View，保证 Envelope 仍具备完整上下文。
    return this.current();
  }

  clear(): void {
    this.history.length = 0;
  }

  private trim(): void {
    while (this.history.length > this.maxHistorySize) this.history.shift();
  }

  private resolveName(input: string): string {
    try {
      const url = new URL(input, 'http://localhost/');
      const snapshot: RouteLocation = {
        href: url.href,
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
      };
      const resolved = this.resolveRouteName?.(snapshot)?.trim();
      return resolved ? resolved.slice(0, 160) : url.pathname || '/';
    } catch {
      return '/';
    }
  }
}
