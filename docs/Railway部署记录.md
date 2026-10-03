# Browser Monitor Railway 部署记录

> 仓库：`cxDlogver/browser-monitor`  
> 平台：Railway  
> 环境：`production`  
> 目标：在不购买自定义域名的情况下，先完成一次可公网访问的试运行部署。  
> 原则：记录实际执行步骤、架构取舍、问题和修复过程；不记录任何明文 Secret。

## 1. 部署目标与当前约束

Browser Monitor 本地通过 Docker Compose 运行，核心组件包括：

```text
Web
  ↓
API
  ↓
TimescaleDB / Redis
  ↓
Worker

可选：
Audit Worker
Mailpit
Caddy
```

Railway 当前 Hobby/Trial 环境存在资源限制，因此第一次线上试部署采用精简拓扑：

```text
Internet
   ↓
Railway Web Domain
   ↓
Web（Caddy + React）
   ↓ Railway Private Network
Backend（API + Worker）
   ├── TimescaleDB
   └── Redis
```

本次暂不部署：

- `audit-worker`：Chromium + Lighthouse 对内存、共享内存和系统依赖要求较高。
- `mailpit`：当前项目服务数量限制下无法继续增加服务。
- 单独的 Worker Service：为节省 Service 数量，Worker 暂时与 API 运行在同一个 backend Container 中。

## 2. 仓库部署结构核对

仓库是 pnpm Monorepo：

```text
browser-monitor/
├── protocol/
├── sdk/
└── platform/
    ├── apps/
    │   ├── api/
    │   ├── worker/
    │   ├── audit-worker/
    │   └── web/
    ├── packages/
    │   ├── database/
    │   └── shared/
    └── infra/
        ├── Dockerfile.backend
        ├── Dockerfile.web
        ├── Dockerfile.audit-worker
        ├── docker-compose.yml
        └── Caddyfile
```

Railway 构建继续以仓库根目录作为 Build Context，避免破坏 pnpm workspace 对 `protocol`、`database`、`shared` 等包的依赖。

## 3. Railway 项目与服务规划

使用 Railway Project：

```text
successful-elegance
└── production
```

第一次部署使用四个 Service：

| Service | 来源 | 作用 | 公网 |
| --- | --- | --- | --- |
| `web` | GitHub + `Dockerfile.web` | React 管理端 + Caddy | 是 |
| `backend` | GitHub + `Dockerfile.backend` | NestJS API + Worker | 否，Web 通过私网访问 |
| `timescaledb` | `timescale/timescaledb-ha:pg17` | 时序数据库 | 否 |
| `redis` | `redis:7.4-alpine` | Redis | 否 |

## 4. 为 Railway 调整 Caddy 上游地址

本地 Docker Compose 中，Caddy 原来固定代理：

```caddy
reverse_proxy api:3000
```

Railway 中 Service 名称和私有域名不同，因此将 Caddyfile 改为支持环境变量：

```caddy
reverse_proxy {$API_UPSTREAM:api:3000}
```

这样：

- 本地 Docker Compose 不设置 `API_UPSTREAM` 时仍使用 `api:3000`。
- Railway 中设置 `API_UPSTREAM=<backend private domain>:3000`。

对应 Git 提交：

```text
666230600ba0aa830bc6b6ab568b70bf513a4878
chore: make web API upstream configurable for Railway
```

## 5. TimescaleDB 配置

镜像：

```text
timescale/timescaledb-ha:pg17
```

环境变量：

```text
POSTGRES_DB=monitor
POSTGRES_USER=monitor
POSTGRES_PASSWORD=<Railway generated secret>
```

持久化卷：

```text
/home/postgres/pgdata/data
```

当前测试卷大小为 500 MB。

应用通过 Railway Private Network 连接数据库，不暴露数据库公网端口。

## 6. Redis 配置

镜像：

```text
redis:7.4-alpine
```

启动命令：

```bash
redis-server --appendonly yes
```

持久化卷：

```text
/data
```

当前测试卷大小为 500 MB。

Redis 仅通过 Railway Private Network 提供给 backend 使用。

## 7. Backend 配置

构建文件：

```text
platform/infra/Dockerfile.backend
```

由于当前 Service 数量受限，API 与 Worker 暂时在同一个 Container 中运行：

```bash
sh -c 'pnpm --filter @browser-monitor/api start & pnpm --filter @browser-monitor/worker start & wait -n'
```

