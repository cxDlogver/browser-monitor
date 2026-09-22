import type {
  PerformanceMetricName,
  PerformanceMetricRating,
  PerformanceNavigationType,
} from '@browser-monitor/protocol';

export interface WebVitalSignal {
  name: Extract<PerformanceMetricName, 'LCP' | 'FCP' | 'INP' | 'CLS'>;
  metricId: string;
  value: number;
  delta: number;
  rating: PerformanceMetricRating;
  navigationType: PerformanceNavigationType;
  navigationId: number;
  timestamp: number;
}

export interface LoAFSignal {
  timestamp: number;
  startTime: number;
  duration: number;
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scriptCount: number;
}

export interface FrameWindowSignal {
  timestamp: number;
  frameCount: number;
  sampleDurationMs: number;
}
