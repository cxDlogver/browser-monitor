import type { PerformanceMetricName, PerformanceMetricRating } from '@browser-monitor/protocol';

export interface MetricThreshold {
  direction: 'lower-is-better' | 'higher-is-better';
  good: number;
  poor: number;
}

export type RatedMetricName = Exclude<PerformanceMetricName, 'LoAF'>;
export type ThresholdSet = Readonly<Record<RatedMetricName, MetricThreshold>>;

export const DEFAULT_THRESHOLDS: ThresholdSet = Object.freeze({
  LCP: { direction: 'lower-is-better', good: 2_500, poor: 4_000 },
  INP: { direction: 'lower-is-better', good: 200, poor: 500 },
  CLS: { direction: 'lower-is-better', good: 0.1, poor: 0.25 },
  FCP: { direction: 'lower-is-better', good: 1_800, poor: 3_000 },
  FPS: { direction: 'higher-is-better', good: 50, poor: 30 },
});

export function rateMetric(
  metric: PerformanceMetricName,
  value: number,
  thresholds: ThresholdSet = DEFAULT_THRESHOLDS,
): PerformanceMetricRating | null {
  if (metric === 'LoAF') return null;
  const threshold = thresholds[metric];
  if (threshold.direction === 'lower-is-better') {
    if (value <= threshold.good) return 'good';
    if (value <= threshold.poor) return 'needs-improvement';
    return 'poor';
  }
  if (value >= threshold.good) return 'good';
  if (value >= threshold.poor) return 'needs-improvement';
  return 'poor';
}

export function mergeThresholds(
  overrides: Partial<Record<RatedMetricName, Partial<MetricThreshold>>>,
): ThresholdSet {
  const merged = {} as Record<RatedMetricName, MetricThreshold>;
  for (const metric of ['LCP', 'INP', 'CLS', 'FCP', 'FPS'] as const) {
    merged[metric] = { ...DEFAULT_THRESHOLDS[metric], ...overrides[metric] };
  }
  return merged;
}

