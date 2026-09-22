# 04 · Processing：七阶段加工链路

> 本文承接 [03 · Collector 与信封组装](./03-Collector与信封组装.md)。
> `MonitorPipeline.emit()` 把领域草稿补齐成完整信封后，信封会立刻走进本文所讲的**七道加工关卡**。
> 本文按「作用 → 解决什么问题 → 判定逻辑 → 注意点」逐个讲清每个阶段，并配一个**贯穿全文的完整实例**，逐阶段展示数据形态的变化。

---

## 一、定位与契约

```text
Collector ──emit(draft)──> MonitorPipeline ──> Processing（本文） ──> Transport
                                  │                   │
                            补齐成 Envelope      七道关卡：修正 / 校验 / 脱敏
                                                 / 排除 / 去重 / 采样 / 限流
```

Processing 是整个 SDK 里**唯一有权决定「这条数据发不发」**的地方。它保证无论数据来自哪种采集器，都必然经过同一套治理规则 —— 不存在绕过它的出口。

契约只有三个元素：

```ts
// src/processing/pipeline.ts
export interface ProcessingStage {
  readonly name: string;
  process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined;
}
```

| 返回值              | 含义                                       |
| ------------------- | ------------------------------------------ |
| `TelemetryEnvelope` | 通过，交给下一阶段                         |
| `undefined`         | **丢弃**，整条链路短路，不会进入 Transport |

---

## 二、执行器：严格串行的管道

```ts
// src/processing/pipeline.ts（第 8–27 行）
process(input: TelemetryEnvelope): TelemetryEnvelope | undefined {
  let current: TelemetryEnvelope | undefined = input;

  for (const stage of this.stages) {
    if (!current) return undefined;          // 上一阶段丢弃 → 立即短路
    try {
      current = stage.process(current);      // 前一阶段的输出 = 后一阶段的输入
    } catch {
      return undefined;                      // 任一阶段抛错 → 丢弃该条
    }
  }

  return current;
}
```

两条铁律：**顺序即规范**（不能随意调换）；**错误不外溢**（宁可少报一条，也绝不把异常抛回业务调用栈）。

---

## 三、装配顺序

```ts
// src/processing/index.ts（第 12–25 行）
return new ProcessingPipeline([
  new NormalizeStage(), // ① 修正
  new ValidateStage(), // ② 校验
  new RedactStage(options.sensitiveKeys), // ③ 脱敏
  new FilterStage(options.excludeUrls), // ④ 排除
  new DedupeStage(options.dedupeWindowMs), // ⑤ 去重
  new SamplingStage(options.samplingRate), // ⑥ 采样
  new RateLimitStage(options.rateLimit.maxEvents, options.rateLimit.windowMs), // ⑦ 限流
]);
```

| 顺序 | 阶段         | 类别 | 会不会丢数据 | 有没有状态       |
| ---- | ------------ | ---- | ------------ | ---------------- |
| ①    | `normalize`  | 修正 | 否           | 否               |
| ②    | `validate`   | 校验 | 是           | 否               |
| ③    | `redact`     | 安全 | 否           | 否               |
| ④    | `filter`     | 排除 | 是           | 否               |
| ⑤    | `dedupe`     | 流量 | 是           | 是（`seen` Map） |
| ⑥    | `sampling`   | 流量 | 是           | 否（确定性）     |
| ⑦    | `rate-limit` | 流量 | 是           | 是（窗口计数）   |

**顺序为什么不能换**：

| 约束               | 反例后果                                        |
| ------------------ | ----------------------------------------------- |
| 修正 → 校验        | 先校验会误杀「内容正确但格式脏」的数据          |
| 校验 → 后续        | 无效数据晚丢弃，白白消耗后续算力                |
| 脱敏 → 排除        | 排除规则里可能出现敏感串，且匹配的是未脱敏 URL  |
| 排除 → 去重        | 先算指纹（`JSON.stringify` 有成本）再排除，浪费 |
| 去重 → 采样 → 限流 | 限流额度会被重复数据和抽样外的数据白白消耗      |

