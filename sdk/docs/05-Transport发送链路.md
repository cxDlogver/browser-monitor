# 05 · Transport：从内存队列到可靠发送

> 本文承接 [04 · Processing：七阶段加工链路](./04-Processing加工链路.md)。
> 数据通过七道关卡后进入 Transport。本文给出**完整链路图、逐模块代码走读、队列状态推演、异常场景演练**，力求看完就能把每一步对上代码。

---

## 一、它到底要解决什么问题

先看「不设 Transport 会怎样」：

```text
Collector emit 一条 → 立刻 fetch 一次
```

问题依次出现：

| 问题 | 后果 |
| --- | --- |
| 一条一个请求 | 页面一次交互就产生几十个请求，把用户带宽和公司服务端一起拖垮 |
| 同步等待响应 | 采集在业务调用栈上，网络抖动会直接拖慢页面 |
| 页面关闭时数据丢失 | 最后一批数据随页面卸载被浏览器取消 |
| 失败就丢 | 一次网络抖动 = 一批数据永久消失 |
| 队列无上限 | 异常循环时内存被监控数据吃光 |

因此 Transport 要同时满足四个互相冲突的目标：

| 目标 | 手段 |
| --- | --- |
| 不阻塞页面 | `enqueue` 同步、只入队，返回极快 |
| 不拖慢网络 | 攒批发送，一批一个请求 |
| 尽量不丢 | 五个冲刷时机 + 失败保留队列 + Beacon 兜底 |
| 不成为故障源 | 队列限容、批次限字节、重试限次数、异常一律吞掉 |

---

## 二、全景与分层

```text
Pipeline.process()
      │  通过七关的数据
      ▼
Transport.enqueue(envelope)                    ← src/transport/flush
      │  ① active? 否 → 丢弃
      ▼
MemoryQueue.enqueue()                          ← src/transport/queue
      │  ② 未满 → push；已满 → 按优先级淘汰
      │  ③ size >= batchSize ? → 触发冲刷
      ▼
Transport.flush(preferBeacon)
      │  ④ flushing 已存在？→ 复用同一个 Promise（合并并发）
      ▼
drain(): while (队列非空)                       ← src/transport/flush
      │  ⑤ takeBatch(队列, batchSize, maxBatchBytes)   ← src/transport/batch
      │        ├─ take(条数) 取候选
      │        ├─ 逐条累计字节，超限则 prepend 回队首
      │        └─ 返回本批
      │  ⑥ sendWithRetry(sender, batch, preferBeacon, retry)  ← src/transport/retry
      │        ├─ sender.send(batch, preferBeacon && 首次)     ← src/transport/sender
      │        │     ├─ Beacon 路径（页面离开 + 首次）
      │        │     └─ fetch + keepalive 路径
      │        ├─ success → true
      │        └─ 失败且 retryable → 退避后重试，次数用尽 → false
      │  ⑦ !sent → return（本批已出队，直接丢弃；仅字节超限部分被 prepend 回队首）
      ▼
采集端点 200 OK
```

四个模块各司其职，依赖单向：

| 模块 | 输入 | 输出 | 知道什么 | 不知道什么 |
| --- | --- | --- | --- | --- |
| `flush`（Transport） | 信封 / 生命周期信号 | 冲刷调度 | 队列、批次、时机 | HTTP |
| `queue` | 信封 | 一批信封 | 容量、优先级 | 网络、重试 |
| `batch` | 队列 + 两个上限 | 一批 | 条数与字节 | 怎么发 |
| `retry` | 一批 + Sender | 成功 / 失败 | 退避与次数 | 队列、HTTP |
| `sender` | 一批 | `{success, retryable}` | HTTP | 队列、重试 |

---

## 三、逐模块代码走读

### 3.1 Transport（flush/index.ts）：调度中心

#### 状态字段

```ts
export class Transport implements MonitorModule {
  readonly name = 'transport';
  private readonly queue: MemoryQueue;                        // 缓冲区
  private timer: ReturnType<typeof setInterval> | undefined;  // 周期冲刷定时器
  private unsubscribeLifecycle: (() => void) | undefined;     // 信号退订句柄
  private active = false;                                     // 采集态闸门
  private flushing: Promise<void> | undefined;                 // 进行中的冲刷（合并并发）
}
```

