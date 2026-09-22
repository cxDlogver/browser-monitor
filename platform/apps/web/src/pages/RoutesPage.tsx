import { useQuery } from '@tanstack/react-query';
import { Card, Progress, Table, Tag } from 'antd';
import { useParams } from 'react-router-dom';

import { api } from '../api/client';
import { PageHeading } from '../components/PageHeading';
import { useAnalyticsRange } from '../hooks/useAnalyticsRange';

interface RouteRow {
  routeName: string;
  name: string;
  count: number;
  p75: number | null;
  abnormalCount: number;
  abnormalRate: number;
  pageViews: number;
  loafPerThousandViews: number | null;
}

export function RoutesPage() {
  const { projectId = '' } = useParams();
  const range = useAnalyticsRange();
  const query = useQuery({
    queryKey: ['routes', projectId, range],
    queryFn: () => api<RouteRow[]>(`/api/v1/projects/${projectId}/analytics/routes${range}`),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeading title="页面排名" description="用稳定 routeName 合并动态路径，定位最需要优化的页面。" />
      <Card>
        <Table rowKey={(row) => `${row.routeName}-${row.name}`} loading={query.isLoading} dataSource={query.data ?? []} columns={[
          { title: '页面', dataIndex: 'routeName', render: (value: string) => <strong>{value}</strong> },
          { title: '指标', dataIndex: 'name', render: (value: string) => <Tag color="cyan">{value}</Tag> },
          { title: '样本量', dataIndex: 'count', sorter: (a: RouteRow, b: RouteRow) => a.count - b.count },
          { title: '访问量', dataIndex: 'pageViews', sorter: (a: RouteRow, b: RouteRow) => a.pageViews - b.pageViews },
          { title: 'p75', dataIndex: 'p75', render: (value: number | null) => value?.toFixed(2) ?? '—', sorter: (a: RouteRow, b: RouteRow) => (a.p75 ?? 0) - (b.p75 ?? 0) },
          { title: '异常占比', dataIndex: 'abnormalRate', render: (value: number) => <Progress percent={Math.round(value * 100)} size="small" status={value > 0.25 ? 'exception' : 'normal'} /> },
          { title: 'LoAF / 千次访问', dataIndex: 'loafPerThousandViews', render: (value: number | null) => value === null ? '—' : value.toFixed(1) },
        ]} />
      </Card>
    </>
  );
}
