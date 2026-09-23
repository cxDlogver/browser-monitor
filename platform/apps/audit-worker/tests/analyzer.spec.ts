import { describe, expect, it } from 'vitest';

import { aggregateRuns, buildAnalysis, median } from '../src/analyzer.js';
import type { AuditRunRecord } from '../src/types.js';

function run(runNumber: number, performance: number, lcp: number): AuditRunRecord {
  return {
    runNumber,
    scores: { performance, seo: 90, accessibility: 92, bestPractices: 88 },
    metrics: { fcp: 1_200, lcp, cls: 0.08, tbt: 180, speedIndex: 1_500, tti: 2_000, serverResponseTime: 200, mainThreadWork: 900 },
    diagnostics: [],
    lighthouseVersion: '13.5.0',
    chromeVersion: 'Chrome',
    environment: {},
  };
}

describe('lab audit aggregation', () => {
  it('uses the median and picks the closest representative run', () => {
    const summary = aggregateRuns([run(1, 70, 3_000), run(2, 90, 2_000), run(3, 80, 2_500), run(4, 60, 3_500), run(5, 80, 2_400)]);
    expect(summary.scores.performance.median).toBe(80);
    expect(summary.metrics.lcp.minimum).toBe(2_000);
    expect([3, 5]).toContain(summary.representativeRun);
  });

  it('handles even and empty medians', () => {
    expect(median([4, 2])).toBe(3);
    expect(median([])).toBeNull();
  });

  it('creates prioritized Chinese recommendations', () => {
    const summary = aggregateRuns([run(1, 45, 4_500), run(2, 50, 4_200), run(3, 48, 4_300)]);
    const analysis = buildAnalysis(summary, []);
    expect(analysis.sections.map((section) => section.title)).toContain('内容加载');
    expect(analysis.recommendations[0]?.priority).toBe('P0');
  });
});