| 字段 | 作用 | 出错会怎样 |
| --- | --- | --- |
| `timer` | 周期冲刷 | 不清理 → 页面永远有后台任务 |
| `unsubscribeLifecycle` | 退订 `page.lifecycle` | 不清理 → destroy 后仍被触发 |
| `active` | false 时 `enqueue` 直接丢弃 | 缺失 → destroy 后仍发请求 |
| `flushing` | 合并并发 flush | 缺失 → 两个 drain 并发消费同一队列，重复消费 + 乱序 |

#### install：订阅页面生命周期

```ts
install(): void {
  if (this.unsubscribeLifecycle) return;                      // install 幂等
  this.unsubscribeLifecycle = this.signals.subscribe('page.lifecycle', (signal) => {
    // 页面即将进入后台或离开时优先尝试 Beacon，提高尾部数据送达概率。
    if (signal.type === 'hidden' || signal.type === 'pagehide') void this.flush(true);
  });
}
```

为什么订阅放在 `install`：订阅关系与「是否在采集」无关，一生只需建立一次；stop/start 反复退订重订没有意义。

#### start / stop / destroy

```ts
start(): void {
  if (this.active) return;
  this.active = true;
  this.timer = setInterval(() => void this.flush(false), this.options.flushIntervalMs);
}

stop(): void {
  if (!this.active) return;
  this.active = false;
  this.clearTimer();
  void this.flush(false);            // 关定时器前把残留数据发出去
}

destroy(): void {
  this.active = false;
  this.clearTimer();
  this.unsubscribeLifecycle?.();
  this.unsubscribeLifecycle = undefined;
  void this.flush(true).finally(() => this.queue.clear());   // 最后抢救，然后清空
}
```

| 动作 | 定时器 | Beacon | 队列 | 之后 |
| --- | --- | --- | --- | --- |
| `start` | 开启 | — | — | 可收数据 |
| `stop` | 关闭 | 否 | 冲刷后保留 | 再 start 可恢复 |
| `destroy` | 关闭 | **是** | 冲刷后清空 | 终态 |

注意三处 `void`：定时器回调与生命周期回调里的 Promise 一律不 await、不 catch，因为**发送失败绝不能变成未处理的 Promise 拒绝冒泡到宿主页面**。

#### enqueue：唯一的写入口

```ts
enqueue(envelope: TelemetryEnvelope): void {
  if (!this.active) return;                                        // ① 闸门
  this.queue.enqueue(envelope);                                    // ② 入队（同步）
  if (this.queue.size >= this.options.batchSize) void this.flush(false);  // ③ 攒够即发
}
```

它跑在采集调用栈上（Collector → Pipeline → enqueue），所以必须**同步且廉价**：没有 await、没有 JSON、没有网络。

#### flush：合并并发

```ts
flush(preferBeacon: boolean = false): Promise<void> {
  // 合并并发 flush，确保同一队列不会被多个 drain 循环同时消费。
  if (this.flushing) return this.flushing;

  this.flushing = this.drain(preferBeacon).finally(() => {
    this.flushing = undefined;
  });
  return this.flushing;
}
```

**为什么必须合并**：假设队列里正好有 20 条，`enqueue` 触发一次 flush；同一毫秒定时器也到期触发一次。若不加保护，两个 `drain` 会并发执行 `takeBatch`，把同一批数据取两遍，或产生乱序批次。用一个 `flushing` 字段把并发调用收敛为「共享同一个 Promise」，是最省事的可靠方案。

#### drain：循环取批发送

```ts
private async drain(preferBeacon: boolean): Promise<void> {
  while (this.queue.size > 0) {
    const batch = takeBatch(this.queue, this.options.batchSize, this.options.maxBatchBytes);
    if (batch.length === 0) return;          // 切不出批次 → 退出（防死循环）

    const sent = await sendWithRetry(this.sender, batch, preferBeacon, this.options.retry);
    if (!sent) return;                       // 失败即停；注意本批已被 takeBatch 出队，不会放回（见下方⚠️）

    // Beacon 只用于离开页面时的第一批；后续批次回到可判断响应状态的 fetch。
    preferBeacon = false;
  }
}
```

| 决策 | 理由 |
| --- | --- |
| 失败即停 | 继续发只会浪费重试配额，本轮的剩余数据（如果有）等下一个时机再处理 |
| Beacon 只第一批 | Beacon 拿不到状态码，无法判断成败，因此只用于「页面要没了」的第一批 |
| `batch.length === 0` 退出 | 理论上不会发生（队列非空必然切得出首条），是防御性死循环保护 |

