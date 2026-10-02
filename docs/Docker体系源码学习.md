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

### 【ARG 与 ENV 要先区分“写在哪里”和“什么时候生效”】

ARG 与 ENV 都可能出现在 Dockerfile 中，但它们服务的阶段不同。理解它们时不能只记“ARG 是构建时、ENV 是运行时”，还要先看它们**写在哪个文件、由谁读取、值从哪里来**。

先看一个完整的通用 Dockerfile：

~~~dockerfile
FROM node:22-bookworm-slim

ARG PACKAGE_MIRROR=https://example.com

ENV NODE_ENV=production
ENV APP_PORT=3000

RUN echo "build with ${PACKAGE_MIRROR}"

CMD ["node", "dist/main.js"]
~~~

这里：

~~~text
Dockerfile
├── ARG PACKAGE_MIRROR
│   └── 给 docker build 阶段使用
│
└── ENV NODE_ENV / APP_PORT
    └── 写进 Image 的环境变量配置
        Container 启动后程序也能读取
~~~

#### <u>1. ARG 写在 Dockerfile 中，值主要在 Build 阶段使用</u>

Dockerfile：

~~~dockerfile
ARG PACKAGE_MIRROR=https://example.com
RUN echo "build with ${PACKAGE_MIRROR}"
~~~

执行：

~~~bash
docker build --build-arg PACKAGE_MIRROR=https://mirror.example.com -t my-app .
~~~

实际过程：

~~~text
docker build
    ↓
传入 PACKAGE_MIRROR
    ↓
Dockerfile ARG 接收这个值
    ↓
后续 RUN 可以读取
    ↓
影响 Image 如何构建
~~~

