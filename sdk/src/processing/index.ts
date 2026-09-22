/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：装配加工管道 —— 把七个阶段按固定顺序组合起来，并对外只暴露一个工厂函数。
 *
 * 顺序不可随意调整，整体分三组：
 *   第一组「修正与校验」：normalize → validate（把格式整理好，再判断结构是否合法）
 *   第二组「安全与排除」：redact → filter（脱敏、排除不关心的页面）
 *   第三组「流量控制」  ：dedupe → sampling → rate-limit（去重复、做抽样、控上限）
 *
 * 之所以把流量控制放在最后：先剔除无效与重复数据，让限流的额度只被「真正该发的数据」消耗。
 * ---------------------------------------------------------------------------
 */

import type { NormalizedMonitorOptions } from '../core/config';

import { DedupeStage } from './dedupe';
import { FilterStage } from './filter';
import { NormalizeStage } from './normalize';
import { ProcessingPipeline } from './pipeline';
import { RateLimitStage } from './rate-limit';
import { RedactStage } from './redact';
import { SamplingStage } from './sampling';
import { ValidateStage } from './validate';

/**
 * 创建加工管道。配置来自归一化后的 options，各阶段不再自行兜底默认值。
 * 这是整个 SDK 唯一的加工入口，任何数据都必须经过它才能进入发送队列。
 */
export function createProcessingPipeline(
  options: NormalizedMonitorOptions['processing'],
): ProcessingPipeline {
  // 顺序不可随意调整：先修正和校验结构，再脱敏/过滤，最后执行流量控制。
  return new ProcessingPipeline([
    new NormalizeStage(),
    new ValidateStage(),
    new RedactStage(options.sensitiveKeys),
    new FilterStage(options.excludeUrls),
    new DedupeStage(options.dedupeWindowMs),
    new SamplingStage(options.samplingRate),
    new RateLimitStage(options.rateLimit.maxEvents, options.rateLimit.windowMs),
  ]);
}

export { ProcessingPipeline, type ProcessingStage } from './pipeline';
