import { contract, object } from './errors.js';
export function timestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
export function projectContract(value: unknown, detail = false, created = false): asserts value is Record<string, any> {
  contract(object(value) && typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id) &&
    typeof value.displayName === 'string' && typeof value.appName === 'string' &&
    ['owner', 'member'].includes(value.role) && (created || typeof value.enabled === 'boolean'), '项目响应缺少必要字段。');
  if (detail) {
    contract(Array.isArray(value.origins) && value.origins.every((v: unknown) => typeof v === 'string') && Array.isArray(value.keys), '项目详情缺少来源或密钥列表。');
    for (const key of value.keys) contract(object(key) && typeof key.id === 'string' && typeof key.active === 'boolean' &&
      (key.expiresAt === null || timestamp(key.expiresAt)) && typeof key.dsn === 'string', '接入密钥契约无效。');
  }
}
export function diagnostic(value: unknown): asserts value is Record<string, any> {
  contract(object(value) && timestamp(value.asOf) && value.source === 'database' &&
    object(value.event) && typeof value.event.eventId === 'string' &&
    object(value.raw) && ['present', 'missing'].includes(value.raw.recordState) &&
    object(value.processing) && ['committed', 'notObserved', 'unknown'].includes(value.processing.state) &&
    object(value.task) && ['present', 'missing'].includes(value.task.recordState) &&
    object(value.projection) && ['visible', 'missing', 'unknown'].includes(value.projection.visibility) &&
    object(value.history) && Array.isArray(value.history.limitations), '单事件诊断契约无效。');
  if (value.processing.state === 'committed') contract(timestamp(value.processing.processedAt), '处理提交缺少时间证据。');
  if (value.task.recordState === 'present') contract(['pending', 'processing', 'failed', 'completed'].includes(value.task.status), '未知任务状态。');
  if (value.task.status === 'completed') contract(timestamp(value.task.completedAt), '任务完成缺少时间证据。');
}
export function queueContract(value: unknown): asserts value is Record<string, any> {
  contract(object(value) && timestamp(value.asOf) && value.source === 'database', '队列响应缺少数据库快照时间。');
  for (const key of ['pendingTotal', 'readyPending', 'delayedPending', 'pendingUnclassified', 'processingTotal', 'processingActive', 'processingStale', 'processingUnclassified', 'failed', 'deadLetters', 'processedLastMinute']) {
    contract(Number.isSafeInteger(value[key]) && value[key] >= 0, '队列计数无效：' + key);
  }
  contract(value.pendingTotal === value.readyPending + value.delayedPending + value.pendingUnclassified &&
    value.processingTotal === value.processingActive + value.processingStale + value.processingUnclassified &&
    Number.isFinite(value.lockTimeoutSeconds) && value.lockTimeoutSeconds > 0 &&
    Array.isArray(value.recentFailures) && value.recentFailures.length <= value.recentFailuresLimit &&
    typeof value.recentFailuresHasMore === 'boolean', '队列分类或失败列表契约不一致。');
}
