import { useQuery } from '@tanstack/react-query';
import { Button, Card, Descriptions, Drawer, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, queryString } from '../api/client';
import { PageHeading } from '../components/PageHeading';

/** 与 protocol 的 telemetryEventV3Schema.type 保持一致，不能只列 performance/view/event。 */
const rawEventTypes = ['performance', 'view', 'event', 'trace', 'span'] as const;
export type RawEventType = (typeof rawEventTypes)[number];

const rawEventTypeLabels: Record<RawEventType, string> = {
  performance: '性能',
  view: '页面访问',
  event: '自定义事件',
  trace: 'Trace',
  span: 'Span',
};

interface RawEvent {
  eventId: string;
  occurredAt: string;
  receivedAt: string;
  type: RawEventType;
  name: string;
  environment: string;
  version: string;
  sessionId: string;
  viewId: string;
  routeName: string;
  event: unknown;
}

export function RawEventsPage() {
  const { projectId = '' } = useParams();
  const [type, setType] = useState<RawEventType>();
  const [name, setName] = useState('');
  const [eventId, setEventId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [viewId, setViewId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [version, setVersion] = useState('');
  const [routeName, setRouteName] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<RawEvent>();
  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
  }, [type, name, eventId, sessionId, viewId, environment, version, routeName]);
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60_000);
  const search = queryString({ from: from.toISOString(), to: to.toISOString(), environment: environment || undefined, version: version || undefined, routeName: routeName || undefined, type, name: name || undefined, eventId: eventId || undefined, sessionId: sessionId || undefined, viewId: viewId || undefined, cursor, limit: 100 });
  const query = useQuery({
    queryKey: ['raw-events', projectId, environment, version, routeName, type, name, eventId, sessionId, viewId, cursor],
    queryFn: () => api<{ items: RawEvent[]; nextCursor: string | null }>(`/api/v1/projects/${projectId}/analytics/raw-events${search}`),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeading title="原始事件" description="按事件、会话和 View 检索经过服务端脱敏的 30 天明细。" />
      <Card>
        <Space className="table-toolbar" wrap>
          <Select allowClear placeholder="事件类型" value={type} onChange={setType} options={rawEventTypes.map((value) => ({ value, label: rawEventTypeLabels[value] }))} />
          <Input.Search allowClear placeholder="事件名称" value={name} onChange={(event) => setName(event.target.value)} style={{ width: 260 }} />
          <Input.Search allowClear placeholder="Event ID" value={eventId} onChange={(event) => setEventId(event.target.value)} style={{ width: 280 }} />
          <Input.Search allowClear placeholder="Session ID" value={sessionId} onChange={(event) => setSessionId(event.target.value)} style={{ width: 280 }} />
          <Input.Search allowClear placeholder="View ID" value={viewId} onChange={(event) => setViewId(event.target.value)} style={{ width: 280 }} />
          <Input allowClear placeholder="环境" value={environment} onChange={(event) => setEnvironment(event.target.value)} style={{ width: 130 }} />
          <Input allowClear placeholder="版本" value={version} onChange={(event) => setVersion(event.target.value)} style={{ width: 130 }} />
          <Input allowClear placeholder="routeName" value={routeName} onChange={(event) => setRouteName(event.target.value)} style={{ width: 180 }} />
          <Button onClick={() => void query.refetch()}>刷新</Button>
        </Space>
        <Table rowKey="eventId" loading={query.isLoading} dataSource={query.data?.items ?? []} onRow={(row) => ({ onClick: () => setSelected(row) })} columns={[
          { title: '时间', dataIndex: 'occurredAt', render: (value: string) => new Date(value).toLocaleString() },
          { title: '类型', dataIndex: 'type', render: (value: RawEventType) => <Tag>{rawEventTypeLabels[value] ?? value}</Tag> },
          { title: '名称', dataIndex: 'name' },
          { title: '页面', dataIndex: 'routeName' },
          { title: '环境', dataIndex: 'environment' },
          { title: '版本', dataIndex: 'version' },
        ]} />
        <Space>
          <Button
            disabled={cursorHistory.length === 0}
            onClick={() => {
              const history = [...cursorHistory];
              setCursor(history.pop());
              setCursorHistory(history);
            }}
          >上一页</Button>
          <Button
            disabled={!query.data?.nextCursor}
            onClick={() => {
              setCursorHistory((history) => [...history, cursor]);
              setCursor(query.data?.nextCursor ?? undefined);
            }}
          >下一页</Button>
        </Space>
      </Card>
      <Drawer width={640} open={Boolean(selected)} onClose={() => setSelected(undefined)} title={selected?.name}>
        {selected ? <><Descriptions column={1} size="small" items={[{ key: 'event', label: 'Event ID', children: selected.eventId }, { key: 'session', label: 'Session', children: selected.sessionId }, { key: 'view', label: 'View', children: selected.viewId }, { key: 'route', label: 'Route', children: selected.routeName }]} /><Typography.Title level={5}>事件内容</Typography.Title><pre className="json-view">{JSON.stringify(selected.event, null, 2)}</pre></> : null}
      </Drawer>
    </>
  );
}
