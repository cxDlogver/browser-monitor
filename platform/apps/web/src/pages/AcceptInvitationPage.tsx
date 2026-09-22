import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, Result } from 'antd';
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '../api/client';

export function AcceptInvitationPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const token = search.get('token');
  const invitation = useMutation({
    mutationFn: () => api<{ projectId: string }>('/api/v1/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
    onSuccess: ({ projectId }) => navigate(`/projects/${projectId}/overview`, { replace: true }),
  });

  useEffect(() => {
    if (token) invitation.mutate();
    // A link token is consumed once; mutation identity must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <main className="auth-page">
      <Card className="auth-card" bordered={false}>
        {!token ? (
          <Alert type="error" showIcon message="邀请链接缺少 token。" />
        ) : invitation.error ? (
          <Result
            status="error"
            title="无法接受邀请"
            subTitle={invitation.error.message}
            extra={<Button onClick={() => invitation.mutate()}>重试</Button>}
          />
        ) : (
          <Result status="info" title="正在加入项目……" subTitle="验证成功后会自动进入项目总览。" />
        )}
      </Card>
    </main>
  );
}
