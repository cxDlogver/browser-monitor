# Docker 体系源码学习

> **学习目标**：先建立 Docker 的完整对象模型，再学习 Dockerfile、Image、Container、Network、Volume 和 Compose，最后回到 Browser Monitor 的真实配置做逐层映射。本文不默认读者已经了解当前项目；所有项目内容都先给出目录、文件和运行关系，再作为通用知识的工程案例。
>
> **事实边界**：Docker 通用机制以 Docker 官方文档为依据；项目事实以当前 browser-monitor/platform/infra、各应用 package.json 和 .env.example 为准。项目没有实现的能力会明确标记为“主流方案 / 演进方向”，不把理想设计写成当前实现。
>
> **与前置知识的关系**：Monorepo 解决“源码如何组织、Project 如何依赖、Task 如何构建”；Docker 从 Build Artifact 之后继续解决“运行环境如何打包、进程如何隔离、多个运行单元如何组成系统”。

---

## 1. Docker 的完整框架围绕 Build 与 Runtime 两个阶段展开

Docker 最容易学乱，是因为 Dockerfile、Image、Container、Volume、Network、Compose 经常被平铺成一组名词。更稳定的理解方式是先分成两个阶段。

~~~text
第一阶段：Build

Host Project Files
        ↓
Build Context
        ↓
Dockerfile
        ↓ docker build
Image


第二阶段：Runtime

Image
        ↓ docker run / docker compose up
Container
        ↓
Application Process
        ↓
Network / Port / Environment / Storage
        ↓
多个 Container
        ↓
Compose Application
~~~

这两个阶段回答不同问题：

| 阶段 | 核心问题 | 主要对象 |
| --- | --- | --- |
| Build | 怎样把应用和运行环境做成一个可复用模板？ | Dockerfile、Build Context、Layer、Cache、Image |
| Runtime | 怎样从模板创建真实运行实例，并让多个实例组成系统？ | Container、Process、Network、Port、Volume、Compose |

### 【Docker 的核心对象存在明确的上下游关系】

完整对象链可以先记成：

~~~text
Host Files
   ↓
Build Context
   ↓
Dockerfile
   ↓
Image
   ↓
Container
   ↓
Process
   ↓
Runtime Resources
   ├── Network
   ├── Port
   ├── Environment
   └── Storage
   ↓
Compose
~~~

每个对象分别解决：

| 对象 | 解决的问题 |
| --- | --- |
| Dockerfile | Image 应该怎么构建 |
| Build Context | Docker Build 可以读取哪些 Host 文件 |
| Image | 保存可重复创建 Container 的文件、Runtime 和默认配置 |
| Container | Image 的一个运行实例 |
| Process | Container 中真正执行的程序 |
| Volume | 与 Container 生命周期分离的数据 |
| Network | Container 之间如何通信 |
| Compose | 多个 Container 怎样组成一个应用 |

先建立这张表，后面的 Docker 指令才有位置。

### 【Docker 解决的是运行环境一致性，不是“让代码能够运行”】

没有 Docker，应用依然可以运行。例如 Node.js 应用可以直接：

~~~bash
node dist/main.js
~~~

问题在于开发、测试和生产机器可能分别安装：

~~~text
机器 A
Node 22
Redis 7.4
Chromium X

机器 B
Node 20
Redis 7.2
Chromium Y
~~~

代码相同，但运行环境不同。

Docker 将这些运行条件转换成可声明、可构建的 Image：

~~~text
Base Runtime
+
System Dependency
+
Application Dependency
+
Application Files
+
Default Runtime Config
        ↓
Image
~~~

