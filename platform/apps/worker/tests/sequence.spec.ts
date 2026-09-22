import { describe, expect, it } from 'vitest';

import { shouldApplySequence } from '../src/sequence.js';

describe('performance sample sequence', () => {
  it('accepts the first and strictly newer revisions only', () => {
    expect(shouldApplySequence(null, 0)).toBe(true);
    expect(shouldApplySequence(3, 4)).toBe(true);
    expect(shouldApplySequence(3, 3)).toBe(false);
    expect(shouldApplySequence(3, 2)).toBe(false);
  });
});

