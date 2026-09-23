# Browser Monitor Platform

Browser Monitor Platform 是 `cx-browser-monitor-sdk` 的服务端和可视化平台。SDK 只负责在浏览器中采集、治理和发送遥测数据；平台负责接收协议 3.0 批次、可靠地生成查询模型、计算服务端指标口径，并向项目成员提供管理后台与监控看板。

完整链路为：`Monitor SDK → 公开 DSN → Ingestion API → telemetry_events + Outbox → Worker → TimescaleDB 聚合 → Analytics API → React 看板`。

## 1. 项目边界

### 【业务应用需要提供什么】

业务应用只需要安装 SDK、填写应用身份、配置稳定页面名称并使用平台生成的 DSN。业务项目**不需要自己实现 `endpoint` 接口，也不需要额外开发可视化页面**；采集接口和看板都由本项目提供。

```ts
import { createMonitor } from "cx-browser-monitor-sdk";

const monitor = createMonitor({
  app: {
    name: "customer-center",
    version: "1.4.0",
    environment: "production",
  },
  view: {
    resolveRouteName: ({ pathname }) => pathname,
  },
  transport: {
    dsn: "https://monitor.example.com/api/v3/ingest/bm_pk_xxx/envelopes",
  },
});

monitor.start();
```

`transport.dsn` 是唯一的 SDK 采集地址字段。DSN 由平台的公开域名、协议版本路由和项目写入键组成；代码中不再保留 `transport.endpoint` 兼容分支。DSN 写入键用于识别项目，不是管理凭据，平台通过 Origin 白名单、项目/IP 限流、请求配额和密钥轮换控制滥用。

### 【平台负责什么】

平台承担四类责任：账号、项目和权限管理；遥测数据接收与原始留存；异步投影、指标计算和时间聚合；看板查询、运行状态与失败任务恢复。它不会反向操作业务页面，也不会把业务管理 Cookie 用作采集鉴权。

## 2. 目录结构

### 【完整目录树】

```text
platform/
├─ apps/
│  ├─ api/                         # NestJS + Fastify HTTP 服务
│  │  ├─ src/auth/                # 注册、验证、登录、Session、CSRF、邮件
│  │  ├─ src/projects/            # 项目、成员、Origin、写入键、阈值和死信重试
│  │  ├─ src/ingestion/           # 协议 3.0 采集、限流、脱敏、幂等与事务 Outbox
│  │  ├─ src/analytics/           # 总览、性能、页面、事件、原始数据和服务状态查询
│  │  ├─ src/observability/       # Prometheus 指标
│  │  └─ src/health/              # 存活与就绪检查
│  ├─ worker/                      # 独立 Outbox 消费进程
│  │  └─ src/
│  │     ├─ outbox-worker.ts      # 任务领取、退避重试、死信和后台维护
│  │     ├─ processor.ts          # Performance/View/Event 投影与服务端评级
│  │     └─ sequence.ts           # Performance sequence 接受规则
│  ├─ audit-worker/                # 独立 Lighthouse 实验室测试进程
│  │  └─ src/                      # Chrome 启动、5 次运行、聚合和中文建议
│  └─ web/                         # React + Vite + Ant Design + ECharts
│     └─ src/
│        ├─ api/                  # Session/CSRF 请求客户端和响应类型
│        ├─ auth/                 # 登录状态
│        ├─ layout/               # 项目级导航
│        └─ pages/                # 总览、性能、页面、事件、原始数据、状态和设置
├─ packages/
│  ├─ database/
│  │  ├─ src/schema.ts            # Drizzle 关系模型
│  │  └─ migrations/              # 表、Hypertable、连续聚合、压缩和留存策略
│  └─ shared/
│     └─ src/                     # 配置、密码/令牌、隐私处理和指标阈值
├─ infra/
│  ├─ docker-compose.yml          # Caddy/API/Worker/Web/TimescaleDB/Redis/Mailpit
│  ├─ docker-compose.load.yml     # 容量测试专用配额覆盖
│  ├─ Caddyfile                   # 静态站点、API 反向代理和内部指标保护
│  └─ Dockerfile.*                # 后端与前端镜像
└─ load/k6-ingestion.js           # 持续与峰值采集负载脚本
```

