import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Space, Typography, message } from 'antd';
import { useEffect } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { api, setCsrfToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';

type Mode = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

export function AuthPage({ mode }: { mode: Mode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const urlToken = search.get('token');
  const [messageApi, contextHolder] = message.useMessage();
  const mutation = useMutation({
    mutationFn: async (values: Record<string, string>) => {
      if (mode === 'login') {
        return api<{ csrfToken: string }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(values) });
      }
      if (mode === 'register') {
        return api('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(values) });
      }
      if (mode === 'forgot') {
        return api('/api/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify(values) });
      }
      const token = urlToken ?? values.token;
      return api(mode === 'verify' ? '/api/v1/auth/verify-email' : '/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ ...values, token }),
      });
    },
    onSuccess: async (result) => {
      if (mode === 'login') {
        setCsrfToken((result as { csrfToken: string }).csrfToken);
        await auth.refresh();
        const state = location.state as { from?: string } | null;
        navigate(state?.from ?? '/projects', { replace: true });
        return;
      }
      if (mode === 'register') messageApi.success('验证邮件已经发送，请先完成邮箱验证。');
      if (mode === 'forgot') messageApi.success('如果账号存在，重置邮件已经发送。');
      if (mode === 'reset') messageApi.success('密码已重置，请重新登录。');
      if (mode !== 'verify') navigate('/login');
    },
  });

  useEffect(() => {
    if (mode === 'verify' && urlToken) mutation.mutate({});
    // The URL token is the only dependency; rerunning on mutation identity would duplicate verification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, urlToken]);

  if (auth.user && mode === 'login') return <Navigate to="/projects" replace />;

  const titles: Record<Mode, string> = {
    login: '进入监控平台',
    register: '创建平台账号',
    verify: '验证邮箱',
    forgot: '找回密码',
    reset: '设置新密码',
  };

  return (
    <main className="auth-page">
      {contextHolder}
      <section className="auth-brand">
        <div className="brand-mark">BM</div>
        <Typography.Title>Browser Monitor</Typography.Title>
        <Typography.Paragraph>
          从浏览器真实体验数据出发，连接采集、计算、定位与持续改进。
        </Typography.Paragraph>
      </section>
      <Card className="auth-card" bordered={false}>
        <Typography.Title level={2}>{titles[mode]}</Typography.Title>
        {mutation.error ? <Alert type="error" showIcon message={mutation.error.message} /> : null}
        {mode === 'verify' ? (
          <Space direction="vertical" size="large">
            <Typography.Text>{mutation.isPending ? '正在验证……' : mutation.isSuccess ? '验证完成。' : '验证链接无效或已过期。'}</Typography.Text>
            <Link to="/login">返回登录</Link>
          </Space>
        ) : (
          <Form layout="vertical" onFinish={(values) => mutation.mutate(values)} requiredMark={false}>
            {mode === 'register' ? (
              <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
                <Input autoComplete="name" />
              </Form.Item>
            ) : null}
            {mode !== 'reset' ? (
              <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
                <Input autoComplete="email" />
              </Form.Item>
            ) : null}
            {mode === 'login' || mode === 'register' || mode === 'reset' ? (
              <Form.Item name="password" label={mode === 'reset' ? '新密码' : '密码'} rules={[{ required: true, min: mode === 'login' ? 1 : 10 }]}>
                <Input.Password autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              </Form.Item>
            ) : null}
            <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
              {mode === 'login' ? '登录' : mode === 'register' ? '注册' : mode === 'forgot' ? '发送重置邮件' : '重置密码'}
            </Button>
          </Form>
        )}
        {mode === 'login' ? (
          <div className="auth-links"><Link to="/register">注册账号</Link><Link to="/forgot-password">忘记密码</Link></div>
        ) : mode !== 'verify' ? <div className="auth-links"><Link to="/login">返回登录</Link></div> : null}
      </Card>
    </main>
  );
}
