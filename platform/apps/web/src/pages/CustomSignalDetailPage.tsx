import { ArrowLeftOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Descriptions, Drawer, Empty, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { EChartsOption } from 'echarts';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../api/client';
import { Chart } from '../components/Chart';
import { PageHeading } from '../components/PageHeading';
import { useAnalyticsRange } from '../hooks/useAnalyticsRange';
import type {
  CustomAggregation,
  CustomSignalDetail,
  CustomSignalKind,
  CustomSignalRecord,
  CustomSignalRecordPage,
  CustomSignalSummary,
  CustomTraceDetail,
} from './custom-signal-types';

const aggregations: CustomAggregation[] = ['count', 'sum', 'avg', 'min', 'max', 'p50', 'p75', 'p90', 'p95', 'p99'];
const kindLabels = { event: '事件', trace: 'Trace', span: 'Span' };
const statusColors = { ok: 'green', error: 'red', cancelled: 'orange' };

function withQuery(base: string, range: string, extra: Record<string, string | undefined>): string {
  const params = new URLSearchParams(range.slice(1));
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  return `${base}?${params.toString()}`;
}

function displayNumber(value: number | null, unit: string): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}

function RecordDetails({ record }: { record: CustomSignalRecord }) {
  return (
    <>
      <Descriptions column={1} bordered size="small" items={[
        { key: 'name', label: '名称', children: record.name },
        { key: 'type', label: '类型', children: kindLabels[record.kind] },
        { key: 'time', label: '发生时间', children: new Date(record.occurredAt).toLocaleString() },
        { key: 'status', label: '状态', children: record.status ? <Tag color={statusColors[record.status]}>{record.status}</Tag> : '—' },
        { key: 'duration', label: '耗时', children: displayNumber(record.durationMs, 'ms') },
        { key: 'route', label: '路由', children: record.routeName },
        { key: 'trace', label: 'Trace ID', children: record.traceId ?? '—' },
        { key: 'span', label: 'Span ID', children: record.spanId ?? '—' },
        { key: 'parent', label: '父 Span ID', children: record.parentSpanId ?? '—' },
        { key: 'session', label: 'Session / View', children: `${record.sessionId} / ${record.viewId}` },
      ]} />
      <Typography.Title level={5}>数值指标</Typography.Title>
      <pre className="code-block">{JSON.stringify(record.metrics, null, 2)}</pre>
      <Typography.Title level={5}>属性</Typography.Title>
      <pre className="code-block">{JSON.stringify(record.attributes, null, 2)}</pre>
    </>
  );
}

