import { CopyOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Form, Input, InputNumber, List, Row, Select, Space, Tag, Typography, message } from 'antd';
import { useParams } from 'react-router-dom';

import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { PageHeading } from '../components/PageHeading';

export function SettingsPage() {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api<ProjectDetail>(`/api/v1/projects/${projectId}`) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] });
  const origins = useMutation({
    mutationFn: (values: { origins: string }) => api(`/api/v1/projects/${projectId}/origins`, { method: 'PUT', body: JSON.stringify({ origins: values.origins.split('\n').map((value) => value.trim()).filter(Boolean) }) }),
    onSuccess: async () => { await invalidate(); messageApi.success('来源域名已更新'); },
  });
  const rotate = useMutation({
    mutationFn: () => api(`/api/v1/projects/${projectId}/keys/rotate`, { method: 'POST', body: JSON.stringify({ label: `rotated-${new Date().toISOString().slice(0, 10)}` }) }),
    onSuccess: async () => { await invalidate(); messageApi.success('新写入键已生成，旧键将在 24 小时后失效'); },
  });
  const invite = useMutation({
    mutationFn: (values: { email: string; role: string }) => api(`/api/v1/projects/${projectId}/invitations`, { method: 'POST', body: JSON.stringify(values) }),
    onSuccess: () => messageApi.success('邀请邮件已发送'),
  });
  const thresholds = useMutation({
    mutationFn: (values: Record<string, unknown>) => api(`/api/v1/projects/${projectId}/thresholds`, { method: 'PUT', body: JSON.stringify(values) }),
    onSuccess: async () => { await invalidate(); messageApi.success('新阈值版本已生效'); },
  });
  const detail = project.data;
  const activeDsn = detail?.keys.find((key) => key.active && !key.expiresAt)?.dsn;
  const snippet = `createMonitor({\n  app: { name: '${detail?.appName ?? 'app'}', version: '1.0.0', environment: 'production' },\n  view: { resolveRouteName: ({ pathname }) => pathname },\n  transport: { dsn: '${activeDsn ?? ''}' },\n});`;
  return (
    <>
      {contextHolder}
      <PageHeading title="项目设置" description="管理接入地址、来源域名、成员和指标口径。" />
      {detail?.role !== 'owner' ? <Alert type="info" showIcon message="当前账号为只读成员，不能修改项目设置。" /> : null}
      <Row gutter={[16, 16]}>
        <Col span={24}><Card title="SDK 接入"><pre className="code-block">{snippet}</pre><Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(snippet)}>复制代码</Button></Card></Col>
        <Col xs={24} xl={12}><Card title="写入键" extra={detail?.role === 'owner' ? <Button icon={<ReloadOutlined />} loading={rotate.isPending} onClick={() => rotate.mutate()}>轮换</Button> : null}><List dataSource={detail?.keys ?? []} renderItem={(key) => <List.Item><List.Item.Meta title={<Space>{key.label}{key.expiresAt ? <Tag color="gold">即将失效</Tag> : <Tag color="green">当前</Tag>}</Space>} description={<Typography.Text copyable code>{key.dsn}</Typography.Text>} /></List.Item>} /></Card></Col>
        <Col xs={24} xl={12}><Card title="允许来源">{detail ? <Form key={`origins-${detail.origins.join('|')}`} layout="vertical" initialValues={{ origins: detail.origins.join('\n') }} onFinish={(values) => origins.mutate(values)}><Form.Item name="origins" help="每行一个完整 Origin，例如 https://app.example.com"><Input.TextArea rows={6} disabled={detail.role !== 'owner'} /></Form.Item><Button type="primary" htmlType="submit" disabled={detail.role !== 'owner'} loading={origins.isPending}>保存来源</Button></Form> : null}</Card></Col>
        <Col xs={24} xl={12}><Card title="项目成员"><List dataSource={detail?.members ?? []} renderItem={(member) => <List.Item><List.Item.Meta title={member.displayName} description={member.email} /><Tag>{member.role}</Tag></List.Item>} />{detail?.role === 'owner' ? <Form layout="inline" onFinish={(values) => invite.mutate(values)}><Form.Item name="email" rules={[{ required: true, type: 'email' }]}><Input placeholder="member@example.com" /></Form.Item><Form.Item name="role" initialValue="member"><Select style={{ width: 110 }} options={[{ value: 'member' }, { value: 'owner' }]} /></Form.Item><Button icon={<SendOutlined />} htmlType="submit" loading={invite.isPending}>邀请</Button></Form> : null}</Card></Col>
        <Col xs={24} xl={12}><Card title={`指标阈值 · v${detail?.thresholds.version ?? 1}`}>
          {detail ? <Form key={`threshold-${detail.thresholds.version}`} layout="vertical" initialValues={detail.thresholds.config} onFinish={(values) => thresholds.mutate(values)}>
            {(['LCP', 'INP', 'CLS', 'FCP', 'FPS'] as const).map((metric) => <Space key={metric} align="baseline" className="threshold-row"><strong>{metric}</strong><Form.Item name={[metric, 'good']} label="Good"><InputNumber min={0} disabled={detail.role !== 'owner'} /></Form.Item><Form.Item name={[metric, 'poor']} label="Poor"><InputNumber min={0} disabled={detail.role !== 'owner'} /></Form.Item></Space>)}
            <Button type="primary" htmlType="submit" disabled={detail.role !== 'owner'} loading={thresholds.isPending}>创建新阈值版本</Button>
          </Form> : null}
          <Typography.Text type="secondary">历史样本保留当时使用的阈值版本，不会被静默改写。</Typography.Text>
        </Card></Col>
      </Row>
    </>
  );
}
