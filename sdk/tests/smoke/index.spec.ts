import { describe, expect, it } from 'vitest';

import { createMonitor } from '../../src';

describe('browser monitor SDK entry', () => {
  it('exports only the unified monitor factory', async () => {
    const sdk = await import('../../src');

    expect(sdk.createMonitor).toBeTypeOf('function');
    expect('createPerformanceMonitor' in sdk).toBe(false);
  });

  it('fails fast for invalid required configuration', () => {
    expect(() =>
      createMonitor({
        app: { name: '', version: '1.0.0', environment: 'test' },
        transport: { dsn: '/collect' },
      }),
    ).toThrow('app.name is required');

    expect(() =>
      createMonitor({
        app: { name: 'app', version: '1.0.0', environment: 'test' },
        transport: { dsn: '', batchSize: -1 },
      }),
    ).toThrow('transport.dsn is required');
  });
});