### 【为什么 API 与 Worker 分离】

API 的首要目标是快速、确定地回答“这批数据是否被平台接收”。指标投影和聚合会访问更多表，也可能因单条异常数据失败，因此不应阻塞采集请求。API 只在一个事务中写入原始事件和 Outbox；Worker 在事务提交后异步消费。两者分离后，采集延迟不受复杂计算直接影响，Worker 也可以独立扩容和重启。

## 3. 完整数据链路

### 【采集请求】

SDK 向 `POST /api/v3/ingest/:publicKey/envelopes` 发送 `TelemetryBatchV3`。API 接受常规 `application/json`，也接受页面离开时 `sendBeacon` 产生的 `text/plain` JSON 字符串。单个请求体最大 256 KiB，每批最多 100 条事件。

处理顺序为：协议版本检查 → 批次头校验 → 写入键解析 → Origin 校验 → 项目/IP 令牌桶限流 → 逐事件 Schema 校验 → `app.name` 一致性检查 → 时间范围检查 → 服务端二次脱敏 → `eventId` 幂等去重 → 原始事件与 Outbox 同事务入库。

整批身份、协议或 Origin 错误直接拒绝；某条事件字段非法时只拒绝该事件。成功响应使用 HTTP `202`：

```json
{
  "accepted": 18,
  "duplicate": 1,
  "rejected": 1,
  "requestId": "request-uuid",
  "rejections": [{ "index": 7, "code": "invalid_event" }]
}
```

`408`、`429` 和 `5xx` 属于 SDK 可以有限重试的状态；协议不支持、写入键无效、Origin 不允许或事件本身非法，不会通过重试自动恢复。

### 【事务 Outbox】

每条首次接收的事件同时写入 `telemetry_events` 和 `outbox_tasks`。两个写入位于同一数据库事务中，因此不会出现“接口返回成功但没有后续处理任务”，也不会出现“Worker 看到了任务但原始事件尚未提交”。

`eventId` 是协议级幂等键。API 先去除同一请求内的重复 ID，再用项目级事务咨询锁串行化重叠批次，最后查询已有事件并批量插入。SDK 因网络超时重发同一批次时，平台返回 duplicate，而不会重复计算指标。

### 【Worker 投影】

Worker 使用 `FOR UPDATE SKIP LOCKED` 领取可执行任务，多实例之间不会等待同一行。任务进入 processing 后如果进程退出，超过五分钟的锁会被其他 Worker 重新领取。

不同 payload 的投影目标不同：Performance 进入 `performance_samples`；View 进入 `view_records`；自定义 Event/Trace/Span 进入 `custom_signal_samples` 和 `custom_metric_samples`。处理成功后更新原始事件的 `processed_at`，再将 Outbox 标记为 completed，并递增项目查询缓存版本。

失败任务执行指数退避，最多尝试八次。超过上限后，Outbox 保留 failed 状态并写入 `dead_letter_tasks`；服务状态页展示最近死信，Owner 可以将任务重新放回 pending 队列。

### 【Performance 修订与最终状态】

Web Vitals 同一观测使用稳定 `sampleId`，值变化时递增 `sequence`。Worker 只接受高于当前值的 sequence，因此重复或乱序到达不会重复计数。`final` 是单向终态：更高 sequence 的迟到数据可以修正数值，但不能把样本重新改回 provisional。

样本在三种情况下结束：SDK 在 View 结束时发送 final；Worker 收到 `view.end` 后关闭该 View 的 provisional 样本；缺少结束事件时，后台任务把五分钟未更新的 provisional 样本兜底设为 final。

SDK 传入的 `clientRating` 只作为诊断信息保存。Worker 根据项目当前阈值版本重新计算 `serverRating`，并在样本上记录 `threshold_version_id`，阈值更新不会静默改写旧样本的历史口径。

### 【TimescaleDB 聚合与查询】

原始事件、性能样本、View 和自定义事件明细都是 Hypertable。数据库维护一分钟连续聚合和一小时分层聚合：近 29 天查询直接使用明细，跨越更早时间的查询切换到小时聚合；会话数和 View 数使用 HyperLogLog 中间状态合并，分位数使用 Timescale Toolkit 的 percentile aggregate。

