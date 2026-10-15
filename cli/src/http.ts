import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError, object } from './errors.js';
import { Credentials, type Context, type Session } from './context.js';
export class Budget {
  readonly start = performance.now();
  readonly deadline: number;
  constructor(seconds: number) { this.deadline = this.start + seconds * 1000; }
  remaining(): number { return Math.max(0, this.deadline - performance.now()); }
  elapsed(): number { return Math.round(performance.now() - this.start); }
  async sleep(ms: number): Promise<void> { if (this.remaining() > 0) await delay(Math.min(ms, this.remaining())); }
}
export interface Reply { body: any; headers: Headers; status: number }
const codes: Record<string, string> = {
  authentication_required: 'AUTH_REQUIRED', session_expired: 'AUTH_EXPIRED', invalid_credentials: 'AUTH_REQUIRED',
  email_not_verified: 'AUTH_REQUIRED', invalid_csrf_token: 'AUTH_EXPIRED', project_not_found: 'PROJECT_UNAVAILABLE',
  owner_role_required: 'OWNER_REQUIRED', invalid_request: 'INVALID_ARGUMENT',
};
export class Http {
  readonly credentials = new Credentials();
  readonly sensitiveValues: string[] = [];
  session: Session | undefined;
  constructor(readonly context: Context, readonly budget: Budget, readonly requestTimeout: number) {}
  async authenticate(): Promise<void> {
    this.session = await this.credentials.get(this.context.baseUrl);
    if (!this.session) throw new CliError('AUTH_REQUIRED', '尚未登录当前平台。');
    this.sensitiveValues.push(this.session.cookie, this.session.cookie.slice('bm_session='.length), this.session.csrfToken);
    if (this.session.expiresAt && Date.parse(this.session.expiresAt) <= Date.now()) {
      await this.credentials.set(this.context.baseUrl, undefined);
      this.session = undefined; throw new CliError('AUTH_EXPIRED', '会话已到期，请重新登录。');
    }
  }
  async request(path: string, method = 'GET', payload?: unknown, authenticated = true): Promise<Reply> {
    if (authenticated && !this.session) await this.authenticate();
    if (authenticated && this.session) this.sensitiveValues.push(this.session.cookie, this.session.cookie.slice('bm_session='.length), this.session.csrfToken);
    const write = method !== 'GET';
    let failure: CliError | undefined;
    for (let attempt = 0; attempt < (write ? 1 : 3); attempt++) {
      const remaining = this.budget.remaining();
      if (remaining <= 0) throw failure ?? new CliError('REQUEST_TIMEOUT', '命令总预算已耗尽。');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.requestTimeout * 1000, remaining));
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (payload !== undefined) headers['Content-Type'] = 'application/json';
      if (authenticated && this.session) {
        headers.Cookie = this.session.cookie;
        if (write) headers['x-csrf-token'] = this.session.csrfToken;
      }
      let response: Response | undefined; let body: any; let transport: unknown;
      try {
        response = await fetch(this.context.baseUrl + path, {
          method, headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal, redirect: 'manual',
        });
        const content = await response.text();
        if (content) { try { body = JSON.parse(content); } catch { body = undefined; } }
      } catch (error) { transport = error; }
      finally { clearTimeout(timer); }
      if (transport) {
        const code = write ? 'WRITE_OUTCOME_UNKNOWN' : controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_UNREACHABLE';
        failure = new CliError(code, write ? '写请求未获得可靠响应。不要自动重复写入；请回查平台。' : '平台请求未完成。', { path, method, attempts: attempt + 1 });
      } else if (response) {
        if (response.status >= 300 && response.status < 400) throw new CliError(write ? 'WRITE_OUTCOME_UNKNOWN' : 'API_CONTRACT_INVALID', '平台返回重定向；未向新地址发送凭据。', { path, status: response.status });
        if (response.ok) {
          if (response.status !== 204 && body === undefined) throw new CliError(write ? 'WRITE_OUTCOME_UNKNOWN' : 'API_CONTRACT_INVALID', '响应不是可解析的 JSON。', { path, status: response.status });
          return { body, headers: response.headers, status: response.status };
        }
        const code = (object(body) && typeof body.code === 'string' ? codes[body.code] ?? body.code : undefined);
        if (response.status === 401 || code === 'AUTH_EXPIRED') {
          if (authenticated) { await this.credentials.set(this.context.baseUrl, undefined); this.session = undefined; }
          throw new CliError(authenticated ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED', '身份验证失败或会话已失效。', { path, status: response.status });
        }
        const stable = code && ['INVALID_ARGUMENT', 'INVALID_CURSOR', 'AMBIGUOUS_EVENT', 'PROJECT_UNAVAILABLE', 'OWNER_REQUIRED', 'CAPABILITY_UNAVAILABLE'].includes(code) ? code :
          response.status === 403 ? 'PROJECT_UNAVAILABLE' : response.status === 404 ? (path.includes('/diagnostics/') || path.split('?')[0]!.endsWith('/events') ? 'CAPABILITY_UNAVAILABLE' : 'PROJECT_UNAVAILABLE') :
          response.status === 400 ? 'INVALID_ARGUMENT' : 'SERVER_ERROR';
        failure = new CliError(stable, '平台拒绝或无法完成请求。', { path, status: response.status, ...(object(body) && Array.isArray(body.candidates) ? { candidates: body.candidates, candidatesTruncated: body.candidatesTruncated } : {}) });
        if (write || !(response.status === 429 || response.status >= 500)) throw failure;
      }
      if (write || attempt === 2) throw failure;
      const retryAfter = response?.headers.get('retry-after');
      const retryMs = retryAfter ? (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 200 * 2 ** attempt;
      if (retryMs >= this.budget.remaining()) { await this.budget.sleep(this.budget.remaining()); throw new CliError('REQUEST_TIMEOUT', '重试等待已达到总预算。', { lastError: failure?.code }); }
      await this.budget.sleep(Number.isFinite(retryMs) ? retryMs : 200);
    }
    throw failure;
  }
}