export function TraceWaterfall({ data, onSelect }: { data: CustomTraceDetail; onSelect: (record: CustomSignalRecord) => void }) {
  const root = data.records.find((item) => item.kind === 'trace');
  const origin = root?.startedAt ? new Date(root.startedAt).getTime() : Math.min(...data.records.map((item) =>
    new Date(item.startedAt ?? item.occurredAt).getTime(),
  ));
  const end = Math.max(...data.records.map((item) => new Date(item.endedAt ?? item.occurredAt).getTime()));
  const width = Math.max(1, end - origin);
  const bySpan = new Map(data.records.filter((item) => item.kind === 'span' && item.spanId).map((item) => [item.spanId, item]));
  const depth = (item: CustomSignalRecord): number => {
    let current = item;
    let level = item.kind === 'trace' ? 0 : 1;
    const seen = new Set<string>();
    while (current.parentSpanId && bySpan.has(current.parentSpanId) && !seen.has(current.parentSpanId)) {
      seen.add(current.parentSpanId);
      current = bySpan.get(current.parentSpanId)!;
      level += 1;
    }
    return level;
  };
  const records = [...data.records].sort((a, b) =>
    new Date(a.startedAt ?? a.occurredAt).getTime() - new Date(b.startedAt ?? b.occurredAt).getTime(),
  );
  return (
    <>
      {data.incomplete && <Alert type="warning" showIcon message="不完整链路：根 Trace 或父 Span 缺失，或原始数据已超过保留期。" style={{ marginBottom: 16 }} />}
      {records.length === 0 ? <Empty description="没有可查看的链路记录" /> : records.map((item) => {
        const start = new Date(item.startedAt ?? item.occurredAt).getTime();
        const duration = Math.max(item.durationMs ?? 0, 0);
        const left = Math.max(0, ((start - origin) / width) * 100);
        const barWidth = Math.max(1, (duration / width) * 100);
        const color = item.status === 'error' ? '#ff4d4f' : item.status === 'cancelled' ? '#faad14' : '#4e9cff';
        return <div key={item.eventId} onClick={() => onSelect(item)} style={{ display: 'grid', gridTemplateColumns: '230px 1fr 80px', gap: 12, alignItems: 'center', marginBottom: 12, cursor: 'pointer' }}>
          <div style={{ paddingLeft: Math.min(depth(item), 6) * 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.name}>
            <Tag>{kindLabels[item.kind]}</Tag>{item.name}
          </div>
          <div style={{ position: 'relative', height: 18, background: '#142238', borderRadius: 4 }}>
            <div title={`${item.name} · +${Math.max(0, start - origin)} ms`} style={{ position: 'absolute', left: `${left}%`, width: item.kind === 'event' ? 3 : `${Math.min(barWidth, 100 - left)}%`, minWidth: 3, height: '100%', background: color, borderRadius: 4 }} />
          </div>
          <span>{item.kind === 'event' ? `+${start - origin} ms` : displayNumber(duration, 'ms')}</span>
        </div>;
      })}
    </>
  );
}

export function CustomSignalDetailPage() {
  const { projectId = '', kind: rawKind = '', name: rawName = '' } = useParams();
  const navigate = useNavigate();
  const range = useAnalyticsRange();
  const kind = rawKind as CustomSignalKind;
  const name = rawName;
  const [metricKey, setMetricKey] = useState(kind === 'event' ? '__signal_count__' : JSON.stringify(['duration', 'ms']));
  const [aggregation, setAggregation] = useState<CustomAggregation>(kind === 'event' ? 'count' : 'avg');
  const [routeName, setRouteName] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<CustomSignalRecord>();
  const [traceId, setTraceId] = useState<string>();
  const base = `/api/v1/projects/${projectId}/analytics`;
  const selection = { kind, name };
  const list = useQuery({
    queryKey: ['custom-signal-list', projectId, range],
    queryFn: () => api<CustomSignalSummary[]>(`${base}/custom-signals${range}`),
  });
  const summary = list.data?.find((item) => item.kind === kind && item.name === name);
  const metricOptions = useMemo(() => [
    { value: '__signal_count__', label: '发生次数' },
    ...(summary?.metrics ?? []).map((metric) => ({ value: JSON.stringify([metric.name, metric.unit]), label: `${metric.name} (${metric.unit})` })),
  ], [summary]);
  const [metric, unit] = metricKey === '__signal_count__' ? [undefined, undefined] : JSON.parse(metricKey) as [string, string];
  const effectiveAggregation = metric ? aggregation : 'count';
  const detailUrl = withQuery(`${base}/custom-signals/detail`, range, {
    ...selection, metric, unit, aggregation: effectiveAggregation, routeName,
  });
  const detail = useQuery({
    queryKey: ['custom-signal-detail', detailUrl],
    queryFn: () => api<CustomSignalDetail>(detailUrl),
    enabled: Boolean(name && ['event', 'trace', 'span'].includes(kind)),
    refetchInterval: 15_000,
  });
  const allRoutes = useQuery({
    queryKey: ['custom-signal-routes', projectId, kind, name, range],
    queryFn: () => api<CustomSignalDetail>(withQuery(`${base}/custom-signals/detail`, range, selection)),
  });
  const recordsUrl = withQuery(`${base}/custom-signals/records`, range, {
    ...selection, routeName, cursor, limit: '20',
  });
  const records = useQuery({
    queryKey: ['custom-signal-records', recordsUrl],
    queryFn: () => api<CustomSignalRecordPage>(recordsUrl),
  });
  const trace = useQuery({
    queryKey: ['custom-trace', projectId, traceId, range],
    queryFn: () => api<CustomTraceDetail>(`${base}/traces/${encodeURIComponent(traceId!)}${range}`),
    enabled: Boolean(traceId),
  });
  const chart: EChartsOption = {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: detail.data?.points.map((point) => new Date(point.bucket).toLocaleString()) ?? [] },
    yAxis: { type: 'value', name: detail.data?.unit },
    series: [{ type: 'line', name: `${detail.data?.metric ?? 'count'} · ${effectiveAggregation}`, showSymbol: false, data: detail.data?.points.map((point) => point.value) ?? [] }],
  };

  return (
    <>
      <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/projects/${projectId}/events`)}>返回列表</Button>
      <PageHeading title={name} description={`${kindLabels[kind] ?? kind}的统计、趋势与事件详情`} />
      {(detail.isError || records.isError) && <Alert type="error" showIcon message="自定义观测数据加载失败" style={{ marginBottom: 16 }} />}
      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select value={metricKey} onChange={(value) => { setMetricKey(value); setAggregation(value === '__signal_count__' ? 'count' : 'avg'); }} style={{ minWidth: 190 }} options={metricOptions} />
          <Select value={effectiveAggregation} disabled={!metric} onChange={setAggregation} style={{ width: 130 }} options={aggregations.map((value) => ({ value, label: value }))} />
          <Select allowClear placeholder="全部路由" value={routeName} onChange={(value) => { setRouteName(value); setCursor(undefined); setPreviousCursors([]); }} style={{ minWidth: 220 }} options={(allRoutes.data?.routes ?? []).map((route) => ({ value: route.routeName, label: route.routeName }))} />
        </Space>
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={12} xl={6}><Card><Statistic title="发生次数" value={detail.data?.count ?? 0} loading={detail.isLoading} /></Card></Col>
        <Col xs={12} xl={6}><Card><Statistic title={`${detail.data?.metric ?? 'count'} · ${effectiveAggregation}`} value={detail.data?.value ?? '—'} suffix={detail.data?.unit} loading={detail.isLoading} /></Card></Col>
        <Col xs={12} xl={6}><Card><Statistic title="影响会话" value={detail.data?.sessionCount ?? 0} loading={detail.isLoading} /></Card></Col>
        <Col xs={12} xl={6}><Card><Statistic title="最后发生" value={detail.data?.lastSeenAt ? new Date(detail.data.lastSeenAt).toLocaleString() : '—'} loading={detail.isLoading} /></Card></Col>
        <Col xs={24} xl={16}><Card title="事件趋势">{detail.data?.points.length ? <Chart option={chart} /> : <Empty description="没有趋势数据" />}</Card></Col>
        <Col xs={24} xl={8}><Card title="路由分布"><Table rowKey="routeName" size="small" pagination={{ pageSize: 8 }} dataSource={detail.data?.routes ?? []} columns={[
          { title: '路由', dataIndex: 'routeName' },
          { title: `${effectiveAggregation} (${detail.data?.unit ?? 'count'})`, dataIndex: 'value', render: (value: number | null) => value?.toFixed(2) ?? '—' },
        ]} /></Card></Col>
        <Col span={24}><Card title="原始记录" extra={<Space><Button disabled={previousCursors.length === 0} onClick={() => { setCursor(previousCursors.at(-1)); setPreviousCursors((value) => value.slice(0, -1)); }}>上一页</Button><Button disabled={!records.data?.nextCursor} onClick={() => { setPreviousCursors((value) => [...value, cursor]); setCursor(records.data!.nextCursor!); }}>下一页</Button></Space>}>
          <Table<CustomSignalRecord> rowKey="eventId" pagination={false} loading={records.isLoading} dataSource={records.data?.records ?? []} locale={{ emptyText: '原始记录仅保留 30 天，当前范围内没有记录' }} columns={[
            { title: '时间', dataIndex: 'occurredAt', render: (value: string) => new Date(value).toLocaleString() },
            { title: '状态', dataIndex: 'status', render: (value: CustomSignalRecord['status']) => value ? <Tag color={statusColors[value]}>{value}</Tag> : '—' },
            { title: '耗时', dataIndex: 'durationMs', render: (value: number | null) => displayNumber(value, 'ms') },
            { title: '路由', dataIndex: 'routeName' },
            { title: '操作', render: (_, row) => <Space><Button type="link" onClick={() => setSelected(row)}>详情</Button>{row.traceId && <Button type="link" onClick={() => setTraceId(row.traceId!)}>链路</Button>}</Space> },
          ]} />
        </Card></Col>
      </Row>
      <Drawer title="记录详情" width={640} open={Boolean(selected)} onClose={() => setSelected(undefined)}>{selected && <RecordDetails record={selected} />}</Drawer>
      <Drawer title={`Trace ${traceId ?? ''}`} width={960} open={Boolean(traceId)} onClose={() => setTraceId(undefined)}>
        {trace.isError && <Alert type="error" message="链路加载失败" />}
        {trace.data && <TraceWaterfall data={trace.data} onSelect={setSelected} />}
      </Drawer>
    </>
  );
}