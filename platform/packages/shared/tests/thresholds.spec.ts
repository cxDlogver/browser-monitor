import { describe, expect, it } from 'vitest';

import { rateMetric } from '../src/thresholds';

describe('server metric ratings', () => {
  it('uses inclusive Web Vital boundaries', () => {
    expect(rateMetric('LCP', 2_500)).toBe('good');
    expect(rateMetric('LCP', 4_000)).toBe('needs-improvement');
    expect(rateMetric('LCP', 4_001)).toBe('poor');
  });

  it('reverses the comparison for FPS and leaves LoAF diagnostic-only', () => {
    expect(rateMetric('FPS', 50)).toBe('good');
    expect(rateMetric('FPS', 30)).toBe('needs-improvement');
    expect(rateMetric('FPS', 29)).toBe('poor');
    expect(rateMetric('LoAF', 100)).toBeNull();
  });
});