ARG 常用于 Package Mirror、Build Target、Compile Flag、Proxy、Build Version，也就是主要影响“Image 怎么被做出来”。Docker 官方把 ARG 定义为 Build-time Variable。[[2]](https://docs.docker.com/reference/dockerfile/)

#### <u>2. ENV 也写在 Dockerfile 中，但会保存到 Image Environment</u>

~~~dockerfile
ENV NODE_ENV=production
ENV APP_PORT=3000
~~~

Build 完之后，Image 会记录这些默认环境变量。

~~~text
Image
NODE_ENV=production
APP_PORT=3000
    ↓
docker run
    ↓
Container Environment
    ↓
Node Process
process.env.NODE_ENV
process.env.APP_PORT
~~~

因此 ENV 不只是 Docker Build 自己使用，它还会影响从这个 Image 创建出的 Container。Docker 官方说明 ENV 会持久化到构建得到的 Image 中。[[2]](https://docs.docker.com/reference/dockerfile/)

#### <u>3. Compose 也可以分别给 Build ARG 和 Runtime ENV 传值</u>

这时配置写在 `compose.yaml` 或 `docker-compose.yml` 中。

~~~yaml
services:
  audit-worker:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        PACKAGE_MIRROR: https://mirror.example.com

    environment:
      NODE_ENV: production
      APP_PORT: 3000
~~~

两条链：

~~~text
build.args
    ↓
传给 Dockerfile ARG
    ↓
影响 Image Build


environment
    ↓
传给 Container
    ↓
影响 Runtime Process
~~~

所以 `build.args` 和 `environment` 不是同一种配置。

#### <u>4. Browser Monitor 当前正好同时使用 ARG 和 ENV</u>

当前相关文件：

~~~text
browser-monitor/
└── platform/
    └── infra/
        ├── Dockerfile.audit-worker
        └── docker-compose.yml
~~~

`Dockerfile.audit-worker`：

~~~dockerfile
ARG DEBIAN_MIRROR_BASE=https://deb.debian.org

ENV AUDIT_CHROME_PATH=/usr/bin/chromium
~~~

`docker-compose.yml` 中对应：

~~~yaml
services:
  audit-worker:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.audit-worker
      args:
        DEBIAN_MIRROR_BASE: ${DEBIAN_MIRROR_BASE:-https://deb.debian.org}

    environment:
      AUDIT_CHROME_PATH: ${AUDIT_CHROME_PATH:-/usr/bin/chromium}
~~~

两条链分别是：

~~~text
DEBIAN_MIRROR_BASE
Compose build.args
    ↓
Dockerfile ARG
    ↓
apt 使用哪个 Debian Mirror
    ↓
影响 Image Build


AUDIT_CHROME_PATH
Compose environment
    ↓
Container Environment
    ↓
Audit Worker Process
    ↓
运行时知道 Chromium 在哪里
~~~

这就是 ARG 与 ENV 最实际的区别。

#### <u>5. Secret 不应该因为 ENV 方便就写进 Dockerfile</u>

例如：

~~~dockerfile
ENV DATABASE_PASSWORD=123456
~~~

会把 Secret 固定进 Image 配置。

更合理的方向是：

~~~text
Image
只保存通用程序和默认配置

Deployment Environment
在 Container 启动时注入 Secret
~~~

因此：ARG 主要影响 Build；ENV 可以成为 Image/Container 的默认 Runtime Environment；Secret 仍应与 Image 分离。

### 【Port Publishing 将 Host 端口映射到 Container 内的监听端口】

理解 ports 前，先明确 Container Port 到底是什么。

Container 拥有自己的 Network Namespace（网络命名空间）。可以先把它理解为：Container 有自己独立的一套网络视图，包括网络接口、IP 地址、路由表、localhost 和端口空间。

假设 Container 中运行：

~~~text
Node Process
↓
listen 0.0.0.0:3000
~~~

这里的 3000，就是这个程序在 Container 网络空间内部监听的端口。

所以：

~~~text
Container Port
不是 Docker 额外创建的一个“端口对象”

而是
Container 内某个 Process 正在监听的 TCP / UDP Port
~~~

#### <u>1. Container Port 本身可以被访问，但要看谁在访问</u>

不能简单说“Container Port 不能直接访问”。

| 访问者 | 常见访问方式 | 是否需要 ports 发布 |
| --- | --- | --- |
| Container 自己 | localhost:3000 | 不需要 |
| 同一 Docker Network 的其他 Container | api:3000 | 不需要 |
| Docker Host | 跨平台稳定方式是 localhost:8080 → Published Port | 通常需要 |
| Host 外部的其他机器 | HOST_IP:8080 | 需要 Published Port 并允许外部网络访问 |

Docker 官方说明，同一个 Bridge Network 上的 Container 可以直接通过 Container Port 通信；Published Port 主要用于把 Container 内端口提供给 Host 之外的网络入口。[[9]](https://docs.docker.com/compose/how-tos/networking/)

还要注意平台差异：Linux Docker Engine 某些网络模式下 Host 可以路由到 Container IP；Docker Desktop 的 Container 实际运行在内部 Linux VM 中，Host 到 Container IP 的行为不同。因此工程上不要依赖临时 Container IP，Host 访问通常使用 Published Port。

#### <u>2. 应用监听地址决定其他 Container 能不能连接这个端口</u>

如果程序只监听：

~~~text
127.0.0.1:3000
~~~

127.0.0.1 属于 Container 自己的 Loopback Interface。

结果：

~~~text
同一个 Container 内
localhost:3000
可以访问

另一个 Container
api:3000
通常不能访问
~~~

如果希望其他 Container 通过 Docker Network 访问，服务通常要监听：

~~~text
0.0.0.0:3000
~~~

因此网络是否可达，要同时检查：

~~~text
Process 是否启动
+
监听哪个 Port
+
绑定哪个 Address
+
两个 Container 是否共享 Network
+
是否需要向 Host / 外部发布 Port
~~~

#### <u>3. ports 写在某个 Compose Service 下</u>

完整配置：

~~~yaml
services:
  api:
    image: my-api:1.0

    ports:
      - "8080:3000"
~~~

结构：

~~~text
services
└── api
    ├── image
    └── ports
~~~

这里：

~~~text
8080
= Host Port

3000
= Container 内应用监听的 Port
~~~

Docker 建立：

~~~text
Host Network
localhost:8080
      │
      │ Port Publishing
      ▼
Container Network
:3000
      │
      ▼
Node API Process
~~~

Docker 官方把这个机制称为 Port Publishing / Mapping。[[12]](https://docs.docker.com/engine/network/port-publishing/)

#### <u>4. 删除 ports 不会让 Container 内的 3000 消失</u>

如果删除：

~~~yaml
ports:
  - "8080:3000"
~~~

仍然有：

~~~text
Node Process
仍监听 Container :3000

同 Network Container
仍可通过 api:3000 访问
~~~

只是：

~~~text
Host localhost:8080
不再映射到 Container :3000
~~~

因此：

~~~text
Process Listen Port
≠
Host Published Port
~~~

#### <u>5. Browser Monitor 当前 Web 的 Published Port</u>

文件：

~~~text
browser-monitor/platform/infra/docker-compose.yml
~~~

配置：

~~~yaml
services:
  web:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.web

    ports:
      - "8080:8080"
~~~

关系：

~~~text
Host Browser
http://localhost:8080
        ↓
Host Port 8080
        ↓ Docker Published Port
Web Container Port 8080
        ↓
Caddy Process
~~~

TimescaleDB：

~~~yaml
services:
  timescaledb:
    image: timescale/timescaledb-ha:pg17
    ports:
      - "5432:5432"
~~~

Host 数据库客户端可以通过 localhost:5432 访问。

但 API Container 访问 TimescaleDB 时不需要 Host Port：

~~~text
API Container
↓ Compose Network
timescaledb:5432
~~~

这里直接使用的是 TimescaleDB Container 内的 5432。

这一节最终建立：

~~~text
Process Listen
0.0.0.0:3000
      ↓
Container Port 3000
      │
      ├── 同 Network Container
      │      → api:3000
      │
      └── ports: "8080:3000"
             ↓
          Host :8080
             ↓
          Host / 外部客户端
~~~

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

### 【Container Writable Layer 是“这个 Container 自己临时拥有的可写文件层”】

理解 Volume 前，必须先理解一个 Container 的文件系统是怎样组成的。

Image 可以先看成一组只读 Layer：

~~~text
Image

Layer A
Base Linux Files

Layer B
Node Runtime

Layer C
Application Files

Layer D
Dependencies
~~~

Docker 根据 Image 创建 Container 时，不直接修改这些 Image Layer，而是在最上面增加一个只属于这个 Container 的 Writable Layer（可写层）。

~~~text
Container

Container Writable Layer   ← 当前 Container 自己写文件的位置
────────────────────────
Image Layer D              ← Read-only
Image Layer C              ← Read-only
Image Layer B              ← Read-only
Image Layer A              ← Read-only
~~~

Docker 官方说明，默认情况下 Container 内新建或修改的文件会写入这个 writable container layer。[[1]](https://docs.docker.com/engine/storage)

#### <u>1. 为什么 Container 需要 Writable Layer</u>

假设 Image 里原来只有：

~~~text
/app/
└── server.js
~~~

Container 启动以后，应用可能生成：

~~~text
/app/log.txt
/tmp/cache.json
/data/result.json
~~~

这些是 Runtime 新产生的文件。如果没有额外挂载 Volume / Bind Mount，它们默认进入这个 Container 自己的 Writable Layer。

所以：

~~~text
Image
提供初始文件

Container Writable Layer
保存这个 Container 运行后产生的文件变化
~~~

#### <u>2. stop 和 remove 必须区分</u>

只执行：

~~~bash
docker stop my-container
~~~

Container 还存在。

再次：

~~~bash
docker start my-container
~~~

仍然是同一个 Container、同一个 Writable Layer，因此这些运行时文件通常还在。

但如果：

~~~bash
docker rm my-container
~~~

或者 Compose 删除旧 Container 后重新创建一个新的 Container：

~~~text
old Container
被删除
↓
它自己的 Writable Layer 一起删除
↓
new Container
从 Image 创建新的 Writable Layer
~~~

因此长期数据不能只依赖 Writable Layer。

#### <u>3. 数据库为什么特别不能只写 Writable Layer</u>

假设数据库程序把数据写到：

~~~text
/var/lib/database
~~~

没有 Volume：

~~~text
Database Process
    ↓ write
/var/lib/database
    ↓
Container Writable Layer
~~~

如果 Container 被删除并重新创建：

~~~text
Writable Layer 删除
↓
数据库文件一起丢失
~~~

数据库真正需要的是：

~~~text
Application Container
可以替换

Database Data
独立保留
~~~

因此需要把 Data Lifecycle 从 Container Lifecycle 中分离，这正是 Volume 的作用。

### 【Named Volume 把 Container 内某个目录改为独立持久化存储】

先看完整 Compose 上下文：

~~~yaml
services:
  db:
    image: postgres:17

    volumes:
      - db-data:/var/lib/postgresql/data

volumes:
  db-data:
~~~

这里有两处 `db-data`：

~~~text
services.db.volumes
使用这个 Volume

顶层 volumes.db-data
声明这个 Named Volume
~~~

#### <u>1. db-data:/var/lib/postgresql/data 是 SOURCE:TARGET 语法</u>

短语法：

~~~text
SOURCE : TARGET
~~~

这里：

~~~text
db-data : /var/lib/postgresql/data
~~~

左边 `db-data` 是 Docker Named Volume 名称。

右边 `/var/lib/postgresql/data` 是 Container 内部路径。

所以这不是两个 Host 路径。

完整关系：

~~~text
Docker Host
Docker Managed Volume
db-data
      │
      │ mount
      ▼
Container Filesystem
/var/lib/postgresql/data
      │
      ▼
PostgreSQL Process
在这里读写数据库文件
~~~

#### <u>2. 右边的 Container Path 从哪里来</u>

`/var/lib/postgresql/data` 不是 Docker 自动猜出来的。

它来自应用本身对“数据目录”的约定。

例如：

~~~text
PostgreSQL
有自己的数据库数据目录

Redis
常见数据目录是 /data

自定义应用
可能使用 /app/uploads
或 /app/storage
~~~

配置 Volume 时，要先知道：

> 应用真正把长期数据写到 Container 内哪个路径。

然后把 Volume Mount 到这个路径。

#### <u>3. mount 之后到底发生什么</u>

没有 Volume：

~~~text
PostgreSQL
↓ write
/var/lib/postgresql/data
↓
Container Writable Layer
~~~

使用 Volume：

~~~text
PostgreSQL
↓ write
/var/lib/postgresql/data
↓
这个 Container Path 已被 Volume Mount 接管
↓
实际数据写进 db-data Volume
~~~

所以**改变的是这个 Container Path 的底层存储来源**。

从 PostgreSQL 看，它仍然只是在读写：

~~~text
/var/lib/postgresql/data
~~~

程序不需要知道 Docker 在 Host 上把 Volume 放在哪里。

Docker 负责 Volume Creation、Storage Location、Mount、Lifecycle、Inspection 和 Removal。Docker 官方明确说明 Named Volume 由 Docker Daemon 创建和管理，数据位于 Docker Host 的 Docker Storage 中。[[8]](https://docs.docker.com/engine/storage/volumes/)

#### <u>4. 为什么删除 Container 后数据还在</u>

第一次：

~~~text
db Container A
    ↓ mount
db-data Volume
    ↓
写入业务数据
~~~

删除 Container A：

~~~text
Container A Writable Layer
删除

db-data Volume
仍然存在
~~~

重新创建：

~~~text
db Container B
    ↓ mount same db-data
    ↓
继续读取以前的数据
~~~

所以：

~~~text
Container
可替换

Volume
独立生命周期
~~~

#### <u>5. Docker 怎么管理这个 Volume</u>

查看：

~~~bash
docker volume ls
~~~

检查：

~~~bash
docker volume inspect db-data
~~~

删除：

~~~bash
docker volume rm db-data
~~~

Named Volume 不是“复制一份目录”，而是 Docker 在 Host 上管理的一份独立持久存储，再把它 Mount 到 Container 指定路径。

#### <u>6. Browser Monitor 当前真实例子</u>

文件：

~~~text
browser-monitor/platform/infra/docker-compose.yml
~~~

TimescaleDB：

~~~yaml
services:
  timescaledb:
    image: timescale/timescaledb-ha:pg17

    volumes:
      - monitor-timescale-data:/home/postgres/pgdata/data

volumes:
  monitor-timescale-data:
~~~

拆解：

~~~text
monitor-timescale-data
= Docker Named Volume

/home/postgres/pgdata/data
= TimescaleDB Container 内的数据目录
~~~

关系：

~~~text
TimescaleDB Process
↓ write
/home/postgres/pgdata/data
↓ mount
monitor-timescale-data Volume
↓
Docker 管理持久数据
~~~

Redis：

~~~yaml
services:
  redis:
    image: redis:7.4-alpine

    volumes:
      - monitor-redis-data:/data

volumes:
  monitor-redis-data:
~~~

表示：

~~~text
Redis Process
↓ write
/data
↓
monitor-redis-data Volume
~~~

Volume 的核心不是“把一个目录复制出去”，而是把 Container 内指定路径的存储后端，从 Container Writable Layer 换成独立的 Docker-managed Persistent Storage。

### 【Bind Mount 让 Container 直接读写 Host 上指定的真实文件或目录】

Bind Mount 和 Named Volume 都使用“挂载”概念，但左边的来源完全不同。

Named Volume：

~~~text
Docker 管理一块存储
↓
挂到 Container Path
~~~

Bind Mount：

~~~text
Host 上已经存在的具体 Path
↓
直接挂到 Container Path
~~~

完整 Compose：

~~~yaml
services:
  web-dev:
    image: node:22

    volumes:
      - ./src:/app/src
~~~

这里：

~~~text
./src : /app/src
~~~

仍然是：

~~~text
SOURCE : TARGET
~~~

但 SOURCE 变成 Host Path：

~~~text
./src
= Host Path
~~~

TARGET：

~~~text
/app/src
= Container Path
~~~

#### <u>1. 实际映射关系</u>

假设 Host 项目：

~~~text
Host

/project/
├── compose.yaml
└── src/
    └── App.tsx
~~~

Compose：

~~~yaml
volumes:
  - ./src:/app/src
~~~

Container 中 `/app/src/App.tsx` 看到的就是 Host 的 `/project/src/App.tsx`。

~~~text
Host Filesystem

/project/src
      ↕
Bind Mount
      ↕
Container Filesystem

/app/src
~~~

Docker 官方把 Bind Mount 定义为 Host Path 与 Container Path 之间的直接映射。[[11]](https://docs.docker.com/engine/storage/bind-mounts/)

#### <u>2. “改变的是什么”</u>

Mount 后，Container 访问 `/app/src` 时，看到的不再是 Image 原本在 `/app/src` 中的内容，而是 Host `./src` 的内容。

例如 Image 原来：

~~~text
/app/src/
└── old.js
~~~

Host：

~~~text
./src/
└── new.js
~~~

挂载后 Container 看到：

~~~text
/app/src/
└── new.js
~~~

`old.js` 不是永久被删除，而是在 Mount 存在期间被遮蔽。Docker 官方明确说明，Mount 到非空目录时，原有内容会被 obscured。[[11]](https://docs.docker.com/engine/storage/bind-mounts/)

#### <u>3. 默认情况下 Host 和 Container 修改的是同一份挂载数据</u>

Host 编辑：

~~~text
/project/src/App.tsx
~~~

Container 中：

~~~text
/app/src/App.tsx
~~~

会看到变化。

反过来，如果 Container 对 `/app/src/App.tsx` 写入，默认也会直接改 Host 文件。

因此 Bind Mount 很适合本地开发：

~~~text
IDE 在 Host 修改源码
↓
Bind Mount
↓
Container 看到最新源码
↓
Dev Server / Watch Process 重新执行
~~~

这和 COPY 完全不同：

~~~text
COPY
Build 时复制一次
Host 后续修改不会自动同步进已有 Image

Bind Mount
Runtime 直接共享 Host Path
双方看到同一份挂载内容
~~~

#### <u>4. Bind Mount 为什么更依赖具体机器</u>

如果写：

~~~yaml
volumes:
  - /Users/alice/project/config:/app/config
~~~

则要求 Docker Host 上真实存在 `/Users/alice/project/config`。

换一台机器，Host Path 可能不同。

Named Volume 不要求业务自己固定 Host Path，因此迁移性通常更好。

#### <u>5. 可以配置只读</u>

~~~yaml
volumes:
  - ./config:/app/config:ro
~~~

表示：

~~~text
Host
可以编辑

Container
只能读取
不能写回
~~~

所以 Bind Mount 的核心不是“把文件复制进 Container”，而是让 Container 某个路径直接映射到 Host 的真实路径，双方默认共享并可修改同一份挂载内容。

### 【tmpfs 为只读 Root Filesystem 提供受控的临时可写区域】

理解 tmpfs 前，先把 Container 的几种写入位置放在一起：

~~~text
Container 运行时写文件
        │
        ├── Container Writable Layer
        │      默认可写层，Container 删除后一起消失
        │
        ├── Named Volume
        │      Docker 管理，独立持久化
        │
        ├── Bind Mount
        │      直接映射 Host 指定目录
        │
        └── tmpfs
               临时文件系统
               主要使用 Host Memory
               Container 停止后不保留
~~~

tmpfs 适合处理：程序运行期间必须写，但不需要长期保存，并且希望这部分写入与普通 Container Writable Layer 分离的数据。

Docker 官方说明，tmpfs Mount 是临时存储，主要位于 Host Memory 中；Container 停止后 Mount 被移除，数据不会继续保留。Linux 可能把内存页换出到 Swap，所以不能绝对理解成“永远只在物理 RAM 中”。[[13]](https://docs.docker.com/engine/storage/tmpfs/)

#### <u>1. tmpfs 也需要指定 Container 内的 Mount Path</u>

完整 Compose：

~~~yaml
services:
  app:
    image: my-app

    tmpfs:
      - /tmp
~~~

这里不是创建一个叫 tmp 的 Volume，而是：

~~~text
services.app.tmpfs
↓
为 app Container 创建 tmpfs
↓
Mount 到 Container 内 /tmp
~~~

应用仍然正常读写：

~~~text
/tmp/file.txt
~~~

只是 /tmp 背后的 Storage Backend 改变了。

没有 tmpfs：

~~~text
Process
↓ write
/tmp/a.txt
↓
Container Writable Layer
~~~

挂载 tmpfs：

~~~text
Process
↓ write
/tmp/a.txt
↓
/tmp 被 tmpfs Mount 接管
↓
tmpfs Temporary Storage
~~~

所以 Container Path 没变，变的是 Path 背后的实际存储位置。

#### <u>2. tmpfs 与 Named Volume 的核心差异是数据生命周期</u>

~~~text
Named Volume
→ Container 删除后仍希望数据保留
→ Database / Upload / Persistent State

tmpfs
→ 只需要当前 Container 运行期间存在
→ Temporary File / Cache / Browser Profile
~~~

适合 tmpfs 的内容包括 Temporary Files、Runtime Cache、Browser Temporary Profile、PID / Lock 等短生命周期运行文件、一次任务的中间结果、不需要长期保留的临时敏感数据。

通常不适合 Database Data、User Upload、长期日志归档、审计记录，以及 Container 重建后仍需要恢复的数据。

#### <u>3. read_only: true 限制的是普通 Root Filesystem 写入</u>

默认 Container 可以把运行时文件写入 Container Writable Layer。

如果 Compose 设置：

~~~yaml
services:
  app:
    read_only: true
~~~

可以理解为：

~~~text
Container Root Filesystem
↓
以 Read-only 方式使用
↓
程序不能再通过普通 Root Filesystem
随意写入 Container Writable Layer
~~~

于是：

~~~text
write /app/a.txt
→ 失败

write /etc/a.conf
→ 失败
~~~

但 read_only: true 不意味着 Container 任何地方都不能写。仍然可以通过 tmpfs、Volume、Bind Mount 显式开放可写区域。

例如：

~~~yaml
services:
  app:
    read_only: true
    tmpfs:
      - /tmp
~~~

形成：

~~~text
Container
/
├── app/   Read-only
├── etc/   Read-only
├── usr/   Read-only
└── tmp/   Writable ← tmpfs
~~~

因此：

~~~text
write /app/a.txt
→ 失败

write /tmp/a.txt
→ 成功
~~~

这也是 read_only 与 tmpfs 经常一起出现的原因：大部分 Root Filesystem 禁止写，只给确实需要 Runtime 写入的路径显式开放可写空间。

#### <u>4. Browser Monitor 的 Audit Worker 正是这个组合</u>

当前：

~~~yaml
services:
  audit-worker:
    read_only: true
    tmpfs:
      - /tmp:size=1g,mode=1777
~~~

Dockerfile.audit-worker 同时设置：

~~~dockerfile
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache
~~~

完整链：

~~~text
Audit Worker Container
↓
Root Filesystem = Read-only
│
├── /app   不允许普通写入
├── /etc   不允许普通写入
│
└── /tmp
     ↓ tmpfs Mount
  Temporary Writable Area
     ↓
  Chromium / Lighthouse
  写 Profile / Cache / Temporary File
     ↓
  Container Stop
     ↓
  Temporary Data Discarded
~~~

所以当前 tmpfs 的主要价值不是简单“加速”，而是在 Root Filesystem 只读的安全约束下，只为 Chromium / Lighthouse 提供一个明确、受控、可丢弃的写入区域。

### 【Compose Default Network 让 Service 获得可互通的 Container 网络】

理解 redis:6379 前，先理解每个 Container 都有自己的网络空间。

假设：

~~~yaml
services:
  api:
    image: my-api

  redis:
    image: redis:7.4-alpine
~~~

虽然没有显式写 networks，但执行 docker compose up 时，Compose 默认创建一个项目级 Default Network，并把这两个 Service 创建的 Container 都接入这个 Network。[[9]](https://docs.docker.com/compose/how-tos/networking/)

可以抽象成：

~~~text
Docker Host
│
└── Compose Network: myapp_default
      │
      ├── API Container
      │    └── Container IP，例如 172.20.0.2
      │
      └── Redis Container
           └── Container IP，例如 172.20.0.3
~~~

Container 重建后 IP 可能变化，所以业务配置不应该写死临时 IP。

#### <u>1. 共享 Network 先解决“两个 Container 是否有网络路径”</u>

如果两个 Container 都在 myapp_default：

~~~text
API Container
        ↓
Docker Network
        ↓
Redis Container
~~~

Docker 为它们提供可达路径。

如果两个 Container 完全不共享 Network：

~~~text
API → Network A

Redis → Network B
~~~

默认不能直接跨这两个隔离 Network 通信。

因此第一层问题是：

> 两个 Container 是否处于能够互通的 Docker Network 中？

#### <u>2. Service Name Discovery 再解决“用什么地址找到另一个 Container”</u>

Redis Container 可能当前 IP 是：

~~~text
172.20.0.3
~~~

但重建后可能变成：

~~~text
172.20.0.8
~~~

Compose 为 Service Name 提供 DNS Resolution：

~~~text
redis
↓ Docker Internal DNS
解析
↓
当前 Redis Container IP
~~~

所以 API 写：

~~~text
redis:6379
~~~

而不是：

~~~text
172.20.0.3:6379
~~~

Docker 官方建议 Compose Service 之间使用 Service Name，而不是依赖动态 Container IP。[[9]](https://docs.docker.com/compose/how-tos/networking/)

#### <u>3. redis:6379 两部分分别解决什么</u>

~~~text
redis : 6379

redis
=
Compose Service Name
=
Docker DNS 可解析的 Hostname

6379
=
Redis Process 在 Redis Container 内监听的 Container Port
~~~

完整访问：

~~~text
API Process
↓ connect redis:6379

Docker DNS
↓ redis → Redis Container IP

Docker Network
↓ 路由到 Redis Container

Redis Container :6379
↓
Redis Process
~~~

所以：

> Service Name 解决“找到哪个 Container”，Container Port 解决“连接该 Container 中哪个监听程序”。

#### <u>4. Browser Monitor 当前就是通过 Service Name 通信</u>

当前 Backend Environment：

~~~text
REDIS_URL=redis://redis:6379

DATABASE_URL=
postgres://monitor:...@timescaledb:5432/monitor
~~~

其中：

~~~text
redis
timescaledb
~~~

都是 Compose Service Name。

真实链路：

~~~text
API / Worker Process
↓
redis:6379
↓ Compose DNS + Network
Redis Container
↓
Redis Process


API / Worker Process
↓
timescaledb:5432
↓ Compose DNS + Network
TimescaleDB Container
↓
PostgreSQL Process
~~~

即使 Redis 和 TimescaleDB 同时配置了 Host Published Port，Container 之间仍然直接通过 Docker Network 使用 Container Port。

### 【localhost 始终指向当前 Process 所在 Network Namespace 的本机回环地址】

localhost 不是“这台物理电脑里所有程序共同的地址”。

更准确地说：

> localhost 表示当前 Process 所处 Network Namespace 中的 Loopback Interface。

所以程序运行在哪里，localhost 就指向哪里的“自己”。

#### <u>1. Host Process 的 localhost 指 Host</u>

如果 Node 和 Redis 都直接运行在 Host：

~~~text
Host
├── Node API Process
└── Redis Process
~~~

Node 访问：

~~~text
localhost:6379
~~~

路径：

~~~text
Node Process
↓
Host Loopback 127.0.0.1
↓
Host 上监听 6379 的 Redis
~~~

#### <u>2. API Container 内的 localhost 只指 API Container 自己</u>

Docker：

~~~text
Docker Host
│
├── API Container
│    └── Node API Process
│
└── Redis Container
     └── Redis Process
~~~

API Container 有自己的网络空间：

~~~text
API Container Network Namespace
├── localhost / 127.0.0.1
└── eth0 / Container IP
~~~

Redis Container 也有自己的：

~~~text
Redis Container Network Namespace
├── localhost / 127.0.0.1
└── eth0 / Container IP
~~~

因此 API Process 请求：

~~~text
localhost:6379
~~~

实际是：

~~~text
API Process
↓
API Container 的 127.0.0.1
↓
寻找 API Container 自己是否有 Process 监听 6379
~~~

不会自动进入 Redis Container。

#### <u>3. 访问另一个 Container 要通过 Docker Network</u>

正确地址：

~~~text
redis:6379
~~~

路径：

~~~text
API Process
↓
hostname redis
↓
Docker Internal DNS
↓
Redis Container IP
↓
API Container eth0
↓
Compose Network
↓
Redis Container eth0
↓
Redis Container :6379
↓
Redis Process
~~~

所以：

~~~text
localhost:6379
~~~

和：

~~~text
redis:6379
~~~

走的是完全不同的网络路径。

#### <u>4. Container 自己访问自己的 Service 时 localhost 完全可以使用</u>

例如 API Container 内 Node Process 监听：

~~~text
127.0.0.1:3000
~~~

同一个 Container 内：

~~~bash
curl http://localhost:3000
~~~

可以访问。

所以正确结论不是“Docker 中不能使用 localhost”，而是：

> localhost 永远找当前 Network Namespace 自己；目标在另一个 Container 时，localhost 就找错对象。

#### <u>5. 把 Network、Container Port 与 Published Port 放在一起</u>

假设：

~~~text
API Container
Node API → 0.0.0.0:3000

Redis Container
Redis → 0.0.0.0:6379
~~~

访问关系：

~~~text
API Container 自己访问 API
localhost:3000
可以


Redis Container 自己访问 Redis
localhost:6379
可以


API Container 访问 Redis
redis:6379
可以


Host 访问 API
如果配置 ports: "8080:3000"
使用 localhost:8080


外部机器访问 API
如果 Host Port 对外发布并被网络允许
使用 HOST_IP:8080
~~~

Docker Network 最终可以收束成四个概念：

~~~text
Network Namespace
决定每个 Container 有自己的网络空间

Container Port
是 Container 内 Process 的监听端口

Docker Network + Service Name
解决 Container → Container

Published Port
解决 Host / 外部 → Container
~~~

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

### 【image 与 build 必须放在 Compose Service 中理解 Image 从哪里来】

先看完整 Compose 结构：

~~~yaml
services:
  redis:
    image: redis:7.4-alpine

  api:
    build:
      context: .
      dockerfile: Dockerfile
~~~

这里：

~~~text
services
├── redis
│   └── image
│
└── api
    └── build
~~~

也就是说 `image` 和 `build` 都属于某个 Service。

#### <u>1. image 表示使用已经存在的 Image</u>

~~~yaml
services:
  redis:
    image: redis:7.4-alpine
~~~

执行链：

~~~text
我要运行 redis Service
↓
需要 redis:7.4-alpine Image
↓
本机没有时从 Registry Pull
↓
Image 进入本地 Docker Image Store
↓
根据 Image 创建 Redis Container
↓
Redis Process 启动
~~~

所以 `image` 主要回答：这个 Service 用哪一个已经构建好的 Image？

#### <u>2. build 表示先根据 Dockerfile 构建 Image</u>

~~~yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
~~~

执行链：

~~~text
Compose 读取 api.build
↓
context: .
确定 Build Context
↓
dockerfile: Dockerfile
确定 Build Rule
↓
执行 Image Build
↓
得到本地 Image
↓
Create API Container
~~~

所以 `build` 主要回答：这个 Service 的 Image 应该怎样从当前源码构建出来？

#### <u>3. Browser Monitor 中两种方式同时存在</u>

文件：

~~~text
browser-monitor/platform/infra/docker-compose.yml
~~~

基础设施：

~~~yaml
services:
  timescaledb:
    image: timescale/timescaledb-ha:pg17

  redis:
    image: redis:7.4-alpine

  mailpit:
    image: axllent/mailpit:v1.27
~~~

这些使用已经发布的第三方 Image。

业务应用：

~~~yaml
services:
  api:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend

  worker:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend

  web:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.web
~~~

这些要把当前仓库源码 Build 成 Image。

因此当前项目可以先分成：

~~~text
Third-party Infrastructure
→ image

Project-owned Application
→ build
~~~

这不是单纯语法差异，而是 Image 来源不同。

### 【depends_on 与 healthcheck 要从“被依赖 Service”和“依赖 Service”两边一起理解】

只写：

~~~yaml
depends_on:
  db:
    condition: service_healthy
~~~

没有完整上下文。

至少应该看到两个 Service：

~~~yaml
services:
  db:
    image: postgres:17

    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    image: my-api:1.0

    depends_on:
      db:
        condition: service_healthy
~~~

这里有两个配置位置：

~~~text
services.db.healthcheck
写在 db 自己身上
回答：
“怎么判断 db 是否健康？”

services.api.depends_on
写在 api 身上
回答：
“api 启动前要等谁达到什么状态？”
~~~

#### <u>1. 为什么只知道 Container Started 还不够</u>

数据库启动通常经历：

~~~text
Docker 创建 Container
↓
Database Process Started
↓
读取配置
↓
初始化数据目录
↓
加载内部状态
↓
开始真正接受连接
~~~

所以：

~~~text
Process Started
≠
Service Ready
~~~

如果 API 太早连接：

~~~text
API Start
↓
Connect DB
↓
DB 仍在初始化
↓
Connection Failed
~~~

这就是 Startup Race。

#### <u>2. healthcheck 定义“如何判断这个 Service Ready”</u>

~~~yaml
services:
  db:
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 10
~~~

Docker 会：

~~~text
启动 DB Container
↓
周期执行 pg_isready
↓
检查成功
↓
DB Health = healthy
~~~

所以 `healthcheck` 属于被依赖的 `db` Service。

#### <u>3. depends_on condition 定义“依赖方要等到哪个状态”</u>

~~~yaml
services:
  api:
    depends_on:
      db:
        condition: service_healthy
~~~

表示：

~~~text
API 想启动
↓
检查 db Dependency
↓
要求 db = healthy
↓
满足后再启动 API
~~~

Docker 官方 Compose 文档明确说明 `service_healthy` 会等待依赖 Service 的 Healthcheck 通过。[[10]](https://docs.docker.com/compose/how-tos/startup-order/)

#### <u>4. 三种 Condition 对应依赖方的三个生命周期状态</u>

~~~text
service_started
只要求 Container 已启动

service_healthy
要求 Healthcheck 已通过

service_completed_successfully
要求一次性 Job 成功退出
~~~

它们回答的是：我需要等依赖方走到生命周期的哪一步？

#### <u>5. Browser Monitor 当前第一条依赖：TimescaleDB → Migration</u>

~~~yaml
services:
  timescaledb:
    image: timescale/timescaledb-ha:pg17

    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U monitor -d monitor"]

  migrate:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend

    depends_on:
      timescaledb:
        condition: service_healthy
~~~

执行：

~~~text
TimescaleDB Container Start
↓
pg_isready
↓
healthy
↓
migrate Container 才启动
~~~

#### <u>6. Browser Monitor 当前第二条依赖：Migration / Redis → API</u>

~~~yaml
services:
  api:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend

    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
~~~

含义：

~~~text
API 要启动
├── Migration 必须 Exit 0
└── Redis 必须 Healthy
↓
两个条件都满足
↓
API Container Start
~~~

所以完整关系不是抽象的 `DB → API`，而是：

~~~text
TimescaleDB
↓ healthy
Migration
↓ completed successfully
API

Redis
↓ healthy
API
~~~

这才是 Compose Runtime Dependency 的真实含义。

### 【Service 是否长期运行由主进程生命周期决定，restart 与 depends_on 负责配合】

Compose 中没有 `type: job` 或 `type: service` 这样的字段，用来显式声明“这是 One-shot Job”或“这是 Long-running Service”。

两者首先来自 **Container 启动后主进程本身的行为**：

~~~text
Container Start
      ↓
执行 Main Command
      ↓
Application Process
      │
      ├── 完成一次任务后主动 Exit
      │      → One-shot Job
      │
      └── 持续监听 / 轮询 / 消费任务
             → Long-running Service
~~~

然后 Compose 再通过 `restart`、`depends_on.condition`、`healthcheck` 等配置，配合这种 Process Lifecycle（进程生命周期）。

#### <u>1. One-shot Job 的“正常结果”就是进程完成后退出</u>

先看一个完整通用例子：

~~~yaml
services:
  db:
    image: postgres:17
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]

  migrate:
    image: my-app:1.0
    command: ["node", "migrate.js"]
    depends_on:
      db:
        condition: service_healthy
    restart: "no"
~~~

`migrate` Container 启动以后：

~~~text
Container Start
↓
node migrate.js
↓
连接 Database
↓
执行 Schema Migration
↓
Migration 完成
↓
Process Exit 0
↓
Container 进入 Exited 状态
~~~

这里的 `Exited` 不是故障。对于一次性迁移任务来说：

~~~text
Process 成功退出
=
Job 成功完成
~~~

所以：

~~~yaml
restart: "no"
~~~

很自然，因为这个 Container 本来就不应该永远保持 Running。

#### <u>2. Long-running Service 的预期状态是主进程持续存活</u>

再看 API：

~~~yaml
services:
  api:
    image: my-api:1.0
    command: ["node", "dist/main.js"]
    restart: unless-stopped
~~~

如果 `dist/main.js` 启动 HTTP Server：

~~~text
Container Start
↓
node dist/main.js
↓
listen :3000
↓
等待 Request
↓
处理 Request
↓
继续等待
↓
长期保持 Running
~~~

这里如果 Node Process 意外退出，通常意味着 API Service 已经停止工作，而不是“任务完成”。

因此 Long-running Service 常搭配：

~~~yaml
restart: unless-stopped
~~~

表示它的正常目标状态是持续运行，而不是执行一次后结束。

#### <u>3. restart 不负责定义类型，只负责“进程退出后怎么办”</u>

需要特别避免一个误解：

> `restart: "no"` 并不会把 Service 变成 One-shot Job；`restart: unless-stopped` 也不会把 Service 变成长期服务。

真正决定生命周期的是 Main Command 启动的 Process。

`restart` 只是处理：

~~~text
Process 已经退出
↓
Docker 接下来要不要重新启动 Container
~~~

所以：

~~~text
command / CMD
决定运行什么 Process

Process 本身
决定是执行一次还是持续运行

restart
决定 Process 退出以后 Docker 怎么处理
~~~

#### <u>4. service_completed_successfully 让其他 Service 等待 One-shot Job 成功结束</u>

如果 API 必须在 Migration 成功后启动：

~~~yaml
services:
  api:
    image: my-api:1.0
    depends_on:
      migrate:
        condition: service_completed_successfully
~~~

这里 API 等待的不是：

~~~text
migrate Container 已经启动
~~~

而是：

~~~text
migrate Process
已经执行结束
+
Exit Status 表示成功
~~~

完整生命周期：

~~~text
Database Healthy
↓
Migration Container Start
↓
Run Migration
↓
Exit 0
↓
service_completed_successfully
↓
API Container Start
~~~

这正是 One-shot Job 与下游 Long-running Service 最典型的组合。Docker Compose 官方使用 `service_completed_successfully` 表示等待依赖 Service 成功完成。[[10]](https://docs.docker.com/compose/how-tos/startup-order/)

#### <u>5. Browser Monitor 当前 migrate 与 api 正好体现这两种生命周期</u>

当前文件：

~~~text
browser-monitor/platform/infra/docker-compose.yml
~~~

Migration：

~~~yaml
services:
  migrate:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend

    command:
      ["pnpm", "--filter", "@browser-monitor/database", "migrate"]

    depends_on:
      timescaledb:
        condition: service_healthy

    restart: "no"
~~~

运行链：

~~~text
TimescaleDB Healthy
↓
migrate Container Start
↓
pnpm --filter @browser-monitor/database migrate
↓
执行数据库迁移
↓
迁移完成
↓
Process Exit
~~~

API：

~~~yaml
services:
  api:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend

    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy

    restart: unless-stopped
~~~

API 最终运行：

~~~text
node dist/main.js
↓
Node API Process
↓
持续处理 HTTP Request
↓
Long-running
~~~

因此项目里的差异不是某个 `type` 字段，而是：

~~~text
migrate
一次性 Command
+
成功后 Exit
+
restart: no
+
被 API 以 service_completed_successfully 等待

api
长期运行 Command
+
持续 Node Process
+
restart: unless-stopped
~~~

可以最终收束为：

| 维度 | One-shot Job | Long-running Service |
| --- | --- | --- |
| Main Command | 完成一个有限任务 | 启动长期服务 |
| Process 预期 | 完成后退出 | 持续运行 |
| Exit 0 | 正常成功结果 | 通常表示服务停止 |
| restart | 常见 `no` | 常见 `unless-stopped` / `always` 等 |
| 下游依赖 | 常用 `service_completed_successfully` | 常用 `service_healthy` / `service_started` |
| 典型场景 | Migration、初始化、数据导入 | API、Worker、Database、Redis |

### 【Profiles 控制可选 Service 是否参与本次 Compose 应用启动】

一个 Compose 文件可能同时描述：

~~~text
核心 Runtime Service
API / Database / Redis

和

可选辅助 Service
Mail Tool / Debug Tool / Mock Server / Admin UI
~~~

如果所有 Service 每次 `docker compose up` 都启动，会出现：

~~~text
不需要的 Container 也运行
↓
占用 CPU / Memory / Port
↓
本次运行拓扑比实际需求更复杂
~~~

Profiles（配置档）解决的就是：

> 在同一份 Compose 文件中声明可选 Service，并决定当前这次启动是否把它们纳入运行系统。

Docker 官方说明，没有配置 Profile 的 Service 默认启用；配置了 Profile 的 Service 通常只有在对应 Profile 被激活时才启用。[[14]](https://docs.docker.com/compose/how-tos/profiles/)

#### <u>1. 没有 profiles 的 Service 默认属于核心启动集合</u>

例如：

~~~yaml
services:
  db:
    image: postgres:17

  api:
    image: my-api:1.0
~~~

执行：

~~~bash
docker compose up
~~~

Compose 会启动：

~~~text
db
api
~~~

因为它们没有被放入任何可选 Profile。

#### <u>2. 配置 profiles 后，这个 Service 变成条件启用</u>

加入 Mail Tool：

~~~yaml
services:
  db:
    image: postgres:17

  api:
    image: my-api:1.0

  mailpit:
    image: axllent/mailpit
    profiles:
      - dev
~~~

普通执行：

~~~bash
docker compose up
~~~

结果可以理解为：

~~~text
db       启动
api      启动
mailpit  不因为普通 up 自动启动
~~~

此时 `profiles: [dev]` 并不是在说：

~~~text
这个 Container 的 NODE_ENV = development
~~~

而是在说：

~~~text
mailpit 属于 dev 这个可选运行集合
~~~

#### <u>3. --profile dev 会把 dev Service 加入默认启动集合</u>

执行：

~~~bash
docker compose --profile dev up
~~~

启动集合变成：

~~~text
没有 Profile 的核心 Service
db
api

+

dev Profile Service
mailpit
~~~

所以：

~~~text
--profile dev
≠
只启动 dev Service

而是

默认 Service
+
激活的 dev Profile Service
~~~

Docker Compose 也允许显式指定某个带 Profile 的 Service；这种情况下，目标 Service 的 Profile 会被自动激活用于这次目标运行，但不会因此自动启用同 Profile 下所有其他 Service。这个细节属于 Profile 的目标启动行为。[[14]](https://docs.docker.com/compose/how-tos/profiles/)

#### <u>4. 多个 Profile 可以表达不同运行场景</u>

例如：

~~~yaml
services:
  api:
    image: api

  db:
    image: postgres

  mailpit:
    image: mailpit
    profiles: ["dev"]

  adminer:
    image: adminer
    profiles: ["debug"]

  mock-payment:
    image: mock-payment
    profiles: ["test"]
~~~

那么：

~~~bash
docker compose up
~~~

表示核心运行：

~~~text
api
db
~~~

执行：

~~~bash
docker compose --profile dev up
~~~

则加入：

~~~text
mailpit
~~~

执行：

~~~bash
docker compose --profile debug up
~~~

则加入：

~~~text
adminer
~~~

Profile 因此可以理解为：

~~~text
同一份 Compose Runtime Topology
        ↓
根据当前场景
选择额外启用哪些可选 Service
~~~

#### <u>5. Browser Monitor 当前把 Mailpit 放在 dev Profile</u>

当前：

~~~yaml
services:
  mailpit:
    image: axllent/mailpit:v1.27
    profiles: ["dev"]
    ports:
      - "8025:8025"
      - "1025:1025"
    restart: unless-stopped
~~~

Mailpit 主要承担开发邮件调试：

~~~text
Application
↓ SMTP
Mailpit
↓
截获开发邮件
↓
开发者通过 Mailpit Web UI 查看
~~~

它不是 TimescaleDB、Redis、API 这类所有运行场景都必须存在的核心 Service，因此被放入 `dev` Profile。

于是可以得到：

~~~text
普通 Compose 启动
→ 不自动加入 Mailpit

启用 dev Profile
→ 默认 Service + Mailpit
~~~

#### <u>6. Profile 与其他 Compose 配置解决的问题完全不同</u>

| 配置 | 回答的问题 |
| --- | --- |
| `profiles` | 这个 Service 当前要不要参与 Compose 启动 |
| `command` | Container 启动后执行什么 Process |
| `environment` | Process 运行时获得什么配置 |
| `depends_on` | 这个 Service 启动前依赖谁 |
| `healthcheck` | 怎样判断 Service 是否健康 / Ready |
| `restart` | Process 退出后是否重新启动 Container |

所以 Profile 不是“开发环境变量”，也不是“启动顺序”，更不是“One-shot / Long-running 类型声明”。

把这一组配置放在一起，可以形成完整 Service Lifecycle：

~~~text
profiles
↓
本次是否参与启动

command / CMD
↓
启动什么 Process

Process Lifecycle
↓
一次性结束 or 长期运行

healthcheck
↓
当前是否 Ready

depends_on
↓
其他 Service 什么时候可以继续

restart
↓
Process 退出以后怎么办
~~~

### 【.env 先作为 Compose 变量来源，再由 environment 或 build.args 决定是否进入 Container / Build】

`.env` 最容易产生的误解是：只要文件叫 `.env`，里面的变量就会自动进入所有 Container。

更准确的模型是：

~~~text
.env
↓
Compose Variable Source
↓
解析 ${VARIABLE}
↓
Compose Configuration
│
├── environment
│      ↓
│   Container Environment
│      ↓
│   Application Process
│
└── build.args
       ↓
    Dockerfile ARG
       ↓
    Image Build
~~~

所以需要区分两件事：

~~~text
Compose 能不能读取一个变量
≠
这个变量会不会进入 Container
~~~

Docker Compose 官方将 `.env` / `--env-file` 作为变量插值来源，而 Service 的 `environment`、`env_file` 才负责设置 Container Environment。[[28]](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) [[29]](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)

#### <u>1. --env-file 显式告诉 Compose 从哪个文件读取变量</u>

例如项目目录：

~~~text
project/
├── platform/
│   ├── .env
│   └── infra/
│       └── docker-compose.yml
~~~

启动时：

~~~bash
docker compose \
  --env-file platform/.env \
  -f platform/infra/docker-compose.yml \
  up
~~~

这里：

~~~text
--env-file platform/.env
↓
Compose CLI 读取 platform/.env
↓
作为 ${VARIABLE} 的取值来源
~~~

所以当前项目的 `platform/.env` 不是因为名字叫 `.env` 就自动进入所有 Container，而是启动命令显式使用了 `--env-file platform/.env`。

#### <u>2. ${VAR:-default} 是 Compose 解析阶段的变量插值</u>

假设 `platform/.env`：

~~~env
POSTGRES_PASSWORD=secret
INGEST_PROJECT_RATE_PER_SECOND=200
~~~

Compose：

~~~yaml
services:
  timescaledb:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-monitor}

  api:
    environment:
      INGEST_PROJECT_RATE_PER_SECOND: ${INGEST_PROJECT_RATE_PER_SECOND:-100}
~~~

解析过程：

~~~text
${POSTGRES_PASSWORD:-monitor}
↓
先查 Compose Variable Source
↓
找到 POSTGRES_PASSWORD=secret
↓
最终值 secret
~~~

如果没有提供变量：

~~~text
${INGEST_PROJECT_RATE_PER_SECOND:-100}
↓
变量不存在
↓
使用默认值 100
~~~

这里的 `${...}` 发生在 Compose 配置解析阶段，还没有进入 Application Process。

#### <u>3. environment 决定哪些值真正进入 Container</u>

假设 `.env` 中有：

~~~env
A=1
B=2
C=3
~~~

Compose 只写：

~~~yaml
services:
  api:
    environment:
      A: ${A}
~~~

那么 API Container 最终只有：

~~~text
A=1
~~~

`B`、`C` 虽然存在于变量文件中，但没有通过 `environment` 注入该 Service，因此不会自动成为 API Container 的 Environment。

完整链：

~~~text
.env
↓
Compose 能读取 A / B / C
↓
environment 只选择 A
↓
API Container
A=1
~~~

对于 Node.js 程序，最终才可以通过：

~~~js
process.env.A
~~~

读取 Container Environment。

#### <u>4. env_file 与 --env-file 的作用层级不同</u>

命令行：

~~~bash
docker compose --env-file platform/.env up
~~~

主要作用在 Compose CLI：

~~~text
.env
↓
Compose Variable Interpolation
↓
${VAR}
~~~

而 Service 中：

~~~yaml
services:
  api:
    env_file:
      - ../.env
~~~

主要表示：

~~~text
.env
↓
直接作为 api Service 的 Container Environment 来源
~~~

所以两者不能因为名字都包含 `env-file` 就认为完全等价。

当前 Browser Monitor 主要使用的是：

~~~text
--env-file
+
Compose environment
~~~

这种写法能够显式控制每个 Service 获得哪些变量，而不是把同一份 `.env` 全量注入所有 Container。

#### <u>5. build.args 则把变量送入 Image Build，而不是 Runtime Process</u>

例如：

~~~yaml
services:
  audit-worker:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.audit-worker
      args:
        DEBIAN_MIRROR_BASE: ${DEBIAN_MIRROR_BASE:-https://deb.debian.org}
~~~

对应 Dockerfile：

~~~dockerfile
ARG DEBIAN_MIRROR_BASE=https://deb.debian.org
~~~

链路：

~~~text
platform/.env
↓
--env-file
↓
Compose 解析 ${DEBIAN_MIRROR_BASE}
↓
build.args
↓
Dockerfile ARG
↓
影响 apt Build 阶段
~~~

这和：

~~~yaml
environment:
  AUDIT_CHROME_PATH: ${AUDIT_CHROME_PATH:-/usr/bin/chromium}
~~~

不同：后者是 Runtime Environment，会进入 Container，并提供给 Audit Worker Process。

#### <u>6. Browser Monitor 的 Host Runtime 与 Container Runtime 使用不同地址</u>

当前 `platform/.env.example` 中：

~~~env
DATABASE_URL=postgres://monitor:monitor@localhost:5432/monitor
REDIS_URL=redis://localhost:6379
~~~

这两个地址适合 Host 上直接运行 Node Process 时访问 Host 暴露的数据库和 Redis。

但是当前 Compose Backend Environment 写的是：

~~~yaml
environment:
  DATABASE_URL: postgres://monitor:${POSTGRES_PASSWORD:-monitor}@timescaledb:5432/monitor
  REDIS_URL: redis://redis:6379
~~~

这里并没有直接使用：

~~~text
${DATABASE_URL}
${REDIS_URL}
~~~

原因是 Docker Runtime 的网络位置已经变化：

~~~text
Host Local Runtime
Node Process
↓
localhost:5432 / localhost:6379

Docker Compose Runtime
API / Worker Container
↓
timescaledb:5432 / redis:6379
~~~

`timescaledb` 和 `redis` 是 Compose Service Name，可以通过 Docker Network 的 Service Discovery 解析。

因此：

> `.env` 中存在某个变量，不意味着 Compose 必须原样把它交给 Container。Compose 可以根据 Container Runtime 的网络、路径和运行环境重新构造最终值。

#### <u>7. .env.example 是配置模板，不参与实际运行</u>

当前仓库保存的是：

~~~text
platform/.env.example
~~~

本地运行时先复制：

~~~bash
cp platform/.env.example platform/.env
~~~

然后修改真实配置，再执行：

~~~bash
docker compose \
  --env-file platform/.env \
  --profile dev \
  -f platform/infra/docker-compose.yml \
  up --build
~~~

因此：

~~~text
.env.example
→ 配置字段模板 / 示例默认值

.env
→ 本地实际配置

--env-file
→ 告诉 Compose 读取哪个变量文件

environment
→ 选择并构造 Container Runtime Environment

build.args
→ 选择并构造 Image Build Argument
~~~

最终可以把环境变量链路收束为：

~~~text
Host Environment / .env
        ↓
Compose Variable Source
        ↓
${VAR:-default}
        ↓
Compose 最终配置
        │
        ├── environment
        │      ↓
        │   Container Environment
        │      ↓
        │   Application Process
        │
        └── build.args
               ↓
            Dockerfile ARG
               ↓
            Image Build
~~~

这条链能够解释“变量从哪里来、什么时候解析、最终进入 Build 还是 Runtime”，比单纯记住 `.env` 会被加载更准确。


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

### 【Docker 常用命令围绕初始化、启动、验证和排障展开】

Docker CLI 命令很多，但日常项目开发真正高频的命令并不多。命令应该继续挂在前面的对象模型上理解：

~~~text
Project
↓ docker init
Dockerfile / compose.yaml / .dockerignore
↓
Image Build
↓
Container / Compose Runtime
↓
Status / Logs / Exec / Inspect
↓
Stop / Down
~~~

这一节不做命令大全，只保留能完成一次完整 Docker 工作流的核心命令。

#### <u>1. docker init 为项目生成 Docker 初始配置</u>

假设原始 Node 项目：

~~~text
my-api/
├── package.json
├── package-lock.json
└── src/
    └── main.js
~~~

项目原来通过 npm install、npm start 运行，并监听 3000。

进入项目根目录：

~~~bash
cd my-api
docker init
~~~

Docker Desktop 提供的 docker init 会交互式询问 Application Platform、Runtime Version、Package Manager、Build、Start Command、Port 等信息，并生成 Docker Starter Files。[[15]](https://docs.docker.com/reference/cli/docker/init/)

通常生成：

~~~text
my-api/
├── src/
├── package.json
├── package-lock.json
├── Dockerfile
├── compose.yaml
├── .dockerignore
└── README.Docker.md
~~~

docker init 只是生成起点，生成后仍要根据真实项目检查 Runtime Boundary、Port、Volume、Environment 和启动命令。

#### <u>2. 初始化后先检查最终 Compose 配置</u>

至少确认：

~~~text
Dockerfile
├── FROM 使用什么 Runtime
├── COPY 哪些文件
├── RUN 如何安装 / Build
└── CMD 启动什么 Process

compose.yaml
├── build / image
├── environment
├── ports
├── volumes
└── depends_on / healthcheck / restart
~~~

然后执行：

~~~bash
docker compose config
~~~

它用于确认 Compose YAML、Environment Variable、Service、Port、Volume、Network、Profile 等最终解析结果。

#### <u>3. 一条命令完成 Build 与启动</u>

配置确认后：

~~~bash
docker compose up -d --build
~~~

执行链：

~~~text
读取 compose.yaml
↓
需要 Build 的 Service 构建 Image
↓
需要 Pull 的 Service 获取 Image
↓
创建 Network / Volume
↓
Create Container
↓
按 Dependency Start Container
↓
-d 后台运行
~~~

Docker 官方将 docker compose up 定义为创建并启动 Service Container；--build 表示启动前构建需要构建的 Image。[[16]](https://docs.docker.com/reference/cli/docker/compose/up/)

#### <u>4. 启动以后按“状态 → 日志 → Container 内部”排查</u>

先看状态：

~~~bash
docker compose ps
~~~

如果有 Migration 等 One-shot Job：

~~~bash
docker compose ps --all
~~~

再看某个 Service 日志：

~~~bash
docker compose logs -f api
~~~

需要进入 Container：

~~~bash
docker compose exec api sh
~~~

最基本排障链：

~~~text
docker compose ps
↓
哪个 Service 状态异常？

docker compose logs -f <service>
↓
Process 为什么失败？

docker compose exec <service> sh
↓
进入 Container 检查 Environment / Filesystem / Network
~~~

如果要查看底层 Docker 配置，可以使用：

~~~bash
docker inspect <container>
~~~

常用于检查 Environment、Port Binding、Network、Mount、Image、Command 和 Restart Policy。

#### <u>5. 从 Docker 初始化到运行的一条完整示例</u>

第一次给普通 Node API 配置 Docker，可以按下面一条链执行：

~~~bash
# 1. 进入项目
cd my-api

# 2. 生成 Docker 初始配置
docker init

# 3. 检查最终 Compose 配置
docker compose config

# 4. Build Image 并后台启动 Service
docker compose up -d --build

# 5. 查看运行状态
docker compose ps

# 6. 查看 API 日志
docker compose logs -f api
~~~

假设生成后的 Compose 中 API 为：

~~~yaml
services:
  api:
    build:
      context: .
    ports:
      - "8080:3000"
~~~

而 Node Process 在 Container 内监听：

~~~text
0.0.0.0:3000
~~~

那么完整运行链：

~~~text
Host Project
my-api/
↓
docker init
↓
Dockerfile + compose.yaml + .dockerignore
↓
docker compose config
↓
确认最终 Runtime Configuration
↓
docker compose up -d --build
↓
Dockerfile + Build Context
↓
Image
↓
API Container
↓
Node Process listen :3000
↓
ports: 8080:3000
↓
Host Browser
http://localhost:8080
~~~

如果访问异常：

~~~bash
docker compose ps
docker compose logs -f api
docker compose exec api sh
~~~

调试完成后：

~~~bash
docker compose down
~~~

Docker 官方说明，docker compose down 默认停止并移除 Compose 创建的 Service Container 与 Network。[[17]](https://docs.docker.com/reference/cli/docker/compose/down/)

所以最值得记住的完整指令链就是：

~~~text
docker init
↓
docker compose config
↓
docker compose up -d --build
↓
docker compose ps
↓
docker compose logs -f <service>
↓
docker compose exec <service> sh
↓
docker compose down
~~~

#### <u>6. 单 Container 项目才更多直接使用 docker build 与 docker run</u>

没有 Compose 时：

~~~bash
docker build -t my-api:1.0 .

docker run -d \
  --name my-api \
  -p 8080:3000 \
  my-api:1.0
~~~

关系：

~~~text
docker build
Dockerfile + Build Context
↓
Image

docker run
Image
↓
Create Container
↓
Start Container
~~~

查看与排障保留几个关键命令即可：

~~~bash
docker ps -a
docker logs -f my-api
docker exec -it my-api sh
docker inspect my-api
~~~

需要区分：docker run 是从 Image 创建并启动新 Container；docker compose up 是按照 Compose Runtime Topology 一次组织多个 Service。

#### <u>7. Volume 与 Network 命令主要用于排障</u>

Volume：

~~~bash
docker volume ls
docker volume inspect <volume>
~~~

Network：

~~~bash
docker network ls
docker network inspect <network>
~~~

最后把高频命令压缩为：

~~~text
初始化        docker init
检查配置      docker compose config
启动          docker compose up -d --build
状态          docker compose ps
日志          docker compose logs -f <service>
进入 Container docker compose exec <service> sh
关闭          docker compose down
~~~

需要特别谨慎：

~~~bash
docker compose down -v
~~~

`-v` 会连相关 Volume 一起删除，如果其中保存数据库数据，就可能一起被清除。

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
11. Docker Docs, **Bind mounts**：https://docs.docker.com/engine/storage/bind-mounts/
12. Docker Docs, **Port publishing and mapping**：https://docs.docker.com/engine/network/port-publishing/
13. Docker Docs, **tmpfs mounts**：https://docs.docker.com/engine/storage/tmpfs/
14. Docker Docs, **Using profiles with Compose**：https://docs.docker.com/compose/how-tos/profiles/
15. Docker Docs, **docker init**：https://docs.docker.com/reference/cli/docker/init/
16. Docker Docs, **docker compose up**：https://docs.docker.com/reference/cli/docker/compose/up/
17. Docker Docs, **docker compose down**：https://docs.docker.com/reference/cli/docker/compose/down/
18. Browser Monitor：browser-monitor/platform/infra/docker-compose.yml
19. Browser Monitor：browser-monitor/platform/infra/Dockerfile.backend
20. Browser Monitor：browser-monitor/platform/infra/Dockerfile.web
21. Browser Monitor：browser-monitor/platform/infra/Dockerfile.audit-worker
22. Browser Monitor：browser-monitor/platform/infra/Caddyfile
23. Browser Monitor：browser-monitor/platform/apps/api/package.json
24. Browser Monitor：browser-monitor/platform/apps/worker/package.json
25. Browser Monitor：browser-monitor/platform/apps/web/package.json
26. Browser Monitor：browser-monitor/platform/apps/audit-worker/package.json
27. Browser Monitor：browser-monitor/sdk/package.json
28. Docker Docs, **Compose variable interpolation**：https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/
29. Docker Docs, **Set environment variables within your container's environment**：https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/
