import { describe, expect, it } from 'vitest';

import { assertSafeTarget } from '../src/target-safety.js';

describe('audit target safety', () => {
  it('rejects loopback and private literals by default', async () => {
    await expect(assertSafeTarget('http://127.0.0.1/admin', false)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeTarget('http://192.168.1.2/', false)).rejects.toThrow(/private|reserved/i);
    await expect(assertSafeTarget('http://[::1]/', false)).rejects.toThrow(/private|reserved/i);
  });

  it('allows private targets only when explicitly enabled', async () => {
    await expect(assertSafeTarget('http://127.0.0.1/', true)).resolves.toBeUndefined();
  });
});