---

## 四、贯穿全文的实例

为了把七个阶段讲透，下面全程跟踪**同一条业务埋点数据**。

业务代码：

```ts
monitor.track('checkout.submit', {
  orderId: 'o-88',
  amount: 199.9,
  token: 'eyJhbGciOi...', // ← 敏感
  coupon: { code: 'SAVE', password: 'pw123' }, // ← 敏感（嵌套）
  items: [
    /* 60 个商品 */
  ], // ← 超长数组
});
```

SDK 配置：

```ts
createMonitor({
  app: { name: 'shop-web', version: '2.3.1', environment: 'prod' },
  transport: { dsn: 'https://monitor.example.com/api/v2/ingest/bm_pk_xxx/envelopes' },
  processing: {
    excludeUrls: ['/internal', 'health'],
    dedupeWindowMs: 1000,
    samplingRate: 0.3,
    rateLimit: { maxEvents: 120, windowMs: 60_000 },
  },
});
```

### 进入 Processing 之前的信封（emit 补齐后的产物）

```ts
{
  protocolVersion: '2.0',
  eventId: 'event_a1b2',
  type: 'event',
  name: 'checkout.submit',
  occurredAt: 1712345678901.62,                // 浮点
  app: { name: 'shop-web', version: '2.3.1', environment: 'prod' },
  context: {
    sessionId: 'sess_x9',
    viewId: 'view_07',
    url: 'https://shop.com/checkout?token=eyJhbGciOi...&step=2#pay',   // 含敏感参数
    runtime: { userAgent: 'Mozilla/5.0 ...', language: 'zh-CN', online: true,
               sdk: { name: 'cx-browser-monitor-sdk', version: '0.2.0' } },
  },
  correlation: {},
  payload: {
    type: 'event',
    name: 'checkout.submit',
    source: 'custom',
    properties: {
      orderId: 'o-88',
      amount: 199.9,
      token: 'eyJhbGciOi...',
      coupon: { code: 'SAVE', password: 'pw123' },
      items: [ /* 60 项 */ ],
    },
  },
}
```

---

## 五、七个阶段逐个讲透

### 5.1 ① NormalizeStage —— 把格式整理干净

**作用**：只做修正，不做取舍。

**解决什么问题**：上游 Collector 交来的数据可能带有格式噪声（名字首尾空格、浮点时间戳、URL 残留敏感参数）。若直接校验，这些「内容正确但格式脏」的数据会被误杀。

**判定逻辑**：

```ts
// src/processing/normalize/index.ts
process(envelope: TelemetryEnvelope): TelemetryEnvelope {
  return {
    ...envelope,
    name: envelope.name.trim(),                                        // 去首尾空白
    occurredAt: Math.round(envelope.occurredAt),                        // 收敛为整数毫秒
    context: {
      ...envelope.context,
      url: sanitizeUrl(envelope.context.url),  // URL 再移除 query 与 fragment
    },
  };
}
```

**本例的结果**：

| 字段          | 进入前                                       | 出来后                                               |
| ------------- | -------------------------------------------- | ---------------------------------------------------- |
| `name`        | `'checkout.submit'`                          | `'checkout.submit'`（本例已干净；trim 是防御性兜底） |
| `occurredAt`  | `1712345678901.62`                           | `1712345678902`                                      |
| `context.url` | `...checkout?token=eyJhbGciOi...&step=2#pay` | `https://shop.com/checkout`                          |

**注意点**：

- **从不返回 `undefined`** —— 修格式不决定该不该发；
- 协议 2.0 的 `sanitizeUrl` 会**一律移除 query 与 fragment**，同时避免动态参数造成高基数；解析失败时也会从第一个 `?` 或 `#` 截断。

---

### 5.2 ② ValidateStage —— 拦掉不完整的数据

