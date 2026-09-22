import { describe, expect, it } from 'vitest';

import { queryString, resolveApiErrorMessage } from './client';

describe('API query serialization', () => {
  it('omits undefined filters and encodes route names', () => {
    expect(queryString({ environment: 'production', routeName: 'user detail', metric: undefined })).toBe(
      '?environment=production&routeName=user+detail',
    );
  });
});
describe('API error messages', () => {
  it('translates duplicate registration errors', () => {
    expect(resolveApiErrorMessage({ code: 'email_already_registered' }, 409)).toBe(
      '该邮箱已注册，请直接登录或使用“忘记密码”。',
    );
  });

  it('keeps an explicit server message and provides a localized fallback', () => {
    expect(resolveApiErrorMessage({ message: 'Detailed error' }, 400)).toBe('Detailed error');
    expect(resolveApiErrorMessage({}, 503)).toBe('请求失败（HTTP 503）');
  });
});