# Monorepo 多应用仓库知识体系

Monorepo（Monolithic Repository，单体代码仓库）不是“把多个项目放进一个 Git 仓库”这么简单，而是一套围绕**多项目统一管理**建立起来的工程体系：它需要同时解决代码如何组织、项目之间如何共享依赖、任务如何按依赖顺序执行、不同应用如何独立启动、哪些产物需要发布，以及 CI/CD 如何只处理真正受影响的部分。

本文以 `browser-monitor` 作为工程实践映射，但知识体系本身面向通用的前端、Node.js 与全栈多应用仓库。阅读时始终区分三类结论：

- **项目现状**：当前 `browser-monitor` 仓库已经存在并可以从代码、配置中确认的实现。
- **主流方案**：pnpm、Nx、Turborepo、Docker 等官方资料中常见的工程方案。
- **演进方案**：当仓库规模、CI 成本或发布复杂度继续增长时可以考虑的方向，不代表当前项目已经采用。

---

## 1. Monorepo 的整体框架从仓库组织延伸到运行部署

本章先建立总框架：**Monorepo 不是一个单点工具，而是 Repository → Workspace → Project → Dependency → Task → Artifact → Release / Deployment 的连续工程链路。**

### 【Monorepo 解决的是多个相关项目共同演进的问题】

**结论（P）**

Monorepo 是 Repository Strategy（仓库组织策略）。它把多个存在协作关系的 Application（应用）和 Package（包）放在同一个版本控制仓库中，在统一代码历史的基础上继续统一依赖、构建、测试、版本和发布治理。

它真正要解决的是下面这条链路：

```text
多个项目需要共同演进
        ↓
代码放在哪里
        ↓
哪些目录属于可管理项目
        ↓
项目之间如何共享代码
        ↓
修改一个公共包会影响谁
        ↓
哪些任务需要重新执行
        ↓
哪些包需要发布
        ↓
哪些应用需要部署
```

**理由（R）**

如果一个系统只有一个 Web 应用，那么传统单项目仓库通常已经足够。但当系统逐渐出现：

```text
Web 管理后台
API 服务
后台 Worker
浏览器 SDK
共享协议
数据库访问层
公共配置
```

这些模块会产生三个新的工程问题。

第一，**它们不是同一个运行单元**。SDK 会被业务页面安装，API 是长期运行的 Node.js 服务，Web 最终可能只是静态资源，Worker 则是后台任务进程。

第二，**它们又不是完全独立**。例如 SDK 与 API 必须对同一份监控事件协议保持一致，API 与 Worker 又需要共享数据库模型。

第三，**它们的变化范围不同**。修改 Web 页面不应该天然导致重新发布 SDK；修改协议包却可能同时影响 SDK、API 与 Worker。

因此 Monorepo 追求的不是“全部合并”，而是：

```text
统一管理
+
明确边界
+
可计算的依赖关系
```

**browser-monitor 实践（E）**

当前仓库可以概括为：

```text
browser-monitor/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
│
├── sdk/
├── protocol/
│
└── platform/
    ├── package.json
    ├── apps/
    │   ├── api/
    │   ├── worker/
    │   ├── audit-worker/
    │   └── web/
    │
    ├── packages/
    │   ├── database/
    │   └── shared/
    │
    └── infra/
```

其中至少存在三种不同性质的工程单元：

| 类型 | browser-monitor 对应项目 | 核心特点 |
| --- | --- | --- |
| 可发布 Package | `sdk`、`protocol` | 主要被其他项目安装或引用 |
| 内部 Library | `database`、`shared` | 为 Platform 内多个应用提供公共能力 |
| 可运行 Application | `api`、`worker`、`audit-worker`、`web` | 形成独立运行或部署单元 |

所以当前项目最关键的认识是：

```text
同一个 Git 仓库
≠
同一个应用
≠
同一个进程
≠
同一个容器
```

**总结（P）**

面试或答辩中可以回答：

> Monorepo 的核心不是“一个仓库存多个目录”，而是把多个强关联项目放进统一工程边界，通过 Workspace、依赖图和任务图管理它们的协作关系，同时保留不同应用各自的构建、发布和运行生命周期。

常见追问包括：Monorepo 和单体应用有什么区别、Monorepo 是否必须一起部署、为什么不直接拆成多个仓库。

---

### 【Monorepo、Monolith 与 Multi-repo 处于不同维度】

**结论（P）**

Monorepo 描述的是“代码仓库如何组织”，Monolith（单体应用）描述的是“运行架构如何组织”，二者不是同一维度；Multi-repo（多仓库）则是与 Monorepo 相对的仓库管理策略。

**理由（R）**

一个 Monorepo 完全可以包含多个独立服务：

```text
One Repository
├── Web
├── API
├── Worker
└── SDK
```

运行时仍然是：

```text
Web Service
API Service
Worker Service
```

反过来，一个单体服务的代码也可以拆进多个 Git 仓库，只是维护成本通常更高。

所以需要分别判断：

```text
仓库边界：Monorepo / Multi-repo
运行边界：Monolith / Distributed Services
```

**browser-monitor 实践（E）**

`browser-monitor` 在代码管理上属于 Monorepo，但运行时 API、Worker、Audit Worker、Web/Caddy、TimescaleDB、Redis 都是不同运行单元，因此不能称为“因为是 Monorepo，所以运行时也是单体”。

**总结（P）**

> Monorepo 是源码治理策略，不直接决定运行架构；同仓只是便于统一协作，真正的服务边界仍由进程、网络、部署和运行职责决定。

---

## 2. Repository、Workspace、Package 与 Application 构成代码组织边界

本章沿着“仓库里到底有哪些工程单元”展开：**Repository 负责版本控制，Workspace 负责项目发现，Package 定义工程单元，Application 与 Library 再通过运行职责区分。**

### 【Repository 只负责 Git 层面的共同历史】

**结论（P）**

Repository（代码仓库）决定哪些文件共享同一套 Git Commit、Branch、Pull Request、Tag 与历史记录，但它本身并不知道哪些目录是独立应用、哪些目录互相依赖。

**理由（R）**

假设仓库中存在：

```text
repo/
├── app-a/
├── app-b/
└── package-c/
```