> ⚠️ **实现细节（务必注意）**：`takeBatch()` 内部调用 `queue.take()`，已经把这一批数据**从队列里 splice 出去**了。发送失败时 `drain` 直接 `return`，**并没有把这一批 `prepend` 回队列** —— 也就是说：
>
> - **失败的那一批数据会被真正丢弃**（既没发出去，也不再在队列里）；
> - 只有「因字节上限没能进入本批」的那部分，才由 `takeBatch` 内的 `queue.prepend(candidates.slice(index))` 放回队首。
>
> 源码注释写的是「剩余数据留在队列里等下一个冲刷时机」，与实际行为不一致。若希望失败批次可重试，需要在 `if (!sent)` 分支里补一次 `queue.prepend(batch)`。

---

### 3.2 MemoryQueue：限容 + 优先级淘汰

#### 优先级规则

```ts
// View 与业务事件承担链路还原作用，队列压力下优先于可聚合的性能诊断数据。
function priorityOf(envelope: TelemetryEnvelope): number {
  if (envelope.type === 'view') return 2;
  if (envelope.type === 'event') return 2;
  return 1;
}
```

判断依据不是「数据重不重要」，而是**「丢了还能不能还原链路」**：性能诊断数据是可聚合的（少几条不影响趋势），而 view / event 是还原「用户当时在哪个页面、做了什么」的骨架。

#### 入队与淘汰

```ts
enqueue(envelope: TelemetryEnvelope): void {
  const incoming: QueueItem = { envelope, priority: priorityOf(envelope) };
  if (this.items.length < this.capacity) {
    this.items.push(incoming);
    return;
  }

  // 只在遇到更低优先级时更新，因此同优先级下淘汰最早进入队列的数据。
  let lowestIndex = 0;
  for (let index = 1; index < this.items.length; index += 1) {
    const item = this.items[index];
    const lowest = this.items[lowestIndex];
    if (item && lowest && item.priority < lowest.priority) lowestIndex = index;
  }

  const lowest = this.items[lowestIndex];
  if (lowest && incoming.priority >= lowest.priority) {
    this.items.splice(lowestIndex, 1);
    this.items.push(incoming);
  }
  this.dropped += 1;
}
```

**淘汰算法推演**（设 `capacity = 3`）：

| 步骤 | 队列内容（优先级） | 新数据 | 找到的 lowest | 动作 | dropped |
| --- | --- | --- | --- | --- | --- |
| 初始 | `A(1) B(2) C(1)` | `D(1)` perf | `A`（同优先级中最早） | 删 A、插入 D → `B(2) C(1) D(1)` | 1 |
| 再来 | `B(2) C(1) D(1)` | `E(2)` event | `C`（严格小于才更新，D 不替换 C） | 删 C、插入 E → `B(2) D(1) E(2)` | 2 |
| 再来 | `B(2) D(1) E(2)` | `F(1)` perf | `D` | 删 D、插入 F → `B(2) E(2) F(1)` | 3 |
| 再来 | `B(2) E(2) F(1)` | `G(1)` perf | `F` | 1 ≥ 1 → 删 F、插入 G | 4 |

两个细节：

- `item.priority < lowest.priority` 用**严格小于**：同优先级不更新，所以淘汰的是其中**最早**进入的那条（FIFO 语义）；
- `incoming.priority >= lowest.priority` 才替换：低优先级数据**顶不掉**高优先级数据，此时新数据自己被丢弃。

#### take / prepend / clear

```ts
take(count: number): TelemetryEnvelope[] {
  return this.items.splice(0, count).map((item) => item.envelope);
}

// 批处理因字节上限未消费的数据必须放回队首，维持原始事件顺序。
prepend(envelopes: readonly TelemetryEnvelope[]): void {
  this.items.unshift(...envelopes.map((envelope) => ({ envelope, priority: priorityOf(envelope) })));
  while (this.items.length > this.capacity) {
    this.items.pop();            // 回退后超限：从队尾丢
    this.dropped += 1;
  }
}
```

`prepend` 存在的唯一理由是**保序**：切批时没发出去的必须回到队首，否则事件时序会被打乱（先发生的反而后到）。

---

### 3.3 takeBatch：条数与字节双上限

```ts
export function takeBatch(queue: MemoryQueue, maxCount: number, maxBytes: number): TelemetryEnvelope[] {
  const candidates = queue.take(maxCount);          // 先按条数取出候选
  const batch: TelemetryEnvelope[] = [];
  let bytes = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const envelope = candidates[index];
    if (!envelope) continue;

    const nextBytes = JSON.stringify(envelope).length;
    // 首条即使超限也必须发送，否则它会被永久放回队首并阻塞后续事件。
    if (batch.length > 0 && bytes + nextBytes > maxBytes) {
      queue.prepend(candidates.slice(index));       // 剩余候选原序回队首
      break;
    }

    batch.push(envelope);
    bytes += nextBytes;
  }

  return batch;
}
```