这不是长期生产方案。正式部署更适合拆成：

```text
API Service
Worker Service
```

### 7.1 数据库迁移

Railway Pre-deploy Command：

```bash
pnpm --filter @browser-monitor/database migrate
```

迁移会在应用启动前执行，并负责创建项目需要的 PostgreSQL / TimescaleDB Schema 与扩展。

### 7.2 Health Check

```text
/health/ready
```

Timeout：

```text
120s
```

### 7.3 后端关键变量

实际部署通过 Railway Variables / Reference Variables 配置，不在文档中记录 Secret：

```text
NODE_ENV=production
PORT=3000
API_PORT=3000

DATABASE_URL=postgres://<user>:<secret>@<timescaledb private domain>:5432/monitor
REDIS_URL=redis://<redis private domain>:6379

COOKIE_SECRET=<Railway generated secret>
USER_HASH_SECRET=<Railway generated secret>
AUDIT_HEADER_ENCRYPTION_KEY=<valid base64url 32-byte secret>
```

第一次提交部署时，`PUBLIC_BASE_URL` 暂时使用占位地址。获得 Web Railway Domain 后再替换。

## 8. Web 配置

构建文件：

```text
platform/infra/Dockerfile.web
```

该镜像构建 React/Vite 静态文件，然后使用 Caddy 提供静态资源和 API Reverse Proxy。

Railway 变量：

```text
SITE_ADDRESS=:8080
PORT=8080
API_UPSTREAM=<backend Railway private domain>:3000
```

Health Check：

```text
/
```

Web 是第一次部署中唯一需要公开给用户浏览器访问的入口。

## 9. 邮件能力的当前限制

本地开发使用 Mailpit：

```text
API → SMTP → Mailpit
```

当前 Railway Trial 拓扑没有 Mailpit Service，因此：

- 注册邮箱验证
- 忘记密码邮件
- 邀请邮件

暂时不能作为完整功能验证项。

当前 SMTP 使用不可用的本地占位配置，仅为了满足应用配置 Schema。后续有三种方案：

1. 升级 Railway 套餐后增加 Mailpit，用于 Demo。
2. 接入真实 SMTP 服务。
3. 调整测试模式，使验证 Token 可以安全地从测试接口或日志获得。

## 10. 第一次部署后的验证顺序

部署完成后按下面顺序验证：

```text
1. TimescaleDB 启动
      ↓
2. Redis 启动
      ↓
3. Backend Pre-deploy Migration 成功
      ↓
4. API + Worker 启动
      ↓
5. /health/ready 返回 2xx
      ↓
6. Web Caddy 启动
      ↓
7. 生成 Railway Web Domain
      ↓
8. 修改 PUBLIC_BASE_URL 为 Web Domain
      ↓
9. 浏览器打开 Web
      ↓
10. 验证 Web → /api/* → Backend
      ↓
11. 验证 SDK → /api/v3/ingest/... → DB → Worker
```

## 11. 部署状态

### 已完成

- [x] 读取并确认 Monorepo 构建边界。
- [x] 确认 Backend / Web Dockerfile。
- [x] 确认 TimescaleDB 与 Redis 镜像。
- [x] 修改 Caddy，使 API upstream 可通过 Railway 变量覆盖。
- [x] 暂存 `web` Service。
- [x] 暂存 `backend` Service。
- [x] 暂存 `timescaledb` Service 与持久化卷。
- [x] 暂存 `redis` Service 与持久化卷。
- [x] 配置 Backend Pre-deploy Migration。
- [x] 配置 Health Check 和 Restart Policy。
- [x] 配置 Railway Private Network 引用变量。

### 待完成

- [ ] 提交 Railway staged changes。
- [ ] 等待首次 Build / Deploy。
- [ ] 分析 Build Log / Runtime Log。
- [ ] 生成 Web Railway Domain。
- [ ] 将 `PUBLIC_BASE_URL` 替换为真实 Web URL。
- [ ] 验证 Web → API。
- [ ] 验证 SDK ingestion。
- [ ] 记录部署失败与修复过程。
- [ ] 评估是否拆分独立 Worker。
- [ ] 评估正式 SMTP / Audit Worker 部署方案。

## 12. 当前架构取舍

这次部署的目标不是直接得到正式生产环境，而是验证：

```text
GitHub Source
   ↓
Railway Build
   ↓
Container
   ↓
Private Network
   ↓
Database / Redis
   ↓
Public HTTPS
   ↓
Browser Monitor
```

