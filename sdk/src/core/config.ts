/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：把「用户传入的、大量可选的 MonitorOptions」→「内部唯一可信的、字段全部有值的 NormalizedMonitorOptions」。
 *
 * 它是 SDK 唯一的「配置理解权威」，承担三件事：
 *   1. 补默认值：任何未提供的字段在这里落地成具体数值，下游无需关心「缺省」这件事；
 *   2. 校验合法性：必填项缺失、数值越界、URL 非法一律在此抛出，Fail Fast；
 *   3. 消除歧义：配置只在 Core 中解释一次，禁止 Collector / Transport 各自重新解读，
 *      否则同一个字段会在不同模块里产生不同语义，导致启停状态与发送策略不一致。
 *
 * 边界：本文件只做纯函数的类型收窄与数值校验，不读取任何运行时浏览器状态
 * （除 DSN 归一化时借用 location 作为相对地址基准），也不执行任何副作用。
 * ---------------------------------------------------------------------------
 */

import type { AppContextData, PerformanceMetricName } from '@browser-monitor/protocol';

/** 自定义属性中默认脱敏的键名。URL query 在进入协议前会被整体删除。 */
const DEFAULT_SENSITIVE_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'password',
  'secret',
  'api_key',
  'apikey',
];

/**
 * 宿主传入的公开配置。
 * 设计原则：除 app 与 transport 外全部可选且保持扁平，用户无需知道内部默认值；
 * 这里只描述「意图」（我想关掉 FPS、我想提高采样），不描述「实现阈值」。
 */
export interface MonitorOptions {
  app: AppContextData;
  view?: {
    /** Resolve a stable business route such as `user-detail` from a browser location snapshot. */
    resolveRouteName?: (location: RouteLocation) => string | undefined;
  };
  performance?: {
    enabled?: boolean;
    metrics?: Partial<Record<PerformanceMetricName, boolean>>;
    webVitals?: {
      reportAllChanges?: boolean;
      reportSoftNavs?: boolean;
    };
    fps?: {
      sampleWindowMs?: number;
      sampleIntervalMs?: number;
    };
    loaf?: {
      minDurationMs?: number;
      maxEntriesPerView?: number;
    };
  };
  processing?: {
    /** Custom-property keys whose values must be replaced before enqueueing. */
    sensitiveKeys?: readonly string[];
    excludeUrls?: readonly string[];
    dedupeWindowMs?: number;
    samplingRate?: number;
    rateLimit?: {
      maxEvents?: number;
      windowMs?: number;
    };
  };
  transport: {
    /** Public ingestion URL containing the project's non-secret write key. */
    dsn: string;
    headers?: Readonly<Record<string, string>>;
    batchSize?: number;
    maxBatchBytes?: number;
    flushIntervalMs?: number;
    maxQueueSize?: number;
    retry?: {
      maxAttempts?: number;
      baseDelayMs?: number;
    };
  };
}

/**
 * 内部流转的规范配置：所有字段必填、类型收敛（readonly 而非 undefined 联合）。
 * 下游模块拿到它可以直接读取，不必再写 `??` 兜底，也就无法自行解释默认值。
 * 这是「可选配置」与「确定行为」之间唯一的分界线。
 */
export interface NormalizedMonitorOptions {
  app: AppContextData;
  view: {
    resolveRouteName?: (location: RouteLocation) => string | undefined;
  };
  performance: {
    enabled: boolean;
    metrics: Record<PerformanceMetricName, boolean>;
    reportAllChanges: boolean;
    reportSoftNavs: boolean;
    fps: {
      sampleWindowMs: number;
      sampleIntervalMs: number;
    };
    loaf: {
      minDurationMs: number;
      maxEntriesPerView: number;
    };
  };
  processing: {
    sensitiveKeys: readonly string[];
    excludeUrls: readonly string[];
    dedupeWindowMs: number;
    samplingRate: number;
    rateLimit: {
      maxEvents: number;
      windowMs: number;
    };
  };
  transport: {
    dsn: string;
    headers: Readonly<Record<string, string>>;
    batchSize: number;
    maxBatchBytes: number;
    flushIntervalMs: number;
    maxQueueSize: number;
    retry: {
      maxAttempts: number;
      baseDelayMs: number;
    };
  };
}

/*
 * 以下是一组「窄口」校验原语，每个只认领一种数值语义。
 * 语义要分清：计数类必须为正数（positive），
 * 窗口/容量类允许为 0（nonNegative），比例类必须在 [0,1]（probability）。
 * 这样新增配置项时能直接复用，而不是到处写临时的 if。
 */

/** 必填字符串：去空白后仍为空即抛错，避免 '' 伪装成有效值。 */
function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(field + ' is required.');
  return normalized;
}

/** 正数校验：队列容量、批量阈值、重试次数等，0 或负数没有意义。 */
function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(field + ' must be greater than 0.');
  }
  return value;
}

/** 非负数校验：去重窗口、采样间隔等允许取 0（表示关闭等待）但不允许负值。 */
function nonNegative(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(field + ' must be non-negative.');
  }
  return value;
}

/** 概率校验：采样率必须为 [0,1] 区间内的有限数，越界直接失败而非静默截断。 */
function probability(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(field + ' must be between 0 and 1.');
  }
  return value;
}