Git 可以知道三个目录有哪些文件发生变化，却不知道：

```text
app-a → package-c
```

也无法仅凭 Git 判断：

```text
修改 package-c
是否需要重新测试 app-a？
是否需要重新构建 app-b？
是否需要发布 package-c？
```

因此 Monorepo 仍然需要 Workspace 和 Project Graph 来补充 Git 不理解的工程关系。

**browser-monitor 实践（E）**

`browser-monitor` 的 Git 文件只是最外层载体，真正开始定义 Monorepo 工程边界的是：

```text
browser-monitor/package.json
browser-monitor/pnpm-workspace.yaml
```

**总结（P）**

> Repository 回答“哪些代码一起进行版本控制”，但不会自动回答“这些代码由哪些项目组成、项目之间如何依赖”。

---

### 【Workspace 把普通目录提升为可统一管理的项目集合】

**结论（P）**

Workspace（工作区）是 Package Manager（包管理器）管理多个项目的机制。它负责发现哪些子目录属于当前多项目工程，并在一个安装上下文中统一处理它们的依赖。

pnpm Workspace 的根目录通过 `pnpm-workspace.yaml` 定义。官方文档：[pnpm Workspaces](https://pnpm.io/workspaces)。

**理由（R）**

如果没有 Workspace，下面四个目录可以完全按照四个独立项目处理：

```text
sdk/
protocol/
api/
web/
```

每个项目分别维护：

```text
package.json
lockfile
node_modules
依赖版本
```

一旦 SDK 与 API 都需要 `protocol`，就可能出现：

```text
修改 protocol
↓
发布 protocol
↓
SDK 升级版本
↓
API 升级版本
↓
分别安装和联调
```

Workspace 则把开发阶段变成：

```text
Repository
    ↓
Workspace
 ┌──┼─────────┐
 ↓  ↓         ↓
SDK Protocol  API
```

包管理器知道这些项目属于同一个工作空间，可以直接建立内部包关系。

**browser-monitor 实践（E）**

当前 `pnpm-workspace.yaml`：

```yaml
packages:
  - sdk
  - protocol
  - platform
  - platform/apps/*
  - platform/packages/*
```

因此 pnpm 会把这些目录纳入同一个 Workspace。

这里要注意：

```text
apps/
packages/
```

只是目录组织约定。真正让目录成为 Workspace Project 的是它被 `pnpm-workspace.yaml` 匹配，并具有对应的 `package.json`。

**总结（P）**

> Git Repository 是版本控制边界，Workspace 是包管理边界。Monorepo 通过 Workspace 把多个目录正式组织成可统一安装、引用和执行命令的项目集合。

常见追问：Workspace 和 Monorepo 是否等价、为什么需要根 `package.json`、`apps/*` 是否具有特殊语义。

---

### 【Application 与 Library 应按照生命周期而不是目录名字区分】

**结论（P）**

Application（应用）通常会形成独立启动或交付单元；Library（库）主要被其他项目引用，本身通常不长期运行。目录应该围绕 Responsibility（职责）和 Lifecycle（生命周期）拆分，而不是只为了“看起来模块化”。

**理由（R）**

判断一个模块是否应该是 Application，可以问：

```text
是否有自己的启动入口？
是否拥有独立运行生命周期？
是否能够独立部署？
是否存在独立扩缩容需求？
```

判断一个模块是否更适合 Library，可以问：

```text
是否主要通过 import 被其他项目复用？
是否不需要长期独立运行？
是否在提供稳定的契约、基础能力或工具？
```

**browser-monitor 实践（E）**

| 项目 | 工程角色 | 生命周期 |
| --- | --- | --- |
| `sdk` | SDK / 可发布包 | Build → Publish → Browser Runtime |
| `protocol` | Protocol Package | Build → 被 SDK/API/Worker 引用 |
| `apps/api` | Application | Build → Deploy → Node Process |
| `apps/worker` | Application | Build → Deploy → Background Process |
| `apps/audit-worker` | Application | Build → Deploy → Node + Chromium |
| `apps/web` | Application | Build → Static Files → Browser |
| `packages/database` | Library | 被后端应用引用 |
| `packages/shared` | Library | 被 Platform 多个应用复用 |

所以 `apps` 和 `packages` 的价值不是名称本身，而是把不同生命周期显式表达出来。

**总结（P）**

> Monorepo 的目录拆分本质是在定义工程边界：Application 表达独立运行或交付职责，Library 表达稳定复用职责。判断是否拆包，应看职责、依赖方向和生命周期，而不是看到重复代码就抽公共包。

---

## 3. Dependency Management 决定多项目之间如何安全共享代码

本章从“有哪些项目”进入“项目之间怎样建立关系”：**依赖图是 Monorepo 的结构核心，pnpm Workspace 与 `workspace:*` 是 browser-monitor 当前实现依赖关系的基础。**

### 【Dependency Graph 比目录树更能表达真实架构】

**结论（P）**

Dependency Graph（依赖图）描述一个 Project 依赖哪些其他 Project。目录树只回答代码在哪里，依赖图才能回答修改影响范围、构建顺序和循环依赖风险。

**理由（R）**

假设：

```text
API
 ↓
Database
 ↓
Protocol
```

如果 Protocol 改变，影响的不只是 Protocol 自己，还可能沿依赖反向传播到 Database 与 API。

因此依赖图会继续影响：

```text
代码编译
测试范围
构建顺序
发布范围
CI Affected 分析
```

**browser-monitor 实践（E）**

根据当前各个 `package.json`，主要内部关系可以概括为：

```text
sdk
└── protocol

database
└── protocol

shared
└── protocol

api
├── protocol
├── database
└── shared

worker
├── protocol
├── database
└── shared

audit-worker
├── database
└── shared
```

如果画成主要依赖方向：

```text
                    protocol
                 ↙      ↓      ↘
               sdk   database  shared
                        ↘       ↙
                      API / Worker
                          │
                    Audit Worker
```

这里表达的是代码依赖，不代表运行时网络调用。

**总结（P）**

> Monorepo 的核心结构不是目录树，而是 Project Dependency Graph。只有知道“谁依赖谁”，才能进一步判断修改影响范围、任务顺序和发布边界。

---

### 【workspace:* 明确声明内部依赖必须来自当前 Workspace】

**结论（P）**

`workspace:` Protocol（Workspace 协议）用于明确声明某个依赖应该解析为当前 Workspace 中的 Package，而不是静默使用 Registry 中的同名版本。

官方文档：[pnpm Workspace Protocol](https://pnpm.io/workspaces#workspace-protocol-workspace)。

**理由（R）**

普通版本：

```json
"@browser-monitor/protocol": "^3.0.0"
```

描述的是版本范围，本质上可以从 Registry 解析。

而：

```json
"@browser-monitor/protocol": "workspace:*"
```

额外表达了工程关系：

```text
这个依赖属于当前 Monorepo 内部包
```

这样开发阶段可以确保 SDK、API 等直接基于同一份本地 Protocol 开发，减少“本地代码已经改了，但另一个项目仍在使用 Registry 旧版本”的问题。

**browser-monitor 实践（E）**

SDK：

```json
{
  "dependencies": {
    "@browser-monitor/protocol": "workspace:*"
  }
}
```

API：

```json
{
  "dependencies": {
    "@browser-monitor/database": "workspace:*",
    "@browser-monitor/protocol": "workspace:*",
    "@browser-monitor/shared": "workspace:*"
  }
}
```

于是开发阶段形成：

```text
API import @browser-monitor/protocol
        ↓
pnpm 读取 workspace:*
        ↓
定位当前 Workspace 的 protocol Package
```

pnpm 在 Package Pack/Publish 时会根据 Workspace Protocol 规则转换为可发布的普通版本关系，因此开发期本地连接与发布后的 Registry 消费可以同时成立。

**总结（P）**

> `workspace:*` 不只是一个版本写法，而是在声明“这是 Monorepo 内部依赖”。它让开发阶段使用本地 Package，并防止错误解析到外部同名包。

常见追问：`workspace:*` 与 SemVer 的区别、内部 Package 发布到 npm 后如何处理、如果本地没有对应包会发生什么。

---

### 【pnpm install 面向整个 Workspace 建立依赖安装结果】

**结论（P）**

在 Monorepo 根目录执行 `pnpm install`，本质上是在根据 Workspace 中所有 `package.json` 建立统一依赖解析与链接结果，而不是只给根目录安装依赖。

**理由（R）**

逻辑上可以理解为：

```text
读取 pnpm-workspace.yaml
        ↓
发现所有 Workspace Project
        ↓
读取各 package.json
        ↓
解析外部依赖
+
解析 workspace:* 内部依赖
        ↓
读取 / 更新 pnpm-lock.yaml
        ↓
安装依赖并建立项目可见关系
```

这使多个 Package 可以共享统一 Lockfile，同时保留各自的依赖声明。

**browser-monitor 实践（E）**

当前根目录存在统一：

```text
pnpm-lock.yaml
```

并在 Dockerfile 中先复制根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 以及各子项目 `package.json`，再执行：

```bash
pnpm install --frozen-lockfile
```

这说明容器构建同样依赖完整 Workspace 关系，而不是把 API 当成一个完全独立的 npm 项目安装。

**总结（P）**

> Workspace 安装是“全局解析、局部声明”：根安装建立整个 Workspace 的一致依赖图，但每个 Package 仍然应该只使用自己显式声明的依赖。

后续可以继续深入 pnpm 的 Content-addressable Store（内容寻址存储）、Hard Link（硬链接）、Symbolic Link（符号链接）、Hoisting（依赖提升）与 Phantom Dependency（幽灵依赖）。

---

### 【共享包必须控制边界，shared 不能成为所有代码的垃圾桶】

**结论（P）**

Monorepo 降低了跨项目共享代码的成本，但也降低了错误耦合的成本，因此共享 Package 必须围绕稳定职责设计，而不能把所有重复代码都塞进 `shared`。

**理由（R）**

如果最终形成：

```text
App A ─┐
App B ─┼→ shared
App C ─┘
```

且 `shared` 同时包含 Auth、Database、UI、业务逻辑、API 工具等完全不同职责，那么一次 Shared 修改就可能影响整个仓库。

更健康的依赖结构通常倾向：

```text
Application
    ↓
明确职责的 Domain / Infrastructure Package
    ↓
更基础的 Protocol / Primitive
```

而不是 Application 之间互相跨目录引用。

**browser-monitor 实践（E）**

当前项目已经把：

```text
protocol
database
shared
```

拆成三个不同职责。其中 Protocol 负责跨端协议，Database 负责数据访问与 Migration，Shared 才承担平台公共能力。这比单一万能 `utils` 或 `shared` 更容易保持依赖边界。

**总结（P）**

> Monorepo 的共享能力不是越多越好。真正需要治理的是依赖方向：共享包应有稳定职责，Application 尽量依赖 Library，而不是互相引用内部实现。

---

## 4. Task Management 把项目依赖转换成可执行的构建与测试顺序

本章解决“代码已经分包后，Build、Test、Typecheck 到底怎么执行”：**Project Graph 描述代码关系，Task Graph 描述任务执行关系。**

### 【--filter 负责从 Workspace 中选择要操作的项目】

**结论（P）**

pnpm `--filter` 负责从整个 Workspace 中选择一个或一组 Project，再执行目标 Package 自己定义的 Script。

官方文档：[pnpm Filtering](https://pnpm.io/filtering)。

**理由（R）**

Monorepo 中可能同时存在十几个项目。如果开发 Web 页面时每次都启动 SDK、API、Worker、Audit Worker，就失去了多项目边界的意义。

所以命令需要拆成：

```text
选择谁
+
执行什么
```

例如：

```bash
pnpm --filter @browser-monitor/api dev
```

可以理解为：

```text
整个 Workspace
      ↓
选择 @browser-monitor/api
      ↓
找到 API package.json
      ↓
执行 dev
      ↓
tsx watch src/main.ts
```

**browser-monitor 实践（E）**

当前 Platform 提供：

```text
dev:api
dev:worker
dev:audit-worker
dev:web
```

底层均通过 `pnpm --filter` 选择对应应用。

SDK 自身也可以：

```bash
pnpm --filter cx-browser-monitor-sdk dev
```

因此 Monorepo 统一管理不等于所有应用一起开发。

**总结（P）**

> Workspace 决定“有哪些项目”，Filter 决定“这次命令操作哪些项目”。这是多应用仓库日常开发、局部测试和局部构建的基础。

---

### 【Project Graph 与 Task Graph 解决的是两种不同关系】

**结论（P）**

Project Graph（项目图）回答“谁依赖谁”，Task Graph（任务图）回答“这次 Build/Test 应该按什么顺序执行、哪些任务可以并行”。

**理由（R）**

假设：

```text
API
 ↓
Database
 ↓
Protocol
```

这是 Project Graph。

当执行：

```text
API Build
```

如果 API 构建需要 Database 构建产物，就可能形成：

```text
protocol:build
      ↓
database:build
      ↓
api:build
```

这才是 Task Graph。

如果两个 Project 没有任务依赖，它们理论上可以并行；如果存在产物依赖，就必须等待上游完成。

Nx 官方将 Project Graph 与 Task Graph 分开建模，并据此分析任务关系：[Nx Project Graph](https://nx.dev/features/explore-graph)。

**browser-monitor 实践（E）**

当前根 `package.json` 的 Build：

```text
protocol
  ↓
sdk
  ↓
platform
```

Platform 内部又显式按顺序执行：

```text
shared
↓
database
↓
api
↓
worker
↓
audit-worker
↓
web
```

这里的任务顺序目前主要由 `package.json scripts` 通过 `&&` 人工表达。

因此当前方案应明确标记为：

> **项目现状：pnpm Workspace + package scripts 手工任务编排。**

它的优势是简单、透明、无需额外工具；代价是 Package 数量继续增加后，顺序、并发和重复任务需要人工维护。

**总结（P）**

> Monorepo 的依赖关系最终会转换成任务关系。小规模仓库可以手工维护 Task 顺序，但规模扩大后通常需要专门的 Task Graph、缓存和影响分析能力。

---

### 【Nx 与 Turborepo 主要解决规模化任务编排，而不是替代 pnpm】

**结论（P）**

pnpm 与 Nx/Turborepo 处于不同层级。pnpm 主要负责 Package 和 Dependency，Nx/Turborepo 更关注 Task Graph、Cache（缓存）、Affected（受影响项目）与并行执行。

可以理解为：

```text
pnpm
↓
有哪些 Package、依赖怎么安装

Nx / Turborepo
↓
哪些 Task 要运行、什么顺序、能否缓存

Docker Compose
↓
哪些 Runtime Service 要启动
```

**理由（R）**

当仓库只有几个 Package 时：

```text
A && B && C
```

完全可以维护。

当仓库发展为几十个 Package 后，会出现：

```text
哪些 Task 可以并行？
某个公共包改了会影响谁？
某个 Task 上次已经构建过，是否可以复用？
只改 Web 时为什么要重新测试所有 Worker？
```

这些已经超出普通 Package Manager 的核心职责。

**browser-monitor 实践（E）**

当前仓库 Package 数量有限，手工 Scripts 仍然容易理解，因此没有必要仅为了“技术先进”强行引入 Nx/Turborepo。

合理演进条件可以是：

```text
Package 数明显增加
+
依赖关系复杂
+
CI 时间明显增长
+
大量重复 Build/Test
+
需要自动 Affected 计算
        ↓
评估 Nx / Turborepo
```

**总结（P）**

> 当前 browser-monitor 使用 pnpm Scripts 是规模匹配的方案；Nx/Turborepo 更适合仓库扩大后解决任务图、增量执行和缓存问题。工具应该跟随复杂度，而不是 Monorepo 一开始就全部引入。

常见追问：为什么不用 Turborepo、pnpm recursive 已经能执行多个任务为什么还需要 Nx、什么时候 Task Cache 才有价值。

---

## 5. Runtime Management 解释 Monorepo 如何真正启动成一个多服务系统

本章从源码进入运行时：**pnpm 管理开发任务，Docker Compose 管理完整系统，两者分别处于代码工程层和运行编排层。**

### 【单应用开发启动与完整系统启动不是同一件事】

**结论（P）**

`pnpm --filter ... dev` 解决的是单个 Project 的 Development Task（开发任务），`docker compose up` 解决的是多个 Service 的 Runtime Orchestration（运行时编排）。

**理由（R）**

开发 API 时，只需要：

```text
API Source
   ↓
tsx watch
   ↓
Node Process
```

但 API 自身可能依赖：

```text
TimescaleDB
Redis
```

完整平台还需要：

```text
Worker
Audit Worker
Web
Caddy
Migration
```

所以“启动代码”与“启动完整依赖环境”本来就是两个问题。

**browser-monitor 实践（E）**

单应用：

```bash
pnpm --filter @browser-monitor/api dev
pnpm --filter @browser-monitor/worker dev
pnpm --filter @browser-monitor/web dev
```

完整系统则由：

```text
platform/infra/docker-compose.yml
```

统一描述。

Compose 当前包含：

```text
TimescaleDB
Redis
Mailpit
Migration
API
Worker
Audit Worker
Web / Caddy
```

**总结（P）**

> Monorepo 解决源码与任务管理，Docker Compose 解决完整运行环境编排。把两层混在一起，就会误以为 Workspace 中每个 Package 都必须启动成一个服务。

---

### 【服务启动顺序依赖 Ready 状态而不只是 Container 已创建】

**结论（P）**

多服务系统中的关键不是“先执行谁的 docker start”，而是下游应该等待上游真正 Ready。Docker Compose 可以通过 `healthcheck` 与 `depends_on.condition` 建立这种关系。

官方资料：[Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)。

**理由（R）**

数据库容器进入 Running 状态，并不意味着 PostgreSQL 已经能够接受连接。

因此：

```text
Container Started
≠
Service Ready
```

如果 API 仅等待数据库容器“启动”，就可能：

```text
API 启动
↓
立即连接 DB
↓
DB 初始化尚未完成
↓
连接失败
```

所以完整顺序应该围绕健康状态建立。

**browser-monitor 实践（E）**

当前关系可以概括为：

```text
              TimescaleDB
                   │
                 healthy
                   ↓
                migrate
                   │
        completed successfully
                   │
        ┌──────────┼───────────┐
        ↓          ↓           ↓
       API       Worker    Audit Worker
        ↑
        │
   Redis healthy

       API healthy
           ↓
       Web / Caddy
```

其中：

- TimescaleDB 通过 `pg_isready` Healthcheck 判断是否可用。
- Migration 等待数据库 Healthy 后执行。
- API 等待 Migration 成功并等待 Redis Healthy。
- Web 等待 API Healthy 后再启动对外入口。

**总结（P）**

> 多应用启动顺序应该由运行依赖决定，而不是由源码目录顺序决定。Compose 的 `healthcheck`、`service_healthy` 与 `service_completed_successfully` 正是在解决“服务什么时候真正可以被下游依赖”的问题。

---

### 【Package、Process、Image、Container 与 Service 是不同层级】

**结论（P）**

Package 是源码与依赖边界，Process 是操作系统运行边界，Image 是运行环境模板，Container 是 Image 的运行实例，Service 则是面向系统职责的运行单元。它们经常对应，但绝不是同义词。

**理由（R）**

例如：

```text
@browser-monitor/api
```

首先只是 Workspace Package。

构建后得到：

```text
dist/main.js
```

执行：

```bash
node dist/main.js
```

才成为 Node Process。

再把代码和 Node Runtime 打进 Docker Image，运行 Image 后才得到 Container。

**browser-monitor 实践（E）**

`Dockerfile.backend` 会构建 Protocol、Shared、Database、API 和 Worker 相关产物，默认 CMD 启动 API。

但 Compose 中 Worker 可以复用同一个 Backend Image，并覆盖：

```text
command
↓
@browser-monitor/worker start
```

因此实际关系是：

```text
                Backend Image
                  /       \
                 ↓         ↓
        API Container   Worker Container
              ↓              ↓
        API Process     Worker Process
```

这说明：

```text
一个 Image
可以服务多个运行角色
```

而 Audit Worker 因为需要 Chromium 与 Lighthouse，拥有独立 `Dockerfile.audit-worker`。

**总结（P）**

> Monorepo 中的目录和 Package 是源码组织边界，最终部署边界还要由运行环境、系统依赖、资源消耗、安全要求和扩缩容策略共同决定。

---

### 【Web Application 在开发态和生产态拥有不同运行形态】

**结论（P）**

React/Vite Web 在开发环境通常依赖 Dev Server，但生产构建后只是 HTML、JavaScript、CSS 等静态资源，不需要长期运行 React Node Process。

**理由（R）**

完整链路：

```text
React Source

开发：
↓
Vite Dev Server

生产：
↓
Vite Build
↓
dist/
↓
Static Server / CDN
↓
Browser
```

这与 API：

```text
TypeScript
↓
Build
↓
Node Process
```

完全不同。

**browser-monitor 实践（E）**

当前 `Dockerfile.web` 使用 Multi-stage Build：

```text
Node Build Stage
↓
pnpm --filter @browser-monitor/web build
↓
dist

Caddy Runtime Stage
↓
COPY dist
↓
Static File Server
```

Caddy 同时处理：

```text
/api/*    → api:3000
/health/* → api:3000
其他路径  → React dist
```

于是外部形成统一入口：

```text
Browser
   ↓
 Caddy
 /   \
↓     ↓
Web   API
```

**总结（P）**

> 同一个 Monorepo 中的 App 可以拥有完全不同的运行形态。理解运行边界时不能简单地认为“apps 下每一个目录最后都是一个 Node 服务”。

---

## 6. Build、Release 与 Deploy 构成多项目交付链路

本章沿着源码产生最终产物的过程展开：**Build 负责生成 Artifact，Release 负责版本与分发，Deploy 负责让 Application 真正运行。**

### 【Build 只负责把源码转换为目标产物】

**结论（P）**

Build（构建）解决的是从源代码生成可运行或可发布 Artifact（产物），它本身不等于发布，也不等于部署。

**理由（R）**

不同项目的 Build 结果不同：

```text
SDK Source
 ↓ tsup
dist/index.js

API TypeScript
 ↓ tsc
dist/main.js

React Source
 ↓ Vite
dist/*.html/js/css
```

所以 Monorepo 的统一 Build 并不是“所有项目用同一个构建器”，而是统一触发各 Project 自己适合的 Build。

**browser-monitor 实践（E）**

当前：

- SDK 和 Protocol 使用 `tsup`。
- API、Worker、Audit Worker、Database、Shared 主要通过 TypeScript Build。
- Web 使用 `tsc -b && vite build`。

根 Script 再把这些子任务串起来。

**总结（P）**

> Monorepo 统一的是任务入口和依赖关系，不要求所有项目使用相同构建工具。Build 的最终目标是得到各自需要的 Artifact。

---

### 【Release 管理版本和分发，Deploy 管理应用运行】

**结论（P）**

Release（发布）关注“哪个版本的 Package/Image 对外可用”，Deploy（部署）关注“哪个 Application 版本运行在哪个环境”。

**理由（R）**

SDK 的交付可能是：

```text
SDK Source
↓
Build
↓
npm Package
↓
业务项目安装
```

API 的交付可能是：

```text
API Source
↓
Build
↓
Docker Image
↓
Server / Cluster
```

二者虽然在同一 Monorepo，却有完全不同的交付方式。

**browser-monitor 实践（E）**

当前版本可以看到：

```text
cx-browser-monitor-sdk   0.3.0
@browser-monitor/protocol 3.0.0
@browser-monitor/platform 0.1.0
```

同时 API、Worker、Web 等 Package 标记为 `private: true`，说明它们主要作为内部 Platform 工程，而不是都作为 npm Package 发布。

这反映出当前更接近 Independent Versioning（独立版本）而不是整个 Monorepo 使用统一版本号。

**主流方案**

多 Package 发布通常需要进一步管理：

```text
SemVer
Change Record
Version Bump
Changelog
Publish
```

pnpm 官方 Workspace 文档也指出，pnpm 本身不是完整的 Workspace Versioning 工具，常见方案包括 Changesets、Rush 等。

当前仓库中尚未从已确认文件证明存在完整的 Changesets 自动发布链路，因此这部分属于**主流演进方案，不应描述成项目现状**。

**总结（P）**

> Build、Release、Deploy 是连续但不同的阶段。Monorepo 允许不同 Package 独立版本、不同 Application 独立部署，并不要求整个仓库一次性整体发布。

---

## 7. CI/CD 从全仓校验逐步演进到 Affected 与 Cache

本章把前面的 Project Graph 与 Task Graph 落到持续集成：**小仓库优先保证可靠，大仓库再通过影响分析和缓存降低重复工作。**

### 【小规模 Monorepo 可以先使用全仓质量门禁】

**结论（P）**

当 Package 数量有限时，最简单可靠的 CI 是在每次重要变更后统一执行 Typecheck、Test 和 Build。

**理由（R）**

全仓校验虽然会做一些重复工作，但具有：

```text
实现简单
规则清晰
结果完整
故障容易定位
```

等优点。

过早引入复杂 Affected Pipeline，也会增加维护成本。

**browser-monitor 实践（E）**

根目录已有：

```text
typecheck
test
build
check
```

因此基础 CI 可以围绕：

```text
Pull Request
    ↓
pnpm install --frozen-lockfile
    ↓
pnpm typecheck
    ↓
pnpm test
    ↓
pnpm build
```

展开。

是否已经存在完整 GitHub Actions Pipeline，需要继续查对应 Workflow 才能确认；这里不把理想流程写成当前事实。

**总结（P）**

> CI 的第一目标是可靠地阻止错误进入主干。只有当全仓执行已经成为明显成本时，才需要进一步优化增量执行。

---

### 【Affected 解决“哪些任务根本不需要执行”】

**结论（P）**

Affected Analysis（受影响分析）根据代码变化与 Project Graph 计算哪些 Project 真正受到影响，再只对这些项目执行 Test、Build 等任务。

Nx 官方文档：[Nx Affected](https://nx.dev/ci/features/affected)。

**理由（R）**

如果只修改：

```text
apps/web
```

理论上通常不需要重新构建：

```text
SDK
Worker
Audit Worker
```

但如果修改：

```text
protocol
```

影响可能沿依赖图扩散：

```text
protocol
 ↓
sdk

protocol
 ↓
database/shared
 ↓
api/worker
```

因此 Affected 逻辑通常是：

```text
Git Diff
   ↓
变化文件
   ↓
所属 Project
   ↓
Project Graph
   ↓
反向查找 Dependents
   ↓
Affected Set
   ↓
只执行相关 Task
```

**browser-monitor 实践（E）**

当前尚未确认仓库已经实现自动 Affected CI，因此这里属于**规模化演进方案**。

对于当前项目，pnpm Filter 已经提供“手工选择项目”的能力；当项目数量和 CI 成本继续增长时，再引入自动 Project Graph/Affected 分析更有价值。

**总结（P）**

> Filter 是人为选择项目，Affected 是根据变化和依赖关系自动计算项目。二者解决的层级不同。

---

### 【Task Cache 解决“需要执行的任务是否已经有相同结果”】

**结论（P）**

Cache（任务缓存）不是判断任务有没有受到影响，而是在任务需要执行时判断相同输入是否已经产生过可复用的输出。

**理由（R）**

可以抽象为：

```text
Task
+
Source Input
+
Dependency Input
+
Config / Environment
        ↓
计算 Hash
        ↓
历史是否存在相同结果
       / \
     是   否
     ↓     ↓
复用结果  真正执行
```

因此：

```text
Affected
↓
减少需要考虑的任务数量

Cache
↓
减少真正重新执行的任务数量
```

例如：

```text
50 个 Project
↓ Affected
8 个相关

8 个 Task
↓ Cache
3 个命中

最终真正执行 5 个
```

**browser-monitor 实践（E）**

当前没有确认 Nx/Turborepo Remote Cache，因此不能把缓存描述为现有实现。它属于仓库规模扩大后的主流优化方向。

**总结（P）**

> Affected 和 Cache 不是同一优化：前者回答“该不该执行”，后者回答“是否必须重新执行”。

---

## 8. Monorepo 的价值和成本都来自“统一治理”

本章从工具回到架构取舍：**Monorepo 并不是默认优于 Multi-repo，而是当项目之间存在高协作密度时收益更高。**

### 【跨项目原子修改是 Monorepo 的核心协作收益】

**结论（P）**

当多个项目需要同时修改时，Monorepo 可以把跨包修改放在一个 Commit/PR 中完成，从而保持协议、实现和测试的一致性。

**理由（R）**

Multi-repo 下，一个 Protocol 修改可能需要：

```text
Protocol Repo
↓ 发布新版本

SDK Repo
↓ 升级 Protocol
↓ 发布 SDK

API Repo
↓ 升级 Protocol
↓ 联调
```

中间任何一个仓库没有及时升级，都可能产生版本错位。

Monorepo 则可以：

```text
修改 Protocol
+
修改 SDK
+
修改 API
+
修改 Worker
+
统一测试
=
一个 Pull Request
```

这就是 Atomic Change（原子变更）的工程价值。

**browser-monitor 实践（E）**

Browser Monitor 中：

```text
SDK
Protocol
API
Worker
```

围绕 Telemetry Protocol 存在天然协作关系，所以它属于非常典型的 Monorepo 使用场景。

**总结（P）**

> Monorepo 最适合多个项目需要频繁共同演进的系统。它把跨仓版本协调问题转换成同一仓库中的依赖和任务治理问题。

---

### 【Monorepo 的主要风险是依赖边界失控与 CI 膨胀】

**结论（P）**

Monorepo 让共享代码更容易，同时也让错误引用更容易；让统一 CI 更方便，同时也可能让每次改动触发越来越大的任务范围。

**理由（R）**

没有约束时很容易出现：

```text
Web import API internal
Worker import Web utils
API import Worker implementation
```

目录虽然拆开，依赖却变成：

```text
App ↔ App ↔ App
```

最终形成循环依赖和强耦合。

与此同时：

```text
Project 数量增加
↓
Task 数量增加
↓
全仓 Build/Test 时间增长
```

因此大型 Monorepo 必须逐步补充：

```text
依赖边界
Affected
Parallel Execution
Local Cache
Remote Cache
CI 分布式执行
```

**browser-monitor 实践（E）**

当前项目仍处于依赖关系清晰、Package 数量可控的阶段，因此优先维持简单显式结构比过早增加复杂工具更重要。

**总结（P）**

> Monorepo 的优势和风险来自同一个原因：所有项目距离更近。距离近可以提高协作效率，也必须通过依赖边界和增量任务治理防止耦合与 CI 成本失控。

---

### 【Monorepo 与 Multi-repo 的选择取决于项目关联度】

**结论（P）**

不能根据“项目数量多不多”决定 Monorepo，而应该根据多个项目之间的协作密度、共享程度、发布关系和权限隔离要求进行判断。

**理由（R）**

适合 Monorepo 的特征：

```text
跨项目共享代码多
+
协议需要同步演进
+
跨项目修改频繁
+
需要统一工具链
+
希望原子提交
```

更倾向 Multi-repo 的特征：

```text
项目高度独立
+
团队完全不同
+
发布周期完全不同
+
权限需要强隔离
+
几乎没有共享代码
```

**browser-monitor 实践（E）**

Browser Monitor 的数据链：

```text
Browser SDK
    ↓
Protocol
    ↓
API
    ↓
Worker
    ↓
Database
    ↓
Web
```

多个工程围绕同一监控协议和平台共同演进，因此 Monorepo 具有直接价值。

**总结（P）**

> Monorepo 不是“项目大就用”，而是“项目之间的关系密集时更有价值”。判断重点应放在协作和依赖关系，而不是目录数量。

---

## 9. Browser Monitor 需要同时用三张图理解 Monorepo

本章将前面的知识重新映射回当前项目：**目录结构图说明代码在哪里，依赖图说明代码如何关联，运行图说明系统真正如何工作。**

### 【代码组织图描述源码的物理边界】

```text
browser-monitor/
│
├── sdk/
├── protocol/
│
└── platform/
    ├── apps/
    │   ├── api/
    │   ├── worker/
    │   ├── audit-worker/
    │   └── web/
    │
    └── packages/
        ├── database/
        └── shared/
```

这张图只回答：

> 代码在哪里，以及项目是如何按职责分组的。

不能仅根据它判断运行关系。

---

### 【代码依赖图描述 Project 之间的 Import 关系】

```text
                      protocol
                   ↙     ↓      ↘
                 sdk  database  shared
                        ↘       ↙
                       API / Worker
                            │
                      Audit Worker
```

Web 与 API 的主要业务关系是：

```text
Web
 ↓ HTTP
API
```

而不是 Web 直接 import API 内部实现。

这张图回答：

> 修改某个内部 Package，哪些其他 Project 可能受到影响？

---

### 【运行时架构图描述最终系统服务】

```text
                     Browser
                        │
                        ↓
                      Caddy
                     /     \
                    ↓       ↓
               Web Files    API
                             │
                  ┌──────────┼──────────┐
                  ↓          ↓          ↓
             TimescaleDB   Redis     Outbox
                                      ↓
                                   Worker

                     Audit Task
                         ↓
                    Audit Worker
                         ↓
                      Chromium
```

这张图回答：

> 最终有哪些 Process/Container/Service 在运行，它们怎样通过网络和数据库协作？

---

### 【三张图不能合并是因为它们描述不同问题】

例如：

```text
protocol
```

在代码依赖图中非常重要，但运行时并不存在：

```text
Protocol Service
```

反过来：

```text
TimescaleDB
Redis
```

在运行时非常重要，却不是 pnpm Workspace Package。

因此必须建立：

```text
Directory Structure
≠
Project Dependency Graph
≠
Runtime Architecture
```

**总结（P）**

> 阅读任何多应用 Monorepo，都建议至少画出“目录图、代码依赖图、运行图”三张图。只看目录树，很容易把 Package、应用和运行服务混成同一个概念。

---

## 10. Monorepo 的完整知识体系可以归纳为五层工程模型

本章把所有零散工具重新放回同一框架，避免把 pnpm、Nx、Docker、Vite 等技术平铺记忆。

### 【第一层：Repository 与 Workspace 管理代码集合】

负责：

```text
Git
GitHub
pnpm-workspace.yaml
package.json
pnpm-lock.yaml
```

核心问题：

> 哪些代码共同版本控制，哪些目录属于统一工作区？

---

### 【第二层：Dependency Management 管理项目之间的代码关系】

负责：

```text
dependencies
workspace:*
lockfile
Package Boundary
Project Graph
```

核心问题：

> 哪个 Project 可以依赖谁，内部包怎样共享，修改会影响哪些项目？

---

### 【第三层：Task 与 Build 管理工程执行关系】

当前 browser-monitor：

```text
package.json scripts
pnpm --filter
tsc
tsup
Vite
Vitest
```

规模扩大后的主流能力：

```text
Nx / Turborepo
Task Graph
Parallel Execution
Affected
Cache
Remote Cache
```

核心问题：

> 应该运行哪些任务、按照什么顺序、哪些可以跳过或复用？

---

### 【第四层：Release 管理产物和版本】

包括：

```text
SemVer
Independent / Fixed Versioning
npm Package
Changesets
Docker Image
Changelog
```

核心问题：

> 哪些 Package 需要升级版本，哪些产物需要对外分发？

---

### 【第五层：Runtime 与 Deployment 管理真正运行的系统】

browser-monitor 当前：

```text
Node.js
Caddy
Docker
Docker Compose
TimescaleDB
Redis
Chromium
```

规模更大时可能进一步进入 Kubernetes 等编排体系。

核心问题：

> 哪些 Service 真正运行，如何联网、依赖、扩缩容和故障隔离？

---

因此完整主线是：

```text
Repository
    ↓
Workspace
    ↓
Project / Package
    ↓
Dependency Graph
    ↓
Task Graph
    ↓
Build Artifact
    ↓
Release
    ↓
Deployment
    ↓
Runtime System
```

---

## 11. Browser Monitor 当前方案与规模化方案必须明确区分

| 能力 | 项目现状 | 主流规模化方案 |
| --- | --- | --- |
| Workspace | pnpm Workspace | pnpm / npm / Yarn Workspaces |
| 内部依赖 | `workspace:*` | Workspace Protocol |
| 单项目执行 | `pnpm --filter` | Filter / Project Selector |
| Task 编排 | package scripts 显式串联 | Nx / Turborepo Task Graph |
| Task Cache | 当前未确认 | Local / Remote Cache |
| Affected CI | 当前未确认 | Nx Affected / 自研依赖分析 |
| Package Version | 多 Package 独立版本 | Changesets / Rush 等 |
| SDK 发布 | 已具备可发布 Package 结构 | CI 自动 Publish |
| Runtime | Docker Compose | Compose / Kubernetes |
| Web Server | Caddy | Caddy / Nginx / CDN |
| 服务依赖 | depends_on + healthcheck | Compose / Kubernetes Probe |

这里最重要的工程判断是：

> **主流方案不等于当前实现，理想方案也不等于当前必须引入。**

工具选型应该遵循：

```text
当前问题
+
当前规模
+
可维护成本
+
未来增长趋势
```

---

## 12. 面试与答辩应沿统一主线解释 Monorepo

如果面试官问：

> 介绍一下项目中的 Monorepo。

可以按照下面的完整逻辑回答：

> Browser Monitor 是一个多应用全栈 Monorepo。这里的 Monorepo 不是简单把代码放进同一个 Git 仓库，而是统一管理 SDK、共享协议、服务端应用、Worker、Web 和内部公共包。
>
> 代码组织上，我们通过 pnpm Workspace 识别这些子项目。其中 SDK 和 Protocol 属于可复用 Package，API、Worker、Audit Worker 和 Web 属于独立 Application，Database 和 Shared 属于内部 Library。
>
> 依赖管理上，内部包通过 `workspace:*` 建立本地依赖。例如 SDK、API、Worker 都可以围绕同一 Protocol 演进，这样协议修改可以在一个 Pull Request 中同步修改和验证，而不是跨多个仓库先发布再升级。
>
> 任务执行上，当前项目规模不大，所以主要通过根级 package scripts 和 pnpm Filter 显式控制 Build、Typecheck 和 Test。这里实际上已经存在 Project Graph 与 Task Graph，只是目前任务图主要通过 Scripts 手工表达。如果后续 Package 数量明显增加，可以再通过 Nx 或 Turborepo 引入 Affected、并行执行和任务缓存。
>
> 运行阶段又是另一层。Monorepo 管理代码，不代表所有 Package 会运行成服务。API、Worker 和 Audit Worker 最终是独立进程，Web 构建成静态资源后由 Caddy 提供服务，Protocol、Database 和 Shared 则只是被引用的 Library。完整环境再由 Docker Compose 管理 TimescaleDB、Redis、Migration、API、Worker、Audit Worker 与 Web 的启动依赖。
>
> 所以这个 Monorepo 的核心价值，是让强关联项目拥有统一的代码和依赖治理，同时保持不同应用独立的构建、发布和运行边界。

常见连续追问：

1. Monorepo 和 Monolith 有什么区别？
2. Workspace 和 Monorepo 有什么区别？
3. `workspace:*` 和普通版本依赖有什么区别？
4. 为什么 Web 和 API 在一个仓库里仍然通过 HTTP 通信？
5. 为什么不能直接让 App 相互 import？
6. Project Graph 与 Task Graph 有什么区别？
7. pnpm 和 Nx/Turborepo 分别解决什么问题？
8. 为什么当前不用 Turborepo？
9. Affected 是如何计算的？
10. Task Cache 如何判断结果可以复用？
11. Monorepo 是否意味着所有 Package 同版本？
12. Monorepo 是否意味着所有 Application 一起部署？
13. Package、Process、Container、Service 有什么区别？
14. 什么情况下应该从 Monorepo 改回 Multi-repo？
15. `shared` 为什么容易成为架构问题？

---

## 13. 后续深入应沿三条主线而不是继续平铺工具名词

完成当前框架后，下一阶段建议从三个方向继续深入。

### 【依赖管理主线】

```text
pnpm install
↓
Content-addressable Store
↓
Hard Link
↓
Symbolic Link
↓
node_modules Layout
↓
Hoisting
↓
Phantom Dependency
↓
Lockfile
↓
Workspace Protocol
```

目标是回答：

> 为什么多个 Package 能共享依赖，又能保持相对严格的依赖隔离？

---

### 【任务管理主线】

```text
Project Graph
↓
Task Graph
↓
Topological Order
↓
Parallel Execution
↓
Affected
↓
Incremental Build
↓
Local Cache
↓
Remote Cache
```

目标是回答：

> 修改一个公共 Package 后，系统怎样知道哪些任务真正需要重新执行？

---

### 【发布治理主线】

```text
SemVer
↓
Fixed / Independent Version
↓
Change Record
↓
Changesets
↓
Package Publish
↓
Docker Image
↓
CI/CD
↓
Deployment
```

目标是回答：

> Monorepo 中不同 Package、不同 Application 如何独立版本、发布和部署？

三条主线最终重新汇合成：

```text
源码变化
   ↓
依赖影响分析
   ↓
确定需要执行的任务
   ↓
Build / Test
   ↓
确定需要发布的 Package
   ↓
确定需要部署的 Application
   ↓
运行系统更新
```

这才构成完整的 Monorepo 工程闭环。

---

## 14. 参考资料

1. pnpm, **Workspace**：https://pnpm.io/workspaces
2. pnpm, **Filtering**：https://pnpm.io/filtering
3. Nx, **Explore the Project Graph**：https://nx.dev/features/explore-graph
4. Nx, **Run Only Tasks Affected by a PR**：https://nx.dev/ci/features/affected
5. Docker Docs, **Control startup and shutdown order in Compose**：https://docs.docker.com/compose/how-tos/startup-order/
6. Browser Monitor 仓库：`browser-monitor/package.json`
7. Browser Monitor Workspace：`browser-monitor/pnpm-workspace.yaml`
8. Browser Monitor Platform：`browser-monitor/platform/package.json`
9. Browser Monitor Runtime：`browser-monitor/platform/infra/docker-compose.yml`
10. Browser Monitor Backend Image：`browser-monitor/platform/infra/Dockerfile.backend`
11. Browser Monitor Audit Worker Image：`browser-monitor/platform/infra/Dockerfile.audit-worker`
12. Browser Monitor Web Image：`browser-monitor/platform/infra/Dockerfile.web`
13. Browser Monitor Gateway：`browser-monitor/platform/infra/Caddyfile`
