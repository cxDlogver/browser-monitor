let csrfToken = sessionStorage.getItem('browser-monitor-csrf') ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function setCsrfToken(value: string): void {
  csrfToken = value;
  sessionStorage.setItem('browser-monitor-csrf', value);
}

export function clearCsrfToken(): void {
  csrfToken = '';
  sessionStorage.removeItem('browser-monitor-csrf');
}

const apiErrorMessages: Record<string, string> = {
  email_already_registered: '该邮箱已注册，请直接登录或使用“忘记密码”。',
  invalid_credentials: '邮箱或密码错误。',
  email_not_verified: '邮箱尚未验证，请先打开验证邮件完成验证。',
  invalid_or_expired_token: '验证链接无效或已过期，请重新发起操作。',
  audit_already_running: '当前项目已有实验室测试正在运行。',
  audit_origin_not_allowed: '测试 URL 必须属于项目设置中的允许来源。',
  audit_header_not_allowed: '请求头名称不允许用于实验室测试。',
};

export function resolveApiErrorMessage(body: Record<string, unknown>, status: number): string {
  const code = typeof body.code === 'string' ? body.code : 'request_failed';
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  return apiErrorMessages[code] ?? `请求失败（HTTP ${status}）`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken
        ? { 'x-csrf-token': csrfToken }
        : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.code === 'string' ? body.code : 'request_failed';
    throw new ApiError(response.status, code, resolveApiErrorMessage(body, response.status));
  }
  return body as T;
}

export function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
