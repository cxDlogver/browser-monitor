import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Table, Tag } from 'antd';
import type { EChartsOption } from 'echarts';
import { useParams } from 'react-router-dom';

import { api } from '../api/client';
import { Chart } from '../components/Chart';
import { PageHeading } from '../components/PageHeading';
import { useAnalyticsRange } from '../hooks/useAnalyticsRange';

interface EventPoint { bucket: string; name: string; routeName: string; count: number }

export function CustomEventsPage() {
  const { projectId = '' } = useParams();
  const range = useAnalyticsRange();
  const query = useQuery({
    queryKey: ['custom-events', projectId, range],
    queryFn: () => api<EventPoint[]>(`/api/v1/projects/${projectId}/analytics/events${range}`),
    refetchInterval: 15_000,
  });
  const points = query.data ?? [];
  const buckets = [...new Set(points.map((point) => point.bucket))];
  const names = [...new Set(points.map((point) => point.name))];
  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: names.slice(0, 8) },
    xAxis: { type: 'category', data: buckets.map((value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#20324a' } } },
    series: names.slice(0, 8).map((name) => ({ name, type: 'line', showSymbol: false, data: buckets.map((bucket) => points.filter((point) => point.bucket === bucket && point.name === name).reduce((sum, point) => sum + point.count, 0)) })),
  };
  const totals = [...new Map(names.map((name) => [name, points.filter((point) => point.name === name).reduce((sum, point) => sum + point.count, 0)])).entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return (
    <>
      <PageHeading title="自定义事件" description="观察业务埋点的发生次数、时间趋势与页面分布。" />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}><Card title="事件趋势"><Chart option={option} /></Card></Col>
        <Col xs={24} xl={8}><Card title="事件排行"><Table rowKey="name" pagination={false} dataSource={totals.slice(0, 10)} columns={[{ title: '事件', dataIndex: 'name', render: (value: string) => <Tag>{value}</Tag> }, { title: '次数', dataIndex: 'count' }]} /></Card></Col>
        <Col span={24}><Card title="页面明细"><Table rowKey={(row) => `${row.bucket}-${row.name}-${row.routeName}`} dataSource={[...points].reverse()} columns={[{ title: '时间', dataIndex: 'bucket', render: (value: string) => new Date(value).toLocaleString() }, { title: '事件', dataIndex: 'name' }, { title: '页面', dataIndex: 'routeName' }, { title: '次数', dataIndex: 'count' }]} /></Card></Col>
      </Row>
    </>
  );
}

