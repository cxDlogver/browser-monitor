# 采集 API 与事务 Outbox

采集 API 是公开浏览器流量进入平台的第一道边界。它既不能信任浏览器提交的身份和属性，也不能为了追求低延迟而只把数据放入内存队列。本项目把“已接收”定义为原始事件与 Outbox 任务已在数据库事务中持久化；后续计算可以异步，但不能失去恢复入口。

## 1. DSN 和请求模型

### 【DSN 不是普通后端地址】

平台为每个项目生成如下地址：

```text
POST /api/v2/ingest/:publicKey/envelopes
```

public key 把公开请求映射到一个启用中的项目和 `app.name`。它会出现在浏览器代码中，因此不是秘密管理凭据。安全边界由写入键状态、有效期、Origin 白名单、项目/IP 限流和轮换共同组成。读取数据、修改成员或重试死信仍然需要登录 Session 与项目权限。

### 【批次与事件】

请求体必须是 `TelemetryBatchV2`：

```ts
interface TelemetryBatchV2 {
  protocolVersion: '2.0';
  sentAt: number;
  sdk: { name: string; version: string };
  events: TelemetryEventV2[];
}
```

API 同时接受 `application/json` 和 Beacon 常见的 `text/plain` JSON 字符串。两种形式只在最开始的解码方式不同，随后都进入同一个 Zod Schema、身份校验和事务写入过程。平台不会为 Beacon 维护字段更宽松的协议。

## 2. 校验顺序

### 【为什么先校验批次再访问项目】

采集服务按下面的固定顺序处理请求：

```text
协议版本
  → 批次头和最多 100 条事件限制
  → public key 对应的项目
  → Origin 白名单
  → 项目和 IP 配额
  → 每条事件 Schema
  → app.name 与项目一致
  → occurredAt 时间范围
  → 服务端脱敏
  → eventId 幂等
  → 原始事件与 Outbox 事务提交
```

协议版本最先检查，可以对 1.0 等旧格式明确返回 `unsupported_protocol`，而不是让旧请求在深层字段校验中得到难以理解的错误。批次头通过后才使用事件数量扣减令牌桶，避免完全无法解析的请求消耗数据库事务。

项目解析会同时检查写入键是否启用、是否过期，以及项目是否启用。Origin 会先标准化为 URL 的 origin，再与 `allowed_origins` 精确匹配。无 Origin 请求默认拒绝，只有明确开启 `ALLOW_ORIGINLESS_INGEST` 的环境才允许这类流量。

### 【批次错误与事件错误不同】

协议版本、批次形状、public key、Origin 或限流失败时，整批请求没有可信的处理上下文，因此直接拒绝。进入逐条校验后，某一事件 Schema 错误、`app.name` 不一致或时间超界，只把该下标加入 `rejections`，其他合法事件仍然可以提交。

事件时间允许最多领先服务器五分钟，并且不能早于三十天。这个范围既容忍终端时钟的小幅偏差，又避免极端时间戳污染时序分区和保留策略。

## 3. 隐私处理

### 【为什么服务端还要再次清理】

SDK Processing 已经移除 URL query、fragment 和常见敏感属性，但公开采集边界不能假设所有客户端都来自最新 SDK，也不能信任调用方没有手工构造请求。因此服务端在写入前再次执行 URL 清理、自定义事件属性脱敏和用户属性脱敏。

用户原始 ID 不直接落库。平台把项目盐值、原始 ID 和服务端 `USER_HASH_SECRET` 组合后生成项目范围内的稳定散列。同一个用户可以在同一项目中关联，不会天然跨项目共享标识。

### 【清理发生在幂等之前还是之后】

服务端先确认事件合法，再生成清理后的事件对象，随后进入去重和数据库写入。`eventId` 本身不改变，所以客户端重试原事件仍然命中同一个幂等键；落入 `telemetry_events.event` 的始终是服务端处理后的版本。

## 4. eventId 幂等实现

### 【请求内重复】

API 先用 Set 去掉同一批次中的重复 `eventId`。第一次出现的合法事件进入待写入集合，后续重复项计入 duplicate。这一步不需要数据库查询，可以减少无意义的锁和写操作。

### 【跨请求和并发重复】

TimescaleDB 的唯一索引通常需要包含分区时间，而平台的协议幂等要求仅由项目与 `eventId` 决定。为处理同一个 ID 携带不同 `occurredAt` 的并发请求，API 对 `projectId:eventId` 获取 transaction advisory lock。