**推演**（`maxCount = 5`、`maxBytes = 1000`，每条 300 字节）：

| 候选 | 累计字节 | 判定 | 结果 |
| --- | --- | --- | --- |
| 第 1 条 | 300 | batch 为空 → 无条件加入 | 入批 |
| 第 2 条 | 600 | 600 ≤ 1000 | 入批 |
| 第 3 条 | 900 | 900 ≤ 1000 | 入批 |
| 第 4 条 | 1200 | **1200 > 1000** | `prepend([4,5])` 回队首，break |
| 第 5 条 | — | 同上 | 回队首 |

本批 = 3 条，第 4、5 条回到队首，下一轮 `drain` 继续处理。

**首条豁免为什么必须存在**：如果第 1 条就超过 `maxBytes`（比如一条 2000 字节的事件），若也执行回退，它会被永久放回队首，每次 drain 都取它、又放回去 —— **队首阻塞**，后面所有数据永远发不出去。所以 `batch.length > 0` 这个条件是防死局的。

---

### 3.4 sendWithRetry：退避与抖动

```ts
for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
  const result = await sender.send(batch, preferBeacon && attempt === 1);
  if (result.success) return true;
  if (!result.retryable || attempt === options.maxAttempts) return false;

  // 指数退避叠加随机抖动，避免大量客户端在服务恢复瞬间同时重试。
  const jitter = Math.floor(Math.random() * options.baseDelayMs);
  await delay(options.baseDelayMs * 2 ** (attempt - 1) + jitter);
}
```

**时间线**（`maxAttempts = 3`、`baseDelayMs = 500`）：

```text
attempt 1：send → 503（retryable）→ 等待 500*2^0 + [0,500) ≈ 500~999ms
attempt 2：send → 503（retryable）→ 等待 500*2^1 + [0,500) ≈ 1000~1499ms
attempt 3：send → 503 → 已到次数上限 → return false（本批丢弃，不会放回队列）
```

| 设计 | 目的 |
| --- | --- |
| `retryable` 判定 | 4xx（除 408/429）说明请求本身有问题，重试无意义 |
| 指数退避 `2^(n-1)` | 失败越久等越久，给服务端恢复时间 |
| 随机抖动 | 打散重试时刻，防止服务恢复瞬间所有客户端同时打过来（惊群） |
| Beacon 仅首次 | Beacon 没有「响应」概念，失败后必须换回 fetch 才能判断 |

---

### 3.5 HttpSender：唯一接触网络的地方

```ts

export class HttpSender implements Sender {
  constructor(private readonly options: HttpSenderOptions) {}

  async send(batch: readonly TelemetryEnvelope[], preferBeacon: boolean): Promise<SendResult> {
    // 统一上报体：外层只放协议版本与发送时间，业务差异全部在 events 里。
    const body = JSON.stringify({
      protocolVersion: '2.0',
      sentAt: Date.now(),
      sdk: batch[0].context.runtime.sdk,
      events: batch,
    });

    // sendBeacon 无法返回服务端状态，仅在页面即将离开且浏览器确认接收时视为成功。
    if (
      preferBeacon &&
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      try {
        // 返回 true 只表示浏览器已接收并排队，不代表服务端已处理 —— 因此不可重试。
        if (navigator.sendBeacon(this.options.dsn, body)) {
          return { success: true, retryable: false };
        }
      } catch {
        // Beacon 不可用或抛错时继续降级到 fetch keepalive。
      }
    }

    // 环境不支持 fetch 且 Beacon 也不可用：直接失败且不可重试，避免空转。
    if (typeof fetch !== 'function') return { success: false, retryable: false };

    try {
      const response = await fetch(this.options.dsn, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body,
        keepalive: preferBeacon,
      });

      return {
        success: response.ok,
        // 408 超时、429 限流、5xx 服务端错误都值得再试；其余 4xx 属于请求本身有问题。
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      };
    } catch {
      // 网络异常（断网、DNS 失败、CORS）通常是暂时性的 → 可重试。
      return { success: false, retryable: true };
    }
  }
}

```

**上报体**：

