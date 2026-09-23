import { DeleteOutlined, ExperimentOutlined, KeyOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Col, Empty, Form, Input, List, Modal, Progress, Radio,
  Row, Space, Statistic, Table, Tag, Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../api/client';
import type { LabAudit, LabAuditDetail, LabAuditDevice, LabDistribution } from '../api/types';
import { PageHeading } from '../components/PageHeading';
import { useProject } from '../layout/ProjectLayout';

const scoreLabels = {
  performance: 'Performance',
  seo: 'SEO',
  accessibility: 'Accessibility',
  bestPractices: 'Best Practices',
} as const;
const metricLabels = {
  fcp: ['FCP', 'ms'], lcp: ['LCP', 'ms'], cls: ['CLS', ''], tbt: ['TBT', 'ms'],
  speedIndex: ['Speed Index', 'ms'], tti: ['TTI', 'ms'], serverResponseTime: ['服务端响应', 'ms'], mainThreadWork: ['主线程工作', 'ms'],
} as const;
const statusMeta = {
  queued: ['排队中', 'default'], running: ['运行中', 'processing'], completed: ['已完成', 'success'], failed: ['失败', 'error'],
} as const;
const ratingMeta = {
  good: ['良好', 'green'], 'needs-improvement': ['待改善', 'gold'], poor: ['较差', 'red'],
} as const;

export function LabAuditsPage() {
  const { projectId = '' } = useParams();
  const project = useProject();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form] = Form.useForm();
  const [headersForm] = Form.useForm();

  const audits = useQuery({
    queryKey: ['lab-audits', projectId],
    queryFn: () => api<LabAudit[]>(`/api/v1/projects/${projectId}/lab-audits`),
    refetchInterval: (query) => query.state.data?.some((item) => item.status === 'queued' || item.status === 'running') ? 2_000 : false,
  });
  useEffect(() => {
    if (!selectedId && audits.data?.[0]) setSelectedId(audits.data[0].id);
  }, [audits.data, selectedId]);
  const selectedSummary = audits.data?.find((item) => item.id === selectedId);
  const detail = useQuery({
    queryKey: ['lab-audit', projectId, selectedId],
    queryFn: () => api<LabAuditDetail>(`/api/v1/projects/${projectId}/lab-audits/${selectedId}`),
    enabled: Boolean(selectedId),
    refetchInterval: selectedSummary?.status === 'queued' || selectedSummary?.status === 'running' ? 2_000 : false,
  });
  const settings = useQuery({
    queryKey: ['lab-settings', projectId],
    queryFn: () => api<{ canManage: boolean; headers: Array<{ name: string; maskedValue: string }> }>(`/api/v1/projects/${projectId}/lab-settings`),
  });
  const create = useMutation({
    mutationFn: (values: { url: string; device: LabAuditDevice }) => api<LabAudit>(`/api/v1/projects/${projectId}/lab-audits`, { method: 'POST', body: JSON.stringify(values) }),
    onSuccess: async (audit) => {
      setSelectedId(audit.id);
      await queryClient.invalidateQueries({ queryKey: ['lab-audits', projectId] });
    },
  });
  const saveHeaders = useMutation({
    mutationFn: (values: { headers?: Array<{ name: string; value: string }> }) => api(`/api/v1/projects/${projectId}/lab-settings`, { method: 'PUT', body: JSON.stringify({ headers: values.headers ?? [] }) }),
    onSuccess: async () => {
      headersForm.resetFields();
      setSettingsOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['lab-settings', projectId] });
    },
  });
  const report = detail.data;
  const initialUrl = useMemo(() => project.origins[0] ? `${project.origins[0]}/` : '', [project.origins]);

  return (
    <>
      <div className="page-heading compact">
        <PageHeading title="实验室测试" description="独立运行 Chrome 与 Lighthouse；每次执行 5 轮并以中位数生成分析报告。" />
        {project.role === 'owner' ? <Button icon={<KeyOutlined />} onClick={() => setSettingsOpen(true)}>鉴权请求头</Button> : null}
      </div>

      <Card className="lab-launch-card">
        <Form form={form} layout="inline" initialValues={{ url: initialUrl, device: 'mobile' }} onFinish={(values) => create.mutate(values)}>
          <Form.Item name="url" rules={[{ required: true, type: 'url', message: '请输入完整 HTTP/HTTPS URL' }]} className="lab-url-field">
            <Input prefix={<ExperimentOutlined />} placeholder="https://example.com/path" />
          </Form.Item>
          <Form.Item name="device"><Radio.Group optionType="button" buttonStyle="solid" options={[{ label: '手机端', value: 'mobile' }, { label: '桌面端', value: 'desktop' }]} /></Form.Item>
          <Button type="primary" icon={<PlayCircleOutlined />} htmlType="submit" loading={create.isPending} disabled={project.role !== 'owner'}>开始 5 次测试</Button>
        </Form>
        {create.error ? <Alert className="lab-inline-alert" type="error" showIcon message={create.error.message} /> : null}
        {project.role !== 'owner' ? <Alert className="lab-inline-alert" type="info" showIcon message="只有项目 Owner 可以发起测试；成员可以查看历史报告。" /> : null}
      </Card>

      <Row gutter={[16, 16]} className="lab-content-row">
        <Col xs={24} xl={7}>
          <Card title="测试历史" className="full-height">
            <List
              loading={audits.isLoading}
              locale={{ emptyText: <Empty description="还没有实验室测试" /> }}
              dataSource={audits.data ?? []}
              renderItem={(item) => {
                const [label, color] = statusMeta[item.status];
                return <List.Item className={`lab-history-item ${item.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}>
                  <List.Item.Meta title={<Space><Tag color={color}>{label}</Tag><Tag>{item.device === 'mobile' ? '手机端' : '桌面端'}</Tag></Space>} description={<><Typography.Text ellipsis>{item.targetUrl}</Typography.Text><small>P {item.summary?.scores.performance.median?.toFixed(0) ?? '—'} · SEO {item.summary?.scores.seo.median?.toFixed(0) ?? '—'} · {item.successfulRuns}/{item.requestedRuns} 成功</small><small>{new Date(item.createdAt).toLocaleString()}</small></>} />
                </List.Item>;
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={17}>
          {!report ? <Card loading={detail.isLoading}><Empty description="选择一条测试查看报告" /></Card> : <AuditReport audit={report} />}
        </Col>
      </Row>

      <Modal title="项目鉴权请求头" open={settingsOpen} onCancel={() => setSettingsOpen(false)} footer={null} destroyOnClose>
        <Alert type="warning" showIcon message="请求头会加密保存，仅注入 Lighthouse 浏览器；保存时将整体替换已有配置。" />
        {settings.data?.headers.length ? <List size="small" header="当前配置（值已隐藏）" dataSource={settings.data.headers} renderItem={(header) => <List.Item><Typography.Text code>{header.name}</Typography.Text><Typography.Text type="secondary">{header.maskedValue}</Typography.Text></List.Item>} /> : null}
        <Form form={headersForm} layout="vertical" onFinish={(values) => saveHeaders.mutate(values)} className="lab-headers-form">
          <Form.List name="headers">
            {(fields, { add, remove }) => <>
              {fields.map((field) => <Space key={field.key} align="baseline" className="lab-header-row">
                <Form.Item {...field} name={[field.name, 'name']} rules={[{ required: true }]}><Input placeholder="Authorization" /></Form.Item>
                <Form.Item {...field} name={[field.name, 'value']} rules={[{ required: true }]}><Input.Password placeholder="Bearer ..." /></Form.Item>
                <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
              </Space>)}
              <Button block icon={<PlusOutlined />} onClick={() => add()}>添加请求头</Button>
            </>}
          </Form.List>
          <Space className="lab-settings-actions">
            <Button danger onClick={() => saveHeaders.mutate({ headers: [] })}>清除全部</Button>
            <Button type="primary" htmlType="submit" loading={saveHeaders.isPending}>替换并保存</Button>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

function AuditReport({ audit }: { audit: LabAuditDetail }) {
  const [statusLabel, statusColor] = statusMeta[audit.status];
  if (audit.status === 'queued' || audit.status === 'running') {
    const percent = Math.round((audit.completedRuns / audit.requestedRuns) * 100);
    return <Card title={<Space><Tag color={statusColor}>{statusLabel}</Tag><Typography.Text ellipsis>{audit.targetUrl}</Typography.Text></Space>}><Progress percent={percent} status="active" /><Typography.Paragraph type="secondary">已完成 {audit.completedRuns}/{audit.requestedRuns}，成功 {audit.successfulRuns} 次。Chrome 会为每轮使用独立会话。</Typography.Paragraph></Card>;
  }
  if (audit.status === 'failed') return <Card title={<Tag color="error">测试失败</Tag>}><Alert type="error" showIcon message="未能生成可靠报告" description={audit.lastError} /></Card>;
  const summary = audit.summary;
  if (!summary) return <Card><Empty description="报告数据不可用" /></Card>;
  return <Space direction="vertical" size="middle" className="lab-report">
    <Card title={<Space><Tag color="success">已完成</Tag><Typography.Text ellipsis>{audit.targetUrl}</Typography.Text></Space>} extra={<Tag>{audit.device === 'mobile' ? '手机端' : '桌面端'}</Tag>}>
      {audit.warning ? <Alert type="warning" showIcon message={audit.warning} /> : null}
      <Row gutter={[12, 12]} className="lab-score-row">
        {(Object.keys(scoreLabels) as Array<keyof typeof scoreLabels>).map((key) => <Col xs={12} md={6} key={key}><ScoreCard label={scoreLabels[key]} value={summary.scores[key]} /></Col>)}
      </Row>
      <Typography.Text type="secondary">Lighthouse {audit.lighthouseVersion} · 成功 {audit.successfulRuns}/{audit.requestedRuns} · 代表运行 #{summary.representativeRun}</Typography.Text>
    </Card>
    <Card title="核心实验室指标">
      <Row gutter={[12, 12]}>
        {(Object.keys(metricLabels) as Array<keyof typeof metricLabels>).map((key) => <Col xs={12} md={6} key={key}><Statistic title={metricLabels[key][0]} value={summary.metrics[key].median ?? '—'} precision={key === 'cls' ? 3 : 0} suffix={metricLabels[key][1]} /><Typography.Text type="secondary">范围 {formatRange(summary.metrics[key], key === 'cls' ? 3 : 0)}</Typography.Text></Col>)}
      </Row>
    </Card>
    <Card title="分类分析">
      <Row gutter={[12, 12]}>{audit.analysis?.sections.map((section) => { const [label, color] = ratingMeta[section.rating]; return <Col xs={24} md={12} key={section.key}><Card size="small" className="lab-analysis-card" title={section.title} extra={<Tag color={color}>{label}</Tag>}><Typography.Paragraph>{section.summary}</Typography.Paragraph></Card></Col>; })}</Row>
    </Card>
    <Card title="优化建议">
      <Table rowKey={(row) => `${row.domain}-${row.metric}-${row.auditId ?? ''}`} pagination={{ pageSize: 8 }} dataSource={audit.analysis?.recommendations ?? []} columns={[
        { title: '优先级', dataIndex: 'priority', width: 82, render: (value: string) => <Tag color={value === 'P0' ? 'red' : value === 'P1' ? 'gold' : 'blue'}>{value}</Tag> },
        { title: '领域', dataIndex: 'domain', width: 110 },
        { title: '问题', dataIndex: 'metric', width: 180 },
        { title: '证据', dataIndex: 'evidence' },
        { title: '优化动作', dataIndex: 'action' },
      ]} />
    </Card>
    <Card title="单次运行明细"><Table rowKey="id" pagination={false} dataSource={audit.runs} columns={[
      { title: '轮次', dataIndex: 'runNumber', render: (value: number) => `#${value}` },
      { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={value === 'completed' ? 'green' : 'red'}>{value === 'completed' ? '成功' : '失败'}</Tag> },
      { title: 'Performance', render: (_: unknown, row) => row.scores?.performance ?? '—' },
      { title: 'SEO', render: (_: unknown, row) => row.scores?.seo ?? '—' },
      { title: '耗时', dataIndex: 'durationMs', render: (value: number | null) => value === null ? '—' : `${(value / 1_000).toFixed(1)}s` },
      { title: '错误', dataIndex: 'error', ellipsis: true },
    ]} /></Card>
  </Space>;
}

function ScoreCard({ label, value }: { label: string; value: LabDistribution }) {
  const score = value.median;
  return <div className={`lab-score score-${score === null ? 'warn' : score >= 90 ? 'good' : score >= 50 ? 'warn' : 'poor'}`}><strong>{score?.toFixed(0) ?? '—'}</strong><span>{label}</span><small>± {value.variation?.toFixed(1) ?? '—'}</small></div>;
}

function formatRange(value: LabDistribution, precision: number): string {
  if (value.minimum === null || value.maximum === null) return '—';
  return `${value.minimum.toFixed(precision)} – ${value.maximum.toFixed(precision)}`;
}
