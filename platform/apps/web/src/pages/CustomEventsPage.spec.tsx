import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
const chartMock = vi.hoisted(() => vi.fn(() => null));
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: apiMock,
}));
vi.mock('../components/Chart', () => ({ Chart: chartMock }));

import { CustomEventsPage } from './CustomEventsPage';
import { CustomSignalDetailPage, TraceWaterfall } from './CustomSignalDetailPage';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false, media: '', onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function renderPages() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/project-1/events']}>
        <Routes>
          <Route path="/projects/:projectId/events" element={<CustomEventsPage />} />
          <Route path="/projects/:projectId/events/:kind/:name" element={<CustomSignalDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('custom signal pages', () => {
  it('shows nested spans and point events with record drill-down', () => {
    const onSelect = vi.fn();
    const base = {
      routeName: '/checkout', sessionId: 'session-1', viewId: 'view-1',
      environment: 'test', version: '1', attributes: {}, metrics: {},
      traceId: 'trace-1', occurredAt: '2026-01-01T00:00:00.100Z',
    };
    const trace = { ...base, eventId: 'trace-record', kind: 'trace' as const, name: 'flow',
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.100Z',
      durationMs: 100, status: 'ok' as const, spanId: null, parentSpanId: null };
    const parent = { ...base, eventId: 'parent-record', kind: 'span' as const, name: 'parent',
      startedAt: '2026-01-01T00:00:00.010Z', endedAt: '2026-01-01T00:00:00.080Z',
      durationMs: 70, status: 'ok' as const, spanId: 'span-parent', parentSpanId: null };
    const child = { ...base, eventId: 'child-record', kind: 'span' as const, name: 'child',
      startedAt: '2026-01-01T00:00:00.020Z', endedAt: '2026-01-01T00:00:00.060Z',
      durationMs: 40, status: 'cancelled' as const, spanId: 'span-child', parentSpanId: 'span-parent' };
    const event = { ...base, eventId: 'event-record', kind: 'event' as const, name: 'click',
      occurredAt: '2026-01-01T00:00:00.030Z', startedAt: null, endedAt: null,
      durationMs: null, status: null, spanId: 'span-child', parentSpanId: 'span-parent' };
    render(<TraceWaterfall data={{ traceId: 'trace-1', incomplete: false, records: [trace, parent, child, event] }} onSelect={onSelect} />);
    expect(screen.getByTitle('child')).toHaveStyle({ paddingLeft: '28px' });
    expect(screen.getByTitle('child · +20 ms')).toHaveStyle({ background: '#faad14' });
    expect(screen.getByTitle('click · +30 ms')).toHaveStyle({ width: '3px' });
    fireEvent.click(screen.getByTitle('child'));
    expect(onSelect).toHaveBeenCalledWith(child);
  });

  it('lists signals independently and navigates to one signal detail', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('/custom-signals/detail')) return {
        kind: 'span', name: 'page.stay', metric: 'duration', unit: 'ms', aggregation: 'avg',
        count: 2, sessionCount: 2, lastSeenAt: null, value: 150,
        points: [{ bucket: '2026-01-01T00:00:00Z', value: 150 }],
        routes: [{ routeName: '/page', value: 150 }],
      };
      if (path.includes('/custom-signals/records')) return { records: [], nextCursor: null };
      if (path.includes('/custom-signals')) return [
        { kind: 'span', name: 'page.stay', count: 2, sessionCount: 2,
          lastSeenAt: '2026-01-01T00:00:00Z', metrics: [{ name: 'duration', unit: 'ms' }] },
        { kind: 'event', name: 'button.click', count: 9, sessionCount: 3,
          lastSeenAt: '2026-01-01T00:00:00Z', metrics: [] },
      ];
      return {};
    });
    renderPages();
    expect(await screen.findByText('page.stay')).toBeInTheDocument();
    expect(screen.getByText('button.click')).toBeInTheDocument();
    expect(chartMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('page.stay'));
    expect(await screen.findByText('返回列表')).toBeInTheDocument();
    expect(await screen.findByText('事件趋势')).toBeInTheDocument();
    await waitFor(() => expect(chartMock).toHaveBeenCalledTimes(1));
  });
});