**作用**：校验信封结构，宁缺毋滥。

**解决什么问题**：结构不完整的数据（缺 sessionId、时间戳非法、指标单位不合法）到了服务端无法分析，只会污染数据集。

**判定逻辑**：

```ts
// src/processing/validate/index.ts（第 16–34 行）
process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
  if (
    envelope.protocolVersion !== '2.0' ||   // 协议版本必须是 2.0
    !envelope.eventId ||                    // 必须有事件 ID
    !envelope.name ||                       // 必须有事件名
    !Number.isFinite(envelope.occurredAt) || // 时间必须是有限数
    envelope.occurredAt < 0 ||               // 时间不能为负
    !envelope.context.sessionId ||          // 必须有会话
    !envelope.context.viewId                // 必须有 View
  ) {
    return undefined;
  }

  // 领域层：只有性能类有额外约束
  if (envelope.payload.type === 'performance' && !isValidPerformance(envelope.payload)) {
    return undefined;
  }

  return envelope;
}
```

```ts
function isValidPerformance(payload: PerformancePayload): boolean {
  return (
    Number.isFinite(payload.value) &&
    payload.value >= 0 &&
    (payload.unit === 'ms' || payload.unit === 'score' || payload.unit === 'fps')
  );
}
```

**本例的结果**：全部字段齐备，且 payload 是 `event` 类型（不走性能校验）→ **通过**。

**注意点**：

- 校验分两层：**公共层**（信封必须完整）+ **领域层**（性能指标必须合法）；
- 「上下文缺失一律不发」是硬规则 —— `sessionId` 或 `viewId` 为空的数据没有任何分析价值；
- 这条阶段返回 `undefined` **通常是 bug 信号**（上游产生了脏数据），与其他阶段的「预期内丢弃」不同。

---

### 5.3 ③ RedactStage —— 敏感数据不出浏览器

**作用**：脱敏，且只在该脱敏的地方脱敏。

**解决什么问题**：业务自定义事件的 `properties` 可能含任意用户数据（令牌、密码、身份证）。这类数据一旦发出去就是安全事故。

**判定逻辑**：

```ts
// src/processing/redact/index.ts（第 9–28 行）
function redactValue(value: unknown, sensitiveKeys: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]'; // 深度截断
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, sensitiveKeys, depth + 1)); // 长度截断
  }
  if (!isRecord(value)) return value; // 基本类型原样返回

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = sensitiveKeys.has(key.toLowerCase()) // 键名匹配忽略大小写
      ? REDACTED // 命中即整值替换
      : redactValue(nested, sensitiveKeys, depth + 1); // 否则继续下钻
  }
  return result;
}
```

```ts
// src/processing/redact/index.ts（第 38–56 行）
process(envelope: TelemetryEnvelope): TelemetryEnvelope {
  let payload = envelope.payload;
  // 只有业务自定义事件带任意属性，结构化 payload 字段固定，无需递归
  if (payload.type === 'event' && payload.properties) {
    payload = { ...payload, properties: redactValue(payload.properties, this.keys) };
  }

  return {
    ...envelope,
    context: {
      ...envelope.context,
      url: sanitizeUrl(envelope.context.url),   // 纵深防护
    },
    payload,
  };
}
```

**本例的结果**：

| 位置                         | 进入前            | 出来后                       |
| ---------------------------- | ----------------- | ---------------------------- |
| `properties.token`           | `'eyJhbGciOi...'` | `'[REDACTED]'`               |
| `properties.orderId`         | `'o-88'`          | `'o-88'`（键名不敏感，保留） |
| `properties.amount`          | `199.9`           | `199.9`（基本类型原样）      |
| `properties.coupon.code`     | `'SAVE'`          | `'SAVE'`                     |
| `properties.coupon.password` | `'pw123'`         | `'[REDACTED]'`（嵌套也命中） |
| `properties.items`           | 60 项             | 前 50 项                     |
| `context.url`                | 已脱敏            | 再脱敏一次（幂等）           |

