import type { JsonValue } from '@browser-monitor/protocol';

const SENSITIVE_KEY = /authorization|password|passwd|token|secret|cookie|api[_-]?key|session/i;
const MAX_PROPERTY_FIELDS = 100;
const MAX_PROPERTY_BYTES = 16 * 1_024;

interface PropertyBudget {
  fields: number;
}

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return input.split(/[?#]/, 1)[0]?.slice(0, 2_048) ?? '';
  }
}

function redactValue(value: unknown, budget: PropertyBudget, depth: number): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? value.slice(0, 4_096) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 5) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, budget, depth + 1));
  if (typeof value !== 'object') return null;

  const result: Record<string, JsonValue> = {};
  for (const [rawKey, nested] of Object.entries(value)) {
    if (budget.fields >= MAX_PROPERTY_FIELDS) break;
    budget.fields += 1;
    const key = rawKey.slice(0, 128);
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(nested, budget, depth + 1);
  }
  return result;
}

export function redactProperties(value: unknown): JsonValue {
  const redacted = redactValue(value, { fields: 0 }, 0);
  // The request body has its own 256 KiB ceiling; this tighter per-property
  // bound prevents a single custom event from consuming most of a batch.
  if (Buffer.byteLength(JSON.stringify(redacted), 'utf8') > MAX_PROPERTY_BYTES) {
    return { truncated: '[Payload exceeded 16 KiB]' };
  }
  return redacted;
}
