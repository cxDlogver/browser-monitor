# npm 与 pnpm 包发布源码学习

> **通用知识主入口**：[npm 与 pnpm 包发布工程体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/N-npm与pnpm包发布工程体系.md)。本文只记录 Browser Monitor 的真实 Workspace、构建、包契约、发布检查和待验证边界；通用机制在主入口中独立推导。
>
> **证据边界**：下述配置来自 `browser-monitor` 仓库当前 `package.json` 与 `tsup.config.ts`。静态文件可以确认构建目标、脚本和发布意图，但不等于 `pnpm check` / `pnpm pack` 已在本文撰写时执行，也不证明公共 npm Registry 上已存在对应版本、权限已配置、CI 自动发布已运行。任何发布命令均作为建议的受控验证步骤，不在本文写作中实际执行。

## 1. SDK 与 Protocol 分别定义独立的发布包契约

### 【Workspace 的包边界】

当前仓库根目录的 `pnpm-workspace.yaml`：

~~~yaml
packages:
  - sdk
  - protocol
  - platform
  - platform/apps/*
  - platform/packages/*
~~~

这里的发现规则说明 SDK、Protocol 与平台工程受同一个 pnpm Workspace 管理，却不意味着每个 Workspace Project 都应上传公共 npm。当前 SDK 和 Protocol 有面向公共 npm 的 `publishConfig`，部分平台/应用则主要用于服务端和 Web 部署。

源码入口：[pnpm-workspace.yaml](../pnpm-workspace.yaml)、[仓库 Monorepo 体系](./Monorepo知识体系.md#2-workspace-与-dependency-graph-建立多项目之间的代码关系)。

### 【Protocol 和 SDK 的身份与入口来自两个独立 manifest】

`protocol/package.json` 的关键字段：

~~~json
{
  "name": "@cxdlogver/browser-monitor-protocol",
  "version": "3.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./constants": { "types": "./dist/constants.d.ts", "import": "./dist/constants.js" },
    "./fixtures": { "types": "./dist/fixtures.d.ts", "import": "./dist/fixtures.js" }
  }
}
~~~

`sdk/package.json` 的关键字段：

~~~json
{
  "name": "@cxdlogver/browser-monitor-sdk",
  "version": "0.3.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "unpkg": "./dist/index.global.js",
  "jsdelivr": "./dist/index.global.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
~~~

协议包有三个公开导入入口（根、constants、fixtures）；SDK 的主要公开模块入口是根 `.`，并指向类型声明。`unpkg`、`jsdelivr` 表明它还为 CDN 全局构建声明了路径，但不意味着该字段具有与 Node `exports` 完全相同的解析规则。

两份源码中 `files` 都显式包含 `dist` 与 README/License 一类内容，SDK 额外包含 `CHANGELOG.md`、`THIRD_PARTY_NOTICES.md` 与 `LICENSES`。这些字段定义候选发布内容，真正上传的文件集合仍要通过 Pack 验证。两个包使用不同版本号只能证明 **Manifest 版本分离**，不能证明仓库已经拥有自动化的独立版本发布工作流。

源码：[sdk/package.json](../sdk/package.json)、[protocol/package.json](../protocol/package.json)。通用入口：[Package Manifest、exports 和 files 的分发契约](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/N-npm与pnpm包发布工程体系.md#1-package-manifest-决定对外发布的身份内容与消费契约)。

## 2. Workspace 内部依赖怎样变成注册表依赖

### 【本地开发的 SDK → Protocol 依赖】

当前 `sdk/package.json` 中实际声明：

~~~json
{
  "dependencies": {
    "@cxdlogver/browser-monitor-protocol": "workspace:*",
    "web-vitals": "6.2.1"
  }
}
~~~

内部 `workspace:*` 让本地 SDK 优先且明确地依赖当前 Workspace 的 Protocol 包，而不是恰好从远程 Registry 解析另一个同名协议包。`web-vitals` 是 SDK 的普通运行时依赖，不属于 Workspace 协议包。

`pnpm install` 将 Workspace 依赖转换成开发期可解析关系，但其作用止于本地依赖链接，并不会发布 Protocol，也不负责先运行其构建过程。协议源码如果变动，SDK 要能正确解析和引用协议产物，仍需依赖构建顺序或者构建任务编排。

### 【打包前后的依赖声明不是同一种形式】

在 pnpm 10.x 的工作区发布机制中，当 Protocol 当前版本是 `3.0.0` 时，打包 SDK 会把 `"@cxdlogver/browser-monitor-protocol": "workspace:*"` 转换为可公开分发的普通依赖声明，**预期 Tarball manifest** 对应：

~~~json
{
  "dependencies": {
    "@cxdlogver/browser-monitor-protocol": "3.0.0",
    "web-vitals": "6.2.1"
  }
}
~~~

注意这只是由已核验的版本与 pnpm 官方规则推出的**待验证打包结果**，并不是从真实 `.tgz` 解包取得的实测结果。pnpm 不会因为转换出 `3.0.0`，就自动保证 Registry 真的有 `@cxdlogver/browser-monitor-protocol@3.0.0`。如果不存在，外部消费者安装 SDK 就会在依赖解析阶段失败。

SDK 的 `tsup.config.ts` 另有 `noExternal: ['@cxdlogver/browser-monitor-protocol']`，说明构建配置要求将这个模块纳入 SDK 的 Bundle，而 manifest 仍声明其依赖。**构建打包到 JS 内与 Registry 安装依赖声明是不同层次**：前者决定输出 JavaScript 如何组织，后者决定消费者安装阶段请求哪些包。是否需要同时保留这两条路径及其打包体积影响，应结合目标构建产物和消费者测试评估，不能只据 `noExternal` 判断公开依赖已经不需要发布。

源码：[SDK 依赖声明](../sdk/package.json)、[SDK tsup 配置](../sdk/tsup.config.ts)。通用解释：[pnpm Workspace 在 Pack/Publish 时的依赖转换](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/N-npm与pnpm包发布工程体系.md#3-pnpm-workspace-需要把本地依赖转换为可分发依赖)。

## 3. 构建质量检查与发布顺序

### 【两个 tsup 构建配置产生的交付文件不同】

Protocol 的 `protocol/tsup.config.ts`：

~~~ts
export default defineConfig({
  entry: ['src/index.ts', 'src/constants.ts', 'src/fixtures.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
~~~

三个入口与 Protocol 的 `exports` 一一对应；构建意图是生成 ESM 入口和类型声明。真实文件名、构建完成状态应由运行结果确认。

SDK 的 `sdk/tsup.config.ts`：

~~~ts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'iife'],
  globalName: 'CXMonitorSDK',
  target: 'es2020',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ['@cxdlogver/browser-monitor-protocol'],
  outExtension({ format }) {
    return { js: format === 'iife' ? '.global.js' : '.js' };
  },
});
~~~

它希望同一份 SDK 源码产生 ESM、浏览器全局 IIFE 和类型声明。`sdk/README.md` 具体列出 `dist/index.js`、`dist/index.global.js`、`dist/index.d.ts` 及 Source Map。`format: ['esm','iife']` 不能直接解释为提供 CommonJS `require` 入口；当前 `exports` 也没有声明 `require` 分支。

### 【prepack 与 prepublishOnly 分别覆盖打包和发布检查】

当前 SDK 的真实脚本片段：

~~~json
{
  "scripts": {
    "build": "tsup",
    "publint": "publint",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm publint",
    "prepack": "pnpm build",
    "prepublishOnly": "pnpm check"
  }
}
~~~

Protocol 的相关片段：

~~~json
{
  "scripts": {
    "build": "tsup",
    "check": "pnpm typecheck && pnpm test && pnpm build",
    "prepack": "pnpm build",
    "prepublishOnly": "pnpm check"
  }
}
~~~

`prepack` 让正常 Pack/Publish 打包时重新构建；`prepublishOnly` 在 Publish 前执行完整检查。SDK 另外运行格式、Lint 与 Publint，Protocol 则更简化。需要特别注意，单独 `pnpm pack` 不会因为存在 `prepublishOnly` 就自动执行 SDK 的完整 `check`；发布前仍应明确运行验证或交给受控流水线。

根目录 `package.json` 当前含有显式依赖构建顺序：

~~~json
{
  "scripts": {
    "build": "pnpm --filter @cxdlogver/browser-monitor-protocol build && pnpm --filter @cxdlogver/browser-monitor-sdk build && pnpm --filter @browser-monitor/platform build",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  }
}
~~~

这证明了当前项目构建任务的先后顺序，不等于存在自动化的发布编排或 Registry 权限配置。可以据此安排 **Protocol → SDK** 的打包与发布核查顺序，避免 SDK 在公共 Registry 依赖了尚不可安装的协议版本。

源码：[仓库脚本](../package.json)、[SDK 包](../sdk/package.json)、[Protocol 包](../protocol/package.json)。通用解释：[Build、Pack、Lifecycle Script 与消费端验证](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/N-npm与pnpm包发布工程体系.md#2-build-和-pack-将源码转换为可审查的分发产物)。

## 4. 发布验收与当前源码未证实的能力

### 【先执行不产生 Registry 副作用的核查】

下列是建议验证流程，**没有在本次文档整理中实际运行**：

~~~bash
# 仓库根目录：对齐 pnpm 10.28.2 与锁文件后
pnpm install --frozen-lockfile
pnpm --filter @cxdlogver/browser-monitor-protocol check
pnpm --filter @cxdlogver/browser-monitor-sdk check

# 切换到 protocol/、sdk/ 各自目录进行打包预检
pnpm pack --dry-run
pnpm pack

# 查看现有远端版本（只读查询）
npm view @cxdlogver/browser-monitor-protocol versions --json
npm view @cxdlogver/browser-monitor-sdk versions --json
~~~

对于 SDK，还应在独立目录安装其 Tarball，检查入口导入、类型声明、Browser 环境与 SSR 边界，以及外部 Protocol 依赖是否真实可获得。打包成功只能证明包文件已生成，无法证明 npm 账号有发布权限或 Registry 已接收对应版本。

### 【可确认的实现与暂不确认的事情】

| 阶段 | 静态源码已能确认 | 仍需什么证据 |
| --- | --- | --- |
| Package Identity | SDK 0.3.0 / Protocol 3.0.0 独立声明 | Registry 实际已发布版本列表 |
| Build | tsup 配置与声明产物目录 | 本次实际构建日志及文件清单 |
| Pack | `files`、`prepack` 已设置 | 真实 Tarball 的 `package.json` 和文件内容 |
| Quality Gate | `prepublishOnly` 与 SDK `check` 已定义 | 实际运行通过记录、消费者 Smoke Test |
| Registry | `publishConfig.access=public` 与 npm 地址已写入 | 发布者权限、OIDC/Token 配置、发布记录 |
| Release Automation | 可验证根 `build` 顺序 | 独立发版流水线、Changesets、Tag/版本治理的执行证据 |

本次仓库路径中未发现 `.github/workflows` 的发布流水线目录，因此不能据这些源码宣称已建立 GitHub Actions 自动发布；其他 CI 平台或仓库外发布过程需要另查证。也不能仅凭 `sdk/README.md` 的 `pnpm add` 示例声称对应版本已在 npm 上架。

建议后续完善的工程闭环：记录 Manifest 版本和 Commit SHA → Pack 并检查依赖转换 → Protocol 先行确认 Registry 可用 → SDK 消费者隔离测试 → 受控 Publish（优先评估 OIDC）→ Registry 与真实安装二次验证 → 失败时查版本是否已被接收。安全和版本限制详见通用专题，不将建议写成当前已实现功能。

**通用知识回链**：[Registry Publish、版本标签与供应链安全](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/N-npm与pnpm包发布工程体系.md#4-registry-publish-将确定的版本与-tarball-交付给消费者)、[包发布失败与恢复](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/N-npm与pnpm包发布工程体系.md#6-发布失败撤回与升级恢复需要区分几类事故)。