原始数据与明细保留 30 天，24 小时后的旧分区自动压缩；分钟和小时聚合保留 180 天。分析 API 统一支持 `from`、`to`、`environment`、`version`、`routeName` 和 `metric` 过滤，查询结果按项目缓存版本短期缓存。

### 【可视化与运行状态】

React 管理后台每 15 秒刷新主要看板。页面包括项目列表、接入设置、总览、性能趋势、页面排名、自定义事件、原始事件、服务状态和项目设置。原始事件按 `(occurredAt, eventId)` 使用游标分页，避免大偏移分页在时序表上的扫描成本。

服务状态页同时显示最近一分钟接收量、最近一分钟处理量、累计接收/重复/拒绝数量、Outbox 各状态数量和死信明细。它用来区分“SDK 没有上报”“API 拒绝了数据”“Worker 出现积压”和“单条任务持续失败”这几类不同问题。

### 【独立 Lighthouse 实验室测试】

项目菜单中的“实验室测试”只运行主动 Lighthouse 测量，不读取或改写 RUM 数据，也不与线上真实用户指标做对照。Owner 输入项目白名单 Origin 下的 URL 并选择手机端或桌面端后，API 创建独立任务；Audit Worker 为每轮启动新的 Chrome 会话，连续运行 5 次，以中位数和波动度生成 Performance、SEO、Accessibility、Best Practices、FCP、LCP、CLS、TBT 等报告。

需要登录的页面可使用项目级固定请求头。请求头由 `AUDIT_HEADER_ENCRYPTION_KEY` 以 AES-256-GCM 加密保存，管理接口只返回名称和掩码；鉴权值应使用权限最小且短期有效的专用令牌。生产环境默认禁止测试解析到本机、私网、链路本地或保留地址的 URL；Audit Worker 使用独立的非 root、只读容器和任务表，因此 Chrome 资源消耗不会占用 Outbox Worker。

### 【自定义 Event、Trace 与 Span】

协议 3.0 将自定义 Event、Trace、Span 投影到 `custom_signal_samples`，将每个 `{ value, unit }` 数值指标投影到 `custom_metric_samples`。Trace/Span 的 `duration` 指标由 Worker 自动写入，单位固定为 `ms`。分钟、小时连续聚合按类型、埋点名、指标名、单位和路由分别统计，支持 count、sum、avg、min、max 和 p50/p75/p90/p95/p99。原始链路保留 30 天，聚合保留 180 天。

`/events` 展示按“类型 + 埋点名”分组的列表，点击进入该项的统计、趋势、路由分布与事件详情。Trace/Span 记录可查看父子 Span 瀑布图及关联事件。API 使用 `/analytics/custom-signals`、`/analytics/custom-signals/detail`、`/analytics/custom-signals/records` 和 `/analytics/traces/:traceId` 查询这些数据。旧版自定义事件样本不回填。

## 4. 用户、项目与安全边界

### 【登录和权限】

注册账号必须通过 SMTP 邮件验证。未验证账号再次提交注册时，平台会更新本次注册信息、作废旧验证令牌并重新发送邮件，避免开发环境邮件容器重启后账号无法继续验证；已验证邮箱再次注册时才返回 `email_already_registered`。登录状态保存于 Redis Session，并通过 HttpOnly Cookie 传递；管理写请求额外校验 CSRF Token。项目角色分为 owner 和 member：owner 可以管理写入键、Origin、成员、阈值和死信；member 只能查看项目与监控数据。

### 【隐私和输入限制】

URL 在 SDK 与服务端都移除 query 和 fragment。用户 ID 以项目盐值和服务端密钥散列后存储；自定义属性限制深度、字段数和序列化字节数，并对 Token、密码、Authorization 等敏感键执行服务端二次脱敏。平台默认不保存完整 IP。

### 【公开采集与管理接口的区别】

公开采集接口只接受 DSN 写入键，不能读取项目配置和监控数据。管理与查询接口依赖登录 Session、项目成员关系和 CSRF；Caddy 只允许私有网络访问 `/internal/metrics`。这三类入口不能复用同一种身份凭据。

## 5. 本地运行

### 【Docker Compose 启动】

