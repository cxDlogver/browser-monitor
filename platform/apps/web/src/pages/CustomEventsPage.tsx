import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../api/client';
import { PageHeading } from '../components/PageHeading';
import { useAnalyticsRange } from '../hooks/useAnalyticsRange';
import type { CustomSignalSummary } from './custom-signal-types';

const kindLabels = { event: '事件', trace: 'Trace', span: 'Span' };

export function CustomEventsPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const range = useAnalyticsRange();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | CustomSignalSummary['kind']>('all');
  const query = useQuery({
    queryKey: ['custom-signals', projectId, range],
    queryFn: () => api<CustomSignalSummary[]>(`/api/v1/projects/${projectId}/analytics/custom-signals${range}`),
    refetchInterval: 15_000,
  });
  const rows = useMemo(() => (query.data ?? []).filter((row) =>
    (kind === 'all' || row.kind === kind) && row.name.toLowerCase().includes(search.trim().toLowerCase()),
  ), [query.data, kind, search]);

  return (
    <>
      <PageHeading title="自定义观测项" description="按埋点名称查看独立的统计、趋势和原始记录。" />
      {query.isError && <Alert type="error" showIcon message="自定义观测项加载失败" />}
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search placeholder="搜索埋点名称" allowClear value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 280 }} />
          <Select value={kind} onChange={setKind} style={{ width: 140 }} options={[
            { value: 'all', label: '全部类型' },
            { value: 'event', label: '事件' },
            { value: 'trace', label: 'Trace' },
            { value: 'span', label: 'Span' },
          ]} />
        </Space>
        <Table<CustomSignalSummary>
          rowKey={(row) => `${row.kind}:${row.name}`}
          loading={query.isLoading}
          dataSource={rows}
          pagination={{ pageSize: 20 }}
          locale={{ emptyText: '当前时间范围内没有自定义观测项' }}
          onRow={(row) => ({ onClick: () => navigate(`/projects/${projectId}/events/${row.kind}/${encodeURIComponent(row.name)}`), style: { cursor: 'pointer' } })}
          columns={[
            { title: '类型', dataIndex: 'kind', width: 100, render: (value: CustomSignalSummary['kind']) => <Tag>{kindLabels[value]}</Tag> },
            { title: '名称', dataIndex: 'name', render: (value: string) => <Typography.Link>{value}</Typography.Link> },
            { title: '发生次数', dataIndex: 'count', sorter: (a, b) => a.count - b.count },
            { title: '影响会话', dataIndex: 'sessionCount', sorter: (a, b) => a.sessionCount - b.sessionCount },
            { title: '可用指标', dataIndex: 'metrics', render: (metrics: CustomSignalSummary['metrics']) => metrics.length ? metrics.map((metric) => <Tag key={`${metric.name}:${metric.unit}`}>{metric.name} ({metric.unit})</Tag>) : '—' },
            { title: '最后发生', dataIndex: 'lastSeenAt', render: (value: string | null) => value ? new Date(value).toLocaleString() : '—' },
          ]}
        />
      </Card>
    </>
  );
}