```json
{
  "protocolVersion": "2.0",
  "sentAt": 1712345678902,
  "sdk": { "name": "cx-browser-monitor-sdk", "version": "0.2.0" },
  "events": [ /* 一批 TelemetryEnvelope */ ]
}
```

**两条路径对比**：

| 路径 | 触发条件 | 能否拿到状态码 | 能否活过页面卸载 | retryable |
| --- | --- | --- | --- | --- |
| `sendBeacon` | `preferBeacon && 首次` | 否 | **能**（浏览器接管） | false |
| `fetch` + `keepalive` | 其余 | 是 | 部分能 | 按状态码 |

`Sender` 是接口，可注入自定义实现 —— 这正是 `createMonitorWithDependencies` 存在的意义（测试用内存 Sender、宿主用自己的通道转发）。

---

## 四、五个冲刷时机

```text
① 定时       setInterval(flushIntervalMs)      → flush(false)
② 攒够一批   enqueue 时 size >= batchSize      → flush(false)
③ 页面隐藏   page.lifecycle = hidden/pagehide  → flush(true)   ★ Beacon
④ stop()     关定时器后                        → flush(false)
⑤ destroy()  关定时器 + 退订后                 → flush(true)   ★ Beacon
```

五者都汇入同一个 `flush()`，而 `flush()` 用 `flushing` 做并发合并，所以**无论几个时机同时触发，队列都只会被一个 drain 消费**。

---

## 五、完整链路时序：一条 LoAF 数据的旅程

默认配置：`batchSize = 20`、`maxBatchBytes = 64000`、`flushIntervalMs = 10000`、`maxQueueSize = 200`、`retry = { maxAttempts: 3, baseDelayMs: 500 }`。

```text
t=0ms    浏览器推来 LoAF 条目
           Instrumentation → publish('performance.loaf')
           LoAFCollector → 阈值/额度通过 → emitter.emit(draft)
           MonitorPipeline → 补齐信封
           Processing 七关 → 通过
           Transport.enqueue(envelope)

t=0.1ms   ① active = true（已 start）
           ② queue.enqueue()：队列 1/200，未满 → push
           ③ queue.size(1) < batchSize(20) → 不冲刷
           enqueue 同步返回，采集调用栈结束

t=…       陆续来了 19 条，队列 20/200

t=850ms   第 20 条入队 → size(20) >= batchSize(20) → flush(false)
           ④ flushing 为空 → 创建 drain Promise
           ⑤ takeBatch(queue, 20, 64000)
                - take(20) 取出 20 条
                - 累计到第 18 条时 bytes + next > 64000
                - prepend(第 18~20 条) 回队首 → 本批 17 条
           ⑥ sendWithRetry(sender, 17 条, false, retry)
                - attempt 1：fetch POST → 503 → retryable
                - 退避约 700ms
                - attempt 2：fetch POST → 200 OK → return true
           ⑦ 回到 while：队列还有 3 条 → takeBatch → 3 条一批 → 发送成功 → 队列空 → 退出
           flushing 置空

t=3000ms  用户切到别的标签页
           page.lifecycle(hidden) → flush(true)
             → 队列若还有数据：第一批走 sendBeacon（浏览器接管）
             → preferBeacon = false，后续批次回到 fetch

t=10000ms 定时器到期 → flush(false)（队列空，直接结束）
```

---

## 六、异常场景演练

### 6.1 断网

```text
attempt 1：fetch 抛异常 → { success: false, retryable: true } → 退避 500~999ms
attempt 2：仍失败     → 退避 1000~1499ms
attempt 3：仍失败     → return false
drain 退出 → 本批数据被丢弃（已出队且未放回）
             → 之后新入队的数据在下一个定时周期（10s 后）继续发送
```

**数据没有丢**，只是晚发。恢复网络后队列会被逐步清空。

### 6.2 服务端 500

与断网流程相同，区别是 `retryable` 来自状态码判定（5xx → true）。

### 6.3 服务端 400（请求有问题）

```text
attempt 1：400 → retryable: false → 立即 return false
```

一次就放弃，不会浪费三次重试。

### 6.4 页面关闭

```text
pagehide → flush(true)
  → drain(true)：第一批 sendBeacon（浏览器接管，页面关闭也能发出）
  → 若还有剩余：preferBeacon = false，后续批次用 fetch keepalive
destroy → flush(true).finally(queue.clear())
```

### 6.5 队列被打爆（异常循环）