1. 在仓库根目录执行 `pnpm install`。
2. 将 `platform/.env.example` 复制为 `platform/.env`，生产环境必须替换 Cookie、用户散列和数据库密钥。
3. 启动开发环境：

```bash
docker compose \
  --env-file platform/.env \
  --profile dev \
  -f platform/infra/docker-compose.yml \
  up --build
```

迁移容器会先创建普通关系表、TimescaleDB 扩展、Hypertable、连续聚合与保留策略。API 通过就绪检查后，Caddy 在 `http://localhost:8080` 提供平台；Mailpit 在 `http://localhost:8025` 展示开发验证邮件。

注册并验证账号后创建项目，将业务应用的完整 Origin 写入允许列表，再复制设置页生成的 DSN。`app.name` 必须与创建项目时填写的应用标识完全一致。

### 【Docker 构建上下文】

Compose 从整个 `browser-monitor/` 目录构建 API、Worker、迁移和 Web 镜像，以便这些镜像同时访问 workspace 锁文件、共享协议包和平台内部包。根目录 `.dockerignore` 会排除宿主机上的 `node_modules`、`dist`、缓存和日志，防止 Windows 下生成的 pnpm 链接与依赖布局被复制进 Linux 镜像。镜像内部始终依据 `pnpm-lock.yaml` 重新安装依赖，因此宿主机是否已经执行过构建不会改变容器结果。

### 【核心环境变量】

| 变量                             | 作用                                  |
| -------------------------------- | ------------------------------------- |
| `PUBLIC_BASE_URL`                | 生成邮件链接和项目 DSN 的平台公开地址 |
| `DATABASE_URL`、`REDIS_URL`      | TimescaleDB/PostgreSQL 与 Redis 连接  |
| `COOKIE_SECRET`                  | 登录 Cookie 签名密钥                  |
| `USER_HASH_SECRET`               | 用户 ID 项目级散列的服务端密钥        |
| `AUDIT_HEADER_ENCRYPTION_KEY`    | 32 字节 base64url 编码的审计请求头加密密钥；生产必须替换 |
| `SMTP_*`                         | 验证、重置密码和项目邀请邮件；Compose 开发环境使用 `mailpit:1025` |
| `INGEST_PROJECT_RATE_PER_SECOND` | 每项目稳定采集速率                    |
| `INGEST_PROJECT_BURST`           | 每项目允许的短时突发容量              |
| `WORKER_BATCH_SIZE`              | Worker 每轮最多领取的 Outbox 任务数   |
| `AUDIT_POLL_INTERVAL_MS`         | Audit Worker 领取 Lighthouse 任务的间隔 |
| `AUDIT_CHROME_PATH`              | Chrome/Chromium 可执行文件路径；容器内默认为 `/usr/bin/chromium` |
| `AUDIT_ALLOW_PRIVATE_TARGETS`    | 是否允许测试私网 URL；生产环境应保持 `false` |
| `DEBIAN_MIRROR_BASE`             | Audit Worker 构建 Chromium 时使用的 Debian HTTPS 镜像根地址 |

如果 Audit Worker 在下载 Chromium 时出现 `Failed to fetch http://deb.debian.org`，说明仍在使用旧的 Docker 构建层。当前 Dockerfile 会强制把 Debian 软件源切换为 HTTPS，并自动重试。请执行：

```bash
docker compose \
  --env-file platform/.env \
  -f platform/infra/docker-compose.yml \
  build --no-cache audit-worker
```

若官方源在当前网络不可达，在 `platform/.env` 中设置下面的国内 HTTPS 镜像后重复上述命令：

```dotenv
DEBIAN_MIRROR_BASE=https://mirrors.tuna.tsinghua.edu.cn
```

构建成功后再运行 `docker compose --env-file platform/.env --profile dev -f platform/infra/docker-compose.yml up`。`apt-get --fix-missing` 无法修复代理或镜像连接失败，因此不作为这里的解决方案。

## 6. 查询与管理接口

### 【采集、认证和项目】