**注意点**：

- **只递归处理 `event.properties`** —— 这是唯一可能含任意用户数据的地方；性能/View 等结构化 payload 字段固定，递归遍历纯属浪费；
- **键名匹配忽略大小写**（`Token`、`TOKEN`、`token` 都会命中），命中即**整值替换**，不是部分打码；
- **体积防护**：深度 > 5 → `[TRUNCATED]`、数组 > 50 → 截断，防止业务传入巨型对象撑爆监控事件；
- **URL 二次脱敏**是纵深防护（Context 创建时、normalize 时已各处理一次）。

---

### 5.4 ④ FilterStage —— 排除不关心的页面

**作用**：按 URL 子串排除数据。

**解决什么问题**：内部后台、健康检查页、埋点自校验页不应进入监控数据集，否则会稀释真实用户数据。

**判定逻辑**：

```ts
// src/processing/filter/index.ts
process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
  return this.excludedUrlParts.some((part) => envelope.context.url.includes(part))
    ? undefined
    : envelope;
}
```

**本例的结果**：配置 `['/internal', 'health']`，当前 URL 是 `https://shop.com/checkout?...`，两个子串都不包含 → **通过**。

若用户此时在 `https://shop.com/internal/debug`，URL 含 `/internal` → **丢弃**。

**注意点**：

- 匹配的是**已脱敏后的 URL**（redact 在前），排除规则本身不会碰到敏感串；
- 是子串包含而非完整匹配，配置过短的串（如 `'a'`）会误伤大量数据。

---

### 5.5 ⑤ DedupeStage —— 窗口内抑制重复

**作用**：短时间内完全相同的数据只留一条。

**解决什么问题**：重复触发的同一事实（抖动的长任务、重复包装的 API、重发的埋点）会造成刷屏，浪费配额并污染统计。

**判定逻辑**：

```ts
// src/processing/dedupe/index.ts（第 5–41 行）
// occurredAt 和 eventId 不参与指纹；同一 View 内语义与 payload 完全相同才视为重复。
function fingerprint(envelope: TelemetryEnvelope): string {
  return JSON.stringify([
    envelope.type,
    envelope.name,
    envelope.context.sessionId,
    envelope.context.viewId,
    envelope.correlation,
    envelope.payload,
  ]);
}

process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
  if (this.windowMs === 0) return envelope;              // 窗口为 0 = 关闭去重

  const key = fingerprint(envelope);
  const previous = this.seen.get(key);                   // 上次出现时间
  this.seen.set(key, envelope.occurredAt);               // 记录本次
  this.prune(envelope.occurredAt);                       // 顺带清理过期项

  return previous !== undefined && envelope.occurredAt - previous <= this.windowMs
    ? undefined                                          // 窗口内重复 → 丢弃
    : envelope;
}
```

**本例的结果**：本条数据的指纹是

```text
["event","checkout.submit","sess_x9","view_07",{},
 {"type":"event","name":"checkout.submit","source":"custom",
  "properties":{...脱敏后的内容...}}]
```

`seen` 里没有这个 key → 记入 `seen`，**通过**。

若业务代码在 800ms 后又 `track` 了一次完全相同的事件（`dedupeWindowMs = 1000`）：

```text
previous = 1712345678902
本次      = 1712345679702
差值 800ms ≤ 1000ms 且指纹相同 → 丢弃
```

**注意点**：

- 指纹**不含 `timestamp` / `eventId`** —— 否则每条都独一无二，去重永远不生效；
- 指纹**含 `sessionId` + `viewId`** —— 只在「同一次会话、同一页面」内判重，不同页面上的相同指标各自保留；
- `prune` 只在 `seen.size ≥ 500` 时才扫描清理，把 O(n) 成本摊薄；
- `windowMs = 0` 表示关闭去重。

---

### 5.6 ⑥ SamplingStage —— 稳定抽样

