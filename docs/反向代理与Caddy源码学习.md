# 反向代理与 Caddy 源码学习

> **学习目标**：从 Reverse Proxy（反向代理）的网络位置开始，建立“Client → Edge Proxy → Upstream Service”的完整请求模型，再理解 Caddy 如何把路由、静态资源、SPA Fallback、响应压缩和访问控制组合成一个统一入口，最后回到 Browser Monitor 当前源码逐段追踪真实请求链。
>
> **事实边界**：反向代理与 Caddy 的通用行为以 Caddy 官方文档和 MDN 为依据；项目实现以 `cxDlogver/browser-monitor` 当前 `main` 分支源码为准。`cx-learn-notes` 中的 `browser-monitor` 是 Git Submodule，当前可能锁定到较早 Commit，因此学习项目最新行为时应优先读取独立仓库。

---

## 1. 反向代理位于 Client 与真实 Application Service 之间

理解反向代理时，先不要从 Caddy、Nginx 这些工具名开始，而是先看请求原本如何进入后端。

假设浏览器直接访问 API：

~~~text
Browser
↓
http://api.example.com:3000
↓
API Process
~~~

此时 Browser 直接知道并访问真正的 Application Service。

引入 Reverse Proxy（反向代理）以后，请求入口发生变化：

~~~text
Browser
↓
https://monitor.example.com
↓
Reverse Proxy
↓
api:3000
↓
API Process
~~~

Browser 只知道公开入口 `monitor.example.com`，并不知道真正处理请求的 API 位于哪个 Container、哪个私网地址或哪个端口。

因此可以先给反向代理一个最重要的定义：

> **Reverse Proxy 是站在服务端一侧的中间层。Client 先把请求发给 Proxy，由 Proxy 根据规则选择真正的 Upstream（上游服务），再把 Upstream Response 返回给 Client。**

### 【Forward Proxy 与 Reverse Proxy 的区别在于代理代表谁】

Forward Proxy（正向代理）的典型关系是：

~~~text
Client
↓
Forward Proxy
↓
Internet Server
~~~

目标 Server 主要看到 Proxy，而不是直接看到内部 Client。正向代理通常代表 Client 访问外部资源。

Reverse Proxy 则是：

~~~text
Internet Client
↓
Reverse Proxy
↓
Internal Server
~~~

Client 认为自己正在访问一个统一的 Server，但真正的 Application Server 位于 Proxy 后面。

因此：

~~~text
Forward Proxy
主要隐藏 / 代理 Client

Reverse Proxy
主要隐藏 / 代理 Backend Service
~~~

### 【反向代理首先解决 Public Entry 与 Internal Service 的边界】

一个真实系统通常不希望把所有内部 Service 都直接暴露给互联网：

~~~text
Internet
│
├── Web Service :8080
├── API Service :3000
├── Redis :6379
├── PostgreSQL :5432
└── Internal Metrics
~~~

更稳定的边界是：

