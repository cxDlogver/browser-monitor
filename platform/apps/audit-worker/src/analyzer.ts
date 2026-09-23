import type {
  AuditDiagnostic,
  AuditMetrics,
  AuditPriority,
  AuditRating,
  AuditRunRecord,
  AuditScores,
} from './types.js';

interface Distribution {
  median: number | null;
  minimum: number | null;
  maximum: number | null;
  variation: number | null;
}

interface Recommendation {
  domain: string;
  metric: string;
  rating: AuditRating;
  priority: AuditPriority;
  evidence: string;
  impact: string;
  action: string;
  auditId: string | null;
}

const scoreKeys: Array<keyof AuditScores> = ['performance', 'seo', 'accessibility', 'bestPractices'];
const metricKeys: Array<keyof AuditMetrics> = ['fcp', 'lcp', 'cls', 'tbt', 'speedIndex', 'tti', 'serverResponseTime', 'mainThreadWork'];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function distribution(values: Array<number | null>): Distribution {
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const center = median(numbers);
  if (center === null) return { median: null, minimum: null, maximum: null, variation: null };
  const variance = numbers.reduce((sum, value) => sum + (value - center) ** 2, 0) / numbers.length;
  return {
    median: center,
    minimum: Math.min(...numbers),
    maximum: Math.max(...numbers),
    variation: Math.sqrt(variance),
  };
}

export function aggregateRuns(runs: AuditRunRecord[]) {
  if (runs.length === 0) throw new Error('At least one successful audit run is required.');
  const scores = Object.fromEntries(scoreKeys.map((key) => [key, distribution(runs.map((run) => run.scores[key]))])) as Record<keyof AuditScores, Distribution>;
  const metrics = Object.fromEntries(metricKeys.map((key) => [key, distribution(runs.map((run) => run.metrics[key]))])) as Record<keyof AuditMetrics, Distribution>;
  const performanceMedian = scores.performance.median ?? 0;
  const representative = [...runs].sort((left, right) =>
    Math.abs((left.scores.performance ?? 0) - performanceMedian)
      - Math.abs((right.scores.performance ?? 0) - performanceMedian))[0]!;
  return {
    successfulRuns: runs.length,
    scores,
    metrics,
    representativeRun: representative.runNumber,
  };
}

function rating(value: number | null, good: number, poor: number): AuditRating {
  if (value === null) return 'needs-improvement';
  if (value <= good) return 'good';
  return value > poor ? 'poor' : 'needs-improvement';
}

function scoreRating(value: number | null): AuditRating {
  if (value === null) return 'needs-improvement';
  if (value >= 90) return 'good';
  return value < 50 ? 'poor' : 'needs-improvement';
}

function priority(value: AuditRating): AuditPriority {
  return value === 'poor' ? 'P0' : value === 'needs-improvement' ? 'P1' : 'P2';
}

function metricRecommendation(
  domain: string,
  metric: string,
  value: number | null,
  unit: string,
  metricRating: AuditRating,
  impact: string,
  action: string,
): Recommendation {
  return {
    domain,
    metric,
    rating: metricRating,
    priority: priority(metricRating),
    evidence: value === null ? `${metric} 未采集到有效值` : `${metric} 中位数为 ${value.toFixed(metric === 'CLS' ? 3 : 0)}${unit}`,
    impact,
    action,
    auditId: null,
  };
}

export function buildAnalysis(summary: ReturnType<typeof aggregateRuns>, diagnostics: AuditDiagnostic[]) {
  const score = (name: keyof AuditScores) => (summary.scores[name] as Distribution).median;
  const metric = (name: keyof AuditMetrics) => (summary.metrics[name] as Distribution).median;
  const recommendations: Recommendation[] = [
    metricRecommendation('内容加载', 'LCP', metric('lcp'), 'ms', rating(metric('lcp'), 2_500, 4_000), '最大内容元素过晚出现会直接影响用户对页面速度的感受。', '优先压缩首屏图片、预加载关键资源、减少渲染阻塞 CSS，并缩短关键请求链。'),
    metricRecommendation('内容加载', 'FCP', metric('fcp'), 'ms', rating(metric('fcp'), 1_800, 3_000), '首次内容出现过慢会让用户长时间看到空白页面。', '优化服务端响应，内联关键 CSS，延迟非关键脚本并减少首屏资源体积。'),
    metricRecommendation('布局稳定', 'CLS', metric('cls'), '', rating(metric('cls'), 0.1, 0.25), '页面元素意外移动会导致误触和阅读中断。', '为图片、广告和异步组件预留尺寸，避免在已有内容上方动态插入元素。'),
    metricRecommendation('交互响应', 'TBT', metric('tbt'), 'ms', rating(metric('tbt'), 200, 600), '主线程长时间阻塞会延迟输入响应。', '拆分长任务、减少第三方脚本、按需加载 JavaScript，并把重计算迁移到 Web Worker。'),
  ];

  for (const item of diagnostics.slice(0, 12)) {
    const itemRating = item.score !== null && item.score < 0.5 ? 'poor' : 'needs-improvement';
    recommendations.push({
      domain: item.category === 'seo' ? 'SEO' : item.category === 'accessibility' ? '可访问性' : item.category === 'best-practices' ? '最佳实践' : '性能诊断',
      metric: item.title,
      rating: itemRating,
      priority: priority(itemRating),
      evidence: item.displayValue ?? item.description,
      impact: item.description,
      action: `按 Lighthouse 审计说明修复“${item.title}”，优先处理报告定位到的失败节点或资源。`,
      auditId: item.auditId,
    });
  }

  const ordered = recommendations.sort((left, right) => left.priority.localeCompare(right.priority));
  return {
    generatedBy: 'browser-monitor-rules-v1',
    sections: [
      { key: 'experience', title: '综合体验', rating: scoreRating(score('performance')), summary: `Performance 中位数为 ${score('performance')?.toFixed(0) ?? '—'}。` },
      { key: 'loading', title: '内容加载', rating: rating(metric('lcp'), 2_500, 4_000), summary: `FCP ${metric('fcp')?.toFixed(0) ?? '—'}ms，LCP ${metric('lcp')?.toFixed(0) ?? '—'}ms。` },
      { key: 'stability', title: '布局稳定', rating: rating(metric('cls'), 0.1, 0.25), summary: `CLS ${metric('cls')?.toFixed(3) ?? '—'}。` },
      { key: 'interaction', title: '交互响应', rating: rating(metric('tbt'), 200, 600), summary: `TBT ${metric('tbt')?.toFixed(0) ?? '—'}ms；该值是实验室交互代理指标。` },
      { key: 'seo', title: 'SEO', rating: scoreRating(score('seo')), summary: `SEO 中位分数为 ${score('seo')?.toFixed(0) ?? '—'}。` },
      { key: 'quality', title: '可访问性与最佳实践', rating: scoreRating(Math.min(score('accessibility') ?? 0, score('bestPractices') ?? 0)), summary: `Accessibility ${score('accessibility')?.toFixed(0) ?? '—'}，Best Practices ${score('bestPractices')?.toFixed(0) ?? '—'}。` },
    ],
    recommendations: ordered,
  };
}