**作用**：按比例抽样，且必须是**稳定抽样**。

**解决什么问题**：全量上报成本过高时需要降采样。但如果用 `Math.random()`，同一次访问里会出现碎片数据（有 `view.start` 却没有 `view.end`、有请求却没有结果），服务端根本无法还原链路。

**判定逻辑**：

```ts
// src/processing/sampling/index.ts
function stableRatio(input: string): number {
  let hash = 2166136261;                          // FNV-1a 32 位
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;               // 归一化到 [0,1]
}

process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
  if (this.rate >= 1) return envelope;            // 全采
  if (this.rate <= 0) return undefined;           // 全不采

  const key = [envelope.context.sessionId, envelope.type, envelope.name].join(':');
  return stableRatio(key) < this.rate ? envelope : undefined;
}
```

**本例的结果**：配置 `samplingRate = 0.3`。

```text
key  = 'sess_x9:event:checkout.submit'
ratio = stableRatio(key) ≈ 0.62（示意值）
0.62 < 0.3 ? 否 → 丢弃
```

**关键推论**：因为 key 里没有 `eventId`、没有 `timestamp`，所以本次会话里**所有** `checkout.submit` 事件都得到同一个判定结果 —— 要么全采、要么全不采。假设另一类事件的 key `'sess_x9:view:view.start'` 哈希出 0.12 < 0.3，则本次会话的 view 数据全采。于是服务端拿到的虽然是 30% 的会话，但**每个被采样到的会话内部数据是完整的**。

**注意点**：

- 采样键是 `sessionId:type:name`，决定了「稳定的最小粒度」是「一次会话里的一种事件」；
- `rate ≥ 1` 时直接短路返回，不做哈希计算；
- 采样与限流都在最后，保证额度只被「真正该发的数据」消耗。

---

### 5.7 ⑦ RateLimitStage —— 最后一道闸门

**作用**：限制单位时间内的事件数量，SDK 的自我保护底线。

**解决什么问题**：异常循环、死循环埋点、页面疯狂报错时，若不设上限，SDK 自己会把用户的网络与服务端打垮。

**判定逻辑**：

```ts
// src/processing/rate-limit/index.ts
process(envelope: TelemetryEnvelope): TelemetryEnvelope | undefined {
  if (
    this.windowStartedAt === 0 ||                                  // 首次
    envelope.occurredAt < this.windowStartedAt ||                  // 时间倒流兜底
    envelope.occurredAt - this.windowStartedAt >= this.windowMs    // 超出当前窗口
  ) {
    this.windowStartedAt = envelope.occurredAt;                    // 开启新窗口
    this.count = 0;
  }

  if (this.count >= this.maxEvents) return undefined;              // 额度用尽 → 丢弃
  this.count += 1;
  return envelope;
}
```

**本例的结果**：配置 `maxEvents = 120`、`windowMs = 60000`，假设当前窗口从 `1712345640000` 开始、已用 118 条。

```text
1712345678902 - 1712345640000 = 38902ms < 60000ms  → 仍在当前窗口
count = 118 < 120  → 通过，count 变为 119
```

窗口内第 121 条及之后的数据会被丢弃，直到 `timestamp - windowStartedAt ≥ 60000` 开启新窗口。

**窗口是怎么滚动的**（`maxEvents = 120`、`windowMs = 60000`，时间单位 ms）：

| 到达的数据                        | `ts - windowStartedAt`            | 动作                     | `count` 变化 | 结果     |
| --------------------------------- | --------------------------------- | ------------------------ | ------------ | -------- |
| 第 1 条 `ts=1000000`              | `windowStartedAt` 还是 0 → 开窗口 | `start=1000000, count=0` | 0 → 1        | 放行     |
| 第 2～120 条 `ts=1000000~1004000` | `< 60000`，仍在窗口               | 不开新窗口               | 1 → 120      | 放行     |
| 第 121 条 `ts=1004100`            | `4100 < 60000`，仍在窗口          | 不开新窗口               | 120 ≥ 120    | **丢弃** |
| 第 122 条 …                       | 仍在窗口                          | 不开新窗口               | 120 ≥ 120    | **丢弃** |
| 某条 `ts=1060000`                 | `60000 ≥ 60000` → 开新窗口        | `start=1060000, count=0` | 0 → 1        | 放行     |

