import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpSender } from '../../src/transport';
import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';

const event: TelemetryEnvelope = {
  protocolVersion: '2.0',
  eventId: 'event-1',
  type: 'event',
  name: 'checkout',
  occurredAt: 1_700_000_000_000,
  app: { name: 'shop', version: '1.0.0', environment: 'test' },
  context: {
    sessionId: 'session-1',
    viewId: 'view-1',
    routeName: 'checkout',
    url: 'https://shop.test/checkout',
    runtime: { sdk: { name: 'cx-browser-monitor-sdk', version: '0.2.0' } },
  },
  correlation: {},
  payload: { type: 'event', name: 'checkout', source: 'custom' },
};

describe('HttpSender protocol 2.0', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the versioned batch wrapper to the public DSN', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response(null, { status: 202 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sender = new HttpSender({
      dsn: 'https://monitor.test/api/v2/ingest/bm_pk_test/envelopes',
      headers: {},
    });
    await expect(sender.send([event], false)).resolves.toEqual({ success: true, retryable: false });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://monitor.test/api/v2/ingest/bm_pk_test/envelopes',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]![1]!;
    expect(typeof init.body).toBe('string');
    const body = typeof init.body === 'string' ? init.body : '';
    expect(JSON.parse(body)).toMatchObject({
      protocolVersion: '2.0',
      sdk: { name: 'cx-browser-monitor-sdk', version: '0.2.0' },
      events: [{ protocolVersion: '2.0', eventId: 'event-1' }],
    });
  });
});