Docker 官方将 Image 定义为创建 Container 的只读模板，将 Container 定义为 Image 的可运行实例。[[1]](https://docs.docker.com/get-started/docker-overview/)

### 【Container 与 Virtual Machine 的差异来自隔离层不同】

Virtual Machine：

~~~text
Physical Machine
    ↓
Host OS
    ↓
Hypervisor
    ├── Guest OS A → Application A
    └── Guest OS B → Application B
~~~

Container：

~~~text
Physical Machine
    ↓
Host OS / Kernel
    ↓
Container Runtime
    ├── Isolated Process A
    └── Isolated Process B
~~~

Container 通常共享 Host Kernel，而不是每个 Container 再启动完整 Guest OS，因此更轻量。Docker 使用 Linux Namespace 等能力为 Container 提供隔离视图。[[1]](https://docs.docker.com/get-started/docker-overview/)

但需要避免一个过度简化：

> Container 不是“完全等于普通进程”，而是被 Namespace、Cgroup、Filesystem 等机制隔离和限制后的进程运行环境。

Namespace、Cgroup、OCI、containerd、runc 属于后续深入层，不是入门第一步。

---

## 2. Build 阶段把 Host 文件逐步转换成 Image

Build 阶段的主链只有四个核心对象：

~~~text
Host Project
    ↓
Build Context
    ↓
Dockerfile Instructions
    ↓
Image Layers
    ↓
Final Image
~~~

理解这一章以后，WORKDIR、COPY、Layer Cache、Multi-stage Build 才不会变成孤立知识点。

### 【Host Filesystem、Build Context 与 Image Filesystem 是三套不同空间】

先使用一个完全脱离具体项目的例子：

~~~text
Host 电脑

my-app/
├── package.json
├── src/
└── Dockerfile
~~~

执行：

~~~bash
docker build -t my-app .
~~~

最后的点表示 Build Context 是当前 my-app/ 目录。

此时存在三套路径：

~~~text
1. Host Filesystem
   /Users/me/projects/my-app

2. Build Context
   my-app/ 这一棵可供 Builder 读取的文件树

3. Image Filesystem
   Docker Image 内部自己的 /
~~~

Dockerfile：

~~~dockerfile
COPY package.json /app/package.json
~~~

含义不是“复制到 Host 的 /app”，而是：

~~~text
Build Context
package.json
     ↓ COPY
Image Filesystem
/app/package.json
~~~

Docker 官方说明，COPY 的源路径相对于 Build Context Root 解析。[[2]](https://docs.docker.com/reference/dockerfile/)

### 【WORKDIR 创建的是 Image 内部工作目录】

例如：

~~~dockerfile
FROM node:22-bookworm-slim
WORKDIR /workspace
~~~

这里的 /workspace 不是要求 Host Project 中存在一个 workspace 目录。

它表示：

> 在正在构建的 Image Filesystem 中，把 /workspace 设置为后续指令的默认工作目录；如果目录不存在，Docker 会创建它。[[2]](https://docs.docker.com/reference/dockerfile/)

所以：

~~~dockerfile
WORKDIR /workspace
COPY package.json ./
~~~

最终得到：

~~~text
Image Filesystem

/
└── workspace/
    └── package.json
~~~

这里的 ./ 指 Image 内部当前 WORKDIR，而不是 Host 当前目录。

这也是为什么不能通过“我项目根目录没有 workspace 文件夹”来判断 Dockerfile 是否正确。

### 【FROM、WORKDIR、COPY、RUN 组成最基础的 Image Build 流程】

通用例子：

~~~dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY src ./src

RUN npm run build
~~~

执行顺序：

~~~text
FROM
选择 Base Image
    ↓
WORKDIR
确定 Image 内工作目录
    ↓
COPY Manifest
把依赖声明复制进 Image
    ↓
RUN npm ci
在 Build 阶段安装依赖
    ↓
COPY Source
复制业务源码
    ↓
RUN npm run build
生成 Build Artifact
    ↓
得到 Final Image
~~~

每条指令都不是“配置说明”而已，它们共同定义 Image 的构建过程。

### 【Image Layer 保存每一步产生的文件系统变化】

Docker Image 由 Layer 组成。Docker 官方说明，Image 是不可变的，并由多个 Layer 构成，每个 Layer 表示一组文件系统变化。[[3]](https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-an-image/)

例如：

~~~dockerfile
FROM node:22
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src ./src
RUN npm run build
~~~

可以先用概念图理解：

~~~text
Layer 1
Base Image

Layer 2
设置 /app

Layer 3
加入 package.json

Layer 4
npm install 产生依赖文件

Layer 5
加入 src

Layer 6
npm run build 产生 dist
~~~

重点不是死记“每一行一定严格对应一个物理 Layer 文件”，而是理解：

> Image Build 是逐步叠加文件系统结果的过程，Docker 可以针对这些步骤复用以前的构建结果。

### 【Build Cache 缓存的是某一步构建后的结果】

Layer Cache 最容易被误解成“缓存 Dockerfile 文本”。

实际上更接近：

> Docker 记录某条 Build Instruction 在特定输入下已经得到过什么构建结果；下一次输入相同，就可以复用结果，不重新执行昂贵步骤。

第一次构建：

~~~text
COPY package.json
    ↓
RUN npm install
    ↓
产生 node_modules
    ↓
COPY src
    ↓
RUN npm run build
    ↓
产生 dist
~~~

第二次如果只改：

~~~text
src/user.ts
~~~

而 package.json 没变化：

~~~text
COPY package.json
Cache Hit
    ↓
RUN npm install
Cache Hit，不重新安装
    ↓
COPY src
Cache Miss
    ↓
RUN npm run build
重新执行
~~~

如果 package.json 变化：

~~~text
COPY package.json
Cache Miss
    ↓
RUN npm install
重新执行
    ↓
后续步骤继续重新构建
~~~

Docker 官方说明，一旦某个步骤 Cache 失效，后续步骤通常也需要重新生成；并建议把变化较少的步骤放在变化频繁的步骤之前。[[4]](https://docs.docker.com/build/cache/invalidation/)

所以更准确地记：

~~~text
Build Cache
=
以前已经计算过的 Build Step Result
~~~

它解决的不是 Runtime 性能，而是减少重复 Image Build 成本。

### 【为什么依赖清单通常先于 Source COPY】

错误但常见：

~~~dockerfile
COPY . .
RUN npm install
RUN npm run build
~~~

只修改一行业务代码：

~~~text
src/user.ts changed
↓
COPY . . 输入变化
↓
npm install 之前的 Cache 链被打断
↓
重新安装依赖
~~~

更合理：

~~~dockerfile
COPY package.json package-lock.json ./
RUN npm install

COPY src ./src
RUN npm run build
~~~

这样：

~~~text
依赖声明没变
↓
npm install Cache 可复用

业务源码变了
↓
只重新 COPY Source + Build
~~~

这不是固定语法要求，而是利用 Cache Dependency 的工程优化。

### 【Multi-stage Build 把构建环境和运行环境分开】

一个前端项目构建时需要：

~~~text
Node.js
npm / pnpm
TypeScript
Vite
Source Code
~~~

但运行构建后的静态网站只需要：

~~~text
Web Server
HTML / JS / CSS
~~~

因此：

~~~dockerfile
FROM node:22 AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build

FROM caddy:alpine
COPY --from=build /app/dist /srv
~~~

逻辑：

~~~text
Stage 1：Build

Source
↓
Node + Build Tool
↓
dist/


Stage 2：Runtime

Caddy
+
dist/
↓
Final Image
~~~

Docker 官方把这种设计称为 Multi-stage Build，并支持从前一个 Stage 只复制所需 Artifact。[[5]](https://docs.docker.com/build/building/multi-stage/)

主要收益：

~~~text
不把 Build Tool 带入 Runtime
↓
Final Image 更小
↓
减少不必要文件和依赖
↓
降低 Attack Surface
~~~

### 【Build Context 与 .dockerignore 共同控制构建输入】

Build Context 如果包含：

~~~text
node_modules
.git
logs
local cache
temporary files
secret files
~~~

会增加构建输入规模，也增加误复制风险。

.dockerignore 用于排除不需要进入 Docker Build Context 的文件。

需要分清：

~~~text
.gitignore
控制 Git

.dockerignore
控制 Docker Build Context
~~~

---

## 3. Runtime 阶段从 Image 创建 Container 并启动真正的程序

Build 阶段结束后只有 Image。

Image 本身不会处理 HTTP，也不会消费任务。

真正进入 Runtime：

~~~text
Image
↓
Create Container
↓
Apply Runtime Config
↓
Start Container
↓
Execute Main Command
↓
Application Process Running
~~~

### 【Container 是运行环境，Process 才是真正执行程序的主体】

例如一个 Node API：

~~~text
TypeScript Source
    ↓ tsc
dist/main.js
    ↓ 被放入 Image
Node Runtime + dist/main.js
    ↓ docker run
Container
    ↓
node dist/main.js
    ↓
Node Process
    ↓
持续监听 HTTP Request
~~~

这里每一层职责不同：

| 对象 | 含义 |
| --- | --- |
| dist/main.js | Build Artifact，编译后的应用文件 |
| Image | 保存 Node Runtime、依赖和 Artifact |
| Container | Image 的一个隔离运行实例 |
| node dist/main.js | Container 启动时执行的命令 |
| Node Process | 真正持续执行 JavaScript 和处理请求的 OS Process |

所以“API Artifact → Node Process”过于压缩。

完整表达应该是：

~~~text
API TypeScript
↓ tsc
dist/main.js
↓ Build into Image
API Image
↓ create Container
Container
↓ execute node dist/main.js
Node API Process
↓
监听端口并处理请求
~~~

Worker 同理，但长期工作不同：

~~~text
Worker TypeScript
↓ tsc
dist/main.js
↓
Image
↓
Container
↓
node dist/main.js
↓
Node Worker Process
↓
轮询 / 消费后台任务
~~~

### 【CMD 是 Image 的默认启动命令】

例如：

~~~dockerfile
CMD ["node", "dist/main.js"]
~~~

它不会在 docker build 时执行。

它的含义是：

> 当这个 Image 创建 Container，并且 Runtime 没有另外指定命令时，默认执行 node dist/main.js。

Docker 官方把 CMD 定义为 Container 的默认命令。[[6]](https://docs.docker.com/reference/dockerfile/)

因此：

~~~text
RUN
Build 时真的执行

CMD
Build 时不执行
只保存 Runtime Default
~~~

### 【Compose command 覆盖 CMD 后，原 CMD 本次不会生效】

假设 Image：

~~~dockerfile
CMD ["node", "api.js"]
~~~

直接：

~~~bash
docker run my-image
~~~

执行：

~~~text
node api.js
~~~

如果 Compose：

~~~yaml
services:
  worker:
    image: my-image
    command: ["node", "worker.js"]
~~~

这个 Worker Container 启动时执行：

~~~text
node worker.js
~~~

而不是：

~~~text
node api.js
~~~

所以：

> Compose 的 command 覆盖 Image 中 Dockerfile 的默认 CMD；对于这个 Container，本次启动时原 CMD 不再执行。Docker 官方 Compose Reference 明确说明 command overrides the default command declared by the container image。[[7]](https://docs.docker.com/reference/compose-file/services/)

但是 Image 本身没有被修改。

另一个 Container 如果没有指定 Compose command：

~~~text
仍然使用原来的 CMD
~~~

所以：

~~~text
CMD
Image-level Default

Compose command
Container-level Override
~~~

### 【ENTRYPOINT 与 CMD 共同决定最终执行命令】

简单模型：

~~~text
ENTRYPOINT
定义固定主程序

CMD
定义默认命令 / 默认参数
~~~

例如：

~~~dockerfile
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
~~~

最终：

~~~text
node dist/main.js
~~~

当前 Browser Monitor 自建 Dockerfile 没有显式 ENTRYPOINT，因此不需要为了学习而强行加入项目实现，但面试需要理解通用语义。Docker 官方给出了 CMD 与 ENTRYPOINT 的组合规则。[[6]](https://docs.docker.com/reference/dockerfile/)

### 【ARG 与 ENV 分别服务 Build-time 和 Runtime Configuration】

通用理解：

~~~text
ARG
主要给 docker build 使用

ENV
写入 Image Environment
并影响 Container Runtime
~~~

例如：

~~~dockerfile
ARG PACKAGE_MIRROR
ENV NODE_ENV=production
~~~

可以理解为：

~~~text
PACKAGE_MIRROR
影响 Image 怎么构建

NODE_ENV
影响 Container 里的程序怎么运行
~~~

Secret 不应该因为方便就长期写死进 Dockerfile ENV。

### 【Port Mapping 是 Host 与 Container 的网络边界】

例如：

~~~yaml
ports:
  - "8080:3000"
~~~

含义：

~~~text
Host :8080
    ↓
Container :3000
~~~

Host 浏览器访问 localhost:8080，会被转发到 Container 内应用监听的 3000。

需要区分：

~~~text
Container 内部监听端口
≠
Host Published Port
~~~

Container 与 Container 在同一 Docker Network 通信时，通常直接使用：

~~~text
service-name:container-port
~~~

不需要绕 Host Published Port。

---

## 4. Storage 与 Network 补齐 Container 的运行条件

Container 不是单纯“把进程放进去”。程序还需要：

~~~text
数据存在哪里
如何访问别的 Service
Host 如何访问它
配置从哪里来
~~~

因此 Runtime 还要理解 Storage 和 Network。

### 【Container Writable Layer 与 Container 生命周期绑定】

运行中的 Container 可以修改自己的文件系统：

~~~text
Image Read-only Layers
        +
Container Writable Layer
~~~

如果只把数据库数据写进 Container Writable Layer：

~~~text
Database Container
└── database files
~~~

这些数据和 Container 生命周期强绑定。

Docker 官方说明，Container 删除时，没有保存到 Persistent Storage 的状态会消失。[[1]](https://docs.docker.com/get-started/docker-overview/)

长期状态应该从 Container 生命周期中分离。

### 【Volume 用于 Docker 管理的持久化数据】

Named Volume：

~~~yaml
services:
  db:
    volumes:
      - db-data:/var/lib/database

volumes:
  db-data:
~~~

关系：

~~~text
Container
/var/lib/database
        │
        ↓ mount
Docker Volume
db-data
~~~

即使重新创建 Container：

~~~text
old Container deleted
↓
new Container created
↓
mount same Volume
↓
继续读取原数据
~~~

Docker 官方建议 Volume 用于持久化数据，并指出它由 Docker 管理。[[8]](https://docs.docker.com/engine/storage/volumes/)

### 【Bind Mount 直接映射 Host 路径】

例如：

~~~yaml
volumes:
  - ./src:/app/src
~~~

关系：

~~~text
Host
./src
  ↕
Container
/app/src
~~~

Bind Mount 常用于：

~~~text
本地开发源码
配置文件
需要 Host 直接编辑 / 查看的数据
~~~

Volume 与 Bind Mount 更准确的区别：

| 类型 | 存储位置由谁决定 | Host 是否直接按路径操作 |
| --- | --- | --- |
| Volume | Docker | 通常不依赖固定 Host Path |
| Bind Mount | 用户指定 Host Path | 是 |
| tmpfs | Memory | 不做长期持久化 |

### 【tmpfs 适合不需要持久化的临时写入】

有些程序运行时需要：

~~~text
temporary files
cache
browser profile
socket
~~~

但不需要 Container 重建后保留。

tmpfs 可以理解为：

~~~text
Memory-backed Temporary Storage
↓
允许临时写入
↓
Container 结束后不做长期持久化
~~~

### 【Compose Default Network 提供 Service Name Discovery】

假设：

~~~yaml
services:
  api:
    ...
  redis:
    image: redis
~~~

没有显式声明 Network 时，Compose 默认创建项目级 Network，并让 Service 加入该 Network。Service 可以通过 Service Name 发现对方。[[9]](https://docs.docker.com/compose/how-tos/networking/)

因此 API 可以连接：

~~~text
redis:6379
~~~

而不是写 Redis Container 的临时 IP。

### 【Container 中 localhost 永远先指向自己】

假设：

~~~text
API Container
Redis Container
~~~

API Container 内：

~~~text
localhost:6379
~~~

表示：

~~~text
API Container 自己的 6379
~~~

不是 Redis。

访问 Redis 应该：

~~~text
redis:6379
~~~

所以要区分：

~~~text
Host 上运行的 Node Process
→ localhost:6379 可以指 Host Redis

Container 内运行的 Node Process
→ redis:6379 指另一个 Compose Service
~~~

这是 Docker 网络面试中最常见的错误之一。

---

## 5. Docker Compose 把多个 Container 组织成一个 Runtime System

Dockerfile 解决：

~~~text
一个 Image 怎么构建
~~~

Docker Compose 继续解决：

~~~text
系统里有哪些 Service
每个 Service 用什么 Image
怎样配置 Environment
怎样挂 Volume
怎样连 Network
谁先启动
怎样判断 Ready
异常退出后怎么办
~~~

所以 Compose 本质上描述 Multi-container Application 的 Runtime Topology。

### 【Compose Service 是运行单元配置，不等于源码 Project】

假设一个 Monorepo 有：

~~~text
packages/shared
apps/api
apps/worker
apps/web
~~~

Compose 不一定出现四个 Service。

可能是：

~~~text
api     → Container
worker  → Container
web     → Container

shared  → 只是构建时 Library
          不是 Runtime Service
~~~

因此：

~~~text
Project
≠
Package
≠
Image
≠
Container
≠
Compose Service
~~~

### 【image 与 build 表示两种 Image 来源】

直接使用 Registry Image：

~~~yaml
redis:
  image: redis:7.4-alpine
~~~

表示：

~~~text
Registry
↓ pull
Image
↓
Container
~~~

自己构建：

~~~yaml
api:
  build:
    context: .
    dockerfile: Dockerfile
~~~

表示：

~~~text
Local Build Context
+
Dockerfile
↓
Build Image
↓
Container
~~~

### 【depends_on 解决启动依赖，但 Ready 需要 Condition】

仅仅“Container 已启动”不代表内部应用已经 Ready。

例如：

~~~text
Database Process Started
≠
Database Ready for Query
~~~

因此需要 Healthcheck，并在依赖方使用 service_healthy。

Docker 官方明确区分：

~~~text
service_started
service_healthy
service_completed_successfully
~~~

三类依赖条件。[[10]](https://docs.docker.com/compose/how-tos/startup-order/)

| Condition | 适合场景 |
| --- | --- |
| service_started | 只要求依赖 Container 已启动 |
| service_healthy | 要求依赖通过 Health Check |
| service_completed_successfully | 要求一次性 Job 成功退出 |

### 【One-shot Job 与 Long-running Service 生命周期不同】

Database Migration 很适合 One-shot Job：

~~~text
Container Start
↓
Run Migration
↓
Exit 0
~~~

API：

~~~text
Container Start
↓
Node Process
↓
持续处理请求
↓
长期运行
~~~

所以 Restart Policy 不应该一刀切：

~~~text
Migration
成功退出是正常结果

API
意外退出通常需要恢复
~~~

### 【Profile 用于可选 Service】

例如：

~~~yaml
mail:
  profiles: ["dev"]
~~~

适合：

~~~text
Local Mail Tool
Debug Tool
Mock Service
Development-only Dependency
~~~

---

## 6. Browser Monitor 项目把前面的 Docker 模型落到真实文件中

从这一章开始才进入项目案例。先把项目相关目录明确列出来，不默认读者知道当前仓库结构。

### 【Docker 相关目录与文件】

当前相关结构：

~~~text
browser-monitor/
│
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
│
├── protocol/
│   ├── package.json
│   └── src/
│
├── sdk/
│   ├── package.json
│   └── src/
│
└── platform/
    │
    ├── package.json
    ├── .env.example
    │
    ├── apps/
    │   ├── api/
    │   │   ├── package.json
    │   │   └── src/
    │   ├── worker/
    │   │   ├── package.json
    │   │   └── src/
    │   ├── audit-worker/
    │   │   ├── package.json
    │   │   └── src/
    │   └── web/
    │       ├── package.json
    │       └── src/
    │
    ├── packages/
    │   ├── database/
    │   │   ├── package.json
    │   │   └── src/
    │   └── shared/
    │       ├── package.json
    │       └── src/
    │
    └── infra/
        ├── docker-compose.yml
        ├── Dockerfile.backend
        ├── Dockerfile.web
        ├── Dockerfile.audit-worker
        └── Caddyfile
~~~

文件职责：

| 文件 | 当前职责 |
| --- | --- |
| Dockerfile.backend | 构建 API / Worker 共用 Backend Image |
| Dockerfile.web | Build Web，再生成 Caddy Runtime Image |
| Dockerfile.audit-worker | 构建额外包含 Chromium 的 Audit Worker Image |
| docker-compose.yml | 组织 TimescaleDB、Redis、Migration、API、Worker、Audit Worker、Web、可选 Mailpit |
| Caddyfile | Web 静态资源服务和 API Reverse Proxy |
| .env.example | Runtime 配置示例 |

### 【Dockerfile.backend 从 browser-monitor Build Context 构建 Backend Image】

当前 Compose：

~~~yaml
build:
  context: ../..
  dockerfile: platform/infra/Dockerfile.backend
~~~

Compose File 位于：

~~~text
browser-monitor/platform/infra/
~~~

所以：

~~~text
../..
=
browser-monitor/
~~~

即 Build Context 是 browser-monitor/。

Dockerfile 位置和 Build Context 不同：

~~~text
Dockerfile Location
browser-monitor/platform/infra/Dockerfile.backend

Build Context
browser-monitor/
~~~

#### <u>1. FROM 建立 Node Base Image</u>

~~~dockerfile
FROM node:22-bookworm-slim
~~~

得到：

~~~text
Debian Bookworm Slim 用户空间
+
Node.js 22
~~~

#### <u>2. ENV 与 Corepack 准备 pnpm</u>

~~~dockerfile
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
~~~

目的：

~~~text
Image 内准备 pnpm 环境
↓
后续 RUN pnpm ... 可执行
~~~

#### <u>3. WORKDIR 创建 Image 内部 /workspace</u>

~~~dockerfile
WORKDIR /workspace
~~~

这里的 /workspace：

~~~text
不是
browser-monitor/workspace/

而是
Image Filesystem /workspace
~~~

随后：

~~~dockerfile
COPY package.json ./
~~~

目标实际是：

~~~text
/workspace/package.json
~~~

#### <u>4. 先复制 Manifest 是为了 Dependency Install Cache</u>

Dockerfile 先复制：

~~~text
root package.json
pnpm-workspace.yaml
pnpm-lock.yaml

protocol/package.json
sdk/package.json
platform/package.json
api/package.json
worker/package.json
web/package.json
database/package.json
shared/package.json
~~~

然后：

~~~dockerfile
RUN pnpm install --frozen-lockfile
~~~

原因：

~~~text
Package Manifest
变化相对少
↓
Dependency Install
成本较高
↓
放在 Source COPY 之前
↓
业务源码变化时仍可复用 Install Cache
~~~

如果只修改：

~~~text
platform/apps/api/src/main.ts
~~~

理想 Cache：

~~~text
Manifest COPY        → Cache Hit
pnpm install         → Cache Hit
Source COPY          → Cache Miss
Application Build    → Re-run
~~~

这就是 Layer Cache 在当前项目中的具体作用。

#### <u>5. 再复制 Source 并执行 Project Build</u>

当前：

~~~dockerfile
COPY protocol ./protocol
COPY platform ./platform
~~~

因为 WORKDIR 是 /workspace，最终 Image 内：

~~~text
/workspace/
├── protocol/
└── platform/
~~~

然后 Build：

~~~text
protocol
↓
shared
↓
database
↓
api
↓
worker
~~~

这些任务生成 Runtime 需要的 dist 文件。

#### <u>6. CMD 定义默认 API Runtime Command</u>

~~~dockerfile
CMD ["pnpm", "--filter", "@browser-monitor/api", "start"]
~~~

API package.json：

~~~json
"start": "node dist/main.js"
~~~

所以默认链路：

~~~text
Backend Image
↓
创建 API Container
↓
使用 Dockerfile CMD
pnpm --filter @browser-monitor/api start
↓
node dist/main.js
↓
Node API Process
↓
长期处理 HTTP Request
~~~

### 【Worker 使用同一 Backend Image，但 command 覆盖默认 CMD】

Worker Compose：

~~~yaml
worker:
  build:
    dockerfile: platform/infra/Dockerfile.backend

  command:
    ["pnpm", "--filter", "@browser-monitor/worker", "start"]
~~~

因此对 Worker Container：

~~~text
Dockerfile CMD
pnpm ... api start
↓
本次不执行

Compose command
pnpm ... worker start
↓
worker package start
↓
node dist/main.js
↓
Node Worker Process
~~~

Backend Image 本身没有被改掉。

API Container：

~~~text
没有 command Override
↓
仍使用 Image CMD
↓
启动 API
~~~

完整图：

~~~text
Backend Image
CMD = API Default
      │
      ├── API Container
      │      没有 Override
      │      ↓
      │      API CMD 生效
      │
      └── Worker Container
             Compose command Override
             ↓
             原 CMD 本次不执行
             ↓
             Worker Command 生效
~~~

### 【API、Worker、Web、SDK 的运行链必须分别理解】

#### <u>1. API</u>

~~~text
API src/main.ts
↓
tsc -p tsconfig.build.json
↓
dist/main.js
↓
放入 Backend Image
↓
创建 API Container
↓
node dist/main.js
↓
Node API Process
↓
监听端口并处理 HTTP Request
~~~

#### <u>2. Worker</u>

~~~text
Worker src/main.ts
↓
tsc
↓
dist/main.js
↓
放入 Backend Image
↓
创建 Worker Container
↓
Compose command 选择 Worker start
↓
node dist/main.js
↓
Node Worker Process
↓
持续执行后台任务逻辑
~~~

API 和 Worker 都是 Node Process，但职责不同：

~~~text
API
处理 Request / Response

Worker
处理后台异步任务
~~~

#### <u>3. Web</u>

~~~text
React / TypeScript Source
↓
tsc -b && vite build
↓
dist/
HTML / JavaScript / CSS
↓
只把 dist 复制进 Caddy Runtime Image
↓
创建 Web Container
↓
Caddy Process
↓
向 Browser 返回 HTML / JS / CSS
↓
JavaScript 最终在 Browser 中执行
~~~

所以 Web Container 真正长期运行的是 Caddy，不是 React Node Server。

#### <u>4. SDK</u>

~~~text
SDK TypeScript Source
↓
tsup
↓
dist/index.js
dist/index.d.ts
dist/index.global.js
↓
Package 发布 / 被业务页面引入
↓
Browser 执行 SDK JavaScript
~~~

SDK 没有独立的 SDK Server Process，因此 Compose 不需要 sdk Service。

这再次说明：

~~~text
Workspace Package
≠
Runtime Service
~~~

### 【Dockerfile.web 使用 Multi-stage Build】

第一阶段：

~~~text
node:22-bookworm-slim
↓
pnpm install
↓
Web Build
↓
/workspace/platform/apps/web/dist
~~~

第二阶段：

~~~text
caddy:2.10-alpine
↓
COPY Caddyfile
↓
COPY --from=build dist → /srv
↓
Final Web Image
~~~

最终 Runtime Image 不需要：

~~~text
Node
pnpm
TypeScript Compiler
Vite
完整 Web Source
~~~

### 【Dockerfile.audit-worker 因 Chromium Runtime 单独拆 Image】

Audit Worker package 依赖：

~~~text
lighthouse
chrome-launcher
~~~

Lighthouse Runtime 还需要 Chromium。

所以：

~~~text
Node.js
+
Audit Worker JS
+
Lighthouse
+
Chromium
+
CA Certificates
~~~

与普通 API / Worker 不同。

当前：

~~~text
Dockerfile.backend
→ API / Worker

Dockerfile.audit-worker
→ Audit Worker + Chromium
~~~

这体现：

> 根据 Runtime Dependency 划分 Image Boundary。

### 【Compose 把项目 Service 分成四类】

~~~text
1. Infrastructure
├── TimescaleDB
├── Redis
└── Mailpit（dev profile）

2. Initialization Job
└── migrate

3. Application Process
├── api
├── worker
└── audit-worker

4. Entry / Static Web
└── web + Caddy
~~~

### 【项目启动顺序由 Ready Condition 控制】

~~~text
TimescaleDB
↓ pg_isready
Healthy
↓
migrate
↓ Migration Exit 0
Completed Successfully
↓
API / Worker / Audit Worker

Redis
↓ redis-cli ping
Healthy
↓
API / Worker

API
↓ /health/ready
Healthy
↓
Web
~~~

合并：

~~~text
TimescaleDB Healthy
        ↓
     Migration
        ↓ success
 ┌──────┼─────────────┐
 ↓      ↓             ↓
API   Worker     Audit Worker
↑       ↑
└─ Redis Healthy

API Healthy
    ↓
   Web
~~~

### 【Volume 保存 TimescaleDB 和 Redis 的长期数据】

TimescaleDB：

~~~text
Container Path
/home/postgres/pgdata/data
        ↓
Named Volume
monitor-timescale-data
~~~

Redis：

~~~text
Container Path
/data
        ↓
Named Volume
monitor-redis-data
~~~

### 【Compose Network 让 Service 通过名称通信】

项目中：

~~~text
API
↓
timescaledb:5432

API / Worker
↓
redis:6379

Caddy
↓
api:3000
~~~

而不是 localhost。

Caddyfile：

~~~text
/api/*
↓
reverse_proxy api:3000
~~~

这里的 api 就是 Compose Service Name。

### 【Audit Worker 同时体现 Container Security Hardening】

当前：

~~~text
USER node
↓
Non-root

read_only: true
↓
Root Filesystem Read-only

tmpfs /tmp
↓
只开放临时写入区域

cap_drop: ALL
↓
移除 Linux Capability

no-new-privileges
↓
禁止获取新增权限
~~~

Docker 提供隔离基础，真正安全仍依赖：

~~~text
User
Capability
Filesystem
Secret
Network
Image
Runtime Config
~~~

---

## 7. Docker 工程治理围绕构建效率、可重复性、安全和排障展开

前六章已经建立运行机制，这一章才进入工程优化。

### 【构建效率首先来自正确的 Cache Dependency】

优先级：

~~~text
合理组织 Dockerfile Instruction
↓
低频输入在前
高频 Source 在后
↓
提高昂贵步骤 Cache Hit
~~~

进一步可使用 BuildKit Cache Mount 等能力，但属于进阶优化，不是当前项目已确认实现。

### 【Reproducible Build 依赖锁定构建输入】

当前项目根：

~~~json
"packageManager": "pnpm@10.28.2"
~~~

Dockerfile：

~~~text
corepack enable
pnpm install --frozen-lockfile
~~~

意图：

~~~text
固定 Package Manager 版本
+
遵循 pnpm-lock.yaml
↓
减少同一个 Commit 在不同时间解析出不同 Dependency Set
~~~

### 【Image Size 优化是减少 Runtime 不需要的内容】

不能简单等价成“全部换 Alpine”。

需要综合：

~~~text
Base Image
Build Tool
Dev Dependency
Source
System Package
Temporary Package Metadata
Multi-stage
~~~

当前例子：

~~~text
Web
Multi-stage
→ Final Image 只保留 Caddy + dist

Audit Worker
apt install 后删除 /var/lib/apt/lists/*
~~~

### 【Secret 应与 Image 分离】

不要把 Production Secret 写进 Dockerfile：

~~~text
COOKIE_SECRET
DB Password
Encryption Key
SMTP Password
~~~

更合理：

~~~text
Image
保存程序和通用 Runtime

Deployment Environment
注入 Secret
~~~

生产可进一步使用 Docker Secret、Kubernetes Secret、Cloud Secret Manager、Vault。

当前 Compose 有开发默认值，但这不能理解为 Production Secret Management 已完成。

### 【Debug 应沿对象链逐层排查】

固定顺序：

~~~text
1. Image 是否 Build 成功
2. Container 是否创建
3. Container 是否 Running / Exited
4. Main Command 是什么
5. Logs 报什么
6. Environment 是否正确
7. Network 是否可达
8. Volume 是否挂载
9. Healthcheck 是否通过
~~~

Image：

~~~bash
docker images
docker image history <image>
docker inspect <image>
~~~

Container：

~~~bash
docker ps
docker ps -a
docker logs <container>
docker logs -f <container>
docker exec -it <container> sh
docker inspect <container>
~~~

Storage：

~~~bash
docker volume ls
docker volume inspect <volume>
~~~

Network：

~~~bash
docker network ls
docker network inspect <network>
~~~

Compose：

~~~bash
docker compose ps
docker compose logs
docker compose logs -f api
docker compose exec api sh
docker compose config
~~~

docker compose config 很适合确认 Environment Interpolation、Anchor、Profile 和最终生效配置。

### 【Docker 在 CI/CD 中连接 Build、Release 与 Deploy】

~~~text
Git Commit
↓
Test
↓
docker build
↓
Image
↓
Tag
↓
Registry
↓
Deployment Environment Pull
↓
Container
~~~

常见 Image Tag：

~~~text
api:1.4.2
api:<git-sha>
~~~

当前 Browser Monitor 是否已有自动 Image Push 和 Production Deployment Workflow，需要单独读取 CI 配置后确认。

### 【Compose 与 Kubernetes 管理的规模不同】

~~~text
Dockerfile
构建 Image

Container Runtime
运行单个 Container

Compose
组织单 Docker Environment 的多个 Service

Kubernetes
组织 Cluster 级 Workload
~~~

Kubernetes 进一步处理：

~~~text
Scheduling
Replica
Self-healing
Rolling Update
Service Discovery
Resource Management
~~~

---

## 8. 面试与答辩应该沿 Docker 主链回答，而不是背零散题目

### 【第一层追问：Docker 基础模型】

**Docker 主要解决什么问题？**

推荐主线：

> Docker 把应用运行需要的 Runtime、Dependency 和文件组织成 Image，再从 Image 创建隔离 Container。没有 Docker 应用也能运行，Docker 主要解决运行环境一致性、可移植性和可重建性。

追问：

- Image 和 Container 区别？
- Docker 与 VM 区别？
- Container 底层为什么比 VM 轻？
- Container 是否只是普通进程？

### 【第二层追问：Image Build】

**Dockerfile、Build Context 和 Image 的关系是什么？**

~~~text
Build Context
提供构建输入

Dockerfile
描述如何处理输入

docker build
执行构建

Image
保存构建结果
~~~

追问：

- WORKDIR 为什么项目里没有对应目录？
- COPY 的源路径从哪里解析？
- .dockerignore 的作用？
- Layer 是什么？
- Cache 缓存什么？

### 【第三层追问：Layer Cache】

**为什么先 COPY package.json 再 COPY Source？**

> Build Cache 会复用之前相同输入下的构建步骤结果。依赖 Manifest 比业务源码变化少，把 Manifest COPY 和依赖安装放在 Source COPY 之前，可以让源码变化时继续复用依赖安装结果，避免每次重新 install。

~~~text
Source Changed

Manifest COPY     Cache Hit
Install           Cache Hit
Source COPY       Cache Miss
Build             Re-run
~~~

追问：

- package.json 变化会发生什么？
- 为什么一层失效会影响后续步骤？
- --no-cache 是什么？

### 【第四层追问：Container Runtime】

**CMD 被 Compose command 覆盖是什么意思？**

> Dockerfile CMD 是 Image 的默认 Runtime Command；Compose Service 如果声明 command，就为该 Container 提供新的 Runtime Command。因此该 Container 启动时原 CMD 不执行，但 Image 的默认 CMD 本身仍然存在，其他没有 Override 的 Container 仍可使用。

项目例子：

~~~text
Backend Image
CMD → API start

API Container
没有 command
→ API start

Worker Container
command → Worker start
→ 原 API CMD 本次不执行
~~~

追问：

- command 会修改 Image 吗？
- ENTRYPOINT 又是什么？
- RUN 和 CMD 区别？

### 【第五层追问：Storage 与 Network】

高频问题：

- 为什么数据库使用 Volume？
- Volume 和 Bind Mount 区别？
- Container 删除后 Volume 是否保留？
- 为什么 Container 内 localhost 不能访问另一个 Service？
- Compose Service Name 为什么能直接作为 Host？
- ports 的 8080:3000 分别是什么？

### 【第六层追问：Compose】

**Compose 的真正作用是什么？**

> Compose 不是简单批量执行 docker run，而是声明 Multi-container Application 的 Runtime Topology，包括 Service、Image、Build、Environment、Network、Volume、Health、Dependency 和 Lifecycle。

追问：

- depends_on 是否代表 Ready？
- Health Check 有什么作用？
- Migration 为什么适合 One-shot Job？
- Profile 的用途？
- restart policy 怎么选择？

### 【第七层追问：Browser Monitor 项目答辩】

可以沿：

> 当前项目的 Docker 配置位于 platform/infra。API 和普通 Worker 都使用 Node 22，因此 Dockerfile.backend 构建一份共用 Backend Image；Dockerfile 默认 CMD 启动 API，而 Worker 在 Compose 中通过 command 覆盖这个默认 CMD，从同一 Image 启动另一个 Node Worker Process。
>
> Web 的源码通过 TypeScript 和 Vite 构建为 dist 静态资源，Dockerfile.web 使用 Multi-stage Build：第一阶段用 Node 完成构建，第二阶段只保留 Caddy 和 dist，最终由 Caddy 提供静态资源并反向代理 API。
>
> Audit Worker 因 Lighthouse 需要 Chromium，所以使用独立 Dockerfile，避免 API 和普通 Worker 的 Image 携带无关浏览器 Runtime。
>
> Compose 再把 TimescaleDB、Redis、Migration、API、Worker、Audit Worker、Web 和开发 Mailpit 组织起来。TimescaleDB 与 Redis 使用 Named Volume；Service 通过默认 Compose Network 和 Service Name 通信。TimescaleDB Healthy 后执行 Migration，Migration 成功后启动业务 Process，API Ready 后再启动 Web。
>
> SDK 不进入 Compose，因为 SDK Build 后是被业务页面消费的浏览器 Package，不形成一个独立 Server Process。这也是 Package、Image、Container 和 Service 边界的区别。

### 【后续深入顺序】

~~~text
Container Internals
Namespace / Cgroup / OCI / containerd / runc

Image Internals
OverlayFS / BuildKit / Registry / Digest / SBOM

Security
Seccomp / AppArmor / Rootless / Resource Limit / Image Scan

Orchestration
Compose → Kubernetes
Pod / Deployment / Service / Probe / ConfigMap / Secret / PVC
~~~

不要在第一轮 Docker 学习时把这些底层名词与 Image、Container、Compose 平铺在同一层。

---

## 9. 参考资料

1. Docker Docs, **What is Docker?**：https://docs.docker.com/get-started/docker-overview/
2. Docker Docs, **Dockerfile reference**：https://docs.docker.com/reference/dockerfile/
3. Docker Docs, **What is an image?**：https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-an-image/
4. Docker Docs, **Build cache invalidation**：https://docs.docker.com/build/cache/invalidation/
5. Docker Docs, **Multi-stage builds**：https://docs.docker.com/build/building/multi-stage/
6. Docker Docs, **Dockerfile CMD / ENTRYPOINT reference**：https://docs.docker.com/reference/dockerfile/
7. Docker Docs, **Compose services / command**：https://docs.docker.com/reference/compose-file/services/
8. Docker Docs, **Volumes**：https://docs.docker.com/engine/storage/volumes/
9. Docker Docs, **Networking in Compose**：https://docs.docker.com/compose/how-tos/networking/
10. Docker Docs, **Control startup and shutdown order in Compose**：https://docs.docker.com/compose/how-tos/startup-order/
11. Browser Monitor：browser-monitor/platform/infra/docker-compose.yml
12. Browser Monitor：browser-monitor/platform/infra/Dockerfile.backend
13. Browser Monitor：browser-monitor/platform/infra/Dockerfile.web
14. Browser Monitor：browser-monitor/platform/infra/Dockerfile.audit-worker
15. Browser Monitor：browser-monitor/platform/infra/Caddyfile
16. Browser Monitor：browser-monitor/platform/apps/api/package.json
17. Browser Monitor：browser-monitor/platform/apps/worker/package.json
18. Browser Monitor：browser-monitor/platform/apps/web/package.json
19. Browser Monitor：browser-monitor/platform/apps/audit-worker/package.json
20. Browser Monitor：browser-monitor/sdk/package.json