要点：**窗口不是定时器驱动的，而是「下一条数据到来时才检查是否该开新窗口」**；额度耗尽后，窗口内剩余的所有数据全部丢弃，直到出现一条时间上超出窗口的数据把窗口顶开。

**注意点**：

- 窗口按 **`envelope.occurredAt`（数据发生时间）** 划分，而不是 `Date.now()` —— 数据可能延迟处理（批处理、队列积压），用处理时间会把「同一分钟内产生的数据」切进不同窗口；
- `timestamp < windowStartedAt` 分支是**时间倒流兜底**（时钟回拨、手工构造数据）。少了它，`ts - start` 会一直是负数，`>= windowMs` 永不成立，窗口永不复位 → **计数永久卡在上限、之后所有数据都被拒**，即「死窗口」；
- `maxEvents` 是「每个窗口内的放行条数上限」，不是「每秒速率」；
- 它是最后一道闸门，前面六关通过的数据才会计入额度。

### 5.7.1 它到底防住了什么

异常场景长这样：

```text
渲染循环里抛错 → Error Collector 每帧 emit 一次 → 每秒上千条
或：业务把 track() 写进了死循环 / 状态更新里 → 每毫秒一条
```

如果不设上限，会发生三件事，而且**都是 SDK 自己造成的**：

1. **内存**：发送队列无上限增长，页面越跑越卡直至崩溃；
2. **网络**：成百上千个请求打向采集端点，把用户带宽和公司服务端一起拖垮；
3. **递归放大**：最坏的情况是「监控本身触发了新的监控数据」，形成正反馈。

限流把这三者一次性掐断：**无论上游产生多快，进入发送队列的速率被硬性锁死在「每窗口 maxEvents 条」**，默认即 120 条 / 60 秒。第 121 条及之后的数据在 Pipeline 里就被丢弃，连队列都进不去。

还要强调一个容易被忽略的点：**丢弃必须是静默的**。限流阶段不能因为「丢了一条数据」再去 emit 一条事件，否则丢弃行为本身又产生数据，形成新的循环。

### 5.7.2 为什么是「计数 + 固定窗口」而不是别的算法

| 方案                       | 做法                             | 为什么没采用                                                           |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| **滑动窗口日志**           | 保存每条数据的时间戳数组         | 突发时数组会涨到和突发量一样大 —— 恰恰在「最需要保护的时候」吃最多内存 |
| **令牌桶 + 定时器**        | `setInterval` 定期补令牌         | 需要常驻定时器：页面永远有个后台任务在跑，且要小心清理，否则泄漏       |
| **固定窗口计数（本实现）** | 只记 `windowStartedAt` + `count` | **O(1) 时间、O(1) 内存、零定时器**，窗口由数据自己顶开                 |

这套取舍的出发点只有一个：**监控 SDK 跑在别人的页面里，它必须保证自己永远不会成为性能问题的来源**。因此宁可要一个「粗糙但零成本」的限流，也不要一个「精确但有内存/定时器开销」的限流。

**已知代价**：固定窗口在边界处会放行至多 2 倍额度（窗口 N 末尾 120 条 + 窗口 N+1 开头 120 条）。这是可接受的 —— 客户端限流的目标是**兜住成本**，精确限流交给服务端做。

另外，窗口锚定在「第一条数据的时间」上，而不是对齐到自然时钟（不是 00:00–01:00 这种），因为判定条件是 `ts - windowStartedAt >= windowMs` 且 `windowStartedAt` 会被重置为该条数据的时间。

