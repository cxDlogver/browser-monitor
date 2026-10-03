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
