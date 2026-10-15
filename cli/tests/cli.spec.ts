import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const bin = fileURLToPath(new URL('../bin/bm.mjs', import.meta.url));
const projectId = '00000000-0000-4000-8000-000000000001';
const keyId = '00000000-0000-4000-8000-000000000002';
let directory: string, baseUrl: string, server: Server;
let requests: { method: string; path: string; cookie: string | undefined; csrf: string | string[] | undefined; body: any }[];
let handler: ((request: IncomingMessage, reply: ServerResponse, path: URL) => Promise<boolean> | boolean) | undefined;
let origins: string[];
let keys: any[];
let enabled: boolean;
function send(reply: ServerResponse, body: unknown, status = 200) {
  reply.writeHead(status, { 'content-type': 'application/json' }); reply.end(JSON.stringify(body));
}
function detail() { return { id: projectId, displayName: '项目', appName: 'test-app', enabled, role: 'owner', origins, keys }; }
function diagnosis(state = 'notObserved', status: string | null = 'pending', projection = 'missing') {
  return { projectId, event: { eventId: 'real-event', occurredAt: '2026-10-13T00:00:00.000Z' },
    raw: { recordState: 'present' }, processing: { state, processedAt: state === 'committed' ? '2026-10-13T00:00:01Z' : null },
    task: { recordState: status === null ? 'missing' : 'present', status, completedAt: status === 'completed' ? '2026-10-13T00:00:02Z' : null },
    projection: { visibility: projection, eventEffect: 'unknown' }, history: { limitations: [] }, source: 'database', asOf: new Date().toISOString() };
}
async function run(args: string[], input = ''): Promise<{ body: any; stdout: string; stderr: string; code: number }> {
  return new Promise((done, reject) => {
    const process = spawn(globalThis.process.execPath, [bin, ...args], { cwd: directory, env: { ...globalThis.process.env, BM_HOME: resolve(directory, 'private') }, windowsHide: true });
    let stdout = '', stderr = '';
    process.stdout.on('data', (data) => stdout += data); process.stderr.on('data', (data) => stderr += data);
    process.on('error', reject);
    process.on('close', (code) => {
      try { done({ body: JSON.parse(stdout), stdout, stderr, code: code ?? 1 }); } catch (error) { reject(new Error(String(error) + ' output=' + stdout + ' stderr=' + stderr)); }
    });
    process.stdin.end(input);
  });
}
async function login() {
  const result = await run(['auth', 'login', '--base-url', baseUrl, '--email', 'test@example.test', '--password-stdin'], 'secret-password\n');
  expect(result.code).toBe(0); return result;
}
async function seedCredential() {
  await mkdir(resolve(directory, 'private'));
  await writeFile(resolve(directory, 'private/credentials.json'), JSON.stringify({ schemaVersion: 1, platforms: { [baseUrl]: { cookie: 'bm_session=private-session', csrfToken: 'private-csrf', expiresAt: null, user: { id: 'user', email: 'test@example.test', displayName: null } } } }));
}
function target(args: string[]) { return [...args, '--base-url', baseUrl, '--project', projectId]; }
beforeEach(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'bm-cli-'));
  requests = []; handler = undefined; origins = ['http://localhost:9000']; enabled = true;
  server = createServer(async (request, reply) => {
    const path = new URL(request.url!, baseUrl);
    let content = ''; for await (const chunk of request) content += chunk;
    requests.push({ method: request.method!, path: path.pathname, cookie: request.headers.cookie, csrf: request.headers['x-csrf-token'], body: content ? JSON.parse(content) : undefined });
    if (handler && await handler(request, reply, path)) return;
    if (path.pathname === '/api/v1/auth/login') {
      reply.setHeader('set-cookie', 'bm_session=private-session; HttpOnly; Path=/; Expires=' + new Date(Date.now() + 3600000).toUTCString());
      send(reply, { user: { id: 'user', email: 'test@example.test', displayName: '用户', csrfToken: 'private-csrf' }, csrfToken: 'private-csrf' }); return;
    }
    if (path.pathname === '/api/v1/auth/me') { send(reply, { user: { id: 'user', email: 'test@example.test', csrfToken: 'private-csrf' }, csrfToken: 'private-csrf' }); return; }
    if (path.pathname === '/api/v1/auth/logout') { reply.writeHead(204); reply.end(); return; }
    if (path.pathname.startsWith('/health/')) { send(reply, { status: 'ok' }); return; }
    if (path.pathname === '/api/v1/projects') {
      send(reply, request.method === 'POST' ? { id: projectId, displayName: requests.at(-1)!.body.displayName, appName: requests.at(-1)!.body.appName, role: 'owner', dsn: baseUrl + '/ingest/key' } : [detail()]); return;
    }
    if (path.pathname === '/api/v1/projects/' + projectId) { send(reply, detail()); return; }
    if (path.pathname.endsWith('/origins')) { origins = requests.at(-1)!.body.origins; send(reply, { origins }); return; }
    if (path.pathname.endsWith('/events')) {
      const from = path.searchParams.get('from'), to = path.searchParams.get('to');
      send(reply, { items: [{ eventId: 'real-event', occurredAt: from, receivedAt: to, type: 'span', name: 'site.route.stay', ...(path.searchParams.get('includePayload') === 'true' ? { event: { payload: { attributes: { description: 'untrusted text' } } } } : {}) }],
        hasMore: !path.searchParams.has('cursor'), nextCursor: path.searchParams.has('cursor') ? null : 'server-cursor', range: { from, to }, asOf: new Date().toISOString(), source: 'database' }); return;
    }
    if (path.pathname.includes('/diagnostics/events/')) { send(reply, diagnosis()); return; }
    send(reply, { code: 'project_not_found' }, 404);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  keys = [{ id: keyId, active: true, expiresAt: null, dsn: baseUrl + '/ingest/key' }];
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  await rm(directory, { recursive: true, force: true });
});
describe('CLI 进程与 HTTP 功能', () => {
  it('登录凭据隔离保存，stdout 不包含密码、Cookie 或 CSRF；退出分别确认清除', async () => {
    const logged = await login(); expect(logged.stdout).not.toMatch(/private-session|private-csrf|secret-password/);
    const saved = JSON.parse(await readFile(resolve(directory, 'private/credentials.json'), 'utf8'));
    expect(saved.platforms[baseUrl].expiresAt).not.toBeNull();
    const status = await run(['auth', 'status', '--base-url', baseUrl]); expect(status.code).toBe(0); expect(status.stdout).not.toContain('private-csrf');
    const logout = await run(['auth', 'logout', '--base-url', baseUrl]); expect(logout.body.data).toEqual({ localCleared: true, remoteRevocation: 'confirmed' });
    expect(requests.at(-1)!.csrf).toBe('private-csrf');
    expect(JSON.parse(await readFile(resolve(directory, 'private/credentials.json'), 'utf8')).platforms).toEqual({});
  }, 15000);
  it('非交互缺少密码与无效输入在网络请求前失败', async () => {
    expect((await run(['auth', 'login', '--email', 'test@example.test', '--base-url', baseUrl])).code).toBe(2);
    expect((await run(target(['project', 'create', '--display-name', '   ', '--app-name', 'invalid name']))).code).toBe(2);
    expect((await run(target(['events', 'list', '--limit', '101']))).code).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it('创建后独立回查与选择，不把创建默认为已回查', async () => {
    await seedCredential();
    const created = await run(target(['project', 'create', '--display-name', '新项目', '--app-name', 'new-project']));
    expect(created.body.data.independentlyReadBack).toBe(false);
    expect(await readFile(resolve(directory, '.browser-monitor.json')).catch(() => null)).toBeNull();
    const selected = await run(['project', 'use', projectId, '--base-url', baseUrl]);
    expect(selected.code).toBe(0);
    expect(JSON.parse(await readFile(resolve(directory, '.browser-monitor.json'), 'utf8')).projectId).toBe(projectId);
    expect((await run(['project', 'get'])).body.context.projectId).toBe(projectId);
  });
  it('切换平台不继承项目或凭据，损坏上下文不能静默忽略', async () => {
    await seedCredential(); await writeFile(resolve(directory, '.browser-monitor.json'), JSON.stringify({ schemaVersion: 1, baseUrl, projectId }));
    expect((await run(['project', 'get', '--base-url', 'http://localhost:1'])).body.error.code).toBe('CONTEXT_MISSING');
    expect((await run(['auth', 'status', '--base-url', 'http://localhost:1'])).body.error.code).toBe('AUTH_REQUIRED');
    await writeFile(resolve(directory, '.browser-monitor.json'), '{broken');
    expect((await run(['project', 'list', '--base-url', baseUrl])).body.error.code).toBe('CONTEXT_MISSING');
    expect(requests).toHaveLength(0);
  });
  it('Origin 归一化去重并整体替换，提交 CSRF，非法来源不写入', async () => {
    await seedCredential();
    const changed = await run(target(['origins', 'set', '--origin', 'http://LOCALHOST:80', '--origin', 'http://localhost/']));
    expect(changed.body.data.origins).toEqual(['http://localhost']);
    expect(requests.at(-1)!.csrf).toBe('private-csrf');
    const before = requests.length;
    expect((await run(target(['origins', 'set', '--origin', 'http://localhost/path']))).code).toBe(2); expect(requests).toHaveLength(before);
    expect((await run(target(['origins', 'get']))).body.data.origins).toEqual(['http://localhost']);
  });
  it('GET 有限重试，写入响应丢失不重试，并保留回查方式', async () => {
    await seedCredential(); let gets = 0, writes = 0;
    handler = (request, reply, path) => {
      if (path.pathname !== '/api/v1/projects') return false;
      if (request.method === 'POST') { writes++; request.socket.destroy(); return true; }
      gets++; if (gets < 3) { send(reply, {}, 503); return true; } return false;
    };
    expect((await run(['project', 'list', '--base-url', baseUrl])).code).toBe(0); expect(gets).toBe(3);
    const write = await run(['project', 'create', '--base-url', baseUrl, '--display-name', '项目', '--app-name', 'app']);
    expect(write.body.error.code).toBe('WRITE_OUTCOME_UNKNOWN'); expect(writes).toBe(1);
  });
  it('重试耗尽最多三次，403 不重试，契约错误不能变成空数据', async () => {
    await seedCredential();
    handler = (_, reply) => { send(reply, {}, 503); return true; };
    expect((await run(['project', 'list', '--base-url', baseUrl])).code).toBe(5); expect(requests).toHaveLength(3);
    requests = []; handler = (_, reply) => { send(reply, {}, 403); return true; };
    expect((await run(['project', 'list', '--base-url', baseUrl])).code).toBe(4); expect(requests).toHaveLength(1);
    handler = (_, reply) => { send(reply, {}); return true; };
    expect((await run(['project', 'list', '--base-url', baseUrl])).body.error.code).toBe('API_CONTRACT_INVALID');
  });
  it('过期身份清除本地记录，不隐式登录', async () => {
    await seedCredential(); handler = (_, reply) => { send(reply, { code: 'session_expired' }, 401); return true; };
    expect((await run(['project', 'list', '--base-url', baseUrl])).body.error.code).toBe('AUTH_EXPIRED');
    expect(requests).toHaveLength(1);
    expect(JSON.parse(await readFile(resolve(directory, 'private/credentials.json'), 'utf8')).platforms).toEqual({});
  });
  it('跨平台重定向拒绝，不跟随认证请求', async () => {
    await seedCredential(); handler = (_, reply) => { reply.writeHead(302, { location: 'http://localhost:1/private' }); reply.end(); return true; };
    expect((await run(['project', 'list', '--base-url', baseUrl])).body.error.code).toBe('API_CONTRACT_INVALID'); expect(requests).toHaveLength(1);
  });
  it('Retry-After 受命令总预算限制，截止后不发新请求', async () => {
    await seedCredential(); handler = (_, reply) => { reply.writeHead(429, { 'retry-after': '120' }); reply.end('{}'); return true; };
    const started = Date.now();
    expect((await run(['project', 'list', '--base-url', baseUrl, '--command-timeout', '0.2'])).body.error.code).toBe('REQUEST_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1500); expect(requests).toHaveLength(1);
  });
  it('SDK JSON 纯净、示例包含函数，已有文件要显式覆盖', async () => {
    await seedCredential();
    const args = target(['sdk', 'export', '--app-version', '1.0.0', '--environment', 'cli-acceptance', '--out', 'monitor.json', '--example-out', 'monitor.ts']);
    expect((await run(args)).code).toBe(0);
    expect(JSON.parse(await readFile(resolve(directory, 'monitor.json'), 'utf8'))).toEqual({ app: { name: 'test-app', version: '1.0.0', environment: 'cli-acceptance' }, transport: { dsn: baseUrl + '/ingest/key' } });
    expect(await readFile(resolve(directory, 'monitor.ts'), 'utf8')).toContain('view: { resolveRouteName');
    expect((await run(args)).body.error.code).toBe('FILE_EXISTS');
    expect((await run([...args, '--overwrite'])).code).toBe(0);
  });
  it('停用项目、默认键歧义和过期键都明确拒绝', async () => {
    await seedCredential();
    const args = target(['sdk', 'export', '--app-version', '1.0.0', '--environment', 'test']);
    enabled = false; expect((await run(args)).body.error.code).toBe('PROJECT_DISABLED');
    enabled = true; keys.push({ ...keys[0], id: 'other-key' }); expect((await run(args)).body.error.code).toBe('KEY_AMBIGUOUS');
    expect((await run([...args, '--key-id', keyId])).code).toBe(0);
    keys = [{ ...keys[0], expiresAt: '2020-01-01T00:00:00Z' }]; expect((await run([...args, '--key-id', keyId])).body.error.code).toBe('KEY_UNAVAILABLE');
  });
  it('示例按自身目录引用实际配置，内联示例按调用目录引用', async () => {
    await seedCredential();
    const args = target(['sdk', 'export', '--app-version', '1.0.0', '--environment', 'test', '--out', 'config/monitor.json']);
    const inline = await run(args);
    expect(inline.body.data.example).toContain('import config from "./config/monitor.json"');
    const exported = await run([...args, '--example-out', 'examples/monitor.ts', '--overwrite']);
    expect(exported.code).toBe(0);
    expect(await readFile(resolve(directory, 'examples/monitor.ts'), 'utf8')).toContain('import config from "../config/monitor.json"');
  });
  it('列表 URL 有查询串时，缺失 API 仍返回能力缺失', async () => {
    await seedCredential(); handler = (_, reply) => { send(reply, {}, 404); return true; };
    expect((await run(target(['events', 'list']))).body.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });
  it('健康检查网络预算到期保留存活事实并返回网络类退出码', async () => {
    handler = (_, __, path) => path.pathname.endsWith('/ready');
    const value = await run(['health', '--base-url', baseUrl, '--command-timeout', '0.2']);
    expect(value.code).toBe(5); expect(value.body.error.code).toBe('HEALTH_UNREADY');
    expect(value.body.data.liveness.state).toBe('pass'); expect(value.body.data.readiness.state).toBe('unknown');
    expect(value.body.data.managementApi.reason).toBe('REQUEST_TIMEOUT');
  });
  it('多文件失败保留已成功产物并报告部分成功', async () => {
    await seedCredential(); await mkdir(resolve(directory, 'blocked-directory'));
    const value = await run(target(['sdk', 'export', '--app-version', '1.0.0', '--environment', 'test', '--out', 'saved.json', '--example-out', 'blocked-directory', '--overwrite']));
    expect(value.code).toBe(8); expect(value.body.data.artifacts).toHaveLength(1); expect(await readFile(resolve(directory, 'saved.json'), 'utf8')).toContain('transport');
  });
  it('游标保持固定窗口并绑定平台、项目与筛选，不自动查询所有页', async () => {
    await seedCredential();
    const first = await run(target(['events', 'list', '--name', 'site.route.stay']));
    expect(first.code).toBe(0); expect(requests).toHaveLength(1);
    const second = await run(target(['events', 'list', '--cursor', first.body.data.nextCursor]));
    expect(second.body.data.range).toEqual(first.body.data.range); expect(second.body.data.hasMore).toBe(false);
    const before = requests.length;
    expect((await run(target(['events', 'list', '--cursor', first.body.data.nextCursor, '--name', 'other']))).body.error.code).toBe('INVALID_CURSOR');
    expect(requests).toHaveLength(before);
  });
  it('诊断失败事实是成功读取，等待失败用独立退出码', async () => {
    await seedCredential(); handler = (_, reply) => { send(reply, diagnosis('committed', 'failed')); return true; };
    expect((await run(target(['events', 'diagnose', '--event-id', 'real-event']))).code).toBe(0);
    const waited = await run(target(['events', 'wait', '--event-id', 'real-event'])); expect(waited.code).toBe(7); expect(waited.body.error.code).toBe('PROCESSING_FAILED');
  });
  it('合法无新增投影也可完成，任务缺失则保留历史不足', async () => {
    await seedCredential(); handler = (_, reply) => { send(reply, diagnosis('committed', 'completed')); return true; };
    const complete = await run(target(['events', 'wait', '--event-id', 'real-event'])); expect(complete.code).toBe(0); expect(complete.body.data.lastObservation.projection.visibility).toBe('missing');
    handler = (_, reply) => { send(reply, diagnosis('committed', null)); return true; };
    expect((await run(target(['events', 'wait', '--event-id', 'real-event']))).body.error.code).toBe('HISTORY_INCOMPLETE');
  });
  it('等待超时带最后观察，剩余预算限制间隔，不继续请求', async () => {
    await seedCredential(); const started = Date.now();
    const waited = await run(target(['events', 'wait', '--event-id', 'real-event', '--timeout', '0.2']));
    expect(waited.code).toBe(6); expect(waited.body.data.polls).toBe(1); expect(waited.body.data.lastObservation.processing.state).toBe('notObserved');
    expect(Date.now() - started).toBeLessThan(1500); expect(requests).toHaveLength(1);
  });
  it('健康无需项目与会话，局部故障带阶段证据', async () => {
    const healthy = await run(['health', '--base-url', baseUrl]); expect(healthy.code).toBe(0);
    handler = (_, reply, path) => { if (path.pathname.endsWith('/ready')) { send(reply, { code: 'not_ready' }, 503); return true; } return false; };
    const unhealthy = await run(['health', '--base-url', baseUrl]); expect(unhealthy.body.error.code).toBe('HEALTH_UNREADY'); expect(unhealthy.body.data.liveness.state).toBe('pass'); expect(unhealthy.body.data.readiness.state).toBe('fail');
  });
});
