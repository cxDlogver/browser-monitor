import { createBatchFixture, createPerformanceEventFixture, invalidProtocolFixture } from '@browser-monitor/protocol/fixtures';
import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { IngestionService } from '../src/ingestion/ingestion.service.js';

function setup(inserted: boolean = true) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT event_id FROM telemetry_events')) {
        return { rowCount: inserted ? 0 : 1, rows: inserted ? [] : [{ event_id: 'event-fixture-1' }] };
      }
      if (sql.includes('INSERT INTO telemetry_events')) {
        return { rowCount: 1, rows: [{ event_id: 'event-fixture-1' }] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM ingestion_keys')) {
        return { rowCount: 1, rows: [{ project_id: 'project-1', app_name: 'fixture-app', user_hash_salt: 'salt' }] };
      }
      if (sql.includes('FROM allowed_origins')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
      return { rowCount: 1, rows: [] };
    }),
    connect: vi.fn(async () => client),
  };
  const limiter = { consume: vi.fn(async () => true) };
  const redisTransaction = {
    hincrby: vi.fn(),
    zadd: vi.fn(),
    zremrangebyscore: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn(async () => []),
  };
  redisTransaction.hincrby.mockReturnValue(redisTransaction);
  redisTransaction.zadd.mockReturnValue(redisTransaction);
  redisTransaction.zremrangebyscore.mockReturnValue(redisTransaction);
  redisTransaction.expire.mockReturnValue(redisTransaction);
  const redis = { multi: vi.fn(() => redisTransaction) };
  const metrics = {
    ingestionDuration: { startTimer: vi.fn(() => vi.fn()) },
    ingestionEvents: { inc: vi.fn() },
  };
  const service = new IngestionService(
    { pool } as never,
    { ALLOW_ORIGINLESS_INGEST: false, USER_HASH_SECRET: 'x'.repeat(32) } as never,
    redis as never,
    limiter as never,
    metrics as never,
  );
  return { service, client, pool };
}

describe('IngestionService', () => {
  it('rejects protocol 1.0 with a stable error code', async () => {
    const { service } = setup();
    await expect(service.ingest('bm_pk_test', invalidProtocolFixture, 'https://example.test', '127.0.0.1', 'request-1')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('partially accepts valid events and writes raw data plus outbox in one transaction', async () => {
    const { service, client } = setup();
    const body = { ...createBatchFixture(), events: [createPerformanceEventFixture({ occurredAt: Date.now() }), { invalid: true }] };
    const result = await service.ingest('bm_pk_test', body, 'https://example.test', '127.0.0.1', 'request-2');
    expect(result).toMatchObject({ accepted: 1, duplicate: 0, rejected: 1, requestId: 'request-2' });
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox_tasks'), expect.any(Array));
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('counts idempotent conflicts as duplicates without creating another outbox task', async () => {
    const { service, client } = setup(false);
    const result = await service.ingest(
      'bm_pk_test',
      createBatchFixture([createPerformanceEventFixture({ occurredAt: Date.now() })]),
      'https://example.test',
      '127.0.0.1',
      'request-3',
    );
    expect(result).toMatchObject({ accepted: 0, duplicate: 1, rejected: 0 });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox_tasks'), expect.any(Array));
  });

  it('deduplicates repeated event IDs inside one batch', async () => {
    const { service, client } = setup();
    const event = createPerformanceEventFixture({ occurredAt: Date.now() });
    const result = await service.ingest(
      'bm_pk_test',
      createBatchFixture([event, { ...event, occurredAt: event.occurredAt + 1 }]),
      'https://example.test',
      '127.0.0.1',
      'request-4',
    );
    expect(result).toMatchObject({ accepted: 1, duplicate: 1, rejected: 0 });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('jsonb_to_recordset'), expect.any(Array));
  });

  it('accepts the text/plain JSON representation used by sendBeacon', async () => {
    const { service } = setup();
    const result = await service.ingest(
      'bm_pk_test',
      JSON.stringify(createBatchFixture([createPerformanceEventFixture({ occurredAt: Date.now() })])),
      'https://example.test',
      '127.0.0.1',
      'request-5',
    );
    expect(result).toMatchObject({ accepted: 1, rejected: 0 });
  });
});
