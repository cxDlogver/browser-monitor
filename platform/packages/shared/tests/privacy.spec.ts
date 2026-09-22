import { describe, expect, it } from 'vitest';

import { redactProperties, sanitizeUrl } from '../src/privacy';

describe('server privacy boundary', () => {
  it('drops query strings and fragments', () => {
    expect(sanitizeUrl('https://example.test/users/1?token=secret#profile')).toBe(
      'https://example.test/users/1',
    );
  });

  it('redacts sensitive nested keys', () => {
    expect(redactProperties({ profile: { token: 'secret', role: 'buyer' } })).toEqual({
      profile: { token: '[REDACTED]', role: 'buyer' },
    });
  });

  it('enforces total field and byte budgets', () => {
    const tooManyFields = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`field-${index}`, index]));
    expect(Object.keys(redactProperties(tooManyFields) as Record<string, unknown>)).toHaveLength(100);
    // Each individual string is capped first; use two multibyte fields so the
    // sanitized object still crosses the aggregate UTF-8 byte budget.
    expect(
      redactProperties({ primary: '界'.repeat(4_096), secondary: '界'.repeat(4_096) }),
    ).toEqual({
      truncated: '[Payload exceeded 16 KiB]',
    });
  });
});