因此优先保证完整链路能够在线运行，再逐步补齐独立 Worker、Mail、Audit Worker、自定义域名、备份和更大的数据库存储。


## 13. 首次 Railway 部署执行记录

首次 staged changes 已提交到 Railway：

```text
Project: successful-elegance
Environment: production
Commit message: Deploy browser-monitor trial topology
```

首次部署同时触发四个 Service：

```text
redis
timescaledb
backend
web
```

截至本次记录：

| Service | 状态 |
| --- | --- |
| `redis` | SUCCESS |
| `timescaledb` | DEPLOYING |
| `backend` | BUILDING |
| `web` | BUILDING |

Backend 与 Web 已进入 Railway Docker Build 流程，构建日志显示 Railway 正确读取：

```text
platform/infra/Dockerfile.backend
platform/infra/Dockerfile.web
```

并以仓库根目录作为 Docker Build Context，因此 pnpm workspace 文件和内部 packages 可以正常进入构建上下文。

下一步需要等待 Backend / Web / TimescaleDB 首次 Deployment 结束；若失败，则根据 Railway Build Log、Deploy Log 和 Pre-deploy migration 日志继续定位，并把失败原因和修复过程继续追加到本文档。


## 14. Backend 首次部署失败与修复

### 14.1 失败现象

Railway 中以下服务状态正常：

```text
redis       SUCCESS
timescaledb SUCCESS
web         SUCCESS
backend     FAILED
```

Backend Docker Build 本身成功，`protocol`、`shared`、`database`、`api`、`worker` 均完成编译；Pre-deploy Migration 也能够启动。

真正失败发生在 Container Runtime 阶段。Railway Deploy Log 明确记录：

```text
sh: 1: wait: Illegal option -n
```

随后 `/health/ready` Health Check 持续返回 service unavailable，最终：

```text
1/1 replicas never became healthy
Healthcheck failed
```

### 14.2 根因

为了在 Hobby/Trial 的 Service 数量约束下将 API 与 Worker 临时运行在同一个 Container，首次 Start Command 使用：

```bash
sh -c 'pnpm --filter @browser-monitor/api start & pnpm --filter @browser-monitor/worker start & wait -n'
```

Railway 当前 Backend 镜像基于：

```dockerfile
FROM node:22-bookworm-slim
```

`sh` 对应 Debian 的 POSIX shell（通常为 dash），该 shell 的 `wait` 不支持 Bash 的 `-n` 参数，因此 Container 启动后立即报错退出。

问题不是 TypeScript Build、数据库迁移或 Health Check 路径本身，而是 Runtime Start Command 与实际 shell 能力不兼容。

### 14.3 第一轮修复

将 Backend Start Command 修改为：

```bash
sh -c 'pnpm --filter @browser-monitor/api start & pnpm --filter @browser-monitor/worker start & wait'
```

即去掉 `wait -n`，使用 POSIX shell 支持的 `wait`。

但紧接着触发的数次 Redeploy 仍然执行旧的 `wait -n` 命令。Railway Service 当前配置已经显示新命令，但旧 Deployment Snapshot 仍保留旧 Start Command，因此这些部署仍失败。

### 14.4 第二轮修复

确认 Service Config 已经是正确的：

```text
startCommand:
sh -c 'pnpm --filter @browser-monitor/api start & pnpm --filter @browser-monitor/worker start & wait'
```

随后重新触发一个新的 Deployment，使 Railway 从当前 Service Configuration 创建新的 Deployment Snapshot。

新的 Deployment ID：

```text
5ff476d7-642b-4a19-90cd-453942d9790f
```

截至本次记录，该部署处于：

```text
BUILDING
```

后续需要继续确认：

```text
BUILDING
  ↓
Pre-deploy Migration
  ↓
API + Worker Runtime
  ↓
/health/ready
  ↓
SUCCESS
```

### 14.5 本次排障结论

这次故障体现了三个需要区分的阶段：

```text
Build 成功
≠
Container 能正常启动
≠
Health Check 能通过
```

实际定位过程应按：

```text
Deployment Status
  ↓
Build Log
  ↓
Pre-deploy Log
  ↓
Deploy / Runtime Log
  ↓
Health Check
```

逐层定位，而不是看到 `FAILED` 就默认认为 Docker Build 失败。


## 15. 生成 Railway 公网域名并修正公开基地址

### 15.1 Web 公网域名

