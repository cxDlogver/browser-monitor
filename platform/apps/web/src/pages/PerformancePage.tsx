import { useQuery } from '@tanstack/react-query';
import { Card, Col, DatePicker, Input, Row, Select, Space, Statistic, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { EChartsOption } from 'echarts';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, queryString } from '../api/client';
import type { PerformancePoint } from '../api/types';
import { Chart } from '../components/Chart';
import { PageHeading } from '../components/PageHeading';

const metrics = ['LCP', 'FCP', 'INP', 'CLS', 'FPS', 'LoAF'] as const;

export function PerformancePage() {
  const { projectId = '' } = useParams();
  const [metric, setMetric] = useState<(typeof metrics)[number]>('LCP');
  const [environment, setEnvironment] = useState('');
  const [version, setVersion] = useState('');
  const [routeName, setRouteName] = useState('');
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(24, 'hour'), dayjs()]);
  const search = queryString({
    from: timeRange[0].toISOString(),
    to: timeRange[1].toISOString(),
    metric,
    environment: environment || undefined,
    version: version || undefined,
    routeName: routeName || undefined,
  });
  const query = useQuery({
    queryKey: ['performance', projectId, metric, environment, version, routeName, timeRange[0].valueOf(), timeRange[1].valueOf()],
    queryFn: () => api<PerformancePoint[]>(`/api/v1/projects/${projectId}/analytics/performance${search}`),
    refetchInterval: 15_000,
  });
  const points = query.data ?? [];
  const latest = points.at(-1);
  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['p50', 'p75', 'p95'] },
    grid: { left: 48, right: 20, bottom: 38 },
    xAxis: { type: 'category', data: points.map((point) => new Date(point.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#20324a' } } },
    series: [
      { name: 'p50', type: 'line', showSymbol: false, data: points.map((point) => point.p50) },
      { name: 'p75', type: 'line', showSymbol: false, data: points.map((point) => point.p75), lineStyle: { width: 3 } },
      { name: 'p95', type: 'line', showSymbol: false, data: points.map((point) => point.p95) },
    ],
  };
  return (
    <>
      <div className="page-heading compact"><PageHeading title="性能指标" description="服务端统一计算的分位数、评级分布与诊断数据。" /><Space wrap><Select value={metric} options={metrics.map((value) => ({ value }))} onChange={setMetric} /><Input allowClear value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder="环境" style={{ width: 130 }} /><Input allowClear value={version} onChange={(event) => setVersion(event.target.value)} placeholder="版本" style={{ width: 130 }} /><Input allowClear value={routeName} onChange={(event) => setRouteName(event.target.value)} placeholder="routeName" style={{ width: 180 }} /><DatePicker.RangePicker showTime value={timeRange} onChange={(value) => { if (value?.[0] && value[1]) setTimeRange([value[0], value[1]]); }} /></Space></div>
      <Row gutter={[16, 16]}>
        {(['p50', 'p75', 'p90', 'p95'] as const).map((key) => <Col xs={12} xl={6} key={key}><Card><Statistic title={key.toUpperCase()} value={latest?.[key] ?? 0} precision={metric === 'CLS' ? 3 : 1} suffix={metric === 'CLS' ? '' : metric === 'FPS' ? 'fps' : 'ms'} /></Card></Col>)}
        <Col span={24}><Card title={`${metric} 趋势`}><Chart option={option} height={380} /></Card></Col>
        <Col span={24}><Card title="分钟明细"><Table rowKey={(row) => `${row.bucket}-${row.name}`} dataSource={[...points].reverse()} pagination={{ pageSize: 20 }} columns={[
          { title: '时间', dataIndex: 'bucket', render: (value: string) => new Date(value).toLocaleString() },
          { title: '样本', dataIndex: 'count' },
          { title: '会话 / 页面', render: (_: unknown, row: PerformancePoint) => `${row.sessionCount} / ${row.viewCount}` },
          { title: '覆盖率', dataIndex: 'sampleCoverage', render: (value: number) => `${Math.round(value * 100)}%` },
          { title: 'p75', dataIndex: 'p75', render: (value: number | null) => <strong>{value?.toFixed(2) ?? '—'}</strong> },
          { title: '等级分布', render: (_: unknown, row: PerformancePoint) => <Space><Tag color="green">良好 {row.goodCount}</Tag><Tag color="gold">待改善 {row.needsImprovementCount}</Tag><Tag color="red">较差 {row.poorCount}</Tag></Space> },
          ...(metric === 'LoAF' ? [{ title: '阻塞总时长', dataIndex: 'blockingDurationTotal' }, { title: '脚本数', dataIndex: 'scriptCount' }] : []),
        ]} /></Card></Col>
      </Row>
    </>
  );
}
