# Monorepo 多应用仓库知识体系

Monorepo（Monolithic Repository，单体代码仓库）首先是一种代码仓库组织方式：多个有关联的工程项目共同存放在一个 Git Repository（代码仓库）中。真正进入工程实践后，它还会继续引出 Workspace（工作区）、Package（包）、内部依赖、任务编排、构建产物、发布与运行部署等问题。

理解 Monorepo 时最容易出现两个误区：

1. 把“一个仓库里有很多目录”当成 Monorepo 的全部。
2. 把“代码共享、统一规范、构建工具、Docker”全部算成 Monorepo 自己提供的能力。

这两种理解都不准确。Monorepo 决定的是多个工程如何共同进入一个仓库；pnpm Workspace 决定包管理器如何识别和管理这些工程；各项目的 package.json 决定项目身份、依赖和任务；Nx、Turborepo 等工具可以进一步根据项目依赖关系组织任务；Docker Compose 管理的则是程序构建完成后的运行时服务。

本文以 browser-monitor 为实践案例，但每一部分都先解释通用机制，再映射到仓库事实。项目没有实现的能力会明确标记为“主流方案”或“演进方案”，不把理想设计写成当前实现。

> 版本边界：browser-monitor 根 package.json 明确锁定 pnpm 10.28.2。本文描述当前项目行为时以该版本和仓库配置为准；pnpm 后续版本新增的 Workspace Task Scheduler 等能力不倒推为当前项目已经使用的能力。pnpm 10.28 的发布时间和后续版本能力可参考官方 Release Notes。[[1]](https://pnpm.io/blog?type=releases)

---

## 1. Monorepo 的核心是让多个工程在同一个仓库中共同演进

本章先确定 Monorepo 本身解决的问题，再把“共享代码”“统一规范”等容易混淆的概念放回正确位置。

### 【Monorepo 统一的是仓库边界，而不是创造代码共享能力】

**结论**

Monorepo 的直接作用是把多个相关工程放入同一个 Repository，使它们共享 Git 历史、Branch、Commit 和 Pull Request。它并不会凭空产生代码复用能力，也不会自动建立项目依赖。

例如 SDK 与 API 需要使用同一份事件协议，这件事本身可以在 Monorepo 中实现，也可以在 Multi-repo（多仓库）中实现。

**机制与取舍**

假设存在一个协议包 protocol。

Multi-repo 完全可以采用：

~~~text
protocol-repo
    ↓ publish
@company/protocol@3.0.0
    ↓
    ├── sdk-repo 通过 npm install 使用
    └── api-repo 通过 npm install 使用
~~~

SDK 与 API 仍然可以引用同一份 Schema、TypeScript Type 或运行时校验逻辑。因此：

> “共享 Protocol”属于模块化和 Package 设计能力，不是 Monorepo 独有能力。

Monorepo 改变的是这几个项目的协作方式：

~~~text
Multi-repo

修改 Protocol
    ↓
发布 Protocol 新版本
    ↓
SDK 仓库升级依赖
    ↓
API 仓库升级依赖
    ↓
各仓库分别提交、测试和发布
~~~

变成：

~~~text
Monorepo

修改 Protocol
   ├── 同时修改 SDK
   ├── 同时修改 API
   └── 同时修改 Worker
            ↓
      一个 Commit / PR
            ↓
        统一验证
~~~

因此 Monorepo 对共享 Package 的主要价值不是“可以共享”，而是：

~~~text
共享 Package
+
Package 的消费者
+
依赖关系
+
跨项目修改
+
统一验证
~~~

可以处于同一个仓库上下文中。

这种能力通常称为 Atomic Change（原子变更）：一个需要同时修改多个项目的逻辑变化，可以在一个提交或一个 Pull Request 中完整表达，而不是先后跨仓发布。

**browser-monitor 实践映射**

browser-monitor 中存在：

~~~text
sdk/
protocol/
platform/apps/api/
platform/apps/worker/
~~~

protocol 的职责是提供浏览器 SDK 与平台共同使用的协议契约。它本身解决“协议只有一个事实来源”的问题；Monorepo 则让 protocol 与 SDK、API、Worker 可以在同一个仓库中共同修改和验证。

两层关系要分开：

~~~text
Protocol Package
解决：
协议代码是否只有一个事实来源

Monorepo
解决：
Protocol 与它的多个消费者是否能在同仓协作演进
~~~

**面试与答辩收束**

如果被问“为什么使用 Monorepo”，不能回答成“因为需要共享代码”。

更准确的回答是：

> 共享代码可以通过独立 npm Package 在 Multi-repo 中实现。Monorepo 的额外价值是把共享 Package 和消费者放到同一个仓库，使跨项目变更可以原子提交，并让包管理器、任务工具和 CI 在同一 Workspace 中计算依赖和影响范围。

常见追问包括：Multi-repo 如何共享代码、Monorepo 与公共 npm 包有什么关系、Monorepo 是否一定比 Multi-repo 更好。

---

### 【统一代码规范也不是 Monorepo 独有能力】

**结论**

ESLint、TypeScript、Prettier、Commitlint 等全局规范同样可以在传统单项目或 Multi-repo 中建立。Monorepo 的价值是让这些规范更容易在一个仓库根部统一管理，而不是只有 Monorepo 才能做统一规范。

**机制与取舍**

Multi-repo 可以发布共享配置：

~~~text
@company/eslint-config
@company/tsconfig
@company/prettier-config
~~~

不同仓库分别安装即可。

Monorepo 则可以进一步把：

~~~text
Root Config
   ↓
多个 Workspace Project
~~~

放进一个代码审查和升级范围中。

所以正确关系是：

~~~text
统一规范能力
不是 Monorepo 独有

Monorepo
降低统一配置和同步升级的协调成本
~~~

**browser-monitor 实践映射**

当前 browser-monitor 根 package.json 主要承担顶层 Build、Typecheck、Test、Check 编排，而 SDK、Protocol、API、Web 等仍然拥有自己的 package.json 和构建脚本。说明当前仓库是“统一入口 + 子项目独立任务”，并不是把所有工程行为全部塞到根配置中。

**面试与答辩收束**

> Monorepo 不等于统一规范，但它提供一个天然的统一治理边界。团队仍然需要自己决定哪些配置应该共享、哪些应用应该保留独立配置。

---

## 2. pnpm Workspace 先完成项目发现，再谈项目之间的依赖

本章是理解当前仓库的第一条核心机制链：

~~~text
pnpm-workspace.yaml
    ↓
目录匹配
    ↓
读取 package.json
    ↓
得到 Workspace Projects
~~~

到这一阶段，只完成“有哪些项目”的发现，还没有产生“A 依赖 B”的关系。

### 【pnpm-workspace.yaml 的 packages 字段定义项目搜索范围】

**结论**

pnpm-workspace.yaml 中的 packages 配置是 Workspace Project 的目录匹配规则。它告诉 pnpm 去哪些目录寻找项目。pnpm 官方要求 Workspace 根目录存在 pnpm-workspace.yaml，并通过 Workspace 将多个项目组织在一起。[[2]](https://pnpm.io/workspaces)

**机制**

先看一个与 browser-monitor 无关的最小例子：

~~~text
repo/
├── pnpm-workspace.yaml
├── packages/
│   ├── a/
│   │   └── package.json
│   └── b/
│       └── package.json
└── apps/
    └── web/
        └── package.json
~~~

pnpm-workspace.yaml：

~~~yaml
packages:
  - packages/*
  - apps/*
~~~

packages/* 是 Glob（路径匹配模式），它匹配：

~~~text
packages/a
packages/b
~~~

apps/* 匹配：

~~~text
apps/web
~~~

pnpm 再读取这些目录中的 package.json，把这些目录识别为 Workspace 中的 Project。

因此完整含义不是模糊的：

~~~text
“有 package.json 就属于 Monorepo”
~~~

而是：

~~~text
pnpm-workspace.yaml
    ↓
packages 中的路径规则
    ↓
匹配目录
    ↓
目录中存在 package.json
    ↓
pnpm 读取该 Package Manifest
    ↓
成为当前 Workspace 可管理的 Project
~~~

这里的 package.json 也称 Package Manifest（包清单），它描述这个 Project 的 name、version、dependencies、scripts 等工程信息。

**被发现后发生了什么**

假设三个 package.json 分别是：

~~~json
{
  "name": "@demo/a",
  "version": "1.0.0"
}
~~~

~~~json
{
  "name": "@demo/b",
  "version": "1.0.0"
}
~~~

~~~json
{
  "name": "@demo/web",
  "private": true
}
~~~

pnpm 此时知道 Workspace 中存在：

~~~text
@demo/a
@demo/b
@demo/web
~~~

但并不存在：

~~~text
@demo/web → @demo/a
~~~

因为没有任何 Package 声明这个依赖。

所以必须牢牢记住：

> Workspace Project Discovery（项目发现）和 Dependency Declaration（依赖声明）是两个阶段。

**browser-monitor 实践映射**

当前 browser-monitor/pnpm-workspace.yaml：

~~~yaml
packages:
  - sdk
  - protocol
  - platform
  - platform/apps/*
  - platform/packages/*
~~~

因此 pnpm 会在以下路径读取 Package Manifest：

~~~text
sdk/package.json
protocol/package.json
platform/package.json
platform/apps/api/package.json
platform/apps/worker/package.json
platform/apps/audit-worker/package.json
platform/apps/web/package.json
platform/packages/database/package.json
platform/packages/shared/package.json
~~~

例如：

~~~text
protocol/package.json
name = @browser-monitor/protocol
~~~

~~~text
platform/apps/api/package.json
name = @browser-monitor/api
~~~

这一步只回答：

> Workspace 中有哪些可以由 pnpm 识别和操作的 Project？

它还没有回答：

> API 依赖谁？

**面试与答辩收束**

> pnpm-workspace.yaml 负责定义 Workspace 的项目搜索范围，package.json 负责描述每个被发现项目的身份和工程信息。被 Workspace 发现只意味着“这个 Project 由当前 Workspace 管理”，并不意味着它自动成为其他项目的依赖。

---

### 【Package 的 name 是内部依赖解析时的重要身份标识】

**结论**

Project 的物理路径和 Package 的逻辑名字是两件不同的事情。pnpm 可以通过目录找到 Project，再通过 package.json 中的 name 识别这个 Package。

**机制**

例如：

~~~text
packages/protocol/
└── package.json
~~~

package.json：

~~~json
{
  "name": "@demo/protocol",
  "version": "1.0.0"
}
~~~

目录名是：

~~~text
protocol
~~~

逻辑 Package Name 是：

~~~text
@demo/protocol
~~~

其他 Project 声明依赖时写的是 Package Name：

~~~json
{
  "dependencies": {
    "@demo/protocol": "workspace:*"
  }
}
~~~

而不是写：

~~~text
../../packages/protocol
~~~

这样目录组织和逻辑包名就被解耦。

**browser-monitor 实践映射**

browser-monitor/protocol/package.json：

~~~json
{
  "name": "@browser-monitor/protocol",
  "version": "3.0.0"
}
~~~

browser-monitor/platform/apps/api/package.json：

~~~json
{
  "name": "@browser-monitor/api"
}
~~~

因此内部依赖声明使用的是：

~~~text
@browser-monitor/protocol
@browser-monitor/database
@browser-monitor/shared
~~~

而不是依靠目录名猜测依赖。

**面试与答辩收束**

> pnpm-workspace.yaml 主要通过目录范围发现 Project，package.json.name 给 Project 一个 Package 身份；真正建立依赖时，消费者通过这个 Package Name 声明依赖。

---

## 3. 内部依赖关系来自消费者 package.json，而不是目录结构

本章继续上一章的机制链：

~~~text
Workspace Project 已发现
    ↓
读取消费者 package.json
    ↓
dependencies 声明目标 Package
    ↓
workspace:* 要求本地 Workspace 解析
    ↓
形成 Project Dependency
~~~

### 【被 Workspace 发现不等于可以自动被其他项目引用】

**结论**

一个目录进入 Workspace 后，只表示 pnpm 知道“这个 Package 存在”。要让另一个 Project 把它作为依赖，消费者必须在自己的 package.json 中声明。

**机制**

继续使用最小例子：

~~~text
Workspace Projects:
@demo/a
@demo/b
@demo/web
~~~

如果 web/package.json 是：

~~~json
{
  "name": "@demo/web",
  "private": true
}
~~~

那么当前不存在任何内部依赖。

修改成：

~~~json
{
  "name": "@demo/web",
  "private": true,
  "dependencies": {
    "@demo/a": "workspace:*"
  }
}
~~~

这时才出现：

~~~text
@demo/web
    ↓ depends on
@demo/a
~~~

因此两个文件承担完全不同的职责：

| 文件 | 负责回答的问题 |
| --- | --- |
| pnpm-workspace.yaml | Workspace 中有哪些 Project？ |
| 某 Project/package.json | 这个 Project 叫什么、依赖谁、有哪些任务？ |

**browser-monitor 实践映射**

API 的依赖关系不是根据目录结构推测出来的，而是 platform/apps/api/package.json 明确声明：

~~~json
{
  "dependencies": {
    "@browser-monitor/database": "workspace:*",
    "@browser-monitor/protocol": "workspace:*",
    "@browser-monitor/shared": "workspace:*"
  }
}
~~~

所以可以直接得到事实：

~~~text
@browser-monitor/api
    ├── depends on @browser-monitor/database
    ├── depends on @browser-monitor/protocol
    └── depends on @browser-monitor/shared
~~~

Worker 同样由 package.json 声明：

~~~json
{
  "dependencies": {
    "@browser-monitor/database": "workspace:*",
    "@browser-monitor/protocol": "workspace:*",
    "@browser-monitor/shared": "workspace:*"
  }
}
~~~

因此：

~~~text
@browser-monitor/worker
    ├── database
    ├── protocol
    └── shared
~~~

Audit Worker：

~~~json
{
  "dependencies": {
    "@browser-monitor/database": "workspace:*",
    "@browser-monitor/shared": "workspace:*",
    "chrome-launcher": "^1.2.1",
    "lighthouse": "^13.5.0"
  }
}
~~~

所以它直接依赖：

~~~text
audit-worker
    ├── database
    └── shared
~~~

它没有直接声明 protocol，因此不能画成：

~~~text
audit-worker → protocol
~~~

直接依赖。

但 database 与 shared 都依赖 protocol，因此 Audit Worker 会通过它们间接受到 Protocol 变化影响，这属于 Transitive Dependency（传递依赖）。

**面试与答辩收束**

> Monorepo 的 Project Dependency 不是通过目录层级自动产生的，而是由消费者 Package Manifest 中的 dependency 声明产生。判断当前项目依赖关系时应直接读取 package.json，而不是根据 apps/packages 目录名猜测。

---

### 【workspace:* 控制的是依赖解析来源，不负责创建依赖本身】

**结论**

workspace:* 不是“创建依赖”的指令。依赖已经由 dependencies 中的 Package Name 创建；workspace:* 进一步约束这个依赖必须解析到当前 Workspace 的本地 Package。

pnpm 官方说明，workspace: Protocol 会拒绝解析到 Workspace 之外的 Package。如果本地 Workspace 无法满足这个依赖，安装会失败，而不会静默回退到 Registry。[[2]](https://pnpm.io/workspaces)

**机制**

普通版本声明：

~~~json
{
  "dependencies": {
    "@demo/a": "^1.0.0"
  }
}
~~~

表达的是：

> 我需要符合 ^1.0.0 的 @demo/a。

在不同 pnpm 配置下，本地 Workspace Package 或 Registry Package 都可能参与解析。

而：

~~~json
{
  "dependencies": {
    "@demo/a": "workspace:*"
  }
}
~~~

表达的是：

> 我需要当前 Workspace 中的 @demo/a。

所以逻辑链是：

~~~text
消费者 package.json
    ↓
dependencies 中发现 @demo/a
    ↓
版本说明符 = workspace:*
    ↓
pnpm 在 Workspace Project 集合中查找
name = @demo/a
    ↓
找到本地 Package
    ↓
建立本地 Workspace Dependency
~~~

如果找不到：

~~~text
workspace:* 要求本地 Package
    ↓
Workspace 中没有匹配 Package
    ↓
安装失败
~~~

这就是 workspace:* 的核心保证。[[2]](https://pnpm.io/workspaces)

**发布时为什么不会失效**

消费者从 npm 安装一个已经发布的 Package 时，不会拥有原作者的 Monorepo。因此 pnpm 在 pack/publish Workspace Package 时，会把 workspace:* 等说明符转换成普通版本说明。官方文档给出的规则是 workspace:* 会被转换成目标 Workspace Package 的实际版本。[[2]](https://pnpm.io/workspaces)

所以：

~~~text
开发阶段
workspace:* → 本地 Workspace Package

发布阶段
workspace:* → 普通可发布版本
~~~

**browser-monitor 实践映射**

SDK：

~~~json
{
  "dependencies": {
    "@browser-monitor/protocol": "workspace:*",
    "web-vitals": "6.2.1"
  }
}
~~~

这两个依赖虽然都位于 dependencies，但解析来源不同：

~~~text
@browser-monitor/protocol
    ↓ workspace:*
当前 Workspace

web-vitals
    ↓ 6.2.1
Registry / Lockfile
~~~

**面试与答辩收束**

> dependencies 决定“依赖谁”，workspace:* 决定“这个依赖必须从当前 Workspace 解析”。这两个概念不能合并。

---

## 4. pnpm install 完成依赖解析和链接，但不会自动完成项目构建

本章继续机制链：

~~~text
Project Discovery
    ↓
Dependency Declaration
    ↓
Dependency Resolution
    ↓
pnpm install
    ↓
node_modules 中建立可解析关系
~~~

这一步仍然不是 Build。

### 【pnpm install 会面向整个 Workspace 处理 Package Manifest】

**结论**

在 Workspace 根执行 pnpm install 时，pnpm 会读取 Workspace 中项目的 Package Manifest，根据 dependency 声明解析外部依赖和 Workspace 依赖，并通过统一 Lockfile 保留解析结果。

pnpm 默认支持 Workspace 共用 pnpm-lock.yaml；官方文档把 sharedWorkspaceLockfile 的默认值定义为 true，并说明 Workspace Package 仍然只能访问自己声明的依赖。[[2]](https://pnpm.io/workspaces)

**机制**

可以把安装过程理解成：

~~~text
pnpm-workspace.yaml
        ↓
发现 Workspace Projects
        ↓
读取各 Project/package.json
        ↓
收集 dependency declarations
        ↓
┌───────────────────────────────┐
│ workspace:* dependency        │
│ → 查找本地 Workspace Package │
├───────────────────────────────┤
│ 普通外部 dependency           │
│ → 根据版本和 lockfile 解析    │
└───────────────────────────────┘
        ↓
fetch / link
        ↓
形成 node_modules 可解析结构
~~~

pnpm 官方把安装过程描述为 Resolution、Fetching、Linking，并使用 Content-addressable Store（内容寻址存储）和链接机制减少重复文件。[[3]](https://pnpm.io/)

**Workspace Dependency 的链接意味着什么**

例如：

~~~text
apps/web
    ↓ depends on
packages/a
~~~

安装以后，应用按照 Package Name：

~~~js
import value from "@demo/a";
~~~

进行模块解析时，可以找到 Workspace 中对应的 Package。

在通常的 Workspace Link 模式下，可以概念化理解成：

~~~text
consumer/node_modules/@demo/a
          │
          │ local workspace link
          ↓
packages/a
~~~

实际链接方式还会受到 linkWorkspacePackages、injectWorkspacePackages、nodeLinker 等 pnpm 配置影响，因此文档只把它描述为“建立本地可解析关系”，不把所有场景都简化成固定的单一文件系统结构。官方文档明确区分 Symbolic Link 与 injected Workspace Dependency 等配置。[[2]](https://pnpm.io/workspaces)

**browser-monitor 实践映射**

Dockerfile.backend 在真正复制全部源码之前，先复制：

~~~text
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
protocol/package.json
sdk/package.json
platform/package.json
platform/apps/*/package.json
platform/packages/*/package.json
~~~

然后执行：

~~~bash
pnpm install --frozen-lockfile
~~~

这说明安装阶段需要的是：

~~~text
Workspace 结构
+
各 Package Manifest
+
Lockfile
~~~

而不是先读取所有业务源码。

**面试与答辩收束**

> pnpm install 的核心结果是完成 Dependency Resolution 与 Installation/Linking，让各 Project 能按自己的 package.json 解析依赖。它不等于执行所有 Package 的 build。

---

### 【Workspace Package 已经可解析，不等于它的 dist 已经存在】

**结论**

内部 Package 被链接到消费者后，只说明 Package Resolution（包解析）已经建立。消费者真正 import 时还要遵守目标 Package 自己的 exports/main/types 配置，因此如果这些入口指向 dist，仍然需要提前执行 Build。

**机制**

假设内部 Package：

~~~json
{
  "name": "@demo/a",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup"
  }
}
~~~

消费者已经声明：

~~~json
{
  "dependencies": {
    "@demo/a": "workspace:*"
  }
}
~~~

pnpm install 以后消费者可以找到 @demo/a。

但是 @demo/a 的公开入口仍然是：

~~~text
dist/index.js
dist/index.d.ts
~~~

如果 Package 没有执行 build：

~~~text
Package 已找到
    ↓
读取 exports
    ↓
目标指向 dist/index.js
    ↓
dist 尚未生成
    ↓
构建/运行仍可能失败
~~~

因此：

> Dependency Linking 和 Dependency Build 是两个不同阶段。

pnpm install 并不会因为某个 Package 有一个名为 build 的 script，就自动替你执行该 build。只有 Package 自己配置了对应安装生命周期脚本或其他工具明确触发时，才会产生额外行为；browser-monitor 当前 Protocol、Database、Shared 等 Package 的构建均通过显式 build Script 完成。

**browser-monitor 实践映射**

protocol/package.json：

~~~json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup"
  }
}
~~~

所以 SDK/API 即使已经通过 workspace:* 找到 Protocol，Protocol 的发布/构建入口仍然依赖：

~~~text
protocol/dist/*
~~~

这就是为什么 Dockerfile.backend 安装完依赖以后，还会显式执行：

~~~text
protocol build
shared build
database build
api build
worker build
~~~

**面试与答辩收束**

> Workspace Dependency 解决“Package 去哪里找”，Build 解决“Package 对外暴露的产物有没有生成”。被 pnpm 链接并不等于已经构建完成。

---

## 5. Project Dependency Graph 是根据依赖声明得到的关系模型

本章把前面已经建立的依赖声明汇总成结构：

~~~text
Workspace Projects
+
package.json dependencies
    ↓
Project Dependency Graph
~~~

### 【依赖图首先要明确箭头语义】

**结论**

本文统一使用：

> A → B 表示 A depends on B，也就是 A 依赖 B。

不规定箭头含义，很容易把“依赖方向”和“影响传播方向”画反。

**browser-monitor 实践映射**

由各 package.json 可以直接得到：

~~~text
sdk → protocol

database → protocol

shared → protocol

api → database
api → protocol
api → shared

worker → database
worker → protocol
worker → shared

audit-worker → database
audit-worker → shared
~~~

Web 的 package.json 当前没有声明任何 @browser-monitor/* Workspace Dependency，因此不能为了让架构图“完整”而人为画：

~~~text
web → api
~~~

作为 Package Dependency。

Web 与 API 的关系主要发生在运行时 HTTP 通信层，后文单独解释。

**传递依赖**

由于：

~~~text
audit-worker → database
database → protocol
~~~

可以说 Protocol 的变化可能间接影响 Audit Worker，但不能说 Audit Worker 在 package.json 中直接依赖 Protocol。

这就是：

~~~text
Direct Dependency
直接依赖

和

Transitive Dependency
传递依赖
~~~

的区别。

**面试与答辩收束**

> 判断 Project Dependency 时应该读取 Package Manifest，而不是看目录结构或运行时数据流。A 是否直接依赖 B，要看 A 是否在自己的依赖声明中引用 B。

---

### 【Project Graph 通常是工具计算的数据结构，不天然是一份仓库文件】

**结论**

Dependency Graph / Project Graph 是根据 Workspace Manifest、源码 Import、TypeScript 配置等信息计算出来的关系模型。不同工具可以把它存在内存中、可视化或导出，但 Monorepo 本身不会自动要求仓库里存在一个 project-graph.json。

**pnpm 中的情况**

pnpm 可以按照 Workspace Dependency 关系做 Filter 选择和递归任务顺序处理，因此内部必须理解：

~~~text
dependencies
dependents
~~~

关系。pnpm Filtering 支持选择某 Package 及其 Dependencies 或 Dependents。[[4]](https://pnpm.io/filtering)

但这不等于 pnpm 必须在仓库里保存：

~~~text
dependency-graph.json
~~~

事实来源仍然是：

~~~text
pnpm-workspace.yaml
各 package.json
pnpm-lock.yaml
~~~

图是工具在执行命令时根据这些信息形成的关系模型。

**Nx 中的情况**

Nx 显式维护 Project Graph 与 Task Graph。官方说明 Project Graph 表示 Workspace 中项目及其依赖，Task Graph 是另一张基于项目关系和任务配置形成的图。[[5]](https://nx.dev/docs/features/explore-graph)

Nx 可以执行：

~~~bash
nx graph
~~~

可视化 Project Graph，也可以：

~~~bash
nx graph --file=output.json
~~~

导出 JSON。[[5]](https://nx.dev/docs/features/explore-graph)

这时才真正得到一份可检查的图文件。

**面试与答辩收束**

> Graph 是关系模型，不一定是源代码仓库中的静态文件。pnpm 会利用 Workspace Dependency 关系；Nx 则把 Project Graph 和 Task Graph 作为更显式的一等能力，并提供可视化和导出。

---

## 6. Project Graph 只描述“谁依赖谁”，Task Graph 才决定任务怎么执行

本章进入第二条核心机制链：

~~~text
Project Graph
+
每个 Project 定义的 Task
+
Task Dependency Rule
    ↓
Task Graph
    ↓
实际执行顺序与并行关系
~~~

### 【每个 Project 先独立定义自己的 build、test、dev】

**结论**

Task（任务）首先是一个 Project 自己可以执行的操作，例如 build、test、typecheck、dev。Package Manager 或 Task Runner 不会凭空知道如何构建 React、Node 或 SDK，需要项目自己提供命令。

**browser-monitor 实践映射**

Protocol：

~~~json
{
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
~~~

API：

~~~json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "test": "vitest run"
  }
}
~~~

Web：

~~~json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  }
}
~~~

这说明：

~~~text
Project Graph
解决谁依赖谁

package.json scripts
解决这个 Project 的 build/test/dev 到底做什么
~~~

两者仍然不是一回事。

---

### 【当前 browser-monitor 用 Script 显式写出任务执行顺序】

**结论**

当前项目没有通过 Nx/Turborepo 配置让 Task Runner 自动从 Project Graph 推导 Build Pipeline，而是在根 package.json 和 platform/package.json 中显式写出执行顺序。

根 package.json：

~~~text
protocol build
    &&
sdk build
    &&
platform build
~~~

platform/package.json：

~~~text
shared build
    &&
database build
    &&
api build
    &&
worker build
    &&
audit-worker build
    &&
web build
~~~

这是“手工编排”的准确含义：

~~~text
开发者已经知道项目关系
    ↓
开发者自己决定任务顺序
    ↓
把顺序写成 Shell && 链
~~~

其中 && 还意味着：

> 前一个命令成功后才执行后一个命令。

**当前 Script 并不等于最小必要 Task Graph**

例如：

~~~text
shared → protocol
database → protocol
~~~

Shared 与 Database 之间没有当前 package.json 声明的直接依赖，因此在 Protocol 已完成的前提下，它们原则上可以并行。

API 与 Worker 都依赖 Database/Shared/Protocol，但 API 与 Worker 之间没有 Package Dependency，所以它们也不必因为依赖关系而严格串行。

而当前 Script 使用 &&：

~~~text
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
~~~

是一种保守、简单但并行度较低的执行方式。

因此当前实现的优点和代价是：

| 特点 | 结果 |
| --- | --- |
| 顺序直接写在 package.json | 容易读懂 |
| 不需要额外 Task Runner | 工具少 |
| 依赖变化后要人工同步 Script | 容易维护遗漏 |
| && 串行执行 | 无法自动利用所有安全并行机会 |
| 没有 Task Cache | 重复任务不会自动复用 |

**面试与答辩收束**

> 当前项目已经存在 Project Dependency，但 Task Graph 没有通过专门的构建系统自动推导，而是开发者把任务顺序直接写进 package scripts。这适合当前规模，但不是 Monorepo 的唯一任务执行方式。

---

### 【自动编排的本质是声明规则，而不是继续手写完整顺序】

**结论**

不手工编排并不意味着“不需要定义任务依赖”。区别是：

~~~text
手工方式
把具体顺序写死

自动 Task Runner
声明一般规则
+
读取当前 Project Graph
+
为本次命令生成 Task Graph
~~~

例如最常见规则：

> 一个 Project 执行 build 之前，先执行它所依赖 Project 的 build。

用图表示：

~~~text
Project Graph

api → database
api → shared
database → protocol
shared → protocol


Task Rule

build depends on ^build
       ↓

Task Graph

        protocol:build
          /       \
         ↓         ↓
database:build   shared:build
          \       /
           ↓     ↓
            api:build
~~~

这里的关键不是工具名，而是：

~~~text
Project Graph
+
Task Dependency Rule
=
Task Graph
~~~

---

## 7. Nx 与 Turborepo 如何真正接管任务编排

本章不把 Nx/Turborepo 当名词介绍，而是说明如果把 browser-monitor 接入这类 Task Runner，需要增加什么配置、命令如何变化、工具又是怎样生成 Task Graph 的。

### 【Turborepo 用 Workspace Package 关系和 turbo.json 生成 Task Graph】

**结论**

Turborepo 不替代 pnpm 的 Package 安装。典型组合仍然是：

~~~text
pnpm
负责 Workspace 与 Dependency

Turborepo
负责 Task Pipeline、并行与 Cache
~~~

**主流接入方式**

假设现有 Monorepo 已经有各 Project 的 package.json build Script。

第一步，在根增加开发依赖：

~~~bash
pnpm add -Dw turbo
~~~

第二步，保留各 Project 自己的 build：

~~~json
{
  "scripts": {
    "build": "tsc"
  }
}
~~~

或：

~~~json
{
  "scripts": {
    "build": "vite build"
  }
}
~~~

第三步，根新增 turbo.json：

~~~json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
~~~

这里最关键的是：

~~~text
^build
~~~

语义不是“前一个目录先 build”，而是：

> 当前 Project 的 build 依赖它的 Project Dependencies 的 build。

然后根命令可以变成：

~~~bash
turbo run build
~~~

或者根 package.json：

~~~json
{
  "scripts": {
    "build": "turbo run build"
  }
}
~~~

此时 Turborepo 根据 Workspace Package Dependency 和 Task Rule，为本次 build 形成 Task Graph。

假设：

~~~text
api → database
api → shared
database → protocol
shared → protocol
~~~

就可以形成：

~~~text
protocol:build
     ↓
┌────┴────┐
↓         ↓
database  shared
:build    :build
└────┬────┘
     ↓
 api:build
~~~

Database 与 Shared 可以在满足共同上游后并行；API 只需要等待自己的 Task Dependencies 完成。

Turborepo 官方文档把 Repository 中的 Package 关系和 Task Pipeline 分开管理，具体配置以 turbo.json 的 tasks/dependsOn 为入口。[[6]](https://turborepo.com/docs/crafting-your-repository/configuring-tasks)

**如果映射到 browser-monitor**

当前：

~~~text
protocol build &&
sdk build &&
platform build
~~~

以及 Platform 内部连续 && 可以逐渐替换成：

~~~text
每个 Project 保留自己的 build Script
+
Turbo 读取 Workspace Dependency
+
turbo.json 声明 build → ^build
+
turbo run build
~~~

这样任务顺序由当前依赖关系决定，而不是把所有 Package Name 重复写进根 Script。

**面试与答辩收束**

> Turborepo 并不是替 pnpm 建立 Package Dependency，而是读取已有 Workspace 关系，再通过 dependsOn 等 Task Rule 把 Project Graph 转成可执行 Task Graph，同时增加并行和缓存能力。

---

### 【Nx 把 Project Graph 与 Task Graph 做成可直接检查的一等模型】

**结论**

Nx 的核心优势之一是显式维护 Project Graph 和 Task Graph，并允许开发者查看“为什么存在这条依赖”“本次任务为什么按这个顺序执行”。

Nx 官方定义：Project Graph 表示 Workspace 中 Project 及其 Dependencies；Task Graph 是独立的一张任务图，基于 Project Graph 和 Task Pipeline 决定执行。[[5]](https://nx.dev/docs/features/explore-graph)

**主流接入方式**

Nx 项目仍然可以保留 package.json Script。然后在 nx.json 定义公共 Task Rule：

~~~json
{
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"]
    }
  }
}
~~~

Nx 官方对 ^build 的解释是：

> 在构建当前 Project 前，先执行当前 Project 所依赖 Project 的 build。[[7]](https://nx.dev/docs/concepts/task-pipeline-configuration)

如果：

~~~text
api → database → protocol
~~~

执行：

~~~bash
nx build api
~~~

任务链为：

~~~text
protocol:build
    ↓
database:build
    ↓
api:build
~~~

如果多个 Dependencies 没有相互依赖，Nx 会在满足 Graph Constraint 的前提下并行执行。[[7]](https://nx.dev/docs/concepts/task-pipeline-configuration)

**图是不是文件**

Nx 默认在内部构建 Graph，但可以显式检查：

~~~bash
nx graph
~~~

导出 Project Graph：

~~~bash
nx graph --file=output.json
~~~

查看某次 Build 的 Task Graph：

~~~bash
nx build my-app --graph
~~~

Nx 官方也支持把 Task Graph 写出供分析。[[5]](https://nx.dev/docs/features/explore-graph)

因此 Nx 中：

~~~text
package.json / project config / source imports
        ↓
Nx Project Graph
        ↓
nx.json Task Rules
        ↓
本次命令的 Task Graph
        ↓
Scheduler 执行
~~~

**如果映射到 browser-monitor**

接入后首先要确认 Nx 识别的 Project Graph 是否与真实架构一致，例如：

~~~text
api → database
api → shared
api → protocol
database → protocol
shared → protocol
~~~

再配置：

~~~json
{
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"]
    }
  }
}
~~~

最后使用：

~~~bash
nx run-many --target=build
~~~

或：

~~~bash
nx build api
~~~

由 Nx 生成本次 Task Graph。

**面试与答辩收束**

> Nx/Turborepo 的“自动”不是自动猜业务，而是自动把已经存在的 Project Dependency 和你声明的 Task Rule组合成 Task Graph。依赖关系错了，自动编排同样会错，因此正确的 Package Boundary 仍然是基础。

---

### 【当前项目为什么仍然可以选择 Script 编排】

**结论**

是否引入 Task Runner 是复杂度权衡，不是 Monorepo 正确与否的判断标准。

当前 browser-monitor 只有有限数量的 Workspace Project，Script 编排虽然串行度高，但非常直接：

~~~text
打开 package.json
就能知道执行顺序
~~~

Nx/Turbo 带来的额外收益主要在：

~~~text
项目数量继续增长
依赖经常变化
需要自动并行
CI 时间明显增长
需要 Task Cache
需要 Affected Analysis
~~~

时更加明显。

因此当前事实应表述为：

> browser-monitor 当前使用 pnpm 10.28.2 Workspace + package scripts 进行显式任务编排；Nx/Turborepo 是可以替换这部分“任务顺序管理”的规模化方案，而不是当前已经存在的组件。

---

## 8. Build Artifact 决定一个 Workspace Package 最终如何被使用

本章从 Task Graph 继续向下：

~~~text
Task Graph
    ↓
执行 Project build
    ↓
Build Artifact
    ↓
Package / Server / Static Assets
~~~

同一个 Monorepo 中不同 Project 的 Build Artifact 可以完全不同。

### 【Library Package 构建后提供可被 import 的代码产物】

**结论**

Library/SDK 的 Build 目标通常是生成 JavaScript、Type Declaration 或不同模块格式，使其他应用可以通过 Package Name import。

**browser-monitor 实践映射**

Protocol：

~~~text
source
  ↓ tsup
dist/index.js
dist/index.d.ts
~~~

SDK：

~~~text
source
  ↓ tsup
dist/index.js
dist/index.d.ts
dist/index.global.js
~~~

其 package.json 的 main/types/exports 再指向这些 Build Artifact。

所以消费者依赖 Package Name：

~~~text
@browser-monitor/protocol
~~~

最终解析到的是该 Package 对外声明的 Entry，而不是随意访问其内部 src 文件。

**面试与答辩收束**

> Workspace 负责本地 Package Resolution；exports/main/types 决定 Package 对外入口；build 负责真正生成这些入口需要的 Artifact。三层不能混在一起。

---

## 9. Web Application 与 Node Application 的构建生命周期来自运行模型差异

这一部分不能只说“Web 是静态资源、API 是 Node 进程”，而要从 package.json 和 Dockerfile 顺着执行过程推导。

### 【Node API 构建后仍然需要 Node.js Runtime 长期运行】

**结论**

服务端 Application 的生产构建产物仍然是服务器程序代码，需要 Node.js Process 长期运行、监听端口并处理请求。

**browser-monitor 实践映射**

platform/apps/api/package.json：

~~~json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js"
  }
}
~~~

开发阶段：

~~~text
src/main.ts
   ↓
tsx watch
   ↓
Node 开发进程
~~~

生产构建：

~~~text
TypeScript Source
   ↓
tsc
   ↓
dist/main.js
~~~

生产运行：

~~~text
dist/main.js
   ↓
node dist/main.js
   ↓
长期 Node Process
   ↓
监听 HTTP Port
~~~

Dockerfile.backend 最终：

~~~text
CMD
pnpm --filter @browser-monitor/api start
~~~

而 API 的 start：

~~~text
node dist/main.js
~~~

所以整个链路由文件可以直接验证：

~~~text
API Source
   ↓ Build
Server JavaScript
   ↓ Start
Node Runtime
   ↓
HTTP Service
~~~

**面试与答辩收束**

> Node API 的 Build 只完成 TypeScript 到可运行 JavaScript 的转换；Build 完成后还需要 Node Runtime 长期执行这些代码，因此容器中保留 Node.js。

---

### 【React Web 的生产 Build 把源码转换成浏览器资源】

**结论**

browser-monitor Web 的生产 Build 不生成一个需要 Node.js 长期执行的 React Server，而是通过 Vite 生成 HTML、JavaScript、CSS 等浏览器静态资源，然后由 Caddy 负责 HTTP 文件服务。

**browser-monitor 实践映射**

platform/apps/web/package.json：

~~~json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build"
  }
}
~~~

开发阶段：

~~~text
React / TypeScript Source
        ↓
Vite Dev Server
        ↓
Browser 按开发模式请求模块
~~~

生产构建：

~~~text
React / TypeScript Source
        ↓
tsc -b
        ↓
vite build
        ↓
dist/
├── index.html
├── assets/*.js
└── assets/*.css
~~~

注意 Web Package 当前没有：

~~~text
start: node dist/main.js
~~~

这已经说明它不是和 API 一样的服务端运行模型。

**Dockerfile.web 的两个阶段**

第一阶段：

~~~dockerfile
FROM node:22-bookworm-slim AS build
...
RUN pnpm --filter @browser-monitor/web build
~~~

Node.js 在这里承担的是：

~~~text
pnpm
TypeScript
Vite
~~~

所需要的 Build Environment（构建环境）。

第二阶段：

~~~dockerfile
FROM caddy:2.10-alpine
COPY --from=build /workspace/platform/apps/web/dist /srv
~~~

运行镜像已经换成 Caddy，不再使用 Node Image。

完整生命周期：

~~~text
React Source
    ↓
Node Build Stage
    ↓
Vite Build
    ↓
dist 静态资源
    ↓
Caddy Runtime
    ↓
HTTP 返回 HTML/JS/CSS
    ↓
Browser
    ↓
Browser 执行 React JavaScript
~~~

所以“React 在哪里运行”应该回答：

~~~text
Build Tool 在 Node 环境运行
React Application 最终在 Browser 运行
Caddy 只是生产静态文件服务器
~~~

**面试与答辩收束**

> Web 与 API 生命周期不同不是 Monorepo 导致的，而是两种 Application Runtime Model 不同。Monorepo 只是把它们统一管理；真正的 Build 和 Runtime 仍由各自项目决定。

---

### 【Audit Worker 的独立 Dockerfile 来自运行环境依赖不同】

**结论**

部署边界不必和 Workspace Package 边界一一对应。一个 Application 如果需要特殊系统依赖，可以拥有不同的 Container Image。

**browser-monitor 实践映射**

Audit Worker 的 Package Dependency 包括：

~~~text
chrome-launcher
lighthouse
~~~

Dockerfile.audit-worker 还会通过 apt 安装：

~~~text
chromium
ca-certificates
~~~

因此其 Runtime 不只是：

~~~text
Node.js
~~~

而是：

~~~text
Node.js
+
Lighthouse
+
Chromium
~~~

这就是为什么 Audit Worker 使用独立 Dockerfile，而 API 与普通 Worker 可以共享 Dockerfile.backend 的构建环境。

**面试与答辩收束**

> Workspace Package 是源码和依赖边界，Container Image 是运行环境边界。两者可以相关，但不会天然一一对应。

---

## 10. Runtime Graph 与 Project Graph 是两张完全不同的图

本章把源码阶段和运行阶段彻底分离。

### 【Web → API 的 HTTP 关系不是 Workspace Package Dependency】

**结论**

两个 Application 可以在运行时通过网络依赖，但源码层完全没有 Package Dependency。

**browser-monitor 实践映射**

Web package.json 当前没有：

~~~text
@browser-monitor/api
~~~

依赖。

所以 Project Graph 中不应该画：

~~~text
web → api
~~~

作为 Package Dependency。

但是 Caddyfile：

~~~text
/api/* → reverse_proxy api:3000
~~~

说明生产运行时存在：

~~~text
Browser
   ↓
Caddy
   ↓ HTTP
API
~~~

因此至少要区分：

~~~text
Source / Package Dependency

与

Runtime / Network Dependency
~~~

同理 API 对 Database Package 的关系：

~~~text
API Source
    ↓ import
@browser-monitor/database
~~~

属于代码依赖。

而 API 运行后连接 TimescaleDB：

~~~text
API Process
    ↓ PostgreSQL Protocol / TCP
TimescaleDB
~~~

属于运行时依赖。

**面试与答辩收束**

> Project Graph 用来分析源码依赖；Runtime Graph 用来分析进程、服务和网络关系。把两张图混在一起，会错误地认为所有 HTTP 服务调用都应该写成 package.json Dependency。

---

### 【Docker Compose 根据运行依赖启动多个 Service】

**结论**

pnpm Workspace 和 Task Runner 管理的是代码与任务；Docker Compose 管理的是构建完成后有哪些 Service 需要运行，以及它们之间的启动条件。

Docker 官方明确指出：depends_on 可以控制服务启动顺序，但“Container 已启动”不等于“Service 已就绪”；service_healthy 与 healthcheck 用于等待依赖真正健康，service_completed_successfully 可用于等待一次性任务成功完成。[[8]](https://docs.docker.com/compose/how-tos/startup-order/)

**browser-monitor 实践映射**

当前 docker-compose.yml 定义：

~~~text
timescaledb
redis
mailpit
migrate
api
worker
audit-worker
web
~~~

运行关系：

~~~text
TimescaleDB
    ↓ service_healthy
Migrate
    ↓ service_completed_successfully
┌───────────┬──────────────┐
↓           ↓              ↓
API       Worker      Audit Worker
↑
Redis service_healthy

API service_healthy
    ↓
Web
~~~

这里的关系来自 docker-compose.yml，不来自 package.json。

因此完整工程存在至少两套依赖模型：

~~~text
Build-time / Source Graph
由 package.json 等形成

Runtime Graph
由 Service 配置、网络调用、数据库连接等形成
~~~

**面试与答辩收束**

> Monorepo 不负责自动启动数据库、Redis、API 和 Web。完整系统的运行编排属于 Docker Compose 等 Runtime Orchestrator 的职责。

---

## 11. Build、Release 与 Deploy 是三段独立生命周期

本章继续从 Artifact 向最终交付延伸。

### 【Build 只回答“源码变成什么产物”】

**结论**

Build 的输入是 Source，输出是 Artifact。不同 Project 可以使用完全不同的构建工具。

browser-monitor 当前：

| Project | Build | 主要 Artifact |
| --- | --- | --- |
| protocol | tsup | dist JS + d.ts |
| sdk | tsup | SDK dist |
| api | tsc | Server JS |
| worker | tsc | Worker JS |
| audit-worker | tsc | Worker JS |
| web | tsc + Vite | HTML/JS/CSS |
| database/shared | tsc | Library JS + d.ts |

所以 Monorepo 的统一 Build 并不是“所有项目都用同一个 Builder”，而是：

~~~text
统一触发多 Project Task
+
每个 Project 使用自己的 Build Implementation
~~~

---

### 【Release 管理版本与分发，Deploy 管理运行环境】

**结论**

Release（发布）主要回答 Package/Image 哪个版本可以被其他系统使用；Deploy（部署）主要回答 Application 的哪个 Artifact 在哪个环境中运行。

SDK 可以是：

~~~text
Source
↓
Build
↓
npm Package
↓
其他业务项目安装
~~~

API 可以是：

~~~text
Source
↓
Build
↓
Docker Image
↓
Container
↓
Server
~~~

当前仓库中 SDK 的 publishConfig.access 为 public，而 API、Worker、Web 等 Package 标记 private: true，说明它们的交付边界本来就不同。

**版本策略事实边界**

当前 Manifest 可以确认：

~~~text
SDK = 0.3.0
Protocol = 3.0.0
Platform/Apps = 0.1.0
~~~

这只能证明：

> 当前 Package Manifest 并没有统一使用同一个版本号。

它不能单独证明仓库已经建设完整的“Independent Version Release Workflow”。

完整版本发布策略是否存在自动 Bump、Changelog、Changesets、Tag 等流程，需要读取实际 Release 配置后才能确认。

pnpm 官方也明确指出 Workspace 中的 Package Versioning 是复杂问题，并推荐 Changesets、Rush 等工具处理发布工作流。[[2]](https://pnpm.io/workspaces)

**面试与答辩收束**

> Monorepo 不意味着所有 Package 同版本，也不意味着所有 Application 一起部署。Build、Release、Deploy 必须分别讨论。

---

## 12. CI 的优化建立在正确的 Project Graph 与 Task Graph 之上

本章解释为什么 Affected、Cache 不是独立工具名词，而是前面机制的自然结果。

### 【Affected 先判断哪些 Project 被变化影响】

**结论**

Affected Analysis（受影响分析）解决：

> 代码变化以后，哪些 Project 的任务值得重新执行？

基本机制：

~~~text
Git Diff
   ↓
变化文件属于哪些 Project
   ↓
Project Graph
   ↓
向 Dependents 传播影响
   ↓
Affected Projects
   ↓
只运行相关 Task
~~~

Nx 官方利用 Project Graph 计算受影响项目，并提供 affected 命令运行相关任务。[[9]](https://nx.dev/ci/features/affected)

**browser-monitor 示例**

如果只修改：

~~~text
platform/apps/web/src/*
~~~

而 Web 没有 Workspace Dependents，那么影响通常停留在 Web 范围。

如果修改：

~~~text
protocol/*
~~~

根据当前 Project Dependency：

~~~text
protocol
↑
├── sdk
├── database
├── shared
├── api
└── worker
~~~

直接和传递影响范围会明显扩大。

这里的关键是：

> 影响传播来自真实 Dependency Graph，而不是“公共目录改了就全仓 Build”这种粗粒度规则。

当前 browser-monitor 尚未从已确认配置中看到 Nx/Turbo Affected Pipeline，因此这属于演进方案，不是项目现状。

---

### 【Cache 再判断相同 Task 是否需要重新计算】

**结论**

Affected 回答“这个 Task 是否相关”，Cache 回答“相关 Task 是否已经有相同输入对应的结果”。

~~~text
Affected
↓
减少任务候选集

Cache
↓
减少真正执行的任务
~~~

典型 Task Cache 会把：

~~~text
Source Input
Dependency Input
Config
Environment
Task Command
~~~

组成计算输入，生成 Hash，再判断能否恢复历史 Artifact。

Nx 的 Task Graph 与 Cache 都基于它对 Project/Task Input 的理解；官方 Graph UI 甚至可以查看某个 Task 用于计算 Hash 的 Inputs。[[5]](https://nx.dev/docs/features/explore-graph)

当前 browser-monitor 没有确认 Task Cache，因此仍然标记为规模化方案。

**面试与答辩收束**

> Affected 和 Cache 都建立在“工具知道 Project 和 Task 关系”的前提下。依赖边界越混乱，增量 CI 越难准确。

---

## 13. browser-monitor 应同时用四张图理解，而不是只看目录

到这里可以把整个工程压缩为四张互不替代的图。

### 【第一张：Workspace Discovery 图】

~~~text
pnpm-workspace.yaml
    ↓
sdk
protocol
platform
platform/apps/*
platform/packages/*
    ↓
读取各 package.json
    ↓
Workspace Project Set
~~~

回答：

> pnpm 管理哪些 Project？

---

### 【第二张：Project Dependency Graph】

统一约定 A → B 表示 A depends on B：

~~~text
sdk ───────────────→ protocol

database ──────────→ protocol
shared ────────────→ protocol

api ───────────────→ database
api ───────────────→ shared
api ───────────────→ protocol

worker ────────────→ database
worker ────────────→ shared
worker ────────────→ protocol

audit-worker ──────→ database
audit-worker ──────→ shared

web
当前无 @browser-monitor/* Workspace Dependency
~~~

回答：

> 源码层谁依赖谁？

---

### 【第三张：Task Graph】

当前实现不是动态生成 Graph 文件，而是通过 Script 明确串联：

~~~text
root build
protocol
   ↓
sdk
   ↓
platform

platform build
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
~~~

如果未来采用 Nx/Turbo，并声明：

~~~text
build depends on dependency build
~~~

则工具可以根据 Project Graph 生成更接近真实必要依赖的 Task Graph，例如：

~~~text
          protocol:build
          /      |      \
         ↓       ↓       ↓
     sdk:build database shared
                  \       /
                   ↓     ↓
                api / worker
~~~

回答：

> 任务应该先后或并行怎么执行？

---

### 【第四张：Runtime Graph】

~~~text
Browser
   ↓
Caddy
   ├── Static Web Files
   └── /api/* → API
                    │
          ┌─────────┼─────────┐
          ↓         ↓         ↓
     TimescaleDB   Redis    Outbox
                              ↓
                           Worker

Audit Task
    ↓
Audit Worker
    ↓
Chromium
~~~

回答：

> Build 完成以后真正有哪些 Service/Process 在运行？

四张图分别是：

~~~text
Workspace Discovery
≠
Project Dependency
≠
Task Execution
≠
Runtime Architecture
~~~

这四层分清以后，Monorepo 的结构才能真正建立起来。

---

## 14. Monorepo 的完整机制可以沿一条因果链复述

如果需要在面试或答辩中完整介绍 browser-monitor 的 Monorepo，可以沿下面的顺序回答，而不是按工具名平铺。

> browser-monitor 把 SDK、Protocol、Platform Apps 和内部 Packages 放在同一个代码仓库中。Monorepo 本身只定义了仓库边界，真正让 pnpm 识别多个 Project 的是根 pnpm-workspace.yaml。
>
> pnpm 先按照 packages 路径模式发现 sdk、protocol、platform/apps/*、platform/packages/* 等目录，再读取这些目录的 package.json。package.json.name 给每个 Package 一个逻辑身份，但此时只是完成项目发现，还没有自动产生项目依赖。
>
> 项目之间真正的代码依赖来自消费者 package.json。例如 API 的 dependencies 明确声明了 @browser-monitor/database、@browser-monitor/protocol 和 @browser-monitor/shared。workspace:* 再进一步要求这些 Package 必须从当前 Workspace 解析，而不能静默使用 Registry 中的同名 Package。
>
> pnpm install 根据这些 Manifest 和 pnpm-lock.yaml 完成依赖解析、外部依赖安装以及内部 Workspace Package 的本地可解析关系。但是 Package 能被找到不代表已经 Build；像 Protocol 的 exports 指向 dist，因此仍然需要执行自己的 build 生成 dist。
>
> 这些 Package Dependency 共同形成 Project Graph。当前项目并没有用 Nx/Turborepo 根据 Project Graph 动态生成 Build Pipeline，而是在根 package.json 和 platform/package.json 中用 pnpm --filter 和 && 显式写出 Build、Typecheck、Test 的执行顺序。
>
> 如果后续接入 Nx 或 Turborepo，可以继续保留每个 Package 自己的 build Script，再定义“build 依赖 ^build”这样的 Task Rule。工具会把 Project Graph 和 Task Rule 组合成本次执行的 Task Graph，使没有相互依赖的任务并行，并进一步支持 Cache 和 Affected。
>
> Build 完成以后，不同 Project 又进入不同生命周期。API 通过 tsc 输出 Server JavaScript，再由 Node 长期运行；Web 通过 Vite 输出 HTML/JS/CSS，生产镜像只需要 Caddy 提供静态文件；Audit Worker 因为依赖 Lighthouse 和 Chromium，使用独立运行镜像。最后 Docker Compose 管理 TimescaleDB、Redis、Migration、API、Worker、Audit Worker 和 Web 的运行依赖。
>
> 所以这套 Monorepo 不能简单理解为“一个仓库多个包”。完整链路实际上是 Workspace Project Discovery → Dependency Declaration → Workspace Resolution → Installation/Linking → Project Graph → Task Graph → Build Artifact → Runtime/Deployment。

---

## 15. 后续深入应沿三条机制线继续，而不是增加名词

### 【pnpm 依赖安装机制】

下一层继续回答：

~~~text
Content-addressable Store 是什么
Hard Link 与 Symbolic Link 分别出现在哪里
pnpm node_modules 为什么不是 npm 的简单扁平结构
Hoisting 如何工作
Phantom Dependency 为什么会出现
pnpm-lock.yaml 记录了什么
Peer Dependency 如何影响依赖图
~~~

目标不是记住 pnpm “更快”，而是能解释：

> 一个 Workspace Package 从 dependency declaration 到 Node.js 真正能够 import，中间经历了什么。

---

### 【Task Runner 与增量构建机制】

继续回答：

~~~text
Project Graph 如何从代码和 Manifest 推导
Task Graph 何时生成
Topological Order 如何保证依赖任务先执行
哪些任务能够并行
Task Input/Output 如何定义
Local Cache / Remote Cache 如何命中
Affected 如何结合 Git Diff
~~~

目标是能解释：

> 为什么改一个 Protocol Package 后，有些 Task 必须重跑、有些可以跳过。

---

### 【Release 与 Deployment 机制】

继续回答：

~~~text
SemVer
workspace:* Publish 转换
Changesets
Package Release
Docker Image
CI/CD
Environment
Deployment
Rollback
~~~

目标是能解释：

> 一个 Monorepo 中的不同 Package 和 Application 为什么可以一起开发，却独立发布和部署。

---

## 16. 参考资料

1. pnpm，Release Notes：https://pnpm.io/blog?type=releases
2. pnpm，Workspace：https://pnpm.io/workspaces
3. pnpm，Package Manager / Workspace Support：https://pnpm.io/
4. pnpm，Filtering：https://pnpm.io/filtering
5. Nx，Explore Your Workspace / Project Graph / Task Graph：https://nx.dev/docs/features/explore-graph
6. Turborepo，Configuring Tasks：https://turborepo.com/docs/crafting-your-repository/configuring-tasks
7. Nx，Task Pipeline Configuration：https://nx.dev/docs/concepts/task-pipeline-configuration
8. Docker Docs，Control Startup and Shutdown Order in Compose：https://docs.docker.com/compose/how-tos/startup-order/
9. Nx，Affected：https://nx.dev/ci/features/affected
10. browser-monitor：browser-monitor/pnpm-workspace.yaml
11. browser-monitor：browser-monitor/package.json
12. browser-monitor：browser-monitor/sdk/package.json
13. browser-monitor：browser-monitor/protocol/package.json
14. browser-monitor：browser-monitor/platform/package.json
15. browser-monitor：browser-monitor/platform/apps/api/package.json
16. browser-monitor：browser-monitor/platform/apps/worker/package.json
17. browser-monitor：browser-monitor/platform/apps/audit-worker/package.json
18. browser-monitor：browser-monitor/platform/apps/web/package.json
19. browser-monitor：browser-monitor/platform/packages/database/package.json
20. browser-monitor：browser-monitor/platform/packages/shared/package.json
21. browser-monitor：browser-monitor/platform/infra/Dockerfile.backend
22. browser-monitor：browser-monitor/platform/infra/Dockerfile.web
23. browser-monitor：browser-monitor/platform/infra/Dockerfile.audit-worker
24. browser-monitor：browser-monitor/platform/infra/docker-compose.yml
25. browser-monitor：browser-monitor/platform/infra/Caddyfile
