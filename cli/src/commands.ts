import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { CliError, contract, invalid, object } from './errors.js';
import { option, text, number, url, uuid, instant, cursorError, type Input } from './input.js';
import { project, saveContext, type Context, type Session } from './context.js';
import { atomicWrite, exists } from './files.js';
import { Http } from './http.js';
import { diagnostic, projectContract, queueContract, timestamp } from './contracts.js';

export interface Execution { data: any; meta?: Record<string, unknown> }
async function password(stdin: boolean): Promise<string> {
  if (stdin) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 4096) invalid('密码输入过长');
    }
    const value = input.replace(/\r?\n$/, '');
    if (!value) invalid('标准输入未提供密码');
    return value;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) invalid('非交互登录必须使用 --password-stdin');
  process.stderr.write('密码：');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('keypress', listener); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); };
    const listener = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === 'return') { cleanup(); value ? resolvePassword(value) : reject(new CliError('INVALID_ARGUMENT', '密码不能为空')); }
      else if (key.ctrl && key.name === 'c') { cleanup(); reject(new CliError('INVALID_ARGUMENT', '登录已取消')); }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (character && !key.ctrl && value.length < 4096) value += character;
    };
    process.stdin.on('keypress', listener);
  });
}
export async function prepare(input: Input, context: Context): Promise<Record<string, any>> {
  const v: Record<string, any> = {};
  const command = input.command;
  if (command.startsWith('origins ') || command.startsWith('sdk ') || command.startsWith('events ') || command === 'project get' || command === 'data summary' || command === 'queue status') project(context);
  if (command === 'project use') v.projectId = uuid(input.args[0]!);
  if (command === 'project create') {
    v.displayName = text(input, 'display-name', 120, true); v.appName = text(input, 'app-name', 128, true);
    if (!/^[a-z0-9._-]+$/i.test(v.appName)) invalid('应用标识仅允许字母、数字、点、下划线和连字符');
  }
  if (command === 'auth login') {
    v.email = text(input, 'email', 254, true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) invalid('无效邮箱');
    v.password = await password(option(input, 'password-stdin') === 'true');
  }
  if (command === 'origins set') {
    const origins = input.options.origin ?? [];
    if (origins.length < 1 || origins.length > 50) invalid('需要 1–50 个业务 Origin');
    v.origins = [...new Set(origins.map((origin) => url(origin, true)))];
  }
  if (command === 'sdk export') {
    v.appVersion = text(input, 'app-version', 64, true); v.environment = text(input, 'environment', 64, true);
    v.keyId = text(input, 'key-id', 256); v.overwrite = option(input, 'overwrite') === 'true';
    v.outputs = Object.fromEntries(['out', 'example-out'].filter((key) => option(input, key) !== undefined).map((key) => [key, resolve(text(input, key, 32767, true)!)]));
    if (v.outputs.out && v.outputs.out === v.outputs['example-out']) invalid('配置与示例不能写到同一文件');
    for (const path of Object.values(v.outputs) as string[]) if (!v.overwrite && await exists(path)) throw new CliError('FILE_EXISTS', '文件已存在，需要显式 --overwrite。', { path });
  }
  if (command.startsWith('events ') && command !== 'events list') {
    v.eventId = text(input, 'event-id', 256, true);
    const occurredAt = option(input, 'occurred-at'); if (occurredAt !== undefined) v.occurredAt = instant(occurredAt);
    v.includePayload = option(input, 'include-payload') === 'true';
  }
  if (command === 'events wait') {
    v.timeout = number(input, 'timeout', 60, 0.001); v.interval = number(input, 'interval', 2, 1);
  }
  if (command === 'events list') {
    v.limit = number(input, 'limit', 50, 1, 100, true);
    const filters: Record<string, string> = {};
    for (const [key, mapped, max] of [
      ['type', 'type', 32], ['name', 'name', 128], ['event-id', 'eventId', 256],
      ['environment', 'environment', 64], ['version', 'version', 64], ['route-name', 'routeName', 160],
      ['session-id', 'sessionId', 256], ['view-id', 'viewId', 256],
    ] as const) { const value = text(input, key, max); if (value !== undefined) filters[mapped] = value; }
    if (filters.type && !['performance', 'view', 'event', 'trace', 'span'].includes(filters.type)) invalid('未知事件类型');
    v.includePayload = option(input, 'include-payload') === 'true';
    const suppliedCursor = option(input, 'cursor');
    if (suppliedCursor) {
      let cursor: any;
      try { cursor = JSON.parse(Buffer.from(suppliedCursor, 'base64url').toString('utf8')); } catch { cursorError('游标无法解析'); }
      if (!object(cursor) || cursor.cliVersion !== 1 || cursor.baseUrl !== context.baseUrl || cursor.projectId !== context.projectId ||
          !object(cursor.query) || typeof cursor.serverCursor !== 'string' || suppliedCursor.length > 32768) cursorError('游标不属于当前平台或项目');
      for (const [key, value] of Object.entries(filters)) if (cursor.query[key] !== value) cursorError('游标过滤条件与参数冲突');
      if (option(input, 'from') && instant(option(input, 'from')!) !== cursor.query.from) cursorError('游标起始时间与参数冲突');
      if (option(input, 'to') && instant(option(input, 'to')!) !== cursor.query.to) cursorError('游标结束时间与参数冲突');
      const allowed = new Set(['from', 'to', 'type', 'name', 'eventId', 'environment', 'version', 'routeName', 'sessionId', 'viewId']);
      if (Object.entries(cursor.query).some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) cursorError('游标包含无效查询条件');
      v.query = cursor.query; v.serverCursor = cursor.serverCursor;
    } else {
      const to = option(input, 'to') ? instant(option(input, 'to')!) : new Date().toISOString();
      const from = option(input, 'from') ? instant(option(input, 'from')!) : new Date(Date.parse(to) - 86400000).toISOString();
      v.query = { from, to, ...filters };
    }
    v.query.from = instant(v.query.from); v.query.to = instant(v.query.to);
    const duration = Date.parse(v.query.to) - Date.parse(v.query.from);
    if (duration <= 0 || duration > 180 * 86400000) invalid('查询窗口必须为正，最长 180 天');
  }
  return v;
}
export async function execute(input: Input, ctx: Context, v: Record<string, any>, http: Http): Promise<Execution> {
  const command = input.command;
  const base = '/api/v1/projects/' + ctx.projectId;
  let projectReadAt = Date.now();
  let projectTimeSource = 'client_clock';
  const getDetail = async (id = project(ctx)) => {
    const { body, headers } = await http.request('/api/v1/projects/' + id);
    const serverDate = Date.parse(headers.get('date') ?? '');
    if (Number.isFinite(serverDate)) { projectReadAt = serverDate; projectTimeSource = 'server_http_date'; }
    projectContract(body, true); return body;
  };
  const queryString = (value: Record<string, any>) => new URLSearchParams(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, String(child)])).toString();
  const diagnose = async () => {
    const { body } = await http.request(base + '/diagnostics/events/' + encodeURIComponent(v.eventId) + '?' +
      queryString({ occurredAt: v.occurredAt, includePayload: v.includePayload }));
    diagnostic(body); contract(body.event.eventId === v.eventId && body.projectId === ctx.projectId, '事件诊断身份与请求不一致。');
    if (v.occurredAt && body.event.occurredAt !== v.occurredAt) contract(false, '事件诊断时间与请求不一致。');
    return body;
  };
  if (command === 'auth login') {
    const { body, headers } = await http.request('/api/v1/auth/login', 'POST', { email: v.email, password: v.password }, false);
    const cookies = headers.getSetCookie();
    const sessionCookie = cookies.find((cookie) => /^bm_session=/.test(cookie));
    contract(object(body) && object(body.user) && typeof body.user.id === 'string' && typeof body.user.email === 'string' && typeof body.csrfToken === 'string' && body.csrfToken && sessionCookie, '登录成功响应缺少必要凭据。');
    const expiry = /(?:^|;)\s*Expires=([^;]+)/i.exec(sessionCookie!)?.[1];
    const maxAge = /(?:^|;)\s*Max-Age=(\d+)/i.exec(sessionCookie!)?.[1];
    const expiresAt = expiry && timestamp(expiry) ? new Date(expiry).toISOString() : maxAge ? new Date(Date.now() + Number(maxAge) * 1000).toISOString() : null;
    const session: Session = { cookie: sessionCookie!.split(';')[0]!, csrfToken: body.csrfToken, expiresAt,
      user: { id: body.user.id, email: body.user.email, displayName: typeof body.user.displayName === 'string' ? body.user.displayName : null } };
    const data = { user: session.user, expiresAt, sessionSaved: true };
    try { await http.credentials.set(ctx.baseUrl, session); http.session = session; }
    catch { throw new CliError('PARTIAL_SUCCESS', '已建立远端会话，但本地保存失败。', null, { ...data, sessionSaved: false }); }
    return { data, meta: { source: 'platform_api', expiresAt } };
  }
  if (command === 'auth status') {
    const { body } = await http.request('/api/v1/auth/me');
    contract(object(body) && object(body.user) && typeof body.user.id === 'string' && typeof body.user.email === 'string', '身份响应契约无效。');
    return { data: { user: { id: body.user.id, email: body.user.email, displayName: body.user.displayName ?? null }, expiresAt: http.session?.expiresAt ?? null, verified: true } };
  }
  if (command === 'auth logout') {
    let remoteRevocation = 'unknown'; let failure: CliError | undefined;
    try { await http.request('/api/v1/auth/logout', 'POST'); remoteRevocation = 'confirmed'; }
    catch (error) { failure = error as CliError; if (failure.code === 'AUTH_EXPIRED') remoteRevocation = 'already_expired'; if (failure.code === 'AUTH_REQUIRED') remoteRevocation = 'no_local_session'; }
    try { await http.credentials.set(ctx.baseUrl, undefined); http.session = undefined; }
    catch { throw new CliError('PARTIAL_SUCCESS', '退出时清除本地凭据失败。', null, { localCleared: false, remoteRevocation }); }
    const data = { localCleared: true, remoteRevocation };
    if (failure && remoteRevocation === 'unknown') throw new CliError('PARTIAL_SUCCESS', '已清除本地凭据，远端撤销结果未知。', { remoteError: failure.code }, data);
    return { data };
  }
  if (command === 'project list') {
    const { body } = await http.request('/api/v1/projects'); contract(Array.isArray(body), '项目列表契约无效。');
    body.forEach((row) => projectContract(row)); return { data: { items: body } };
  }
  if (command === 'project get') return { data: await getDetail() };
  if (command === 'project create') {
    const { body } = await http.request('/api/v1/projects', 'POST', { displayName: v.displayName, appName: v.appName });
    try { projectContract(body, false, true); contract(typeof body.dsn === 'string', '创建响应缺少 DSN'); }
    catch { throw new CliError('WRITE_OUTCOME_UNKNOWN', '创建响应缺少可靠确认。请回查，勿自动重建。', null, object(body) && typeof body.id === 'string' ? { id: body.id, confirmation: 'incomplete' } : null); }
    return { data: { ...body, confirmation: 'server_response', independentlyReadBack: false } };
  }
  if (command === 'project use') {
    const detail = await getDetail(v.projectId);
    try { await saveContext(ctx, detail.id); }
    catch { throw new CliError('PARTIAL_SUCCESS', '项目可访问，但上下文保存失败。', null, { projectId: detail.id, accessible: true, contextSaved: false }); }
    ctx.projectId = detail.id; return { data: { projectId: detail.id, contextSaved: true, path: resolve(ctx.directory, '.browser-monitor.json') }, meta: { source: 'platform_api_and_local_file' } };
  }
  if (command === 'origins get') return { data: { origins: (await getDetail()).origins } };
  if (command === 'origins set') {
    const { body } = await http.request(base + '/origins', 'PUT', { origins: v.origins });
    if (!object(body) || !Array.isArray(body.origins) || !body.origins.every((origin: unknown) => typeof origin === 'string')) throw new CliError('WRITE_OUTCOME_UNKNOWN', '来源写响应无可靠确认，请用 origins get 回查。');
    return { data: { origins: body.origins, confirmation: 'server_response', semantics: 'replace_entire_set' } };
  }
  if (command === 'sdk export') {
    const detail = await getDetail();
    if (!detail.enabled) throw new CliError('PROJECT_DISABLED', '项目已停用，不能导出接入配置。');
    let key;
    if (v.keyId) key = detail.keys.find((item: any) => item.id === v.keyId && item.active && (item.expiresAt === null || Date.parse(item.expiresAt) > projectReadAt));
    else {
      const current = detail.keys.filter((item: any) => item.active && item.expiresAt === null);
      if (current.length > 1) throw new CliError('KEY_AMBIGUOUS', '存在多个当前键，请用 --key-id 明确选择。');
      key = current[0];
    }
    if (!key) throw new CliError('KEY_UNAVAILABLE', '没有符合条件的写入键。');
    contract(typeof detail.appName === 'string' && detail.appName.trim().length > 0 && detail.appName.length <= 128, '应用标识契约无效。');
    try { const dsn = new URL(key.dsn); contract(['http:', 'https:'].includes(dsn.protocol) && !dsn.username && !dsn.password, '无效 DSN'); } catch { throw new CliError('API_CONTRACT_INVALID', '平台 DSN 无效。'); }
    const config = { app: { name: detail.appName, version: v.appVersion, environment: v.environment }, transport: { dsn: key.dsn } };
    const configPath = v.outputs.out ?? resolve('monitor.json');
    const exampleDirectory = v.outputs['example-out'] ? dirname(v.outputs['example-out']) : process.cwd();
    const relativeConfig = relative(exampleDirectory, configPath).replaceAll('\\', '/');
    const configReference = isAbsolute(relativeConfig) ? pathToFileURL(configPath).href :
      relativeConfig.startsWith('.') ? relativeConfig : './' + relativeConfig;
    const example = [
      'import { createMonitor } from "@cxdlogver/browser-monitor-sdk";',
      'import config from ' + JSON.stringify(configReference) + ';',
      '', '// 在浏览器客户端入口启动；SSR 项目使用客户端插件。',
      'const monitor = createMonitor({',
      '  ...config,',
      '  view: { resolveRouteName: (location) => location.pathname },',
      '});',
      'monitor.start();',
      '// 在业务需要结束监控时调用 monitor.destroy()。', '',
    ].join('\n');
    const artifacts: { kind: string; path: string }[] = [];
    for (const [kind, path] of Object.entries(v.outputs) as [string, string][]) {
      try { await atomicWrite(path, kind === 'out' ? JSON.stringify(config, null, 2) + '\n' : example, v.overwrite); artifacts.push({ kind, path }); }
      catch (error) {
        if (!artifacts.length && error instanceof CliError) throw error;
        throw new CliError('PARTIAL_SUCCESS', 'SDK 产物未全部写入，已成功的文件已保留。', { failedArtifact: { kind, path } }, { artifacts, config: v.outputs.out && artifacts.some((a) => a.kind === 'out') ? undefined : config, projectId: detail.id, keyId: key.id });
      }
    }
    return { data: { ...(v.outputs.out ? {} : { config }), ...(v.outputs['example-out'] ? {} : { example }), artifacts, projectId: detail.id, keyId: key.id }, meta: { source: 'platform_api_and_generated_artifact', keyExpiresAt: key.expiresAt, keyEligibilityTimeSource: projectTimeSource, warnings: ['SDK JSON 不含函数；业务路由解析与初始化顺序需要在接入入口补充。'] } };
  }
  if (command === 'events list') {
    const { body } = await http.request(base + '/events?' + queryString({ ...v.query, limit: v.limit, cursor: v.serverCursor, includePayload: v.includePayload }));
    contract(object(body) && Array.isArray(body.items) && body.items.length <= v.limit && typeof body.hasMore === 'boolean' &&
      (body.asOf == null || timestamp(body.asOf)) && body.source === 'database' && object(body.range) && body.range.from === v.query.from && body.range.to === v.query.to &&
      (body.hasMore ? typeof body.nextCursor === 'string' && body.nextCursor.length > 0 : body.nextCursor === null), '事件列表响应契约无效。');
    for (const row of body.items) contract(object(row) && typeof row.eventId === 'string' && timestamp(row.occurredAt) && timestamp(row.receivedAt) &&
      typeof row.type === 'string' && typeof row.name === 'string', '事件列表项契约无效。');
    const nextCursor = body.nextCursor ? Buffer.from(JSON.stringify({ cliVersion: 1, baseUrl: ctx.baseUrl, projectId: ctx.projectId, query: v.query, serverCursor: body.nextCursor })).toString('base64url') : null;
    return { data: { ...body, asOf: body.asOf ?? null, nextCursor }, meta: { source: 'database', asOf: body.asOf ?? null, query: v.query, warnings: body.asOf == null ? ['平台没有提供本页快照时刻，asOf 为未知。'] : [] } };
  }
  if (command === 'data summary') {
    const { body } = await http.request(base + '/diagnostics/data');
    contract(object(body) && Number.isSafeInteger(body.retainedRawEventCount) && body.retainedRawEventCount >= 0 && timestamp(body.asOf) &&
      body.source === 'database' && (body.latestReceivedAt === null || timestamp(body.latestReceivedAt)) && object(body.retentionPolicy), '原始数据概况契约无效。');
    return { data: body, meta: { source: 'database', asOf: body.asOf } };
  }
  if (command === 'queue status') {
    const { body } = await http.request(base + '/diagnostics/queue'); queueContract(body);
    return { data: body, meta: { source: 'database_and_labeled_auxiliary_sources', asOf: body.asOf } };
  }
  if (command === 'events diagnose') { const body = await diagnose(); return { data: body, meta: { source: 'database', asOf: body.asOf } }; }
  if (command === 'events wait') {
    let polls = 0; let lastObservation: any = null; let lastQueryFailure: unknown = null;
    const data = (reason: string) => ({ reason, polls, elapsedMs: http.budget.elapsed(), lastObservation, lastObservationAsOf: lastObservation?.asOf ?? null, lastQueryFailure });
    while (http.budget.remaining() > 0) {
      polls++;
      try { lastObservation = await diagnose(); }
      catch (error) {
        const cause = error as CliError;
        lastQueryFailure = { code: cause.code, details: cause.details };
        if (http.budget.remaining() <= 0 && cause.code === 'REQUEST_TIMEOUT') break;
        throw new CliError(cause.code, cause.message, cause.details, data('query_failed'));
      }
      if (lastObservation.task.recordState === 'present' && lastObservation.task.status === 'failed') throw new CliError('PROCESSING_FAILED', '任务已终止处理。', null, data('processing_failed'));
      if (lastObservation.processing.state === 'committed' && lastObservation.task.recordState === 'missing') throw new CliError('HISTORY_INCOMPLETE', '处理已提交，但任务完成证据缺失。', null, data('history_incomplete'));
      if (lastObservation.processing.state === 'committed' && lastObservation.task.recordState === 'present' && lastObservation.task.status === 'completed') return { data: data('completed'), meta: { source: 'database', asOf: lastObservation.asOf } };
      await http.budget.sleep(v.interval * 1000);
    }
    throw new CliError('WAIT_TIMEOUT', '等待到期，尚未取得完整完成证据。', null, data('deadline_reached'));
  }
  if (command === 'health') {
    const observations: Record<string, any> = {};
    let connectionFailure: string | null = null;
    for (const stage of ['live', 'ready']) {
      const name = stage === 'live' ? 'liveness' : 'readiness';
      if (connectionFailure) { observations[name] = { state: 'unknown', source: '/health/' + stage, reason: '未取得端点响应' }; continue; }
      try {
        const reply = await http.request('/health/' + stage, 'GET', undefined, false);
        contract(object(reply.body) && reply.body.status === 'ok', '健康响应契约无效');
        observations[name] = { state: 'pass', source: '/health/' + stage, reason: '平台确认', details: reply.body };
      } catch (error) {
        const cause = error as CliError;
        if (['NETWORK_UNREACHABLE', 'REQUEST_TIMEOUT'].includes(cause.code)) connectionFailure = cause.code;
        observations[name] = { state: connectionFailure || ['API_CONTRACT_INVALID', 'PROJECT_UNAVAILABLE'].includes(cause.code) ? 'unknown' : 'fail', source: '/health/' + stage, reason: cause.code };
      }
    }
    try {
      if (connectionFailure) throw new CliError(connectionFailure, '尚未取得管理 API 响应');
      const saved = await http.credentials.get(ctx.baseUrl);
      const active = saved && (!saved.expiresAt || Date.parse(saved.expiresAt) > Date.now());
      if (active) http.session = saved;
      const reply = await http.request('/api/v1/auth/me', 'GET', undefined, !!active);
      contract(object(reply.body) && object(reply.body.user) && typeof reply.body.user.id === 'string', '管理 API 响应契约无效');
      observations.managementApi = { state: 'pass', authentication: 'pass', source: '/api/v1/auth/me', reason: '身份接口可响应' };
    } catch (error) {
      const cause = error as CliError;
      observations.managementApi = ['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(cause.code) ?
        { state: 'pass', authentication: 'unknown', source: '/api/v1/auth/me', reason: cause.code } :
        { state: cause.code === 'SERVER_ERROR' ? 'fail' : 'unknown', authentication: 'unknown', source: '/api/v1/auth/me', reason: cause.code };
    }
    const reachable = Object.values(observations).some((item) => item.state === 'pass');
    const data = { target: ctx.baseUrl, checkedAt: new Date().toISOString(),
      connectivity: { state: reachable ? 'pass' : 'fail', source: 'http_responses', reason: reachable ? '已收到平台响应' : connectionFailure ?? '尚未确认平台可连接' },
      ...observations, limitations: ['基础健康不证明 Worker 正常或特定项目已经写入、处理。'] };
    if (connectionFailure || data.connectivity.state === 'fail' || Object.values(observations).some((item) => item.state === 'fail')) throw new CliError('HEALTH_UNREADY', '平台或依赖尚未就绪。', null, data);
    if (Object.values(observations).some((item) => item.state === 'unknown')) throw new CliError('CAPABILITY_UNAVAILABLE', '部分健康检查无法取得必要证据。', null, data);
    return { data, meta: { source: 'health_api' } };
  }
  invalid('未实现命令');
}