四个核心 Service 全部成功运行后，为 `web` Service 生成 Railway 提供的免费公网域名，并显式绑定到 Caddy 监听的 8080 端口：

```text
https://web-production-2d509.up.railway.app
```

当前公网拓扑变为：

```text
Internet
   ↓ HTTPS
web-production-2d509.up.railway.app
   ↓ Railway Edge
Web / Caddy :8080
   ↓ /api/*, /health/*
Railway Private Network
   ↓
Backend :3000
   ├── API
   └── Worker
   ↓
TimescaleDB / Redis
```

Backend、TimescaleDB、Redis 仍不创建 Public Domain，继续只通过 Railway Private Network 通信。

### 15.2 PUBLIC_BASE_URL 从占位值切换为真实 Web 地址

首次部署时，为了在尚未生成公网域名的情况下满足 API Configuration Schema，Backend 使用：

```text
PUBLIC_BASE_URL=https://placeholder.invalid
```

Web Domain 生成后，将 Backend 的 `PUBLIC_BASE_URL` 更新为：

```text
PUBLIC_BASE_URL=https://web-production-2d509.up.railway.app
```

修改该环境变量会触发 Backend 新版本部署。此次部署仅用于使运行中的 API 获得真实公网基地址，不改变代码和数据库结构。

`PUBLIC_BASE_URL` 会用于生成：

```text
/verify-email
/reset-password
/accept-invitation
```

等完整 URL，因此不能长期保留占位地址。

### 15.3 当前验证状态

Web Domain 已由 Railway 成功创建，Backend 因 `PUBLIC_BASE_URL` 变化正在执行新的 Deployment。

截至本次记录：

```text
redis        SUCCESS
timescaledb  SUCCESS
web          SUCCESS
backend      DEPLOYING
```

上一个 Backend Deployment 已经处于 SUCCESS，因此本次属于配置更新后的滚动发布。

第一次从外部执行 DNS/HTTPS 访问验证时，域名尚未在当前验证环境中完成 DNS 解析，因此公网访问验证暂记为“等待 Railway 域名解析/传播完成”，不能将该现象判断为应用启动失败。

后续验证顺序：

```text
Backend 新部署 SUCCESS
  ↓
Web Domain DNS 可解析
  ↓
GET /
  ↓
GET /health/ready
  ↓
Web /api/* → Backend
  ↓
注册/登录页面基础请求
  ↓
SDK ingestion
```


## 16. 公网域名配置完成后的状态与自动部署优化

### 16.1 Backend 配置更新部署成功

将 `PUBLIC_BASE_URL` 切换到真实 Railway Web Domain 后，Backend 自动触发新的 Deployment。

最终状态：

```text
redis        SUCCESS
timescaledb  SUCCESS
web          SUCCESS
backend      SUCCESS
```

对应最新 Backend Deployment：

```text
bb24e395-df09-4175-8277-70f1382e3ae8
SUCCESS
```

说明当前生产环境中：

- 数据库可运行。
- Redis 可运行。
- Database Migration 可执行。
- API + Worker 可共同启动。
- `/health/ready` 可通过 Railway Health Check。
- Web / Caddy 可启动。
- Backend 使用真实 `PUBLIC_BASE_URL` 后仍能健康运行。

### 16.2 Railway Web Domain 已绑定

当前 Web Service Domain：

```text
https://web-production-2d509.up.railway.app
```

Target Port：

```text
8080
```

Railway 侧已确认 Domain 绑定存在。Backend、TimescaleDB、Redis 仍不暴露公网。

### 16.3 避免纯文档提交触发应用重新构建

部署过程中发现一个工程问题：

```text
修改 docs/Railway部署记录.md
        ↓
GitHub main 产生 commit
        ↓
Railway 自动部署
        ↓
Backend / Web 都重新 Build
```

这对于 Monorepo 并不合理，因为文档变化不会改变运行产物，却会消耗构建时间和 Railway 资源。

因此给 Backend 与 Web 增加 Watch Patterns，只在以下路径变化时触发自动部署：

```text
/platform/**
/protocol/**
/package.json
/pnpm-lock.yaml
/pnpm-workspace.yaml
/.dockerignore
```

这样后续只修改：

```text
/docs/**
```

不会再无意义地重新构建 Web / Backend。

### 16.4 公网访问验证仍待完成

Railway 已创建并绑定 Service Domain，但在本次自动验证环境中执行 DNS 查询时仍返回：

