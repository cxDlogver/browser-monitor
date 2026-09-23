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

export type LabAuditStatus = 'queued' | 'running' | 'completed' | 'failed';
export type LabAuditDevice = 'mobile' | 'desktop';

export interface LabDistribution {
  median: number | null;
  minimum: number | null;
  maximum: number | null;
  variation: number | null;
}

export interface LabAuditSummaryData {
  successfulRuns: number;
  representativeRun: number;
  scores: Record<'performance' | 'seo' | 'accessibility' | 'bestPractices', LabDistribution>;
  metrics: Record<'fcp' | 'lcp' | 'cls' | 'tbt' | 'speedIndex' | 'tti' | 'serverResponseTime' | 'mainThreadWork', LabDistribution>;
}

export interface LabAuditAnalysis {
  generatedBy: string;
  sections: Array<{ key: string; title: string; rating: 'good' | 'needs-improvement' | 'poor'; summary: string }>;
  recommendations: Array<{
    domain: string;
    metric: string;
    rating: 'good' | 'needs-improvement' | 'poor';
    priority: 'P0' | 'P1' | 'P2';
    evidence: string;
    impact: string;
    action: string;
    auditId: string | null;
  }>;
}

export interface LabAudit {
  id: string;
  projectId: string;
  targetUrl: string;
  device: LabAuditDevice;
  status: LabAuditStatus;
  requestedRuns: number;
  completedRuns: number;
  successfulRuns: number;
  lighthouseVersion: string | null;
  chromeVersion: string | null;
  environment: Record<string, unknown>;
  summary: LabAuditSummaryData | null;
  analysis: LabAuditAnalysis | null;
  warning: string | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LabAuditDetail extends LabAudit {
  runs: Array<{
    id: string;
    runNumber: number;
    status: 'completed' | 'failed';
    scores: Record<string, number | null> | null;
    metrics: Record<string, number | null> | null;
    diagnostics: Array<Record<string, unknown>> | null;
    error: string | null;
    durationMs: number | null;
    createdAt: string;
  }>;
}
