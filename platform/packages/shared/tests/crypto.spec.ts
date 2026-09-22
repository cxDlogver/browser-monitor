import { describe, expect, it } from 'vitest';

import { hashPassword, hashToken, hashUserId, verifyPassword } from '../src/crypto';

describe('authentication crypto', () => {
  it('hashes and verifies passwords without storing the original value', async () => {
    const encoded = await hashPassword('correct-horse-battery');
    expect(encoded).not.toContain('correct-horse-battery');
    await expect(verifyPassword('correct-horse-battery', encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', encoded)).resolves.toBe(false);
  });

  it('uses project-scoped user hashes', () => {
    expect(hashUserId('project-a', 'user-1', 'secret')).not.toBe(hashUserId('project-b', 'user-1', 'secret'));
    expect(hashToken('token')).toHaveLength(64);
  });
});