```text
Temporary failure in name resolution
```

因此当前可以确认的是：

```text
Railway Domain 创建成功
+
Railway Service 全部 SUCCESS
+
内部 Health Check 通过
```

尚不能从当前验证环境独立确认：

```text
Public DNS
  ↓
HTTPS
  ↓
GET /
  ↓
Caddy
  ↓
Web
```

该项继续保留为下一步验证任务。若用户本地浏览器已经能够打开该 Railway Domain，则可以直接进入 Web → API → SDK 数据链路验证。


## 17. 公网链路验收

用户已在本地浏览器确认以下公网地址可以正常打开：

```text
https://web-production-2d509.up.railway.app
```

随后继续从可联网验证环境对公网链路进行检查。

### 17.1 Web 首页

请求：

```http
GET /
```

结果：

```text
200 OK
```

说明链路：

```text
Browser / HTTP Client
  ↓ HTTPS
Railway Public Domain
  ↓
Railway Edge
  ↓
Web Service :8080
  ↓
Caddy
  ↓
React 静态资源
```

已经可以正常工作。

### 17.2 Health Check 反向代理

请求：

```http
GET /health/ready
```

结果：

```http
200 OK

{"status":"ok"}
```

当前 Caddy 将 `/health/*` 代理到：

```text
backend.railway.internal:3000
```

因此该请求同时证明：

```text
公网 Web Domain
  ↓
Caddy
  ↓
Railway Private Network
  ↓
Backend
  ↓
NestJS Health Controller
```

链路可用。

### 17.3 API 反向代理

请求：

```http
GET /api/v1/auth/me
```

结果：

```http
401 Unauthorized

{"code":"authentication_required"}
```

这里的 `401` 是预期结果，因为请求没有登录 Session。

它反而证明了：

```text
/api/*
  ↓
Caddy Reverse Proxy
  ↓
Backend
  ↓
NestJS Route / Auth Guard
```

已经真正到达 API，而不是由 Web/Caddy 返回 404 或 502。

### 17.4 当前线上核心链路结论

截至本次验收，已经验证：

```text
Public HTTPS                 ✅
Railway Web Domain           ✅
React Web                    ✅
Caddy Static Hosting         ✅
Caddy Reverse Proxy          ✅
Railway Private Network      ✅
Backend API                  ✅
Backend Health Check         ✅
TimescaleDB                  ✅
Redis                        ✅
Worker Process               ✅
Database Migration           ✅
```

因此 Browser Monitor 已经从“本地 Docker Compose 可运行”进入“公网环境核心服务可运行”阶段。

尚未完成的业务级验收：

```text
注册 / 登录完整流程
  ↓
创建 Project
  ↓
生成公开 DSN
  ↓
业务页面接入 SDK
  ↓
POST /api/v3/ingest/:publicKey/envelopes
  ↓
Raw Event / Outbox
  ↓
Worker
  ↓
TimescaleDB 明细和聚合
  ↓
Web Dashboard 查询和展示
```

此外，由于当前 Railway Trial 拓扑未部署 Mailpit / 正式 SMTP，因此邮箱验证、密码重置和邀请邮件仍不属于当前可完整验收的能力范围。

## 18. 部署阶段总结

当前线上拓扑：

```text
Internet
   ↓ HTTPS
web-production-2d509.up.railway.app
   ↓
Railway Edge
   ↓
Web / Caddy :8080
   ├── Static React SPA
   ├── /api/* ───────────────┐
   └── /health/* ────────────┤
                              ↓
                    Railway Private Network
                              ↓
                     Backend :3000
                     ├── NestJS API
                     └── Worker
                         ↓
               ┌─────────┴──────────┐
               ↓                    ↓
          TimescaleDB              Redis
```

当前阶段最重要的工程结论：

1. Railway Project 对应一套系统，而 Service 对应独立运行单元。
2. Monorepo 需要保留仓库根目录作为 Docker Build Context，避免 workspace 依赖缺失。
3. PaaS 上不必复刻本地 Docker Compose 的所有网络暴露方式；Railway Edge 和 Private Network 替代了一部分本地 Caddy / Docker Network 职责。
4. Build Success、Container Runtime Success、Health Check Success 是三个不同阶段，必须分别排查。
5. 文档改动应通过 Watch Paths 排除，避免触发无意义生产构建。
6. 第一次试部署可以用 Railway 免费 `*.up.railway.app` 域名，不需要先购买自定义域名。