事件 ID 会先排序，再按确定顺序获得锁。这样两个重叠批次不会因为锁顺序相反产生循环等待。获得锁后，API 查询项目下已存在的 ID，仅对不存在的事件执行插入；数据库的 `ON CONFLICT DO NOTHING` 仍然保留为最后一层保护。

## 5. 原始事件与 Outbox 的原子提交

### 【两张表分别保存什么】

`telemetry_events` 是事实留存，保存事件 Envelope、查询常用维度、接收时间和处理时间。`outbox_tasks` 是处理状态，保存 Worker 需要的事件副本、可执行时间、尝试次数、锁持有者和任务状态。

如果先写事件再单独发消息，服务在两步之间退出会留下无法处理的原始数据；如果先创建任务再写事件，Worker 可能看见尚不存在的事实。因此两者必须共享数据库事务。

### 【提交语义】

写入 SQL 先通过 CTE 插入 `telemetry_events`，再只对 `RETURNING` 的新行插入 `outbox_tasks`。事务中的完整顺序是：

1. `BEGIN`；
2. 获取当前批次 eventId 的 advisory transaction lock；
3. 查询已有事件；
4. 插入原始事件，并为实际插入行生成 Outbox；
5. 更新写入键最后使用时间；
6. `COMMIT`。

任何 SQL 失败都会执行 `ROLLBACK`。只有 COMMIT 成功后，请求结果中的 accepted 才表示可靠接收。Redis 里的运行统计在提交后更新，而且统计写失败不会把已经提交的数据伪装成 SDK 可重试错误。

## 6. 响应语义和 SDK 重试

### 【部分接收响应】

成功请求返回 HTTP `202`：

```json
{
  "accepted": 18,
  "duplicate": 1,
  "rejected": 1,
  "requestId": "request-uuid",
  "rejections": [
    { "index": 7, "code": "invalid_event" }
  ]
}
```

accepted 是本次真正创建原始记录和任务的数量；duplicate 包含请求内重复、历史重复和最终数据库冲突；rejected 是逐事件校验失败数量。requestId 同时进入日志和最近一分钟接收统计，可以把客户端现象与服务端请求关联起来。

### 【哪些错误值得重试】

`408`、`429` 和 `5xx` 可能随时间恢复，SDK 可以采用有限次数退避重试。协议版本不支持、public key 无效、Origin 不允许、`app.name` 不匹配和单条字段非法都不会因原样重发而改变，因此不应无限进入 Transport 重试队列。

即使客户端在收到响应前断线，只要数据库已经提交，下次重发也会由 eventId 识别为 duplicate。这个性质让网络超时不再等价于重复计算。

## 7. 限流和请求尺寸

### 【双层令牌桶】

Redis Lua 脚本分别维护项目级和项目内 IP 级令牌桶。一次批次按事件数量消费令牌，而不是只按 HTTP 请求数量计算，防止调用方通过放大批次绕过配额。项目桶保护租户整体容量，IP 桶限制单一来源对项目额度的挤占。

### 【硬限制】

API 将请求体限制为 256 KiB，协议 Schema 将每批事件限制为 100 条，自定义属性还受字段数、层级和序列化大小限制。限制越靠近入口，越能避免异常请求在 JSON 解析、数据库事务或 Worker 阶段放大资源消耗。

## 8. 排查顺序

### 【请求没有出现在看板】

先按边界逐步判断：

1. 浏览器 Network 中是否请求了 DSN，而不是旧 `endpoint`；
2. 返回码是否为 202，响应中的 accepted、duplicate、rejected 分别是多少；
3. public key 对应项目的 `app.name` 是否与事件一致；
4. 浏览器 Origin 是否完整加入白名单；
5. 服务状态页的 accepted 是否增长；
6. Outbox pending 是否增长但 processed 不增长；
7. 原始事件页能否按 eventId 找到事件。

如果 accepted 增长而原始事件可检索，采集阶段已经完成，问题应转向 Worker 或 Analytics；如果 rejected 增长，应该根据 rejections 修正协议数据，而不是先重启 Worker。

### 【对应代码】

- `apps/api/src/ingestion/ingestion.controller.ts`：HTTP 入口和 202 响应；
- `apps/api/src/ingestion/ingestion.service.ts`：校验、清理、幂等和事务；
- `apps/api/src/ingestion/rate-limiter.service.ts`：Redis 令牌桶；
- `packages/shared/src/privacy.ts`：URL 与属性清理；
- `packages/database/migrations/0001_platform.sql`：原始表、Outbox 与索引。
