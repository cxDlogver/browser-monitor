# Docker 体系源码学习

> **学习目标**：以 Browser Monitor 当前 Docker 配置为真实入口，建立能够用于实际开发、项目答辩和面试追问的 Docker 知识体系。学习顺序不是先背 \`docker run\`、\`docker build\` 等命令，而是按照“为什么需要容器 → Image 如何构建 → Container 如何运行 → Network / Volume / Environment 如何补齐运行条件 → Compose 如何组织多服务 → 如何做健康检查、调试、安全与生产治理”逐层展开。
>
> **分析范围**：项目事实以 \`browser-monitor/platform/infra\` 当前 Dockerfile、Compose、Caddy 配置和各 Package Script 为准；Docker 通用知识以 Docker 官方文档为主要依据。项目未实现的能力会标记为“主流方案 / 演进方向”，不把理想设计写成当前实现。
>
> **与已有知识的关系**：[\`Monorepo知识体系.md\`](./Monorepo知识体系.md) 已经解释 Repository、Workspace、Project Graph、Task Graph、Build Artifact 和 Runtime Graph 的区别。本文从“Build Artifact 如何进入稳定、可复现的运行环境”继续向下展开。

---

## 1. Docker 位于“构建产物 → 运行系统”的交界处

理解 Docker 前，先把它放回完整工程链路。

~~~text
Source Code
    ↓
Project Build
    ↓
Build Artifact
    ↓
运行环境
    ↓
Docker Image
    ↓
Container
    ↓
Network / Volume / Environment
    ↓
Multi-container Runtime
    ↓
Docker Compose
~~~

Monorepo 主要解决：

~~~text
源码如何组织
Project 如何发现
Project 如何依赖
Task 如何执行
~~~

Docker 继续解决：

~~~text
构建产物需要什么运行环境
这个运行环境如何被声明和复制
应用进程如何被隔离运行
多个进程如何组成一个完整系统
~~~

### 【Docker 的核心价值不是“能启动应用”，而是让运行环境可声明、可复制、可重建】

不用 Docker，Node.js API 仍然可以直接运行：

~~~bash
node dist/main.js
~~~

数据库、Redis、Web Server 也都可以直接安装在机器上。

Docker 解决的不是“没有 Docker 就不能运行”，而是传统运行方式中的环境一致性问题：

~~~text
开发机器
Node 22
pnpm 10
Chromium A
PostgreSQL A
Redis A

测试机器
Node 20
pnpm 9
Chromium B
PostgreSQL B
Redis B
~~~

应用代码相同，运行环境不同，结果可能不同。

Docker 将运行条件转成可以声明和构建的 Image：

~~~text
Dockerfile
    ↓
明确 Base Image
安装依赖
复制代码
执行 Build
声明启动命令
    ↓
Image
    ↓
不同 Docker Host 创建 Container
~~~

Docker 官方将 Docker 定义为用于开发、交付和运行应用的平台，并把 Image 描述为创建 Container 的模板，Container 则是 Image 的可运行实例。[[1]](https://docs.docker.com/get-started/docker-overview/)

**一句话总结**

> Docker 的核心价值是把“应用运行所需的环境和文件”变成可构建的 Image，再从同一 Image 可重复创建隔离 Container。

---

## 2. Docker 与 Virtual Machine 的区别来自隔离层不同

Docker 入门和面试最常见的问题之一是：

> Container 和 Virtual Machine（虚拟机）有什么区别？

### 【Virtual Machine 为每个实例提供完整 Guest OS】

可以简化为：

~~~text
Physical Machine
│
├── Host OS
│
└── Hypervisor
      │
      ├── VM A
      │    ├── Guest OS
      │    └── Application
      │
      └── VM B
           ├── Guest OS
           └── Application
~~~

每个 VM 都拥有相对完整的 Guest OS。

### 【Container 主要隔离进程视图而不是启动完整 Guest OS】

Container 可以理解为：

~~~text
Physical Machine
│
└── Host OS / Kernel
      │
      └── Container Runtime
            │
            ├── Container A
            │    └── Application Process
            │
            └── Container B
                 └── Application Process
~~~

Docker 官方说明，Docker 利用 Linux Kernel 的 Namespace 等能力提供 Container 隔离。[[1]](https://docs.docker.com/get-started/docker-overview/)

因此：

| 维度 | Virtual Machine | Container |
| --- | --- | --- |
| 隔离基础 | Hypervisor + Guest OS | Host Kernel 上的进程隔离 |
| Guest OS | 每个 VM 通常独立存在 | 不为每个 Container 启动完整 Guest OS |
| 启动成本 | 相对较重 | 相对较轻 |
| Image 规模 | 通常更大 | 通常更小 |
| 典型用途 | OS 级隔离 | Application Runtime 隔离 |

但不能简单说：

> Container 就是一个普通进程。

更准确的理解是：

> Container 最终确实对应 Host 上运行的进程，但这些进程通过 Namespace、Cgroup、Filesystem 等机制获得受限制的进程、网络、文件系统和资源视图。

入门阶段先建立这一层即可；Namespace、Cgroup、OCI、containerd、runc 属于后续底层实现知识。

---

## 3. Image 与 Container 构成 Docker 最核心的运行模型

最核心的关系可以先记成：

~~~text
Dockerfile
    ↓ docker build
Image
    ↓ docker run / compose up
Container
~~~

### 【Image 是构建后的只读模板】

一个 Image 可以包含：

~~~text
Base Linux 用户空间
Runtime
Dependency
Application Artifact
默认环境配置
默认启动命令
~~~

例如：

~~~dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

CMD ["node", "dist/main.js"]
~~~

执行：

~~~bash
docker build -t demo-api .
~~~

得到：

~~~text
demo-api Image
~~~

此时应用还没有作为业务进程运行。

### 【Container 是 Image 的运行实例】

执行：

~~~bash
docker run demo-api
~~~

之后才形成：

~~~text
Image
    ↓
Container
    ↓
Application Process
~~~

同一个 Image 可以创建多个 Container：

~~~text
             demo-api:1.0
                  │
        ┌─────────┼─────────┐
        ↓         ↓         ↓
 Container A  Container B  Container C
~~~

所以 Image 与 Container 的关系可以用一个帮助理解的类比：

~~~text
Image ≈ Template

Container ≈ Runtime Instance
~~~

类比只用于辅助理解，正式概念仍以“Image 是 Container 创建模板，Container 是 Image 的运行实例”为准。[[1]](https://docs.docker.com/get-started/docker-overview/)

---

## 4. Browser Monitor 同时使用现成 Image 和自建 Image

当前 \`docker-compose.yml\` 中存在两类 Image 来源。

### 【基础设施直接使用 Registry 中已有 Image】

当前：

~~~yaml
timescaledb:
  image: timescale/timescaledb-ha:pg17

redis:
  image: redis:7.4-alpine

mailpit:
  image: axllent/mailpit:v1.27
~~~

这些 Service 不需要当前项目自己维护 Dockerfile。

逻辑是：

~~~text
Registry 已有 Image
    ↓
Docker Pull
    ↓
Container
~~~

### 【业务应用通过 Dockerfile 自己 Build Image】

当前项目存在：

~~~text
Dockerfile.backend
Dockerfile.web
Dockerfile.audit-worker
~~~

Compose 中通过：

~~~yaml
build:
  context: ../..
  dockerfile: platform/infra/Dockerfile.backend
~~~

构建项目自己的 Image。

因此两种方式的职责分别是：

~~~text
image:
直接指定已有 Image

build:
根据 Dockerfile 构建当前项目 Image
~~~

这也是 Compose 中最基础的两个镜像来源。

---

## 5. Dockerfile 描述 Image 的构建过程

Dockerfile 本质上是一组 Image Build Instruction（镜像构建指令）。

Browser Monitor 当前三个 Dockerfile 正好覆盖：

~~~text
普通 Node Backend Image
Web Multi-stage Image
Chromium 特殊 Runtime Image
~~~

理解 Dockerfile 时不要孤立背指令，应沿：

~~~text
Base Image
    ↓
Build Environment
    ↓
Dependency
    ↓
Source
    ↓
Build Artifact
    ↓
Runtime Command
~~~

分析。

### 【FROM 决定 Base Image】

当前 Backend：

~~~dockerfile
FROM node:22-bookworm-slim
~~~

意味着：

~~~text
Debian Bookworm Slim 用户空间
+
Node.js 22
~~~

已经由 Base Image 提供。

当前项目不是从空文件系统开始构建 Node Runtime，而是在官方 Node Image 基础上增加自己的 Package、Source 和 Build Artifact。

Web 的第二阶段：

~~~dockerfile
FROM caddy:2.10-alpine
~~~

则说明最终 Runtime 不需要 Node，而是基于 Caddy Image 运行。

### 【ENV 设置 Image / Container 环境变量】

Backend：

~~~dockerfile
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
~~~

使后续 Build Instruction 和 Container Runtime 能找到 pnpm。

Dockerfile 官方文档中，\`ENV\` 用于设置环境变量，并会影响后续构建步骤以及从 Image 启动的 Container。[[2]](https://docs.docker.com/reference/dockerfile/)

### 【WORKDIR 定义后续构建和启动的默认目录】

当前：

~~~dockerfile
WORKDIR /workspace
~~~

之后：

~~~dockerfile
COPY ...
RUN ...
CMD ...
~~~

都会以 \`/workspace\` 作为默认工作目录。

它可以直观理解成：

~~~text
后续 Dockerfile Instruction 默认在 /workspace 下操作
~~~

### 【COPY 把 Build Context 中的文件复制进 Image】

当前 Compose：

~~~yaml
build:
  context: ../..
  dockerfile: platform/infra/Dockerfile.backend
~~~

Dockerfile 位于：

~~~text
browser-monitor/platform/infra/
~~~

而 \`context: ../..\` 指向：

~~~text
browser-monitor/
~~~

所以 Dockerfile 能够：

~~~dockerfile
COPY protocol ./protocol
COPY platform ./platform
~~~

Docker Build Context（构建上下文）决定 Dockerfile 构建过程中哪些 Host 文件可以被 COPY/ADD 使用。

因此：

> Dockerfile 所在目录和 Build Context 不是同一个概念。

当前实际是：

~~~text
Dockerfile Location
browser-monitor/platform/infra/

Build Context
browser-monitor/
~~~

---

## 6. Docker Layer 与 Build Cache 决定镜像构建效率

Dockerfile 并不是每次都从第一行完全重新执行。

Docker Build 会为可复用的构建步骤利用 Cache。Docker 官方说明，Builder 会按 Dockerfile Instruction 逐步检查是否存在可复用缓存；一旦某一步 Cache 失效，后续相关步骤需要重新执行。[[3]](https://docs.docker.com/build/cache/invalidation/)

### 【为什么先 COPY package.json 再 COPY Source】

当前 Backend Dockerfile：

~~~dockerfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY protocol/package.json ./protocol/package.json
COPY sdk/package.json ./sdk/package.json
COPY platform/package.json ./platform/package.json
COPY platform/apps/api/package.json ./platform/apps/api/package.json
COPY platform/apps/worker/package.json ./platform/apps/worker/package.json
COPY platform/apps/web/package.json ./platform/apps/web/package.json
COPY platform/packages/database/package.json ./platform/packages/database/package.json
COPY platform/packages/shared/package.json ./platform/packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY protocol ./protocol
COPY platform ./platform
~~~

这里没有直接：

~~~dockerfile
COPY . .
RUN pnpm install
~~~

原因是 Package Manifest 与业务 Source 的变化频率不同。

如果：

~~~text
COPY 全部源码
↓
RUN pnpm install
~~~

那么只修改：

~~~text
platform/apps/api/src/*
~~~

也会导致前面的 COPY Layer 发生变化，从而影响后续 Dependency Install Cache。

当前设计：

~~~text
先复制 package.json / lockfile
        ↓
pnpm install
        ↓
再复制 Source
        ↓
Build
~~~

意味着只修改业务源码时：

~~~text
Package Manifest 没变
        ↓
Dependency Layer 更容易复用
        ↓
跳过重复 install
        ↓
只重新复制 Source 并 Build
~~~

Docker 官方也把“先复制依赖清单、安装依赖、再复制源码”作为 Node 类应用提高 Cache 命中率的典型优化。[[4]](https://docs.docker.com/get-started/docker-concepts/building-images/using-the-build-cache/)

**面试回答**

> Dockerfile 顺序本身就是构建性能设计。低频变化、代价高的步骤尽量放在前面；高频变化的业务源码放在后面，可以最大化 Layer Cache 复用。

---

## 7. RUN、CMD 与 ENTRYPOINT 属于不同生命周期

这三个指令是 Docker 高频面试题。

可以先建立：

~~~text
RUN
Image Build 阶段执行

CMD
Container Start 时提供默认命令

ENTRYPOINT
定义 Container 的主要可执行入口
~~~

### 【RUN 在 docker build 阶段执行】

当前 Backend：

~~~dockerfile
RUN pnpm install --frozen-lockfile
~~~

以及：

~~~dockerfile
RUN pnpm --filter @browser-monitor/protocol build \
 && pnpm --filter @browser-monitor/shared build \
 && pnpm --filter @browser-monitor/database build \
 && pnpm --filter @browser-monitor/api build \
 && pnpm --filter @browser-monitor/worker build
~~~

它们发生在：

~~~text
docker build
~~~

阶段。

结果是：

~~~text
Dependency
+
Build Artifact
~~~

进入 Image。

Container 每次启动时不会重新执行这些 RUN。

### 【CMD 在 Container 启动阶段执行】

Backend：

~~~dockerfile
CMD ["pnpm", "--filter", "@browser-monitor/api", "start"]
~~~

它描述：

> 如果创建 Container 时没有提供其他启动命令，默认启动 API。

Dockerfile 官方将 CMD 定义为 Container 运行时的默认命令。[[2]](https://docs.docker.com/reference/dockerfile/)

### 【ENTRYPOINT 更强调固定主程序】

当前 Browser Monitor Dockerfile 没有使用 ENTRYPOINT。

通用上可以这样理解：

~~~text
ENTRYPOINT
更适合定义“这个 Image 的主要程序是什么”

CMD
可以作为默认命令，或者为 ENTRYPOINT 提供默认参数
~~~

例如主流设计：

~~~dockerfile
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
~~~

运行时可以覆盖 CMD 参数，但 ENTRYPOINT 仍保持 Node 主程序。

当前项目无需为了使用而强行引入 ENTRYPOINT；理解两者职责即可。

---

## 8. 同一个 Backend Image 可以运行不同 Process

当前 Backend Dockerfile 默认：

~~~dockerfile
CMD ["pnpm", "--filter", "@browser-monitor/api", "start"]
~~~

Compose 中 API 没有覆盖 command：

~~~yaml
api:
  build:
    dockerfile: platform/infra/Dockerfile.backend
~~~

因此：

~~~text
Backend Image
    ↓ 默认 CMD
API Process
~~~

但是 Worker：

~~~yaml
worker:
  build:
    dockerfile: platform/infra/Dockerfile.backend

  command:
    ["pnpm", "--filter", "@browser-monitor/worker", "start"]
~~~

Compose \`command\` 覆盖了 Image 的默认 CMD。

于是：

~~~text
同一个 Backend Image
        │
        ├── API Container
        │      ↓
        │   API Process
        │
        └── Worker Container
               ↓
            Worker Process
~~~

这说明：

> Image Boundary（镜像边界）与 Process Boundary（进程边界）并不一一对应。

同一个 Image 可以通过不同 Container Start Command 运行不同 Process。

**面试追问**

> 一个 Container 是否只能运行一个 Process？

严格来说 Container 中可以存在多个 Process，但工程实践通常倾向让一个 Container 围绕一个主要职责 / 主进程设计，这样生命周期、日志、健康检查和扩缩容更清晰。

当前 API 与 Worker 就是：

~~~text
共享 Image
但独立 Container / Process
~~~

---

## 9. Multi-stage Build 将构建环境与运行环境分离

当前 Web Dockerfile：

~~~dockerfile
FROM node:22-bookworm-slim AS build
...
RUN pnpm --filter @browser-monitor/web build

FROM caddy:2.10-alpine
COPY platform/infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/platform/apps/web/dist /srv
~~~

这就是 Multi-stage Build（多阶段构建）。

Docker 官方定义：一个 Dockerfile 可以包含多个 FROM，每个 FROM 开始一个新的 Build Stage，并可以只从前一个 Stage 复制需要的 Artifact 到最终 Image。[[5]](https://docs.docker.com/build/building/multi-stage/)

### 【第一阶段负责 Build】

~~~text
node:22-bookworm-slim
    ↓
pnpm install
    ↓
vite build
    ↓
dist/
~~~

这个阶段需要：

~~~text
Node.js
pnpm
TypeScript
Vite
Source Code
Build Dependency
~~~

### 【第二阶段只负责 Runtime】

~~~text
caddy:2.10-alpine
    ↓
COPY dist
    ↓
Caddy Serve Static Assets
~~~

最终 Runtime Image 不需要：

~~~text
Node.js
pnpm
Vite
完整 Source
开发依赖
~~~

因此 Multi-stage 的主要价值包括：

~~~text
Build Environment
与
Runtime Environment
分离
        ↓
最终 Image 更小
        ↓
不携带无关 Build Tool
        ↓
减少 Attack Surface
~~~

Docker 官方也明确指出 Multi-stage 能减少最终镜像中不需要的构建工具和文件，从而降低镜像体积和攻击面。[[6]](https://docs.docker.com/get-started/docker-concepts/building-images/multi-stage-builds/)

---

## 10. Audit Worker 使用独立 Image 是 Runtime Dependency Boundary 的体现

普通 API / Worker 需要：

~~~text
Node.js
Application Dependency
Build Artifact
~~~

Audit Worker 还需要：

~~~text
Lighthouse
chrome-launcher
Chromium
CA Certificates
~~~

当前：

~~~dockerfile
FROM node:22-bookworm-slim
...
RUN ... install ca-certificates ...
RUN ... install chromium ...
...
USER node
CMD ["node", "platform/apps/audit-worker/dist/main.js"]
~~~

如果把 Chromium 直接安装进通用 Backend Image：

~~~text
API
Worker
~~~

也会被迫携带：

~~~text
Chromium
Lighthouse Runtime Dependency
~~~

这会增加：

~~~text
Image Size
Build Time
Security Surface
Runtime Complexity
~~~

所以当前项目采用：

~~~text
Backend Image
├── API
└── Worker

Audit Image
└── Audit Worker + Chromium
~~~

这是典型的：

> 根据 Runtime Dependency 划分 Image Boundary。

---

## 11. Web Runtime 由 Caddy 提供静态文件与反向代理能力

Web Build 后：

~~~text
React / TypeScript
    ↓
Vite Build
    ↓
dist/
~~~

最终 Runtime：

~~~text
Caddy
    ↓
/srv
    ↓
HTML / JavaScript / CSS
~~~

Caddyfile：

~~~text
/api/*      → api:3000
/health/*   → api:3000
/internal/* → private network only → api:3000

其他路径
→ /srv Static Files
→ SPA fallback /index.html
~~~

因此当前 Web Container 不是：

~~~text
Node React Server
~~~

而是：

~~~text
Caddy Process
+
Web Static Artifact
~~~

同时承担入口反向代理。

---

## 12. Container Writable Layer 不适合承担长期持久化数据

Docker 创建 Container 时会为它提供可写文件系统层。Docker 官方说明，运行 Container 会获得可写层，但这个层属于 Container 生命周期。[[1]](https://docs.docker.com/get-started/docker-overview/)

如果数据库直接把数据只写进 Container Writable Layer：

~~~text
Database Container
└── Database Files
~~~

删除 Container 后，很难把这种数据当作长期独立状态管理。

因此数据库通常使用 Volume。

---

## 13. Volume 将持久化数据从 Container 生命周期中分离

当前 TimescaleDB：

~~~yaml
volumes:
  - monitor-timescale-data:/home/postgres/pgdata/data
~~~

Redis：

~~~yaml
volumes:
  - monitor-redis-data:/data
~~~

形成：

~~~text
TimescaleDB Container
        │
        ↓ mount
monitor-timescale-data

Redis Container
        │
        ↓ mount
monitor-redis-data
~~~

Docker 官方把 Volume 定义为由 Docker 管理的持久化数据存储，并指出 Volume 数据在使用它的 Container 被移除后仍可以保留。[[7]](https://docs.docker.com/engine/storage/volumes/)

所以：

~~~text
Container
可以删除 / 重建

Volume
独立保留
~~~

### 【Volume 与 Bind Mount 区别】

Volume：

~~~text
Docker 管理 Host 存储位置
适合数据库等长期持久化状态
~~~

Bind Mount：

~~~text
Host 明确路径
        ↓
直接挂载到 Container
~~~

例如开发环境：

~~~yaml
volumes:
  - ./src:/app/src
~~~

Docker 官方区分：

- Volume：存储位置由 Docker 管理；
- Bind Mount：Host 文件或目录直接挂入 Container。[[7]](https://docs.docker.com/engine/storage/volumes/) [[8]](https://docs.docker.com/engine/storage/bind-mounts/)

可以先记：

| 类型 | 更常见用途 |
| --- | --- |
| Named Volume | Database / Runtime Persistent Data |
| Bind Mount | 本地源码、配置、需要 Host 直接访问的文件 |
| tmpfs | 不需要持久化的临时内存数据 |

---

## 14. Audit Worker 的 tmpfs 体现临时写入与只读 Root Filesystem 的组合

当前 Audit Worker：

~~~yaml
read_only: true

tmpfs:
  - /tmp:size=1g,mode=1777
~~~

Dockerfile 又设置：

~~~dockerfile
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache
~~~

这形成：

~~~text
Root Filesystem
只读

/tmp
tmpfs 可写
~~~

Chromium/Lighthouse 在运行过程中需要临时文件和缓存，因此不能简单把整个 Container 都变成完全不可写。

当前方案是：

~~~text
不允许随意修改 Root FS
+
只给 /tmp 明确的临时写空间
~~~

Docker 官方说明 tmpfs 数据保存在内存中，不用于持久化，Container 停止后不会长期保留。[[9]](https://docs.docker.com/engine/storage/)

---

## 15. Docker Network 解决 Container 之间如何通信

当前 API 环境变量：

~~~text
DATABASE_URL=
postgres://monitor:...@timescaledb:5432/monitor

REDIS_URL=
redis://redis:6379
~~~

注意 Host 不是：

~~~text
localhost
~~~

而是：

~~~text
timescaledb
redis
~~~

原因在于 Compose 默认会为应用创建 Network，并使同一 Network 中的 Container 能够通过 Service Name 互相发现。Docker 官方说明，Compose 默认创建一个应用级网络，Service 在该网络中可以通过 Service Name 进行发现。[[10]](https://docs.docker.com/compose/how-tos/networking/)

因此：

~~~text
API Container
    │
    ├── timescaledb:5432
    └── redis:6379
~~~

### 【Container 中 localhost 指向 Container 自己】

如果 API Container 中访问：

~~~text
localhost:6379
~~~

含义是：

~~~text
API Container 自己的 6379
~~~

不是 Redis Container。

所以 Docker Compose 环境应该：

~~~text
redis:6379
~~~

而非：

~~~text
localhost:6379
~~~

这也是为什么当前 \`.env.example\` 的本地非 Docker 模式写：

~~~env
DATABASE_URL=postgres://monitor:monitor@localhost:5432/monitor
REDIS_URL=redis://localhost:6379
~~~

而 Docker Compose 写：

~~~text
timescaledb:5432
redis:6379
~~~

两种运行位置不同：

~~~text
Host Node Process
    ↓
localhost

Container Process
    ↓
Compose Service Name
~~~

这是 Docker 面试中非常高频的网络问题。

---

## 16. Port Mapping 解决 Host 如何访问 Container

当前 Web：

~~~yaml
ports:
  - "8080:8080"
~~~

TimescaleDB：

~~~yaml
ports:
  - "5432:5432"
~~~

Redis：

~~~yaml
ports:
  - "6379:6379"
~~~

格式：

~~~text
Host Port : Container Port
~~~

例如：

~~~text
Host localhost:8080
        ↓
Web Container :8080
~~~

需要区分两种通信：

~~~text
Host → Container
通常依赖 Published Port

Container → Container
直接通过 Docker Network + Service Name
~~~

因此 API Container 访问 Redis：

~~~text
redis:6379
~~~

并不需要先绕：

~~~text
Host localhost:6379
~~~

---

## 17. Environment Variable 把 Image 与不同运行环境解耦

同一份 Image 应尽量保持稳定：

~~~text
Same Image
~~~

不同环境通过 Runtime Config 改变：

~~~text
Development
DATABASE_URL=A

Staging
DATABASE_URL=B

Production
DATABASE_URL=C
~~~

当前 Compose 使用：

~~~yaml
environment:
  NODE_ENV:
  PUBLIC_BASE_URL:
  DATABASE_URL:
  REDIS_URL:
  COOKIE_SECRET:
  USER_HASH_SECRET:
  ...
~~~

因此可以理解为：

~~~text
Image
+
Runtime Environment
=
Container Runtime Configuration
~~~

### 【ARG 与 ENV 要区分 Build-time 和 Runtime】

Audit Dockerfile：

~~~dockerfile
ARG DEBIAN_MIRROR_BASE=https://deb.debian.org
~~~

Compose：

~~~yaml
build:
  args:
    DEBIAN_MIRROR_BASE: ...
~~~

它主要影响：

~~~text
Image Build 阶段
apt 使用哪个 Debian Mirror
~~~

而：

~~~dockerfile
ENV AUDIT_CHROME_PATH=/usr/bin/chromium
~~~

会进入 Image 配置并可影响 Container Runtime。

可以先记：

~~~text
ARG
主要服务于 Build-time

ENV
可以成为 Image / Container Environment
~~~

但安全上不能因为 ENV 方便，就把长期 Secret 直接 Bake 进 Image。

---

## 18. Docker Compose 描述的是整个 Multi-container Runtime Topology

Compose 不只是“一条命令启动很多 Container”。

它统一声明：

~~~text
有哪些 Service
每个 Service 使用什么 Image
是否需要 Build
环境变量是什么
暴露哪些 Port
挂载哪些 Volume
Service 如何联网
谁依赖谁
什么时候算 Healthy
退出以后是否 Restart
~~~

Docker 官方将 Compose 用于定义和运行 Multi-container Application，并通过 Compose File 描述 Service 等运行关系。[[11]](https://docs.docker.com/compose/)

---

## 19. Browser Monitor 当前 Compose 可以先按职责分成四类 Service

当前：

~~~text
基础设施
├── timescaledb
├── redis
└── mailpit

一次性初始化任务
└── migrate

业务 Application
├── api
├── worker
└── audit-worker

系统入口
└── web / Caddy
~~~

按职责理解比直接记八个 Service 更清楚。

### 【基础设施 Service】

TimescaleDB：

~~~text
时序 / 关系数据库
~~~

Redis：

~~~text
高速状态 / 缓存 / 限流等 Runtime Dependency
~~~

Mailpit：

~~~text
开发环境邮件接收与查看
~~~

### 【Migration 是 One-shot Job】

Migration：

~~~text
Start
↓
执行数据库 Schema Migration
↓
成功
↓
Exit 0
~~~

它不是一个长期监听请求的 Service。

### 【API / Worker / Audit Worker 是长期业务 Process】

~~~text
API
持续处理 HTTP Request

Worker
持续轮询 / 消费异步任务

Audit Worker
持续处理 Lighthouse 审计任务
~~~

### 【Web 是外部入口】

~~~text
Browser
↓
Web / Caddy
├── Static File
└── Reverse Proxy → API
~~~

---

## 20. depends_on 只描述依赖关系，Ready 需要 Health Check

Docker Compose 很常见的错误理解：

> A depends_on B，就代表 B 已经可以提供服务。

并不一定。

Docker 官方明确说明：Compose 默认只知道依赖 Container 是否已经启动，不会自动等待内部应用真正 Ready。要等待 Ready，需要通过 \`healthcheck\` 与 \`condition: service_healthy\`。[[12]](https://docs.docker.com/compose/how-tos/startup-order/)

### 【TimescaleDB 先通过 pg_isready】

当前：

~~~yaml
timescaledb:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U monitor -d monitor"]
~~~

Migration：

~~~yaml
depends_on:
  timescaledb:
    condition: service_healthy
~~~

执行链：

~~~text
TimescaleDB Container Start
        ↓
pg_isready
        ↓
Healthy
        ↓
Migration Start
~~~

### 【API 等待 Migration 成功完成】

API：

~~~yaml
depends_on:
  migrate:
    condition: service_completed_successfully
  redis:
    condition: service_healthy
~~~

因此：

~~~text
DB Healthy
    ↓
Migration
    ↓ completed successfully
API Start
~~~

Docker 官方当前支持：

~~~text
service_started
service_healthy
service_completed_successfully
~~~

三类 Condition。[[12]](https://docs.docker.com/compose/how-tos/startup-order/)

### 【Web 等待 API Healthy】

API 自己：

~~~yaml
healthcheck:
  test:
    ["CMD", "node", "-e", "fetch('http://localhost:3000/health/ready')..."]
~~~

Web：

~~~yaml
depends_on:
  api:
    condition: service_healthy
~~~

所以：

~~~text
API Process Start
    ↓
/health/ready
    ↓
Healthy
    ↓
Web Start
~~~

---

## 21. 当前 Compose 启动图体现三种不同生命周期

可以把完整启动关系整理为：

~~~text
TimescaleDB
      ↓ service_healthy
Migration
      ↓ service_completed_successfully
 ┌──────────┬──────────────┐
 ↓          ↓              ↓
API       Worker      Audit Worker
↑           ↑
│           │
Redis ──────┘
service_healthy

API
↓ service_healthy
Web
~~~

这里存在：

~~~text
Infrastructure
长期运行

One-shot Job
执行后退出

Application Service
长期运行

Entry Service
等待 API Ready 后启动
~~~

所以 Compose 编排的不是简单“顺序”，而是不同 Runtime Lifecycle 之间的依赖关系。

---

## 22. restart policy 描述 Container 退出后的生命周期策略

当前大多数 Service：

~~~yaml
restart: unless-stopped
~~~

而 Migration：

~~~yaml
restart: "no"
~~~

原因非常直接：

~~~text
API / Worker / DB
期望长期运行
异常退出后通常需要恢复

Migration
本来就是 One-shot Job
执行成功后退出是正常结果
~~~

因此：

> Restart Policy 要与 Process Lifecycle 一起设计，而不是所有 Service 都统一配置。

---

## 23. Compose Profile 用于控制可选开发 Service

当前：

~~~yaml
mailpit:
  profiles: ["dev"]
~~~

说明 Mailpit 不一定属于所有环境的固定 Runtime。

它更像：

~~~text
Development Support Service
~~~

需要时通过对应 Profile 启动。

这种设计适合：

~~~text
Mail Sandbox
Debug Tool
Local Mock
Development-only Service
~~~

将“所有环境都必须存在的 Service”和“特定环境可选 Service”分开。

---

## 24. SDK 不应该因为在 Monorepo 中就自动成为 Docker Service

Browser Monitor Workspace 中有：

~~~text
SDK
Protocol
Database Package
Shared Package
API
Worker
Audit Worker
Web
~~~

但 Compose 没有：

~~~yaml
sdk:
~~~

这不是遗漏。

SDK 生命周期：

~~~text
SDK Source
    ↓
Build
    ↓
JavaScript Package
    ↓
业务页面安装 / 引入
    ↓
Browser Runtime
~~~

API：

~~~text
Server Artifact
    ↓
Node Process
~~~

Worker：

~~~text
Worker Artifact
    ↓
Node Process
~~~

Web：

~~~text
Static Artifact
    ↓
Caddy
~~~

所以：

~~~text
Workspace Package
≠
Process
≠
Container
≠
Service
~~~

Docker Compose 管理的是 Runtime Service，而不是把 Monorepo 中每一个 Package 都变成一个 Container。

这也是 Monorepo 与 Docker 两套体系最重要的边界之一。

---

## 25. Docker 与本地非 Docker 启动解决的是不同问题

当前项目完全可以不用 Docker 启动 Node Application。

例如：

~~~text
本机安装：
TimescaleDB
Redis
Chrome / Chromium
SMTP
Node.js
pnpm
~~~

然后：

~~~text
pnpm build / dev
↓
API Process
Worker Process
Audit Worker Process
Web Dev Server
SDK Watch Build
~~~

这种模式的优点：

~~~text
调试直接
文件访问简单
开发反馈快
~~~

但本机需要自己维护所有依赖环境。

Docker 模式：

~~~text
Docker Image
↓
固定 Runtime
↓
Compose
↓
统一启动 DB / Redis / API / Worker / Web ...
~~~

更强调：

~~~text
环境一致
一键重建
运行拓扑可声明
依赖版本固定
~~~

因此：

> Docker 解决的是 Runtime Environment Management，不是 Node Application 唯一的运行方式。

---

## 26. Container Security 要从最小权限和最小写入面开始

当前 Audit Worker 已经体现多项 Container Hardening（容器安全加固）措施。

### 【使用 Non-root User】

Dockerfile：

~~~dockerfile
USER node
~~~

意味着 Runtime 不以 root 作为默认用户。

### 【Root Filesystem 只读】

Compose：

~~~yaml
read_only: true
~~~

减少 Runtime 进程修改基础文件系统的能力。

### 【只提供明确 tmpfs 写空间】

~~~yaml
tmpfs:
  - /tmp:size=1g,mode=1777
~~~

使 Chrome 仍有必要的临时空间。

### 【Drop Linux Capabilities】

~~~yaml
cap_drop:
  - ALL
~~~

减少 Container Process 的 Linux Capability。

### 【禁止获得新权限】

~~~yaml
security_opt:
  - no-new-privileges:true
~~~

进一步限制进程运行期间获取额外权限。

这组设计可以总结为：

~~~text
Non-root
+
Read-only Root FS
+
Explicit Temporary Writable Area
+
Drop Capabilities
+
No New Privileges
~~~

安全原则不是“Docker 天生安全”，而是：

> Container 提供隔离基础，实际安全性仍依赖 Image、用户权限、Capability、Filesystem、Secret、Network、Runtime 配置等具体设计。

---

## 27. Secret 不应该直接写死进 Image

当前 Compose 的敏感配置包括：

~~~text
COOKIE_SECRET
USER_HASH_SECRET
AUDIT_HEADER_ENCRYPTION_KEY
SMTP_PASSWORD
POSTGRES_PASSWORD
~~~

当前开发配置使用环境变量和默认值，例如：

~~~text
COOKIE_SECRET = local development default
~~~

这种默认值适合 Local Development，但 Production 不应该继续使用示例 Secret。

需要区分：

~~~text
Image
保存可复用程序和 Runtime

Secret
运行环境注入
~~~

主流生产方案包括：

~~~text
Environment Secret Injection
Docker Secret
Kubernetes Secret
Cloud Secret Manager
Vault
~~~

但当前仓库是否已经接入生产级 Secret Manager，需要单独查看部署配置，不能仅根据 Compose 推断。

---

## 28. Docker Debug 应建立固定排查链路

Docker 使用能力不能只会 \`docker compose up\`。

排查可以沿：

~~~text
Container 是否存在
    ↓
Container 是否 Running
    ↓
日志有什么错误
    ↓
环境变量是否正确
    ↓
网络是否连通
    ↓
文件和进程是否正确
    ↓
Healthcheck 是否通过
~~~

### 【查看 Container】

~~~bash
docker ps
docker ps -a
~~~

### 【查看日志】

~~~bash
docker logs <container>
docker logs -f <container>
~~~

Compose：

~~~bash
docker compose logs
docker compose logs -f api
~~~

### 【进入 Container】

~~~bash
docker exec -it <container> sh
~~~

Compose：

~~~bash
docker compose exec api sh
~~~

### 【查看详细配置】

~~~bash
docker inspect <container>
~~~

### 【查看 Image】

~~~bash
docker images
docker image history <image>
~~~

### 【查看 Volume】

~~~bash
docker volume ls
docker volume inspect <volume>
~~~

### 【查看 Network】

~~~bash
docker network ls
docker network inspect <network>
~~~

### 【查看 Compose 最终解析结果】

~~~bash
docker compose config
~~~

尤其当 Compose 使用：

~~~text
.env
Variable Interpolation
Anchor
Profile
~~~

时，\`docker compose config\` 很适合验证最终配置。

---

## 29. Docker 常用生命周期命令应该按对象理解

不要背成随机命令列表。

### 【Image Lifecycle】

~~~bash
docker build -t my-image .
docker images
docker pull redis:7.4-alpine
docker rmi my-image
~~~

### 【Container Lifecycle】

~~~bash
docker run ...
docker ps
docker stop <container>
docker start <container>
docker rm <container>
~~~

### 【Compose Application Lifecycle】

~~~bash
docker compose build
docker compose up
docker compose up -d
docker compose ps
docker compose logs
docker compose down
~~~

### 【重新 Build】

~~~bash
docker compose build
docker compose up -d --build
~~~

### 【指定 Profile】

~~~bash
docker compose --profile dev up
~~~

理解对象以后：

~~~text
Image Command
Container Command
Compose Application Command
~~~

边界就比较清楚。

---

## 30. Build Context 和 .dockerignore 共同影响构建输入

Docker Build Context 决定 Builder 能看到的文件范围。

当前：

~~~yaml
context: ../..
~~~

意味着 Browser Monitor Workspace 是构建上下文。

如果 Build Context 非常大：

~~~text
.git
node_modules
test output
local cache
logs
temporary files
~~~

都会增加 Builder 处理成本，甚至可能无意中进入 Build Context。

主流 Docker 工程会通过：

~~~text
.dockerignore
~~~

排除不需要进入 Build Context 的文件。

是否存在以及当前规则如何，需要读取仓库对应文件后再评价；这里先建立通用知识：

> Build Context 应只包含构建真正需要的输入，.dockerignore 用于减少无关文件和潜在敏感文件进入构建上下文。

---

## 31. Image Size 优化不能只看 Alpine

“换成 Alpine”不是完整的 Docker 优化方案。

真正的 Image Optimization 应同时看：

~~~text
Base Image
Build Stage
Runtime Dependency
Layer
Package Manager Cache
Source / Dev Dependency
System Package
~~~

常见方向：

~~~text
选择合理的 Base Image
↓
Multi-stage Build
↓
Runtime Image 不携带 Build Tool
↓
删除 apt cache / 临时文件
↓
只 COPY 必要 Artifact
↓
避免无关 Source
↓
减少重复 Layer
~~~

当前 Audit Dockerfile：

~~~dockerfile
rm -rf /var/lib/apt/lists/*
~~~

就是清理 apt Metadata，避免把不需要的 Package List 留在 Image 中。

当前 Web 则通过 Multi-stage：

~~~text
Node Build Stage
↓
只复制 dist
↓
Caddy Runtime
~~~

减少最终 Runtime Image 内容。

---

## 32. Reproducible Build 要避免“今天和明天 Build 出不同依赖”

当前 Backend：

~~~dockerfile
RUN pnpm install --frozen-lockfile
~~~

含义是：

> 安装必须按照已有 Lockfile，且当 Manifest 与 Lockfile 不一致时不自动修改 Lockfile。

这对 Container Build 非常重要，因为 Image 构建通常要求：

~~~text
同一个 Commit
+
同一组 Build Input
↓
尽可能得到稳定 Dependency Set
~~~

因此 Lockfile 与固定 Package Manager Version 都属于 Reproducible Build（可重复构建）设计的一部分。

当前根：

~~~json
"packageManager": "pnpm@10.28.2"
~~~

再配合：

~~~dockerfile
RUN corepack enable
RUN pnpm install --frozen-lockfile
~~~

是在构建过程中固定 pnpm 与 Dependency Resolution 规则。

---

## 33. Docker Compose 不等于 Kubernetes

Docker Compose 主要解决：

~~~text
单个 Docker Environment
↓
多个 Container 如何组成 Application
~~~

例如开发环境、单机部署、集成测试环境。

Kubernetes 继续解决：

~~~text
多机器 Cluster
↓
Scheduling
Replica
Self-healing
Rolling Update
Service Discovery
Load Balancing
Secret / Config
Resource Management
~~~

因此关系可以理解为：

~~~text
Dockerfile
解决 Image Build

Container Runtime
解决一个运行实例

Docker Compose
解决多个 Container 的应用拓扑

Kubernetes
解决 Cluster 级 Container Workload Orchestration
~~~

不能把：

~~~text
Docker → Compose → Kubernetes
~~~

理解成单纯“工具越来越高级”，而是管理对象逐渐扩大。

---

## 34. CI/CD 中 Docker 连接 Build、Release 与 Deploy

典型交付链：

~~~text
Git Commit
    ↓
CI
    ↓
Test / Build
    ↓
docker build
    ↓
Image
    ↓
Tag
    ↓
Registry Push
    ↓
Deployment Environment Pull
    ↓
Container Start
~~~

例如：

~~~text
my-api:1.4.2
my-api:<git-sha>
~~~

可以将某个 Git Commit 与具体 Image 关联起来。

这使 Rollback 也可以围绕已发布 Image Version 进行。

当前 Browser Monitor 是否已经存在自动 Registry Publish、Image Tagging、Production Deployment Workflow，需要查仓库 CI 配置后才能判断；这里只作为 Docker 在完整交付链中的主流位置。

---

## 35. Browser Monitor 的 Docker Runtime 可以用一张完整图复盘

~~~text
                           Host / Docker Engine
                                    │
                    ┌───────────────┴───────────────┐
                    │        Compose Network         │
                    │                               │
         ┌──────────▼──────────┐                    │
         │ TimescaleDB         │                    │
         │ pg17                │                    │
         │ Volume              │                    │
         └──────────┬──────────┘                    │
                    │ healthy                       │
                    ▼                               │
               ┌─────────┐                          │
               │ migrate │                          │
               │ one-shot│                          │
               └────┬────┘                          │
                    │ completed successfully        │
          ┌─────────┼──────────────┐                │
          ▼         ▼              ▼                │
       ┌─────┐   ┌──────┐    ┌─────────────┐       │
       │ API │   │Worker│    │Audit Worker │       │
       └──┬──┘   └──────┘    │+ Chromium   │       │
          ▲                    └─────────────┘       │
          │                                          │
   ┌──────┴───────┐                                  │
   │ Redis        │                                  │
   │ Volume       │                                  │
   └──────────────┘                                  │
          │                                          │
          │ API healthy                              │
          ▼                                          │
      ┌────────┐                                     │
      │ Web    │                                     │
      │ Caddy  │                                     │
      └───┬────┘                                     │
          │ :8080                                    │
──────────┼───────────────────────────────────────────┘
          ▼
       Browser
~~~

需要注意：

1. TimescaleDB 与 Redis 的数据通过 Named Volume 持久化。
2. Migration 是一次性 Job，不是长期 Service。
3. API / Worker 可以共享 Backend Image，但运行不同 Command。
4. Audit Worker 因 Chromium 需要单独 Image。
5. Web Runtime 使用 Caddy，不需要 Node。
6. Service 之间主要通过 Compose Default Network + Service Name 通信。
7. SDK 不属于 Compose Runtime Service，它是 Browser-side Package。

---

## 36. Docker 知识体系可以压缩成八个主分支

快速复习时，不需要先背命令。

~~~text
Docker
│
├── 1. Containerization
│   ├── 为什么需要 Container
│   ├── Docker vs VM
│   └── Process Isolation
│
├── 2. Image
│   ├── Image vs Container
│   ├── Registry
│   ├── Layer
│   └── Build Cache
│
├── 3. Dockerfile
│   ├── FROM
│   ├── WORKDIR
│   ├── COPY
│   ├── RUN
│   ├── ARG / ENV
│   ├── CMD / ENTRYPOINT
│   ├── USER
│   └── Multi-stage Build
│
├── 4. Container Runtime
│   ├── Process
│   ├── Port
│   ├── Environment
│   ├── Log
│   └── Restart
│
├── 5. Storage & Network
│   ├── Writable Layer
│   ├── Volume
│   ├── Bind Mount
│   ├── tmpfs
│   ├── Compose Network
│   └── Service Discovery
│
├── 6. Docker Compose
│   ├── Service
│   ├── image / build
│   ├── depends_on
│   ├── healthcheck
│   ├── profile
│   └── One-shot Job
│
├── 7. Engineering
│   ├── Build Context
│   ├── Layer Cache
│   ├── Multi-stage
│   ├── .dockerignore
│   ├── Reproducible Build
│   ├── Debug
│   └── CI Image Build
│
└── 8. Security & Production
    ├── Non-root
    ├── Read-only FS
    ├── Capability
    ├── Secret
    ├── Health Check
    ├── Registry
    └── Compose → Kubernetes
~~~

这八个分支分别回答：

~~~text
为什么容器化
↓
Image 怎么产生
↓
Container 怎么启动
↓
运行数据和网络怎么办
↓
多个 Container 怎么组成系统
↓
构建效率怎么保证
↓
运行安全怎么治理
↓
最终怎么进入生产交付
~~~

---

## 37. 面试高频问题应挂在对应知识主线下回答

### 【基础模型】

**Docker 解决什么问题？**

结论：Docker 主要解决运行环境可复现和应用隔离问题，把 Runtime、Dependency 和 Artifact 组织成 Image，再从 Image 创建 Container。

追问：

- 没有 Docker 能否运行应用？
- Docker 为什么比 VM 轻？
- Container 底层是否只是进程？
- Docker Engine、containerd、runc 分别是什么？

### 【Image 与 Container】

**Image 和 Container 有什么区别？**

结论：

~~~text
Image
静态构建模板

Container
Image 的运行实例
~~~

追问：

- 一个 Image 可以启动几个 Container？
- Container 修改文件会不会改 Image？
- Container 删除以后 Writable Layer 怎么办？

### 【Dockerfile】

**RUN、CMD、ENTRYPOINT 区别？**

~~~text
RUN
Build Image 时执行

CMD
Container 默认启动命令

ENTRYPOINT
Container 主执行程序
~~~

追问：

- Compose command 会覆盖什么？
- CMD 与 ENTRYPOINT 怎么配合？
- 为什么要用 Exec Form？

### 【Build Cache】

**为什么先 COPY package.json 再 COPY Source？**

结论：因为依赖文件变化频率低，先基于 Manifest 安装 Dependency 可以让 Dependency Layer 更容易复用 Cache，源码变化不必每次重新 install。

追问：

- COPY 变化为什么影响后续 Layer？
- .dockerignore 有什么作用？
- BuildKit Cache Mount 有什么作用？

### 【Multi-stage Build】

**为什么 Web Image 要分 Build Stage 和 Runtime Stage？**

结论：Build 阶段需要 Node / pnpm / Vite，Runtime 只需要静态文件和 Caddy，把两者分离可以降低最终 Image Size 和 Attack Surface。

追问：

- Node Backend 能不能也 Multi-stage？
- 为什么不能直接把 node_modules 和源码全部留在最终 Image？
- Runtime Image 是否越小越好？

### 【Network】

**为什么 Container 中不能用 localhost 访问 Redis Container？**

结论：Container 中的 localhost 指向自己；Compose 中其他 Service 通过 Default Network 和 Service Name 访问。

追问：

- Service Name 如何解析？
- Container IP 能不能直接写死？
- ports 是否影响 Container 间通信？

### 【Port】

**\`8080:80\` 怎么理解？**

~~~text
Host :8080
    ↓
Container :80
~~~

追问：

- EXPOSE 是否等于 Published Port？
- Container 间访问为什么不一定需要 ports？

### 【Storage】

**Volume 和 Bind Mount 区别？**

结论：

~~~text
Volume
由 Docker 管理
更适合 Runtime Persistent Data

Bind Mount
直接映射 Host Path
更适合开发源码 / Host 文件
~~~

追问：

- Container 删除后 Volume 还在吗？
- 数据库为什么不直接写 Container Layer？
- tmpfs 的数据在哪里？

### 【Compose】

**Docker Compose 解决什么问题？**

结论：Compose 把多 Container Application 的 Service、Image、Network、Volume、Environment 和依赖关系统一声明在一个配置中。

追问：

- image 与 build 区别？
- Compose 是不是生产编排工具？
- Docker Compose 与 Kubernetes 区别？

### 【depends_on】

**depends_on 是否保证数据库已经 Ready？**

结论：默认不等于 Ready；需要 healthcheck + service_healthy，或者使用 service_completed_successfully 等 Condition。[[12]](https://docs.docker.com/compose/how-tos/startup-order/)

项目示例：

~~~text
TimescaleDB Healthy
↓
Migration Success
↓
API Start
↓
API Healthy
↓
Web Start
~~~

### 【Security】

**Container 如何做最小权限？**

可以从：

~~~text
Non-root User
Read-only Root FS
Drop Capability
No New Privileges
Explicit Writable Mount
Secret Externalization
~~~

回答。

当前 Audit Worker 已经实践了前四类能力。

### 【架构边界】

**为什么 SDK 不放进 Docker Compose？**

结论：

> Docker Compose 管理 Runtime Service；SDK 是 Browser-side Package，Build 后被业务页面消费，不形成一个独立长期 Service。

这道题同时考察：

~~~text
Package
Process
Container
Service
~~~

四种边界是否真正理解。

---

## 38. 面试和答辩应沿一条统一主线介绍 Docker

如果需要完整介绍 Browser Monitor 的 Docker 设计，可以沿下面的顺序回答：

> 项目首先通过 Monorepo 管理 SDK、Protocol、API、Worker、Web 和内部 Package；各 Project Build 后会形成不同 Artifact。Docker 从 Artifact 之后接管 Runtime Environment。
>
> API 和普通 Worker 都运行在 Node 22 环境中，因此项目通过 Dockerfile.backend 构建统一 Backend Image，再由不同 Container Command 分别启动 API 和 Worker。Audit Worker 额外依赖 Chromium 和 Lighthouse，所以使用独立 Dockerfile，避免普通 Backend Image 携带不需要的浏览器 Runtime。
>
> Web 使用 Multi-stage Build：Node Stage 负责 Vite Build，最终只把 dist 复制到 Caddy Image。这样 Production Web Container 不需要 Node、pnpm 和前端源码。
>
> Compose 再把 TimescaleDB、Redis、Migration、API、Worker、Audit Worker、Web 组织成完整 Runtime。数据库和 Redis 使用 Named Volume 持久化；Service 之间通过 Compose Network 和 Service Name 通信；Host 通过 Published Port 访问 Web、数据库或 Redis。
>
> 启动过程不是简单的 Container 先后顺序。TimescaleDB 先经过 pg_isready 变成 Healthy，Migration 成功完成后 API/Worker 才启动，API readiness 通过后 Web 才启动。Migration 属于 One-shot Job，而其他业务进程属于 Long-running Service。
>
> 安全上 Audit Worker 使用 Non-root、Read-only Root Filesystem、tmpfs、Drop Capabilities 和 No New Privileges，体现 Container 最小权限设计。
>
> 因此 Docker 在这个项目里不是“把所有 Package 装进 Container”，而是把不同 Build Artifact 与对应 Runtime Dependency 组合成 Image，再通过 Compose 形成可重建的完整运行系统。

---

## 39. 后续深入可以沿四条主线继续

### 【Container 底层实现】

继续理解：

~~~text
Linux Namespace
Cgroup
Mount Namespace
Network Namespace
PID Namespace
Union Filesystem
OCI
containerd
runc
~~~

目标：

> 能解释 Container 为什么既是 Host Process，又拥有独立文件系统、网络和进程视图。

### 【Image Build 深入】

继续：

~~~text
Layer
OverlayFS
BuildKit
Cache Mount
Secret Mount
Multi-platform Build
Image Manifest
Registry
Image Digest
SBOM
~~~

目标：

> 能解释一个 Dockerfile 如何真正转成可缓存、可分发的 Image。

### 【Runtime 与安全深入】

继续：

~~~text
Linux Capability
Seccomp
AppArmor / SELinux
Rootless Docker
Resource Limit
CPU / Memory Limit
Read-only Filesystem
Container Escape
~~~

目标：

> 能说明“Container 隔离不是 VM 隔离”，以及生产环境如何进一步降低风险。

### 【Compose 到 Kubernetes】

继续：

~~~text
Compose Service
↓
Kubernetes Pod / Deployment / Service

Healthcheck
↓
Liveness / Readiness / Startup Probe

Environment
↓
ConfigMap / Secret

Volume
↓
PersistentVolume / PVC

restart
↓
Controller Self-healing
~~~

目标：

> 理解为什么从单机 Multi-container Application 扩展到 Cluster 后，需要 Kubernetes 这类 Orchestrator。

---

## 40. 参考资料

1. Docker Docs, **What is Docker?**：https://docs.docker.com/get-started/docker-overview/
2. Docker Docs, **Dockerfile reference**：https://docs.docker.com/reference/dockerfile/
3. Docker Docs, **Build cache invalidation**：https://docs.docker.com/build/cache/invalidation/
4. Docker Docs, **Using the build cache**：https://docs.docker.com/get-started/docker-concepts/building-images/using-the-build-cache/
5. Docker Docs, **Multi-stage builds**：https://docs.docker.com/build/building/multi-stage/
6. Docker Docs, **Multi-stage builds – Get Started**：https://docs.docker.com/get-started/docker-concepts/building-images/multi-stage-builds/
7. Docker Docs, **Volumes**：https://docs.docker.com/engine/storage/volumes/
8. Docker Docs, **Bind mounts**：https://docs.docker.com/engine/storage/bind-mounts/
9. Docker Docs, **Storage**：https://docs.docker.com/engine/storage/
10. Docker Docs, **Networking in Compose**：https://docs.docker.com/compose/how-tos/networking/
11. Docker Docs, **Docker Compose**：https://docs.docker.com/compose/
12. Docker Docs, **Control startup and shutdown order in Compose**：https://docs.docker.com/compose/how-tos/startup-order/
13. Browser Monitor：\`browser-monitor/platform/infra/docker-compose.yml\`
14. Browser Monitor：\`browser-monitor/platform/infra/Dockerfile.backend\`
15. Browser Monitor：\`browser-monitor/platform/infra/Dockerfile.web\`
16. Browser Monitor：\`browser-monitor/platform/infra/Dockerfile.audit-worker\`
17. Browser Monitor：\`browser-monitor/platform/infra/Caddyfile\`
18. Browser Monitor：\`browser-monitor/platform/.env.example\`
