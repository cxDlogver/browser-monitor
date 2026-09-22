import {
  AppstoreOutlined,
  BarChartOutlined,
  DatabaseOutlined,
  FundOutlined,
  HeartOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Layout, Menu, Space, Spin, Typography } from 'antd';
import { Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';

import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetail>(`/api/v1/projects/${projectId}`),
  });
  if (project.isLoading) return <div className="centered"><Spin size="large" /></div>;

  const section = location.pathname.split('/').at(-1) ?? 'overview';
  const items = [
    { key: 'overview', icon: <AppstoreOutlined />, label: '总览' },
    { key: 'performance', icon: <FundOutlined />, label: '性能指标' },
    { key: 'routes', icon: <BarChartOutlined />, label: '页面排名' },
    { key: 'events', icon: <ThunderboltOutlined />, label: '自定义事件' },
    { key: 'raw-events', icon: <DatabaseOutlined />, label: '原始事件' },
    { key: 'service-status', icon: <HeartOutlined />, label: '服务状态' },
    { key: 'settings', icon: <SettingOutlined />, label: '项目设置' },
  ];
  return (
    <Layout className="platform-shell">
      <Layout.Sider width={236} className="sidebar">
        <button className="project-switcher" onClick={() => navigate('/projects')}>
          <div className="brand-mark small">BM</div>
          <span><strong>{project.data?.displayName}</strong><small>{project.data?.appName}</small></span>
        </button>
        <Menu theme="dark" mode="inline" selectedKeys={[section]} items={items} onClick={({ key }) => navigate(`/projects/${projectId}/${key}`)} />
        <div className="sidebar-user"><Typography.Text>{auth.user?.displayName}</Typography.Text><Button type="text" onClick={() => void auth.logout().then(() => navigate('/login', { replace: true }))}>退出</Button></div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="topbar"><Space><span className="live-dot" />数据约 15 秒内更新</Space></Layout.Header>
        <Layout.Content className="dashboard-content"><Outlet context={{ project: project.data! }} /></Layout.Content>
      </Layout>
    </Layout>
  );
}

export function useProject(): ProjectDetail {
  return useOutletContext<{ project: ProjectDetail }>().project;
}
