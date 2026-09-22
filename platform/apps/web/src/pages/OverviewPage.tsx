import { CheckCircleOutlined, EyeOutlined, SendOutlined, TeamOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Card, Col, Progress, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { EChartsOption } from 'echarts';
import { useParams } from 'react-router-dom';

import { api } from '../api/client';
import type { MetricSummary, Overview, PerformancePoint } from '../api/types';
import { Chart } from '../components/Chart';
import { PageHeading } from '../components/PageHeading';
import { useAnalyticsRange } from '../hooks/useAnalyticsRange';

function quality(metric: MetricSummary): number {
  return metric.count ? Math.round((metric.goodCount / metric.count) * 100) : 0;
}

export function OverviewPage() {
  const { projectId = '' } = useParams();
  const range = useAnalyticsRange();
  const overview = useQuery({
    queryKey: ['overview', projectId, range],
    queryFn: () => api<Overview>(`/api/v1/projects/${projectId}/analytics/overview${range}`),
    refetchInterval: 15_000,
  });
  const performance = useQuery({
    queryKey: ['performance-preview', projectId, range],
    queryFn: () => api<PerformancePoint[]>(`/api/v1/projects/${projectId}/analytics/performance${range}`),
    refetchInterval: 15_000,
  });
  const status = useQuery({
    queryKey: ['service-status', projectId],
    queryFn: () => api<{ pending: number; processing: number; failed: number; processedLastMinute: number; deadLetters: number; rejected: number }>(`/api/v1/projects/${projectId}/analytics/service-status`),
    refetchInterval: 15_000,
  });

  const lcp = performance.data?.filter((point) => point.name === 'LCP') ?? [];
  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 42, right: 18, top: 26, bottom: 30 },
    xAxis: { type: 'category', data: lcp.map((point) => new Date(point.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) },
    yAxis: { type: 'value', name: 'ms', splitLine: { lineStyle: { color: '#20324a' } } },
    series: [{ type: 'line', smooth: true, showSymbol: false, data: lcp.map((point) => point.p75), areaStyle: { opacity: 0.12 }, lineStyle: { width: 3, color: '#39d9c5' } }],
  };

  return (
    <>
      <PageHeading title="运行总览" description="最近 24 小时的真实用户访问、采集状态与核心体验指标。" />
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}><Card><Statistic title="页面访问" value={overview.data?.views ?? 0} prefix={<EyeOutlined />} /></Card></Col>
        <Col xs={24} sm={12} xl={6}><Card><Statistic title="独立会话" value={overview.data?.sessions ?? 0} prefix={<TeamOutlined />} /></Card></Col>
        <Col xs={24} sm={12} xl={6}><Card><Statistic title="采集事件" value={overview.data?.events ?? 0} prefix={<SendOutlined />} /></Card></Col>
        <Col xs={24} sm={12} xl={6}><Card><Statistic title="每分钟已处理" value={status.data?.processedLastMinute ?? 0} prefix={<CheckCircleOutlined />} suffix={<Space size={4}><Tag color={(status.data?.failed ?? 0) > 0 ? 'red' : 'green'}>{status.data?.failed ?? 0} 失败</Tag><Tag color={(status.data?.rejected ?? 0) > 0 ? 'gold' : 'default'}>{status.data?.rejected ?? 0} 拒绝</Tag></Space>} /></Card></Col>
        <Col xs={24} xl={15}>
          <Card title="LCP p75 趋势" extra={<Typography.Text type="secondary">15 秒刷新</Typography.Text>}><Chart option={option} /></Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="指标健康度" className="full-height">
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              {(overview.data?.metrics ?? []).filter((metric) => metric.name !== 'LoAF').map((metric) => (
                <div key={metric.name} className="quality-row">
                  <span><strong>{metric.name}</strong><small>p75 {metric.p75?.toFixed(metric.name === 'CLS' ? 3 : 0) ?? '—'}</small></span>
                  <Progress percent={quality(metric)} size="small" strokeColor="#39d9c5" />
                </div>
              ))}
            </Space>
          </Card>
        </Col>
        <Col span={24}>
          <Card title="核心指标">
            <Table rowKey="name" pagination={false} loading={overview.isLoading} dataSource={overview.data?.metrics ?? []} columns={[
              { title: '指标', dataIndex: 'name', render: (name: string) => <Tag color="cyan">{name}</Tag> },
              { title: '样本', dataIndex: 'count' },
              { title: '覆盖页面', dataIndex: 'viewCount' },
              { title: '样本覆盖率', dataIndex: 'sampleCoverage', render: (value: number) => `${Math.round(value * 100)}%` },
              { title: 'p50', dataIndex: 'p50', render: (value: number | null) => value?.toFixed(2) ?? '—' },
              { title: 'p75', dataIndex: 'p75', render: (value: number | null) => <strong>{value?.toFixed(2) ?? '—'}</strong> },
              { title: 'p95', dataIndex: 'p95', render: (value: number | null) => value?.toFixed(2) ?? '—' },
              { title: '良好率', render: (_: unknown, metric: MetricSummary) => `${quality(metric)}%` },
            ]} />
          </Card>
        </Col>
      </Row>
    </>
  );
}