---

## 六、实例总览：这条数据经历了什么

| 阶段         | 关键动作                                                    | 本例结果             |
| ------------ | ----------------------------------------------------------- | -------------------- |
| ① normalize  | `timestamp` 取整、URL 脱敏去 hash                           | 通过，数据被整理     |
| ② validate   | 公共字段 + 领域校验                                         | 通过                 |
| ③ redact     | `token` / `password` → `[REDACTED]`、数组截 50              | 通过，敏感数据被清除 |
| ④ filter     | URL 不含 `/internal`、`health`                              | 通过                 |
| ⑤ dedupe     | 指纹首次出现 → 记入 `seen`                                  | 通过                 |
| ⑥ sampling   | `stableRatio('sess_x9:event:checkout.submit') ≈ 0.62 ≥ 0.3` | **丢弃**             |
| ⑦ rate-limit | （未执行，已在第 ⑥ 关短路）                                 | —                    |

数据最终没有进入发送队列 —— 但这**不是异常**，而是采样策略的预期结果。若把 `samplingRate` 调成 `1`，同一条数据会走完第 ⑦ 关并被 `enqueue`。

### 另一个视角：三种「被丢弃」

```text
情况 A：800ms 后重复 track 同一事件
   → ⑤ dedupe 命中相同指纹 → 丢弃（预期内的抑制）

情况 B：samplingRate = 0.3，本会话 checkout.submit 未命中
   → ⑥ sampling 丢弃（预期内的抽样）

情况 C：页面死循环疯狂埋点，本窗口已发 120 条
   → ⑦ rate-limit 丢弃（预期内的保护）

情况 D：某条数据 context.viewId 为空
   → ② validate 丢弃（这是 bug，需要修上游）
```

---

## 七、配置来源对照

| 阶段         | 配置项                           | 默认值      | 校验                 |
| ------------ | -------------------------------- | ----------- | -------------------- |
| `normalize`  | 无                               | —           | —                    |
| `validate`   | —（无配置）                      | —           | —                    |
| `redact`     | `processing.sensitiveKeys`       | 内置 8 个键 | —                    |
| `filter`     | `processing.excludeUrls`         | `[]`        | —                    |
| `dedupe`     | `processing.dedupeWindowMs`      | `1000`      | `nonNegative`        |
| `sampling`   | `processing.samplingRate`        | `1`         | `probability`（0–1） |
| `rate-limit` | `processing.rateLimit.maxEvents` | `120`       | `positive` + 取整    |
| `rate-limit` | `processing.rateLimit.windowMs`  | `60000`     | `positive`           |

**配置只在 Core 解释一次**，各阶段拿到的都是已校验的确定值，不再自行兜底。

---

## 八、设计要点小结

| 要点       | 说明                                                      |
| ---------- | --------------------------------------------------------- |
| 唯一出口   | 所有数据都必须经过这条管道，不存在绕过路径                |
| 顺序即规范 | 修正 → 校验 → 脱敏 → 排除 → 去重 → 采样 → 限流            |
| 错误不外溢 | 任一阶段抛错即丢弃该条，绝不传播到业务调用栈              |
| 稳定采样   | 按 `sessionId:类型:名称` 哈希，保住单次访问内的数据完整性 |
| 纵深脱敏   | URL 三处处理 + 业务属性递归脱敏且限深限长                 |
| 成本可控   | 指纹在排除之后计算、`prune` 超 500 才扫描、全采时跳过哈希 |
| 配置单点   | 阈值全部来自归一化配置，各阶段不自行兜底                  |

**一句话**：Processing 是 SDK 的「治理闸门」—— 用一条严格串行、顺序即规范的七段管道，把修格式、查合法、脱敏感、排噪声、去重复、做抽样、控流量七件事收敛到唯一出口上；任何数据要么被规范地放过去，要么被静默地丢弃，绝不会带着脏数据或敏感数据进入发送队列。
