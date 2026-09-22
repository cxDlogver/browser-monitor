import { PlusOutlined, RadarChartOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Empty, Form, Input, Layout, List, Modal, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client';
import type { ProjectSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export function ProjectsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/api/v1/projects') });
  const create = useMutation({
    mutationFn: (values: { displayName: string; appName: string }) =>
      api<ProjectSummary>('/api/v1/projects', { method: 'POST', body: JSON.stringify(values) }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
      navigate(`/projects/${project.id}/overview`);
    },
  });

  return (
    <Layout className="projects-page">
      <header className="projects-header">
        <Space><div className="brand-mark small">BM</div><Typography.Title level={3}>Browser Monitor</Typography.Title></Space>
        <Space><Typography.Text type="secondary">{auth.user?.email}</Typography.Text><Button onClick={() => void auth.logout().then(() => navigate('/login', { replace: true }))}>退出</Button></Space>
      </header>
      <main className="projects-content">
        <div className="page-heading">
          <div><Typography.Title level={2}>监控项目</Typography.Title><Typography.Text type="secondary">一个项目对应一个浏览器应用。</Typography.Text></div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建项目</Button>
        </div>
        {projects.data?.length ? (
          <List grid={{ gutter: 20, xs: 1, md: 2, xl: 3 }} dataSource={projects.data} renderItem={(project) => (
            <List.Item>
              <Card hoverable className="project-card" onClick={() => navigate(`/projects/${project.id}/overview`)}>
                <Space direction="vertical" size="middle">
                  <RadarChartOutlined className="project-icon" />
                  <div><Typography.Title level={4}>{project.displayName}</Typography.Title><Typography.Text code>{project.appName}</Typography.Text></div>
                  <Space><Tag color={project.enabled ? 'green' : 'default'}>{project.enabled ? '运行中' : '已停用'}</Tag><Tag>{project.role}</Tag></Space>
                </Space>
              </Card>
            </List.Item>
          )} />
        ) : <Card><Empty description="还没有监控项目" /></Card>}
      </main>
      <Modal title="创建监控项目" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Form layout="vertical" onFinish={(values) => create.mutate(values)}>
          <Form.Item label="项目名称" name="displayName" rules={[{ required: true }]}><Input placeholder="客户中心" /></Form.Item>
          <Form.Item label="SDK app.name" name="appName" rules={[{ required: true, pattern: /^[a-zA-Z0-9._-]+$/ }]}><Input placeholder="customer-center" /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={create.isPending}>创建</Button>
        </Form>
      </Modal>
    </Layout>
  );
}
