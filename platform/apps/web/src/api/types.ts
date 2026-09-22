export interface User {
  id: string;
  email: string;
  displayName: string;
  csrfToken: string;
}

export interface ProjectSummary {
  id: string;
  displayName: string;
  appName: string;
  enabled: boolean;
  role: 'owner' | 'member';
}

export interface ProjectDetail extends ProjectSummary {
  keys: Array<{
    id: string;
    label: string;
    active: boolean;
    expiresAt: string | null;
    createdAt: string;
    dsn: string;
  }>;
  origins: string[];
  members: Array<{ id: string; email: string; displayName: string; role: 'owner' | 'member' }>;
  thresholds: { id: string | null; version: number; config: Record<string, unknown> };
}

export interface MetricSummary {
  name: string;
  count: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  goodCount: number;
  needsImprovementCount: number;
  poorCount: number;
  sessionCount: number;
  viewCount: number;
  sampleCoverage: number;
}

export interface Overview {
  views: number;
  sessions: number;
  events: number;
  metrics: MetricSummary[];
}

export interface PerformancePoint {
  bucket: string;
  name: string;
  count: number;
  average: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  goodCount: number;
  needsImprovementCount: number;
  poorCount: number;
  sessionCount: number;
  viewCount: number;
  sampleCoverage: number;
  blockingDurationTotal: number | null;
  scriptCount: number;
}