~~~text
Internet
↓
Public Entry
↓
Reverse Proxy / Gateway
│
├── /          → Web
├── /api/*     → API
├── /health/*  → Health Endpoint
└── /internal  → Restricted Endpoint

Internal Network
├── API
├── Redis
├── Database
└── Worker
~~~

这样 Public Exposure（公网暴露）与 Runtime Topology（内部运行拓扑）就被拆开。

反向代理真正创造的不是“多转发一次请求”，而是一个新的边界：

~~~text
External Addressing
公开域名 / 公网端口
        ↓
Reverse Proxy
        ↓
Internal Addressing
Service Name / Private DNS / Container Port
~~~

---

## 2. 统一入口使路径路由、同源访问和内部地址隐藏成为同一套机制

反向代理的价值不是一个孤立功能，而是多个能力都建立在“Client 只访问统一入口”这一前提之上。

### 【Path Routing 把一个 Public Origin 映射到多个内部处理单元】

例如外部只有：

~~~text
https://monitor.example.com
~~~

但是内部可以存在：

~~~text
/
→ Static Web

/api/*
→ API Service

/health/*
→ API Health Controller

/internal/*
→ Internal Metrics
~~~

Client 看到的是一套 URL Space（URL 空间），Proxy 再把不同 Path 分给不同 Upstream。

因此 URL：

~~~text
https://monitor.example.com/api/v1/projects
~~~

在浏览器视角是一条普通 HTTP URL；在服务端入口层内部，它会继续变成：

~~~text
Caddy
↓
api:3000/api/v1/projects
~~~

### 【Same-Origin 取决于 Scheme、Host 与 Port，而不是后端是否同一个进程】

浏览器的 Origin（源）由：

~~~text
Scheme + Host + Port
~~~

共同决定。只有这三个部分都相同才属于 Same-Origin（同源）。[[8]](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)

例如：

~~~text
http://localhost:8080/
http://localhost:8080/api/v1/projects
~~~

虽然一个最终由 Static File Server 处理、另一个最终由 API Process 处理，但对于 Browser 来说：

~~~text
Scheme = http
Host   = localhost
Port   = 8080
~~~

完全相同，因此是 Same-Origin。

反过来：

~~~text
http://localhost:8080
http://localhost:3000
~~~

即使两个服务都在同一台电脑上，因为 Port 不同，也属于不同 Origin。[[8]](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)

所以反向代理可以实现一个非常重要的映射：

~~~text
Browser 世界

一个 Origin
http://localhost:8080
│
├── /
└── /api/*

        ↓ Reverse Proxy

Server 世界

多个 Runtime
├── Caddy :8080
└── API   :3000
~~~

### 【Same-Origin 能减少管理 Web 对 CORS 的依赖，但不能消灭整个系统的 CORS】

如果 Web 页面从：

~~~text
http://localhost:8080
~~~

直接请求：

~~~text
http://localhost:3000/api/...
~~~

浏览器会把它当作 Cross-Origin Request（跨源请求），需要进入 CORS（Cross-Origin Resource Sharing，跨源资源共享）规则。

如果改成：

~~~text
fetch('/api/...')
~~~

浏览器首先请求当前 Origin：

~~~text
http://localhost:8080/api/...
~~~

再由 Server-side Caddy 转发到 API。浏览器不参与 Caddy → API 这一段内部转发，因此管理 Web 本身可以保持 Same-Origin。

但是 Browser Monitor 还有 SDK 上报：

~~~text
业务网站
https://shop.example.com
        ↓
Browser Monitor
https://monitor.example.com/api/v3/ingest/...
~~~

这仍然是 Cross-Origin，所以 API 的 CORS 能力仍然有存在价值。CORS 与 Reverse Proxy 不是互相替代的关系。

---

## 3. Caddy 是把 HTTP 入口能力组合起来的 Web Server 与 Reverse Proxy

Caddy 不等于 Reverse Proxy。Reverse Proxy 是一种网络角色，而 Caddy 是一个可以承担多种 HTTP Server 能力的工具。

当前项目实际使用的 Caddy 能力可以整理为：

~~~text
Caddy
│
├── HTTP Listener
│
├── Request Routing
│   └── handle
│
├── Reverse Proxy
│   └── reverse_proxy
│
├── Static File Server
│   ├── root
│   ├── try_files
│   └── file_server
│
├── Response Compression
│   └── encode
│
└── Response Policy
    └── header
~~~

Caddy 官方把 `reverse_proxy` 定义为把请求代理到一个或多个 Backend，并可进一步提供 Load Balancing、Health Check、Header Manipulation、Transport 等能力。[[1]](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

### 【Caddyfile 通过 Site Block 描述一个 HTTP 入口】

典型 Caddyfile：

~~~caddyfile
:8080 {
  ...
}
~~~

外层 Site Block 表达：

~~~text
哪个 Address / Port
↓
接收 Request
↓
进入哪些 Caddy Directive
~~~

当前项目：

~~~caddyfile
{$SITE_ADDRESS::8080} {
  ...
}
~~~

这里支持从 Environment 读取 `SITE_ADDRESS`，没有配置时默认使用 `:8080`。

### 【handle 负责把一个入口拆成互斥的请求分支】

当前 Caddyfile 使用多个 `handle`：

~~~caddyfile
handle /api/* { ... }

handle /health/* { ... }

handle /internal/* { ... }

handle { ... }
~~~

Caddy 官方说明，同一级 `handle` Block 之间是 mutually exclusive（互斥）的：一个请求进入匹配的分支后，不会继续进入其他同级 `handle`；没有 Matcher 的 `handle` 可以作为 Fallback。[[2]](https://caddyserver.com/docs/caddyfile/directives/handle)

所以可以把当前 Caddyfile 看成一个 HTTP Router：

~~~text
Request
↓
Path Matcher
│
├── /api/*
│      → API Branch
│
├── /health/*
│      → Health Branch
│
├── /internal/*
│      → Internal Branch
│
└── Other
       → Static Web Branch
~~~

### 【reverse_proxy 把当前 Request 转发到 Upstream】

当前最新 Caddyfile：

~~~caddyfile
handle /api/* {
  reverse_proxy {$API_UPSTREAM:api:3000}
}
~~~

`API_UPSTREAM` 没有配置时默认：

~~~text
api:3000
~~~

这表示 Upstream Address（上游地址）。Caddy 收到 Request 后，会建立到这个 Upstream 的连接，把 Request 发给它，再把 Response 带回 Client。[[1]](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

需要注意当前使用的是：

~~~caddyfile
handle /api/*
~~~

而不是：

~~~caddyfile
handle_path /api/*
~~~

`handle` 不会自动剥掉 `/api` Prefix，所以：

~~~text
Browser Request
/api/v1/projects
↓
Caddy
↓
API 收到的 URI
/api/v1/projects
~~~

Caddy 官方也明确说明，`handle_path` 才会自动 Strip Prefix；普通 `handle` 保留原路径。[[2]](https://caddyserver.com/docs/caddyfile/directives/handle)

### 【Caddy 默认补充 X-Forwarded-* 让 Upstream 知道原始请求信息】

Reverse Proxy 会导致一个问题：API TCP Connection 的直接对端已经不是 Browser，而是 Caddy。

~~~text
Browser
10.0.0.20
↓
Caddy
172.20.0.5
↓
API
172.20.0.6
~~~

如果 API 只看当前 TCP Peer，就会认为 Request 来自 Caddy。

因此 Reverse Proxy 通常通过 Header 传递原始 Client 信息。Caddy 默认会设置或增强：

~~~text
X-Forwarded-For
X-Forwarded-Proto
X-Forwarded-Host
~~~

并默认防止直接信任 Client 自己伪造的这些 Header。[[7]](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)

这就连接到当前 API：

~~~ts
const adapter = new FastifyAdapter({
  trustProxy: true,
});
~~~

`trustProxy: true` 的目的，就是让 Fastify / NestJS 在 Proxy 场景下能够使用 Forwarded Information 还原 Client IP、Protocol 等信息。

因此链路是：

~~~text
Browser Client IP
↓
Caddy
↓ add X-Forwarded-For
API
↓ trustProxy
Request Context / Rate Limit / Audit
~~~

---

## 4. Browser Monitor 把 Caddy 放在 Web Runtime 与 Backend Runtime 之间

理解当前反向代理是否必要，必须先看真实 Deployment Topology，而不是只看 Caddyfile。

### 【Dockerfile.web 把 Web 的 Build Runtime 与 Production Runtime 明确分开】

当前 `platform/infra/Dockerfile.web` 是典型的 Multi-stage Build（多阶段构建）：

~~~dockerfile
FROM node:22-bookworm-slim AS build
...
RUN pnpm --filter @browser-monitor/web build

FROM caddy:2.10-alpine
COPY platform/infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/platform/apps/web/dist /srv
~~~

理解这段 Dockerfile 的关键，不是只看到“Node + Caddy 两个镜像”，而是要区分 **Build Time（构建阶段）** 与 **Runtime（运行阶段）**。

第一阶段：

~~~dockerfile
FROM node:22-bookworm-slim AS build
~~~

创建的是 Build Stage。这里需要 Node.js，是因为 pnpm、TypeScript、Vite 等前端工具需要在 Node.js Runtime 中运行：

~~~text
React / TypeScript Source
        ↓
Node.js Build Runtime
        ↓
pnpm
        ↓
Vite Build
        ↓
dist/
~~~

Vite 官方将 `vite build` 定位为 Production Build：把应用源码构建成适合由 Static Hosting Service（静态托管服务）提供的生产资源。[[18]](https://vite.dev/guide/build)

因此 `dist/` 已经不是 React / TypeScript 源码本身，而是浏览器最终能够下载的生产静态资源，例如：

~~~text
dist/
├── index.html
└── assets/
    ├── index-xxxx.js
    └── index-xxxx.css
~~~

第二个：

~~~dockerfile
FROM caddy:2.10-alpine
~~~

不是“继续在前面的 Node Image 中安装 Caddy”，而是开始一个新的 Final Stage。Docker 官方对 Multi-stage Build 的定义也是：每个 `FROM` 可以开始新的 Build Stage，再通过 `COPY --from` 选择性复制前一阶段的构建产物，从而把构建工具留在 Build Stage，而不进入最终 Runtime Image。[[19]](https://docs.docker.com/build/building/multi-stage/)

所以：

~~~dockerfile
COPY --from=build /workspace/platform/apps/web/dist /srv
~~~

真正发生的是：

~~~text
Build Stage
Node.js
├── pnpm
├── Vite
├── TypeScript
├── Source
└── dist/
      │
      │ COPY --from=build
      ↓
Final Stage
Caddy
├── /etc/caddy/Caddyfile
└── /srv
    ├── index.html
    └── assets/
~~~

也就是说，Node.js 和 Vite 在这里主要承担 **“生产 dist”** 的职责；最终生产镜像以 `caddy:2.10-alpine` 为基础，长期运行的 Web Server Process 是 Caddy。

因此完整执行链应该写成：

~~~text
Build Time
────────────────────────────

React / TypeScript Source
        ↓
Node.js
        ↓
Vite Build
        ↓
dist/


Server Runtime
────────────────────────────

Web Container
        ↓
Caddy Process
        │
        ├── Serve /srv Static Files
        └── Reverse Proxy /api/*


Browser Runtime
────────────────────────────

Browser 下载 HTML / JS / CSS
        ↓
JavaScript Engine 执行生产 JS
        ↓
React Application 启动
        ↓
页面渲染
~~~

这里最容易混淆的一点是：

> **Caddy 不执行 React，Vite 也不是当前 Production Container 中长期运行的 Web Server。Caddy 负责把 Vite 已经构建好的静态文件发送给 Browser，真正的 React JavaScript 最终运行在 Browser Runtime 中。**

所以当前 Production Web Container 并不是：

~~~text
Vite Dev Server
~~~

而是：

~~~text
Web Container
↓
Caddy Process
├── Serve React Static Files
└── Reverse Proxy API
~~~

### 【一次页面访问会先经过 Caddy 获取静态资源，再由 Browser 启动 React】

例如 Browser 请求：

~~~text
GET /
~~~

当前 Caddy 的 Static Web Branch 会进入：

~~~caddyfile
handle {
  root * /srv
  try_files {path} /index.html
  file_server
}
~~~

于是链路首先是：

~~~text
Browser
↓ GET /
Caddy
↓
读取 /srv/index.html
↓
HTTP Response
↓
Browser
~~~

Browser 解析 `index.html` 后继续请求构建产物：

~~~text
GET /assets/index-xxxx.js
GET /assets/index-xxxx.css
~~~

Caddy 再从 `/srv/assets/` 返回对应文件：

~~~text
Browser
↓
Caddy
↓
/srv/assets/index-xxxx.js
↓
Browser JavaScript Engine
↓
执行 Production JavaScript
↓
React Boot
~~~

所以从“谁在运行什么”的视角看，当前项目同时存在三个不同阶段：

| 阶段 | Runtime / Process | 当前职责 |
| --- | --- | --- |
| Build Time | Node.js + Vite | 把 React / TypeScript Source 构建成 `dist/` |
| Server Runtime | Caddy Process | 提供 `dist/` 静态资源并代理 Backend Request |
| Browser Runtime | Browser JavaScript Engine | 执行构建后的 JavaScript 并运行 React |

### 【Development 使用 Vite Dev Server，不代表 Production 也必须运行 Vite】

开发环境通常执行：

~~~text
pnpm dev
↓
Vite Dev Server
↓
Browser
~~~

Vite Dev Server 在开发阶段同时承担源码转换、Module Loading、HMR（Hot Module Replacement，热模块替换）和 HTTP Development Server 等职责。

Production 则完全不同：

~~~text
React / TypeScript Source
↓
Vite Build
↓
dist/
↓
Caddy
↓
Browser
↓
React Runtime
~~~

因此可以把开发与生产的边界总结为：

| 维度 | Development | Production |
| --- | --- | --- |
| 前端输入 | React / TypeScript Source | Vite 已构建的 `dist/` |
| Vite 角色 | Dev Server + 开发期转换 | Build Tool |
| 对 Browser 提供 HTTP 的程序 | Vite Dev Server | Caddy |
| React JavaScript 最终执行位置 | Browser | Browser |
| API 转发入口 | 可由 Dev Proxy 或其他开发配置承担 | 当前由 Caddy `reverse_proxy` 承担 |

这个区分也解释了为什么 `Dockerfile.web` 同时出现 Node 和 Caddy：它们不在竞争“谁是 Web Server”，而是分别处于 **构建链** 与 **生产运行链**。

### 【Compose 只把 Web/Caddy 的 8080 暴露给 Host】

当前 Compose：

~~~yaml
services:
  api:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.backend
    # 没有 ports: 3000:3000

  web:
    build:
      context: ../..
      dockerfile: platform/infra/Dockerfile.web
    ports:
      - "8080:8080"
~~~

这形成：

~~~text
Host / Browser
        ↓
Published Port :8080
        ↓
Web Container
Caddy :8080
        ↓
Docker Network
        ↓
API Container :3000
~~~

API 监听：

~~~ts
await app.listen(config.API_PORT, '0.0.0.0');
~~~

说明 API Process 可以通过 Container Network Interface 接收请求，但 Compose 没有把 3000 Published 到 Host。

因此：

~~~text
api:3000
可以被同一 Docker Network 的 Caddy 访问

localhost:3000
默认不能直接作为 Host Browser 的 API 入口
~~~

### 【api:3000 是 Internal Address，不是 Browser URL】

在 Docker Compose 中：

~~~text
api
↓
Compose Service Name
↓
Docker DNS
↓
API Container IP
~~~

因此：

~~~caddyfile
reverse_proxy api:3000
~~~

本质上是：

~~~text
Caddy Container
↓ DNS resolve api
API Container
↓ Port 3000
NestJS / Fastify Process
~~~

浏览器本身无法把 `api` 当作公网 DNS 使用，这个名字属于 Docker Runtime 内部的 Service Discovery。

### 【API_UPSTREAM 把本地 Compose Address 抽象成可替换的 Runtime Address】

当前最新实现已经从固定：

~~~caddyfile
reverse_proxy api:3000
~~~

演进为：

~~~caddyfile
reverse_proxy {$API_UPSTREAM:api:3000}
~~~

于是：

~~~text
Local Docker Compose
API_UPSTREAM 未设置
↓
api:3000

Railway
API_UPSTREAM=<backend private domain>:3000
↓
Railway Private Network
~~~

这说明反向代理层的价值之一就是：

> **Browser 的 Public URL 不需要因为 Backend Runtime Location 变化而改变。**

当前 Railway 部署同样只把 Web/Caddy 暴露为公网 Service，Backend、TimescaleDB、Redis 走 Railway Private Network。项目部署记录明确保留了这一入口模型。[[13]](./Railway部署记录.md)

---

## 5. 一次管理后台 API 请求完整经历 Browser、Caddy 与 NestJS 三个网络视角

现在把前面的概念全部放回一次真实请求。

假设用户打开：

~~~text
http://localhost:8080/projects
~~~

React 页面需要请求项目列表。

### 【第一阶段：Browser 只生成相对路径请求】

当前 Web API Client：

~~~ts
const response = await fetch(path, {
  ...init,
  credentials: 'include',
  ...
});
~~~

调用方传入：

~~~text
/api/v1/projects
~~~

因为是 Relative URL（相对 URL），浏览器会结合当前页面 Origin：

~~~text
Current Origin
http://localhost:8080

+

Request Path
/api/v1/projects

=

http://localhost:8080/api/v1/projects
~~~

此时浏览器只知道 8080，不知道 API Container 的 3000。

`credentials: 'include'` 表示 Fetch 允许携带 Credential（例如 Cookie），并允许处理 `Set-Cookie`；跨源场景还需要 Server 允许 Credential。[[9]](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#credentials)

### 【第二阶段：Host Port 把 Request 交给 Caddy Container】

Compose：

~~~yaml
web:
  ports:
    - "8080:8080"
~~~

所以：

~~~text
Browser
http://localhost:8080/api/v1/projects
↓
Host :8080
↓ Port Publishing
Web Container :8080
↓
Caddy
~~~

### 【第三阶段：Caddy 根据 /api/* 选择 Reverse Proxy Branch】

Caddy：

~~~caddyfile
handle /api/* {
  reverse_proxy {$API_UPSTREAM:api:3000}
}
~~~

于是：

~~~text
Request Path
/api/v1/projects
↓
Matcher /api/*
↓
reverse_proxy
↓
api:3000
~~~

路径不会被删除，因此 NestJS 收到的仍是：

~~~text
/api/v1/projects
~~~

### 【第四阶段：Caddy 作为 HTTP Client 请求 API】

从网络连接角度，此时产生第二段 HTTP Connection：

~~~text
Connection A
Browser → Caddy

Connection B
Caddy → API
~~~

所以 Reverse Proxy 不是“把同一个 TCP Connection 原封不动穿过去”。对普通 HTTP Reverse Proxy 来说，Proxy 终止 Client-side Connection，再建立 Upstream-side Request。

Caddy 会把原始请求的重要信息通过 `X-Forwarded-*` 带给 API。[[7]](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)

### 【第五阶段：Fastify trustProxy 还原 Proxy 前的 Request Context】

当前 API：

~~~ts
const adapter = new FastifyAdapter({
  trustProxy: true,
});
~~~

所以 API 可以按照 Proxy Header 识别 Client 信息，而不是简单把 Caddy Container IP 当成最终用户 IP。

这对当前平台尤其重要，因为 Request IP 还会进入：

~~~text
Rate Limit
Audit
Request Context
~~~

### 【第六阶段：Response 再沿相反方向返回】

~~~text
NestJS Controller
↓
HTTP Response
↓
Caddy
↓
Response Header / Compression
↓
Browser
↓
fetch() Promise Resolve
~~~

所以一次完整管理 API 请求可以压缩成：

~~~text
React
fetch('/api/v1/projects')
        ↓
Browser Origin
localhost:8080
        ↓
Host Published Port
        ↓
Caddy :8080
        ↓
handle /api/*
        ↓
reverse_proxy
        ↓
API_UPSTREAM
        ↓
api:3000 / Railway Private Backend
        ↓
NestJS + Fastify
        ↓
Controller / Guard / Service
        ↓
Response
        ↓
Caddy
        ↓
Browser
~~~

---

## 6. 当前 Caddyfile 的四条请求分支分别承担 Public API、Health、Internal 与 SPA Web

当前配置：

~~~caddyfile
{$SITE_ADDRESS::8080} {
  encode zstd gzip

  handle /api/* {
    reverse_proxy {$API_UPSTREAM:api:3000}
  }

  handle /health/* {
    reverse_proxy {$API_UPSTREAM:api:3000}
  }

  handle /internal/* {
    @private remote_ip private_ranges
    handle @private {
      reverse_proxy {$API_UPSTREAM:api:3000}
    }
    respond "Forbidden" 403
  }

  handle {
    root * /srv
    try_files {path} /index.html
    file_server
  }

  header {
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    -Server
  }
}
~~~

这不是一组没有关系的 Directive，而是一个完整的 Edge Request Decision Tree：

~~~text
Request → Caddy
        ↓
   Path Decision
        │
        ├── /api/*
        │      ↓
        │   Public API
        │      ↓
        │   Backend
        │
        ├── /health/*
        │      ↓
        │   Health API
        │      ↓
        │   Backend
        │
        ├── /internal/*
        │      ↓
        │   Source IP Check
        │      ├── Private → Backend
        │      └── Other   → 403
        │
        └── Other Path
               ↓
           Static Web / SPA
~~~

### 【/api/* 是 Browser 与 SDK 的 Public Backend Entry】

~~~caddyfile
handle /api/* {
  reverse_proxy {$API_UPSTREAM:api:3000}
}
~~~

这一分支同时承载：

~~~text
Management API
/api/v1/...

以及

Ingestion API
/api/v3/ingest/...
~~~

需要注意二者安全模型不同：管理 API 使用 Session / CSRF / Project Membership；采集 API 使用 DSN Write Key、Origin、Rate Limit 等。

Caddy 只负责把 `/api/*` 送入 Backend；真正的 Authentication / Authorization 仍然在 Application Layer。

### 【/health/* 让外部探针不需要直接暴露 Backend Port】

~~~caddyfile
handle /health/* {
  reverse_proxy {$API_UPSTREAM:api:3000}
}
~~~

这样外部或平台 Health Check 可以访问：

~~~text
/health/live
/health/ready
~~~

但不需要让 `api:3000` 直接变成 Public Port。

### 【/internal/* 把网络来源判断放到 Edge Layer】

~~~caddyfile
handle /internal/* {
  @private remote_ip private_ranges
  handle @private {
    reverse_proxy {$API_UPSTREAM:api:3000}
  }
  respond "Forbidden" 403
}
~~~

当前典型 Endpoint 是：

~~~text
/internal/metrics
~~~

它用于 Prometheus-style Runtime Metrics。

访问逻辑：

~~~text
Request /internal/metrics
↓
remote_ip private_ranges ?
│
├── Yes
│    ↓
│  reverse_proxy Backend
│
└── No
     ↓
   403 Forbidden
~~~

这里说明 Caddy 不只是“路由工具”，还承担了一部分 Network Access Boundary。

但是它存在重要部署边界：如果未来 Caddy 前面还有 Cloud Load Balancer / CDN，`remote_ip` 看到的可能是前置 Proxy 的 IP，而不是最终用户 IP。Caddy 官方提供 `trusted_proxies` 与 `client_ip` 模型用于正确解析受信 Proxy 链。[[7]](https://caddyserver.com/docs/caddyfile/options#trusted-proxies)

因此复杂生产环境需要重新评估：

~~~text
Internet
↓
Cloud LB
↓
Caddy
↓
/internal
~~~

不能简单假设 `remote_ip private_ranges` 永远代表“最终用户来自私网”。

### 【Fallback handle 把剩余路径交给 React SPA】

~~~caddyfile
handle {
  root * /srv
  try_files {path} /index.html
  file_server
}
~~~

这条分支处理所有没有被 `/api`、`/health`、`/internal` 抢先匹配的路径。

`root * /srv`：

~~~text
Static File Root
= /srv
~~~

`Dockerfile.web` 已经把 Vite 的 `dist/` 复制到了 `/srv`。

`file_server` 会根据 Request URI 在 Site Root 中寻找静态文件。Caddy 官方说明 `file_server` 会把 Request URI Path 拼到 Root 后形成文件路径。[[4]](https://caddyserver.com/docs/caddyfile/directives/file_server)

`try_files {path} /index.html` 则提供 SPA Fallback：Caddy 会尝试找到第一个存在的文件，找不到请求路径对应文件时改写到 `/index.html`。[[3]](https://caddyserver.com/docs/caddyfile/directives/try_files)

例如用户直接刷新：

~~~text
/projects/123/performance
~~~

Host 上没有：

~~~text
/srv/projects/123/performance
~~~

于是：

~~~text
try_files
↓
/projects/123/performance 不存在
↓
/index.html
↓
React Application Boot
↓
React Router
↓
匹配 /projects/:projectId/performance
~~~

所以 Caddy 还承担了 SPA History Routing 的 Server-side Fallback。

---

## 7. Caddy 还在统一入口上承担 Compression 与 Response Security Policy

反向代理只是当前 Caddy 的一部分职责。

### 【encode 在 Response 返回 Browser 前执行压缩】

~~~caddyfile
encode zstd gzip
~~~

Caddy `encode` Directive 用于按照 Client 的 `Accept-Encoding` 对匹配 Response 进行编码压缩，并支持 Zstandard 与 Gzip。[[5]](https://caddyserver.com/docs/caddyfile/directives/encode)

因此：

~~~text
Static JS / CSS
API JSON Response
↓
Caddy
↓
zstd / gzip
↓
Browser
~~~

它可以减少传输字节，但具体 Response 是否压缩仍取决于 Content Type、大小和 Client Capability。

### 【header 把统一 Response Policy 放在入口层】

当前：

~~~caddyfile
header {
  X-Content-Type-Options nosniff
  Referrer-Policy strict-origin-when-cross-origin
  Permissions-Policy "camera=(), microphone=(), geolocation=()"
  -Server
}
~~~

Caddy `header` Directive 可以 Set、Add、Delete 或 Replace Response Header。[[6]](https://caddyserver.com/docs/caddyfile/directives/header)

当前配置作用可以整理为：

| Header | 当前意图 |
| --- | --- |
| `X-Content-Type-Options: nosniff` | 限制浏览器 MIME Sniffing |
| `Referrer-Policy: strict-origin-when-cross-origin` | 控制跨站请求 Referrer 暴露范围 |
| `Permissions-Policy` | 禁用 Camera / Microphone / Geolocation |
| `-Server` | 删除 Server Response Header |

因此这一层的工程意义是：

~~~text
Static Response
和
API Response
        ↓
统一经过 Caddy
        ↓
统一 Header Policy
~~~

这比在 React 与 NestJS 两边分别维护同一套基础 Response Header 更集中。

---

## 8. 当前项目保留反向代理是合理的，但必要的是 Edge Responsibility 而不是 Caddy 品牌本身

判断“反向代理有没有必要”，不能只问“多一次网络转发是不是多余”，而应该问：

> 如果删除这一层，当前由它承担的职责由谁接管？

### 【在当前 Docker Compose 拓扑不变时，删除 reverse_proxy 会直接破坏 API 请求链】

当前只有 Web：

~~~yaml
ports:
  - "8080:8080"
~~~

API 没有：

~~~yaml
ports:
  - "3000:3000"
~~~

所以 Browser 的 API Entry 依赖：

~~~text
Browser
↓ :8080
Caddy
↓
api:3000
~~~

如果只删除：

~~~caddyfile
reverse_proxy {$API_UPSTREAM:api:3000}
~~~

而不改变其他拓扑，那么 Browser 仍然只能访问 8080，API 3000 没有新的 Public Entry。

所以：

> **在当前 Runtime Topology 不变的前提下，Reverse Proxy 是请求链中的必要节点。**

### 【可以去掉 Caddy API Proxy，但必须把复杂度移到其他地方】

一种替代设计是直接发布 API：

~~~yaml
api:
  ports:
    - "3000:3000"
~~~

Frontend 改成：

~~~text
http://localhost:8080
↓
fetch('http://localhost:3000/api/...')
~~~

这时 Caddy 对 API 的 Proxy 可以删除。

但是系统会同时发生：

~~~text
一个 Public Origin
↓
变成
↓
Web Origin + API Origin

一个 Public Port
↓
变成
↓
8080 + 3000

Relative API Path
↓
变成
↓
Environment-specific Absolute API Base URL
~~~

并且管理后台需要更多处理：

~~~text
CORS
Cookie / Credential
CSRF
Production Domain
TLS Entry
/internal Access Boundary
~~~

这不是错误架构，只是把原本集中在 Edge Proxy 的复杂度分散到了 Browser、API 和部署层。

### 【当前管理后台 Same-Origin 是重要收益，但不是唯一收益】

当前 Web Client：

~~~text
fetch('/api/...')
~~~

因此管理后台页面和 API 在 Browser 视角保持 Same-Origin。

这降低了管理 Web 的部署配置复杂度，也让 Session Cookie、CSRF 和 API URL 管理更直接。

但不能把项目采用 Caddy 的理由简单说成：

~~~text
“为了跨域”
~~~

因为当前 Caddy 同时还承担：

~~~text
Public Entry
Path Routing
Backend Address Hiding
Static File Serving
SPA Fallback
Health Routing
Internal Metrics Boundary
Compression
Security Headers
~~~

### 【Caddy 可以被替换，Edge Layer 的职责不能凭空消失】

未来如果部署环境已经提供：

~~~text
Kubernetes Ingress
Cloud Load Balancer
API Gateway
Nginx
Traefik
Platform Edge Router
~~~

可以重新分配这些职责。

例如：

~~~text
Internet
↓
Kubernetes Ingress
├── /api → API Service
└── /    → Web Service
~~~

此时 Web Container 可能只需要纯 Static Server，甚至静态文件直接进入 CDN。

所以准确结论是：

> **当前项目需要一个 Edge Entry 来完成公开入口、路径分流和暴露边界；Caddy 是当前承担这些职责的具体实现，但不是不可替换的唯一工具。**

---

## 9. 当前实现的安全边界与后续演进应围绕 Proxy Trust Chain 展开

### 【API trustProxy 与 Caddy X-Forwarded-* 必须作为一条链理解】

当前：

~~~text
Caddy
↓ X-Forwarded-*
Fastify trustProxy: true
↓
Client IP / Protocol Context
~~~

这在 Caddy 是 Client 第一跳时逻辑清楚。

但是如果演进为：

~~~text
Internet
↓
CDN / Cloud LB
↓
Caddy
↓
API
~~~

就必须明确：

~~~text
哪些 Proxy 可以被信任？

Client 自己传入的 X-Forwarded-For
能否被伪造？

Caddy 看到的 remote_ip
究竟是 Client 还是上一层 Proxy？
~~~

Caddy 官方建议在前方存在受信代理时配置 `trusted_proxies`，从而安全解析真正的 Client IP，并可配合 `trusted_proxies_strict` 处理常见 Load Balancer 的 X-Forwarded-For Append 行为。[[7]](https://caddyserver.com/docs/caddyfile/options#trusted-proxies)

### 【/internal 的网络访问控制在多层代理部署中需要重新验证】

当前：

~~~caddyfile
@private remote_ip private_ranges
~~~

适合当前简单拓扑理解。

但如果 Public Load Balancer 通过私网访问 Caddy：

~~~text
Public Client
↓
Cloud Load Balancer
↓ private network
Caddy
~~~

Caddy 的直接 `remote_ip` 可能是 Load Balancer 的 Private IP。

因此未来 Production Hardening 可以考虑：

~~~text
方案 A
trusted_proxies + client_ip Matcher

方案 B
/internal 使用独立 Listener / Private Domain

方案 C
由 Cloud Gateway / Network Policy
直接阻断公网访问 Internal Endpoint
~~~

这属于部署层安全治理，不应只依赖 Application Controller 自己判断。

### 【API 的 CORS 仍要服务 SDK Cross-Origin 场景】

当前 API：

~~~ts
app.enableCors({
  origin: true,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
});
~~~

管理 Web 通过 Caddy 使用 Same-Origin，并不代表可以直接删除 CORS，因为 SDK 的 Ingestion Request 可能从任意业务站点跨 Origin 进入 Monitor Platform。

因此需要分开理解：

~~~text
Management Web
Same-Origin through Caddy

SDK Ingestion
Cross-Origin to Monitor Platform
~~~

CORS Credential Request 需要 Server 返回明确允许的 Origin，不能简单使用 `Access-Control-Allow-Origin: *` 与 Credential 组合。[[10]](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS#requests_with_credentials)

当前项目对采集来源的真正业务限制还位于 Ingestion Layer 的项目级 Origin Allowlist，不能把 CORS 本身当成完整 Authorization。

---

## 10. 面试与答辩应沿“入口改变了什么”复述当前方案

如果面试官问：

~~~text
为什么项目使用 Caddy 反向代理？
~~~

不建议只回答：

~~~text
“为了解决跨域。”
~~~

更完整的回答路径应该是：

~~~text
1. 当前 Web 与 API 是两个 Runtime
        ↓
2. API 3000 不直接暴露公网
        ↓
3. Caddy 8080 成为统一 Public Entry
        ↓
4. /api/* 根据 Path 代理到 Backend
        ↓
5. Browser 仍然只访问一个 Origin
        ↓
6. Caddy 同时托管 React 静态资源与 SPA Fallback
        ↓
7. /health 与 /internal 使用不同入口策略
        ↓
8. Compression / Security Header 统一放在 Edge
        ↓
9. Backend Location 可以从 Docker api:3000
   切换到 Railway Private Domain
   而 Browser URL 不变
~~~

可以压缩成一段答辩表达：

> Browser Monitor 把 Caddy 放在 Web 入口层。浏览器只访问 Web 暴露的统一地址，`/api/*`、`/health/*` 再由 Caddy 转发到内部 Backend，API 本身不需要直接发布公网端口。这样管理 Web 与 API 在浏览器视角保持同源，同时隐藏内部 Runtime 地址。Caddy 还负责 React 静态资源、SPA History Fallback、内部 Metrics 的网络入口控制、响应压缩和安全 Header。最新实现把 Backend 地址抽象为 `API_UPSTREAM`，因此本地 Compose 使用 `api:3000`，Railway 可以改成 Private Network Domain，而公开 URL 不需要变化。Caddy 本身可以被 Ingress、Gateway 或 Nginx 替换，但当前这些 Edge Responsibility 仍然需要有一层承担。

最后把整个知识框架收束成：

~~~text
Reverse Proxy
解决 Public Entry → Internal Service
        ↓
Caddy
提供 Routing / Proxy / Static / Policy
        ↓
Browser Monitor
统一 8080 Public Entry
        ↓
Path Routing
├── /api/*      → Backend
├── /health/*   → Backend
├── /internal/* → Private Check → Backend
└── others      → React Static / SPA
        ↓
Proxy Metadata
X-Forwarded-*
        ↓
Fastify trustProxy
        ↓
Application Request Context
        ↓
Deployment Evolution
Docker Service Name
→ Railway Private Domain
→ Future Ingress / Gateway
~~~

---

## 11. 参考资料与项目源码

### 【Caddy 与 Web 标准】

1. Caddy Docs, **reverse_proxy**：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
2. Caddy Docs, **handle**：https://caddyserver.com/docs/caddyfile/directives/handle
3. Caddy Docs, **try_files**：https://caddyserver.com/docs/caddyfile/directives/try_files
4. Caddy Docs, **file_server**：https://caddyserver.com/docs/caddyfile/directives/file_server
5. Caddy Docs, **encode**：https://caddyserver.com/docs/caddyfile/directives/encode
6. Caddy Docs, **header**：https://caddyserver.com/docs/caddyfile/directives/header
7. Caddy Docs, **trusted_proxies / reverse_proxy defaults**：https://caddyserver.com/docs/caddyfile/options#trusted-proxies
8. MDN, **Same-origin policy**：https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy
9. MDN, **RequestInit.credentials**：https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#credentials
10. MDN, **CORS - Requests with credentials**：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS#requests_with_credentials

### 【Browser Monitor 当前实现】

11. [Caddyfile](../platform/infra/Caddyfile)
12. [Docker Compose](../platform/infra/docker-compose.yml)
13. [Railway 部署记录](./Railway部署记录.md)
14. [Web Dockerfile](../platform/infra/Dockerfile.web)
15. [Web API Client](../platform/apps/web/src/api/client.ts)
16. [React Router](../platform/apps/web/src/App.tsx)
17. [NestJS / Fastify API Bootstrap](../platform/apps/api/src/main.ts)

### 【Build 与 Runtime】

18. Vite Docs, **Building for Production**：https://vite.dev/guide/build
19. Docker Docs, **Multi-stage builds**：https://docs.docker.com/build/building/multi-stage/
