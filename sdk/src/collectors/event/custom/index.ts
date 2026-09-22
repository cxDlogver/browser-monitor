import type { TelemetryEmitter } from '../../../core/pipeline';
import type { JsonValue } from '@browser-monitor/protocol';

function toJsonValue(value: unknown, depth: number = 0): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 5) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => toJsonValue(item, depth + 1));
  // Functions, symbols, bigint and undefined do not have a JSON representation.
  if (typeof value !== 'object') return null;

  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 50)) {
    result[key.slice(0, 128)] = toJsonValue(nested, depth + 1);
  }
  return result;
}

export class CustomEventCollector {
  constructor(private readonly emitter: TelemetryEmitter) {}

  track(name: string, properties?: Readonly<Record<string, unknown>>): void {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Event name is required.');

    this.emitter.emit({
      name: normalizedName,
      timestamp: Date.now(),
      payload: {
        type: 'event',
        name: normalizedName,
        source: 'custom',
        ...(properties ? { properties: toJsonValue(properties) as Record<string, JsonValue> } : {}),
      },
    });
  }
}
