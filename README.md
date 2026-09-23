# Browser Monitor Monorepo

Browser Monitor 是一个完整的浏览器监控系统。仓库把浏览器 SDK、共享协议和监控平台收拢在同一个 pnpm workspace 中，但仍保持三者的发布边界和运行职责。业务页面只负责接入 SDK；采集接口、异步处理、指标聚合和可视化都由平台提供。

```text
业务页面
  → SDK 捕获浏览器事实并生成协议事件
  → Platform Ingestion API 接收批次并写入 Outbox
  → Worker 投影明细、计算指标并维护聚合
  → Analytics API 查询
  → React 管理后台展示
```

## 1. 工作区边界

### 【为什么使用一个独立根目录】

监控系统现在完整位于 `browser-monitor/`，不再把 workspace 配置、锁文件或三个子项目散落在 `cx-learn-notes` 根目录。这样可以从一个明确的工程根目录安装依赖、执行检查和构建镜像，也不会让学习笔记仓库中的其他项目被 Monitor 的依赖关系影响。

### 【三个项目分别负责什么】

| 目录 | 包名 | 职责 |
| --- | --- | --- |
| `sdk/` | `cx-browser-monitor-sdk` | 在浏览器中采集、加工、排队并发送遥测数据 |
| `protocol/` | `@browser-monitor/protocol` | 定义 SDK、API 与 Worker 共同遵守的协议 3.0 Schema、类型、枚举和测试夹具 |
| `platform/` | `@browser-monitor/platform` | 提供账号与项目管理、采集 API、异步处理、TimescaleDB 聚合和 React 看板 |

`protocol/` 是线上数据契约的唯一来源。SDK 不再保留 `src/protocol` 转发目录，而是直接依赖 `@browser-monitor/protocol`。SDK 内部尚未形成上报事件的浏览器事实放在 `sdk/src/signals/`；Raw Signal 只在 SDK 进程内流动，不属于跨项目协议。

## 2. 目录结构

### 【完整目录树】

```text
browser-monitor/
├─ .dockerignore                # 排除宿主机依赖和构建产物，避免写入 Linux 镜像
├─ package.json                 # 整个监控系统的统一检查和构建入口
├─ pnpm-workspace.yaml          # pnpm workspace 范围
├─ pnpm-lock.yaml               # 三个项目共享的依赖锁定结果
├─ sdk/
│  ├─ src/                     # Instrumentation、Signal、Collector、Processing、Transport
│  ├─ tests/                   # SDK 核心链路测试
│  └─ docs/                    # SDK 架构与各阶段实现说明
├─ protocol/
│  ├─ src/                     # 协议 3.0 Schema、类型、常量与 fixture
│  └─ tests/                   # 合法和非法协议请求测试
└─ platform/
   ├─ apps/
   │  ├─ api/                  # NestJS + Fastify 采集与管理 API
   │  ├─ worker/               # Outbox 消费、投影和指标计算
   │  ├─ audit-worker/         # 独立 Chrome + Lighthouse 实验室测试
   │  └─ web/                  # React + Vite 可视化平台
   ├─ packages/
   │  ├─ database/             # Drizzle 模型和 TimescaleDB migrations
   │  └─ shared/               # 配置、安全、隐私和指标阈值能力
   ├─ infra/                   # Docker Compose、Caddy 和容器构建文件
   ├─ load/                    # k6 采集容量脚本
   └─ docs/                    # 服务端到可视化完整链路报告
```

## 3. 依赖方向

### 【允许的依赖关系】

依赖只沿着明确方向流动：SDK、API、Worker 和数据库包可以依赖 Protocol；API 与 Worker 可以依赖 Database 和 Shared；Web 只通过 HTTP API 使用平台能力。Protocol 不依赖 SDK 或 Platform，SDK 也不引用 Platform 的实现代码。

```text
                 ┌──────────────┐
                 │   protocol   │
                 └──────┬───────┘
                        │
              ┌─────────┼──────────┐
              ↓         ↓          ↓
             SDK       API       Worker
                                  ↑
                    Database + Shared

业务浏览器：SDK ──HTTP──→ API
管理后台：Web ──HTTP──→ API
```

共享 workspace 的目的，是让编译器和测试使用同一份协议定义，而不是把三个项目合并成一个运行进程。SDK 仍然发布浏览器包，API、Worker 和 Web 仍然独立构建和部署。

## 4. 开发命令

### 【安装与完整检查】

所有命令都从本目录执行：

```bash
pnpm install
pnpm check
```

`pnpm check` 依次执行三个项目的类型检查、核心测试和生产构建。也可以按目的单独执行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

### 【启动监控平台】

```powershell
Copy-Item platform/.env.example platform/.env
docker compose --env-file platform/.env --profile dev -f platform/infra/docker-compose.yml up --build
```

启动后，Caddy 默认通过 `http://localhost:8080` 提供 Web 与 API，Mailpit 默认位于 `http://localhost:8025`。创建账号、验证邮箱并创建项目后，在项目设置中复制公开 DSN，再传给 SDK 的 `transport.dsn`。

## 5. 文档入口

### 【SDK 与协议】

- [SDK 使用说明](sdk/README.md)
- [SDK 项目知识梳理](sdk/docs/Browser-Monitor-SDK-项目知识梳理.md)
- [协议包说明](protocol/README.md)

### 【服务端与可视化】

- [Platform 使用与部署说明](platform/README.md)
- [平台架构与端到端链路](platform/docs/01-平台架构与端到端链路.md)
- [采集 API 与事务 Outbox](platform/docs/02-采集API与事务Outbox.md)
- [Worker 投影与性能指标计算](platform/docs/03-Worker投影与性能指标计算.md)
- [TimescaleDB 聚合与查询链路](platform/docs/04-TimescaleDB聚合与查询链路.md)
- [可视化平台与运行排查](platform/docs/05-可视化平台与运行排查.md)
