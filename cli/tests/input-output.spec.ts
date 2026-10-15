import { describe, it, expect } from 'vitest';
import { parse, instant, url, number } from '../src/input.js';
import { render, result, redact } from '../src/output.js';
import { queueContract, diagnostic } from '../src/contracts.js';
describe('公共输入与结果协议', () => {
  it('只允许当前命令的参数和合法位置参数', () => {
    expect(() => parse(['events', 'list', '--all'])).toThrow();
    expect(() => parse(['project', 'get', 'guess-name'])).toThrow();
    expect(() => parse(['health', '--format', 'json', '--format', 'table'])).toThrow();
    expect(parse(['origins', 'set', '--origin', 'http://localhost:1', '--origin', 'http://localhost:2']).options.origin).toHaveLength(2);
  });
  it('保留平台路径并严格校验 Origin 与时间', () => {
    expect(url('http://LOCALHOST:80/platform/')).toBe('http://localhost/platform');
    expect(url('http://localhost:80/', true)).toBe('http://localhost');
    for (const value of ['ftp://localhost', 'http://u:p@localhost', 'http://localhost/path', 'http://localhost/?q=1']) expect(() => url(value, true)).toThrow();
    expect(instant('2026-10-13T08:00:00+08:00')).toBe('2026-10-13T00:00:00.000Z');
    for (const value of ['2026-02-30T00:00:00Z', '2026-10-13', '2026-10-13T25:00:00Z']) expect(() => instant(value)).toThrow();
  });
  it('数值边界拒绝无穷、零预算和非整数页数', () => {
    expect(() => number(parse(['health', '--command-timeout', '0']), 'command-timeout', 30, 0.001)).toThrow();
    expect(() => number(parse(['events', 'list', '--limit', '2.5']), 'limit', 50, 1, 100, true)).toThrow();
  });
  it('按 UTF-8 完整结果检查预算，不截断页数据', () => {
    const large = result('events list', undefined, { items: ['中'.repeat(2000)], nextCursor: 'cursor' });
    const rendered = render(large, 'json', 4096);
    const body = JSON.parse(rendered.text);
    expect(rendered.exitCode).toBe(2); expect(body.error.code).toBe('OUTPUT_TOO_LARGE'); expect(body.data).toBeNull();
  });
  it('清理管理身份但保留 SDK DSN，表格控制字符保持转义', () => {
    expect(redact({ csrfToken: 'token', nested: 'bm_session=secret', config: { dsn: 'http://x/ingest/key' } }, ['secret'])).toEqual({ nested: 'bm_session=[redacted]', config: { dsn: 'http://x/ingest/key' } });
    const output = render(result('project get', undefined, { name: '\u001b[31m\nmalicious' }), 'table', 4096).text;
    expect(output).not.toContain('\u001b'); expect(output).toContain('\\n');
  });
  it('必要事实缺失或分类矛盾不能填补为成功', () => {
    expect(() => diagnostic({})).toThrow();
    expect(() => queueContract({ source: 'database', asOf: new Date().toISOString(), pendingTotal: 3, readyPending: 1, delayedPending: 1, pendingUnclassified: 0 })).toThrow();
  });
});
