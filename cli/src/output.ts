import { CliError, object } from './errors.js';
import type { Context } from './context.js';
export interface Result {
  schemaVersion: 1; ok: boolean; command: string; context: { baseUrl: string; projectId: string | null } | null;
  data: unknown; meta: Record<string, unknown>; error?: { code: string; message: string; details: unknown };
}
export function result(command: string, context: Context | undefined, data: unknown, meta: Record<string, unknown> = {}, error?: CliError): Result {
  return { schemaVersion: 1, ok: !error, command,
    context: context ? { baseUrl: context.baseUrl, projectId: context.projectId } : null,
    data, meta: { source: 'platform_api', warnings: [], ...meta },
    ...(error ? { error: { code: error.code, message: error.message, details: error.details } } : {}) };
}
export function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
    return text.replace(/\b(?:postgres(?:ql)?|redis):\/\/\S+/gi, '[redacted connection]')
      .replace(/\b(bm_session=)[^\s;,]+/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:password|csrfToken|cookie|authorization)$/i.test(key)).map(([key, child]) => [key, redact(child, secrets)]));
  return value;
}
export function render(value: Result, format: string, maxBytes: number): { text: string; exitCode?: number } {
  const json = JSON.stringify(value, null, 2) + '\n';
  // Enforce the same complete result budget before either formatter can print.
  let content = json;
  if (format === 'table') {
    const rows: [string, string][] = [];
    function flatten(data: unknown, key: string): void {
      if (object(data)) for (const [name, child] of Object.entries(data)) flatten(child, key ? key + '.' + name : name);
      else rows.push([key, JSON.stringify(data) ?? 'null']);
    }
    flatten(value, '');
    content = rows.map(([key, data]) => key + '\t' + data).join('\n') + '\n';
  }
  if (Buffer.byteLength(json) > maxBytes || Buffer.byteLength(content) > maxBytes) {
    return { text: JSON.stringify(result(value.command, value.context ? { ...value.context, directory: '' } : undefined, null, { source: value.meta.source, warnings: [], measuredBytes: Math.max(Buffer.byteLength(json), Buffer.byteLength(content)), maxOutputBytes: maxBytes }, new CliError('OUTPUT_TOO_LARGE', '完整输出超过预算。请缩小页数、关闭 payload 或调整输出预算。'))) + '\n', exitCode: 2 };
  }
  return { text: content };
}