/**
 * 统一端点格式：把「绝对 URL」或「相对路径」都归一化为绝对 URL 字符串。
 * 提前算好可以让 Transport 每次发送时省去重复解析，也保证重试、批处理使用的是同一结果。
 */
export interface RouteLocation {
  href: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

function normalizeDsn(input: string): string {
  const dsn = requiredText(input, 'transport.dsn');
  try {
    // 浏览器中允许传相对地址；非浏览器测试环境使用稳定基地址完成同样的校验。
    const base =
      typeof location !== 'undefined' && /^https?:/.test(location.href)
        ? location.href
        : 'http://localhost/';
    return new URL(dsn, base).toString();
  } catch {
    throw new Error('transport.dsn must be a valid absolute or relative URL.');
  }
}

/**
 * 归一化入口：SDK 启动时由 Core 调用一次，此后所有模块共享同一份快照。
 * 纯函数：相同输入必然产生相同输出，便于单测也便于复现线上问题。
 */
export function normalizeOptions(options: MonitorOptions): NormalizedMonitorOptions {
  // 配置错误必须在创建阶段暴露，不能等到安装监听器后再异步失败。
  if (!options || !options.app || !options.transport) {
    throw new Error('app and transport options are required.');
  }

  const metrics = options.performance?.metrics;
  // 指标默认开启，调用方只需显式关闭不需要的能力。
  const enabled = (name: PerformanceMetricName): boolean => metrics?.[name] !== false;

  return {
    // 冻结应用身份：它是每条上报数据的公共标注，不允许运行期被业务代码改写。
    app: Object.freeze({
      name: requiredText(options.app.name, 'app.name'),
      version: requiredText(options.app.version, 'app.version'),
      environment: requiredText(options.app.environment, 'app.environment'),
    }),
    view: {
      ...(options.view?.resolveRouteName
        ? { resolveRouteName: options.view.resolveRouteName }
        : {}),
    },
    performance: {
      enabled: options.performance?.enabled !== false,
      metrics: {
        LCP: enabled('LCP'),
        FCP: enabled('FCP'),
        INP: enabled('INP'),
        CLS: enabled('CLS'),
        FPS: enabled('FPS'),
        LoAF: enabled('LoAF'),
      },
      // 严格等于 true：布尔开关不做真值转换，避免传入字符串等意外值被当成开启。
      reportAllChanges: options.performance?.webVitals?.reportAllChanges === true,
      reportSoftNavs: options.performance?.webVitals?.reportSoftNavs === true,
      fps: {
        sampleWindowMs: positive(
          options.performance?.fps?.sampleWindowMs,
          5_000,
          'performance.fps.sampleWindowMs',
        ),
        sampleIntervalMs: nonNegative(
          options.performance?.fps?.sampleIntervalMs,
          30_000,
          'performance.fps.sampleIntervalMs',
        ),
      },
      loaf: {
        minDurationMs: nonNegative(
          options.performance?.loaf?.minDurationMs,
          50,
          'performance.loaf.minDurationMs',
        ),
        // 条数必须落在整数，浮点会让比较判断与循环边界变得不可预测。
        maxEntriesPerView: Math.floor(
          positive(
            options.performance?.loaf?.maxEntriesPerView,
            20,
            'performance.loaf.maxEntriesPerView',
          ),
        ),
      },
    },
    processing: {
      // 用户显式给出时用用户清单，否则退回内置默认清单（不合并，便于用户完全自担责任）。
      sensitiveKeys: options.processing?.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS,
      excludeUrls: options.processing?.excludeUrls ?? [],
      dedupeWindowMs: nonNegative(
        options.processing?.dedupeWindowMs,
        1_000,
        'processing.dedupeWindowMs',
      ),
      samplingRate: probability(options.processing?.samplingRate, 1, 'processing.samplingRate'),
      rateLimit: {
        maxEvents: Math.floor(
          positive(options.processing?.rateLimit?.maxEvents, 120, 'processing.rateLimit.maxEvents'),
        ),
        windowMs: positive(
          options.processing?.rateLimit?.windowMs,
          60_000,
          'processing.rateLimit.windowMs',
        ),
      },
    },
    transport: {
      dsn: normalizeDsn(options.transport.dsn),
      // 浅拷贝后冻结：既隔离宿主编突变，也防止 SDK 内部被意外改写。
      headers: Object.freeze({ ...options.transport.headers }),
      batchSize: Math.floor(positive(options.transport.batchSize, 20, 'transport.batchSize')),
      maxBatchBytes: Math.floor(
        positive(options.transport.maxBatchBytes, 64_000, 'transport.maxBatchBytes'),
      ),
      flushIntervalMs: positive(
        options.transport.flushIntervalMs,
        10_000,
        'transport.flushIntervalMs',
      ),
      maxQueueSize: Math.floor(
        positive(options.transport.maxQueueSize, 200, 'transport.maxQueueSize'),
      ),
      retry: {
        maxAttempts: Math.floor(
          positive(options.transport.retry?.maxAttempts, 3, 'transport.retry.maxAttempts'),
        ),
        baseDelayMs: positive(
          options.transport.retry?.baseDelayMs,
          500,
          'transport.retry.baseDelayMs',
        ),
      },
    },
  };
}
