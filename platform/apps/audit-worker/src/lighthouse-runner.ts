import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';

import type { AuditDevice, AuditDiagnostic, AuditMetrics, AuditRunResult, AuditScores } from './types.js';

const metricAuditIds: Record<keyof AuditMetrics, string> = {
  fcp: 'first-contentful-paint',
  lcp: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbt: 'total-blocking-time',
  speedIndex: 'speed-index',
  tti: 'interactive',
  serverResponseTime: 'server-response-time',
  mainThreadWork: 'mainthread-work-breakdown',
};

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function runLighthouseAudit(
  url: string,
  device: AuditDevice,
  headers: Record<string, string>,
  chromePath: string,
): Promise<AuditRunResult> {
  const chrome = await launch({
    ...(chromePath ? { chromePath } : {}),
    chromeFlags: ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-sandbox'],
  });
  try {
    const desktop = device === 'desktop';
    const config = {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
        extraHeaders: headers,
        ...(desktop ? {
          formFactor: 'desktop' as const,
          screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
          throttling: {
            rttMs: 40,
            throughputKbps: 10_240,
            cpuSlowdownMultiplier: 1,
            requestLatencyMs: 0,
            downloadThroughputKbps: 0,
            uploadThroughputKbps: 0,
          },
        } : {}),
      },
    };
    const result = await lighthouse(url, { port: chrome.port, logLevel: 'error', output: 'json' }, config);
    if (!result) throw new Error('Lighthouse returned no result.');
    const lhr = result.lhr;
    if (lhr.runtimeError) {
      throw new Error(`Lighthouse navigation failed (${lhr.runtimeError.code}): ${lhr.runtimeError.message}`);
    }
    const category = (key: string) => numeric(lhr.categories[key]?.score) === null ? null : Math.round((lhr.categories[key]?.score ?? 0) * 100);
    const scores: AuditScores = {
      performance: category('performance'),
      seo: category('seo'),
      accessibility: category('accessibility'),
      bestPractices: category('best-practices'),
    };
    const metrics = Object.fromEntries(Object.entries(metricAuditIds).map(([key, auditId]) => [key, numeric(lhr.audits[auditId]?.numericValue)])) as unknown as AuditMetrics;
    const categoryByAudit = new Map<string, string>();
    for (const [category, value] of Object.entries(lhr.categories)) {
      for (const reference of value.auditRefs) categoryByAudit.set(reference.id, category);
    }
    const diagnostics: AuditDiagnostic[] = Object.values(lhr.audits)
      .filter((audit) => typeof audit.score === 'number' && audit.score < 0.9 && audit.scoreDisplayMode !== 'notApplicable')
      .map((audit) => {
        const details = audit.details as unknown as Record<string, unknown> | undefined;
        return {
          auditId: audit.id,
          category: categoryByAudit.get(audit.id) ?? 'diagnostic',
          title: audit.title,
          description: audit.description,
          score: numeric(audit.score),
          displayValue: audit.displayValue ?? null,
          savingsMs: numeric(details?.overallSavingsMs),
          savingsBytes: numeric(details?.overallSavingsBytes),
        };
      })
      .sort((left, right) => (left.score ?? 1) - (right.score ?? 1))
      .slice(0, 30);
    return {
      scores,
      metrics,
      diagnostics,
      lighthouseVersion: lhr.lighthouseVersion,
      chromeVersion: lhr.environment.hostUserAgent,
      environment: {
        device,
        benchmarkIndex: lhr.environment.benchmarkIndex,
        networkUserAgent: lhr.environment.networkUserAgent,
        formFactor: desktop ? 'desktop' : 'mobile',
        throttling: desktop ? 'desktop-standard' : 'mobile-simulated',
      },
    };
  } finally {
    await chrome.kill();
  }
}