| 方法与路径                                                  | 作用                         |
| ----------------------------------------------------------- | ---------------------------- |
| `POST /api/v3/ingest/:publicKey/envelopes`                  | 接收协议 3.0 批次            |
| `POST /api/v1/auth/register`                                | 注册并发送验证邮件           |
| `POST /api/v1/auth/verify-email`                            | 激活账号                     |
| `POST /api/v1/auth/login`、`POST /logout`                   | 创建或销毁 Session           |
| `POST /api/v1/auth/forgot-password`、`POST /reset-password` | 密码恢复                     |
| `GET/POST /api/v1/projects`                                 | 查询或创建项目               |
| `GET /api/v1/projects/:projectId`                           | 获取 DSN、Origin、成员和阈值 |
| `PUT /origins`、`POST /keys/rotate`                         | 更新 Origin 或轮换写入键     |
| `PUT /thresholds`、`POST /invitations`                      | 创建阈值版本或邀请成员       |
| `POST /dead-letters/:taskId/retry`                          | Owner 重试失败任务           |

### 【分析和运行接口】

| 方法与路径                              | 作用                                 |
| --------------------------------------- | ------------------------------------ |
| `GET /analytics/overview`               | 访问、会话、事件和性能健康度         |
| `GET /analytics/performance`            | 分钟/小时趋势、分位数和等级分布      |
| `GET /analytics/routes`                 | 页面 p75、样本量、异常率与 LoAF 密度 |
| `GET /analytics/events`                 | 自定义事件趋势和页面分布             |
| `GET /analytics/raw-events`             | 原始事件检索与游标分页               |
| `GET /analytics/service-status`         | 接收速率、积压、失败与死信明细       |
| `GET/PUT /lab-settings`                 | 查看掩码请求头或由 Owner 整体替换配置 |
| `POST/GET /lab-audits`                  | 创建实验室测试或查询项目测试历史     |
| `GET /lab-audits/:auditId`              | 查询进度、5 次明细和聚合分析报告     |
| `GET /health/live`、`GET /health/ready` | 存活与依赖就绪检查                   |
| `GET /internal/metrics`                 | Prometheus 运行指标                  |

分析路径都位于 `/api/v1/projects/:projectId` 之下，且会再次校验当前用户是否属于该项目。

## 7. 验证与容量测试

### 【功能检查】

仓库根目录提供一次性检查入口：

```bash
pnpm check
```

它依次执行协议包、SDK 和平台的 TypeScript 检查，运行核心测试，再构建协议包、SDK、API、Worker 和 Web。日常修改不需要反复运行所有低价值组合；涉及协议、采集事务、sequence 或权限边界时，优先补对应的核心用例。

### 【容量测试】

生产默认限流为每项目 100 events/s、突发 500。容量测试通过独立 Compose 覆盖文件放宽配额，避免把压测参数误带入生产默认值：

```bash
docker compose \
  --env-file platform/.env \
  --profile dev \
  -f platform/infra/docker-compose.yml \
  -f platform/infra/docker-compose.load.yml \
  up --build

MONITOR_DSN=http://localhost:8080/api/v3/ingest/bm_pk_xxx/envelopes \
MONITOR_ORIGIN=http://localhost:8080 \
MONITOR_APP_NAME=load-test \
k6 run platform/load/k6-ingestion.js
```

验收时同时观察 API p95、接收/拒绝数量、Outbox 积压、Worker 处理速率和死信数量。只看 HTTP 成功率不足以证明整条链路没有丢失或积压。

## 8. 完整链路报告

### 【阅读顺序】

README 用于接入、运行和接口速查；下面的报告按数据生命周期解释实现细节：

1. [平台架构与端到端链路](docs/01-平台架构与端到端链路.md)：先建立 SDK、协议、API、Worker、数据库和 Web 的整体关系；
2. [采集 API 与事务 Outbox](docs/02-采集API与事务Outbox.md)：理解 DSN、校验顺序、幂等、脱敏和可靠接收边界；
3. [Worker 投影与性能指标计算](docs/03-Worker投影与性能指标计算.md)：理解任务领取、sequence、final、评级、重试和死信；
4. [TimescaleDB 聚合与查询链路](docs/04-TimescaleDB聚合与查询链路.md)：理解明细、Rollup、分位数、缓存、游标和保留策略；
5. [可视化平台与运行排查](docs/05-可视化平台与运行排查.md)：从项目接入、页面使用一路定位到生产运行问题。
