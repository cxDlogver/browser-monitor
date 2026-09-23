export type AuditDevice = 'mobile' | 'desktop';
export type AuditRating = 'good' | 'needs-improvement' | 'poor';
export type AuditPriority = 'P0' | 'P1' | 'P2';

export interface AuditScores {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
}

export interface AuditMetrics {
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  speedIndex: number | null;
  tti: number | null;
  serverResponseTime: number | null;
  mainThreadWork: number | null;
}

export interface AuditDiagnostic {
  auditId: string;
  category: string;
  title: string;
  description: string;
  score: number | null;
  displayValue: string | null;
  savingsMs: number | null;
  savingsBytes: number | null;
}

export interface AuditRunResult {
  scores: AuditScores;
  metrics: AuditMetrics;
  diagnostics: AuditDiagnostic[];
  lighthouseVersion: string;
  chromeVersion: string;
  environment: Record<string, unknown>;
}

export interface AuditRunRecord extends AuditRunResult {
  runNumber: number;
}