```text
1 秒产生 5000 条 → 队列容量 200
  → 前 200 条正常入队
  → 之后每条都触发淘汰：低优先级（性能诊断）先被牺牲，view/event 保住
  → droppedCount 持续增长（可观测）
  → 同时上游有 rate-limit（120 条/60s）已经先挡了一层
```

两层防线：**Processing 限流**控制进入速率，**队列限容**控制内存占用。

---

## 七、数据会在哪些环节丢（全链路汇总）

| 环节 | 条件 | 是否预期 |
| --- | --- | --- |
| Processing ② validate | 结构不完整 | **异常**（需修上游） |
| Processing ④ filter | 命中排除 URL | 预期 |
| Processing ⑤ dedupe | 窗口内重复 | 预期 |
| Processing ⑥ sampling | 未命中采样 | 预期 |
| Processing ⑦ rate-limit | 窗口额度用尽 | 预期 |
| Transport `enqueue` | `active = false` | 预期（生命周期语义） |
| Transport 队列满 | 新数据优先级不高于最低者 | 预期（内存保护） |
| Transport `prepend` 超限 | 回退后超出容量 | 预期（极端情况） |
| Transport 重试耗尽 | 3 次都失败 | **整批丢弃**（已出队且未放回队列） |
| Transport destroy | 最后一次冲刷后清空 | 预期（终态） |

**关键认知**：当前实现下，**「发送失败」就等于「丢这一批」** —— `takeBatch` 已把数据从队列 splice 出去，失败分支没有 `prepend` 放回。所以：

- 失败**不会**自动留待下次重试；
- 能被后续冲刷带走的，只有「字节超限没进批」被 `prepend` 回队首的那部分，以及失败之后新入队的数据。

---

## 八、设计决策问答

**Q1：为什么 `flush` 要合并并发？**
定时器和「攒够一批」可能在同一毫秒触发。两个 `drain` 并发 `takeBatch` 同一队列会造成重复消费与乱序。用 `flushing` 单一 Promise 收敛，成本最低且可靠。

**Q2：为什么切批要「首条豁免」？**
否则超大单条会被反复放回队首，造成队首阻塞，后面所有数据永远发不出去。

**Q3：为什么发送失败就停止 drain？**
继续发只会消耗重试配额。**但要注意当前实现的一个缺口**：本批数据已被 `takeBatch` 出队，失败后并没有放回队列，因此这一批是真正丢失的（见 3.1 的 ⚠️）。若要让它「留待下次」，需要在 `if (!sent)` 分支里补 `queue.prepend(batch)`。

**Q4：为什么 Beacon 只用于第一批？**
Beacon 拿不到响应状态码，无法判断成败，也就无法重试。它只在「页面要没了」这种别无选择的情况下用一次。

**Q5：为什么队列要有优先级而不是简单丢弃新数据？**
丢新数据会把最关键的 `view.start` / 业务事件丢掉，剩下的性能数据无法归因。优先级淘汰保证「骨架数据」活到最后。

**Q6：为什么淘汰时用严格小于比较？**
`item.priority < lowest.priority` 保证同优先级中不更新索引，从而淘汰的是同优先级里**最早**进入的那条，维持 FIFO 语义。

**Q7：为什么重试要加随机抖动？**
否则所有客户端在服务恢复的同一瞬间集体重试，会立刻把刚恢复的服务再次打垮（惊群）。

**Q8：为什么 `enqueue` 里 `active = false` 就丢弃？**
保证 `destroy()` 之后不再产生任何网络请求；同时未 `start()` 时也不应有数据进入队列。

---

## 九、小结

| 关注点 | 做法 | 代码位置 |
| --- | --- | --- |
| 入队 | 同步、廉价、带闸门 | `flush/enqueue` |
| 缓冲 | 限容 + 优先级淘汰 | `queue` |
| 切批 | 条数 + 字节双上限，首条豁免 | `batch/takeBatch` |
| 发送 | Beacon 优先，降级 fetch keepalive | `sender/HttpSender` |
| 重试 | 指数退避 + 抖动，可重试才重试 | `retry/sendWithRetry` |
| 调度 | 五个时机汇入同一 flush，并发合并 | `flush/flush + drain` |
| 清理 | 关定时器、退订信号、清空队列 | `flush/stop + destroy` |

**一句话**：Transport 用「限容优先级队列 + 双上限切批 + 退避重试 + Beacon 兜底」四件事，在**不阻塞页面、不拖慢网络、不无限占用内存**的前提下把数据尽可能完整地送出去；它宁可少发、晚发，也绝不让监控代码成为页面问题的一部分。
