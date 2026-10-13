# npm 发布知识点梳理：以 Browser Monitor SDK 为例

本文以 Browser Monitor SDK 的实际发布过程为例，逐步理解 npm 包的开发、分发和接入。知识讲解随实践展开：遇到一个问题，先说明为什么需要解决它，再结合项目理解相关概念和处理方式。涉及发布配置或兼容性问题时，直接给出必要的配置、关键源码和可复现的操作，说明它们与分发、安装及接入的关系。

## 发布背景

目前，其他业务项目通过 pnpm workspace 引用本地 SDK。例如，在业务项目的 package.json 中声明：

```json
{
  "dependencies": {
    "@cxdlogver/browser-monitor-sdk": "workspace:*"
  }
}
```

这种方式适合同一工作区内的开发和联调。业务项目依赖的是工作区中的本地 SDK；另一个独立项目如果没有这个工作区，就无法直接沿用这样的引用方式。

因此，这次实践要解决的问题是：让 SDK 通过公开 npm 分发，使独立项目能够安装指定版本，并获得可用的代码、类型声明和依赖，同时继续保留仓库内部的 workspace 开发方式。

本项目中，SDK 还依赖共享协议包 protocol，因此采用 SDK 和 protocol 两个包都公开发布的方式。接入范围包括现代前端项目，以及需要在服务端渲染过程中处理前后端执行边界的 SSR 项目。

## 一、准备 npm 发布身份

SDK 放在本地工作区时，业务项目通过本地文件关系获取它。准备公开分发之后，就需要明确这些包由哪个 npm 账号持有：谁可以首次创建它们，谁可以继续发布新版本。

npm 账号与 GitHub 账号分别注册。GitHub 管理源码仓库，npm 管理发布包及其维护权限。两边可以使用相同用户名，但这个名字不会自动同步。本项目 SDK 的 package.json 中 author 是 cxDlogver，这个字段只是作者信息，不能据此判断实际的 npm 发布账号。

因此，实践首先准备可用的 npm 账号。对于当前这两个公开包，可以先由自己的个人账号维护；账号确定后，再结合它的命名空间讨论包名。

如果没有 npm 账号，可以在 [npm 注册页面](https://www.npmjs.com/signup)创建。注册时需要填写用户名、邮箱和密码；用户名使用小写字母，可以包含数字和连字符。注册后还需要完成邮箱验证，才能发布包。[npm 官方账号说明](https://docs.npmjs.com/creating-a-new-npm-user-account/)

以本项目为例，沿用 GitHub 用户名 cxDlogver 注册 npm 时，需要按 npm 的规则填写为 cxdlogver。本项目注册并用于命令行认证的账号为 cxdlogver，包的归属以这个真实 npm 身份为依据。

这里容易混淆两个问题：某个用户名是否已被占用，以及当前电脑是否已经登录 npm。前者可以先查看对应的[公开用户主页](https://www.npmjs.com/~cxdlogver)，但用户名能否注册，以注册页面的校验结果为准。页面打不开、DNS 解析失败等网络问题，不能作为用户名不存在或可以注册的证据。

后者可以通过以下命令检查：

```bash
npm whoami --registry=https://registry.npmjs.org/
```

它查询的是当前登录身份，成功时会显示用户名。ENEEDAUTH 表示本机需要登录认证，不能据此判断 cxdlogver 是否存在，也不能通过在命令后面加一个用户名查询别人的账号。[npm whoami 官方说明](https://docs.npmjs.com/cli/v10/commands/npm-whoami/)

注册命令则需要结合 npm 版本理解。本机使用的 npm 10.9.0 仍有 npm adduser 入口，可以指定公开 npm registry：

```bash
npm adduser --registry=https://registry.npmjs.org/
```

npm 10 的默认认证方式是 web，通过浏览器完成流程。这个命令不能假定在所有版本中都可用：npm 12 已移除 npm adduser，改为在网站创建和管理账号，再通过 npm login 登录命令行。因此，本次实践采用官网注册，先完成账号创建和邮箱验证。[npm 10 adduser 说明](https://docs.npmjs.com/cli/v10/commands/npm-adduser/)；[npm 12 变更说明](https://github.com/npm/cli/blob/v12.0.0/CHANGELOG.md)

账号创建之后，还需要让本机命令行使用这个身份。官网登录状态保存在浏览器中，npm 命令行则使用自己的认证配置；因此，完成网页注册或已经登录官网，并不意味着本机的 npm 命令已经登录。

本项目通过以下命令登录公开 npm registry：

```bash
npm login --registry=https://registry.npmjs.org/ --auth-type=web
```

命令会提示通过浏览器完成认证。按照终端提示打开登录页面，使用刚注册的账号完成登录；如果页面提示验证邮箱，先完成验证，然后等待终端确认登录成功。这里显式指定 registry，是为了明确认证的目标服务。npmjs.com 是账号和包的网页入口，registry.npmjs.org 是命令行访问的公开包注册表地址。[npm login 官方说明](https://docs.npmjs.com/cli/v10/commands/npm-login/)

登录命令会保存认证配置到 .npmrc。默认情况下使用当前系统用户的配置文件，本机通过 npm config get userconfig 查询到的路径是 C:\Users\xiang\.npmrc。它与项目目录中的 .npmrc 是两个配置层级：前者适合保存个人认证信息，后者用于项目共享配置。[npm 配置文件说明](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc/)

登录后，再执行前面的 npm whoami 命令验证。本项目验证成功时输出：

```text
cxdlogver
```

这个输出确认命令行正在使用哪个发布身份。它解决的是“npm 是否识别当前账号”，目标包的发布权限还需要结合包的归属和命名空间理解。

登录之后，还需要理解发布时的二次认证。双因素认证（2FA）是在账号密码之外，再用绑定的验证设备确认操作人。当前 npm 直接发布包要求账号启用 2FA，或者使用允许 bypass 2FA 的 granular access token。对于本项目的手动发布，采用官网启用 2FA、发布时按提示认证的方式。[npm 发布认证要求](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/#direct-publishing)

因此，npm whoami 能返回 cxdlogver，只能说明登录身份有效，不能保证发布请求通过二次认证。可以在终端查看账号信息：

```powershell
npm profile get --json --registry=https://registry.npmjs.org/
```

关注输出中的 tfa 字段。例如，下面只节选本项目账号在启用前的这一项，省略其他个人信息：

```json
{
  "tfa": false
}
```

false 表示当前未启用 2FA。这里查看的是 npm 账号设置，不是本地 package.json；在发布配置中添加 access: public 或修改版本号，都不会开启账号的二次认证。

启用的位置在 npm 官网，操作如下：

1. 打开 [npm 官网](https://www.npmjs.com/)，登录发布账号。
2. 点击右上角头像，选择 Account。
3. 在 Two-Factor Authentication 区域点击 Enable 2FA，按提示确认账号密码。
4. 按页面提示添加验证设备或 security key，并完成浏览器、系统的身份验证。官方支持 Windows Hello 等 WebAuthn 设备；具体可选方式以当前页面和设备为准。
5. 自行保存页面提供的恢复码，完成设置并返回账号页面。

security key 需要在网页中配置，绑定设备时的密码、PIN 或生物识别由账号持有人完成。以后命令行请求二次认证时，也要按终端给出的认证流程操作。恢复码用于验证设备不可用时恢复账号。[npm 2FA 配置说明](https://docs.npmjs.com/configuring-two-factor-authentication/)

启用后，用同一条 npm profile get --json 命令复查。tfa 不再是 false，而会包含认证模式。例如，本项目启用后的相关字段节选为：

```json
{
  "tfa": {
    "mode": "auth-and-writes"
  }
}
```

auth-and-writes 表示登录和写入操作使用二次认证；发布包属于写入操作。账号启用 2FA，与确认某一次发布是两个动作，所以启用成功之后，发布命令仍可能要求浏览器验证。

## 二、理解包名与发布归属

确定账号之后，需要给独立项目一个稳定的安装名称。npm 根据 package.json 的 name 字段识别包；本地目录名、GitHub 仓库名和 npm 包名可以不同。例如，SDK 位于 sdk 目录，改名前的 name 是 cx-browser-monitor-sdk，改名后是 @cxdlogver/browser-monitor-sdk，安装时使用的是包名。

npm 包名有不带 scope 和带 scope 两种形式。cx-browser-monitor-sdk 没有 scope，名称位于整个 npm 的公共命名空间中；@cxdlogver/browser-monitor-sdk 则由 scope cxdlogver 和包名 browser-monitor-sdk 组成，完整名称共同标识一个包。不同 scope 下可以存在相同的包名。

注册 npm 个人账号时，会获得与用户名对应的 scope。因此，cxdlogver 账号可以使用 @cxdlogver 命名空间维护相关包，不需要为这个个人 scope 再创建组织。scope 也可以属于 npm 组织，使用组织 scope 时需要对应的维护权限。[npm scope 官方说明](https://docs.npmjs.com/about-scopes/)

这也解释了本项目为什么不能直接把本地包名视为已经具备发布权限：protocol 改名前叫 @browser-monitor/protocol，workspace 能通过本地文件关系找到它；真正向公开 npm 发布时，@browser-monitor 必须是有权使用的用户或组织命名空间。仅在 package.json 中写下这个前缀，不会自动获得它的归属。

本项目将两个包统一放在个人 scope 下，完整名称如下：

| 包       | 改名前                    | 改名后                              |
| -------- | ------------------------- | ----------------------------------- |
| SDK      | cx-browser-monitor-sdk    | @cxdlogver/browser-monitor-sdk      |
| protocol | @browser-monitor/protocol | @cxdlogver/browser-monitor-protocol |

这组名称把账号归属和项目用途表达在完整包名中，也让两个相关包的归属保持一致。SDK 不带 scope 也能公开分发；这里使用个人 scope，是为了统一管理项目相关的包。

选定名称之前，可以向目标 registry 查询是否已有可访问的包。例如：

```bash
npm view @cxdlogver/browser-monitor-sdk name version --registry=https://registry.npmjs.org/
npm view @cxdlogver/browser-monitor-protocol name version --registry=https://registry.npmjs.org/
```

这两个名称在首次发布前的查询均返回 E404，表示请求没有找到可访问的包。它是包名检查的一项依据，最终能否首次发布仍由 registry 的权限和命名规则决定。ENOTFOUND 则表示网络无法解析域名，不能解释为包名未被占用。

scope 与公开、私有是两个不同概念。带 @cxdlogver 前缀的包可以公开发布，其他项目安装公开包时不需要成为该 scope 的成员。本项目要求两个包都公开，因此正式发布时需要明确设置 public 访问级别。[公开 scoped 包说明](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)

包名确定后，它会同时出现在安装命令、业务代码的 import、SDK 对 protocol 的依赖，以及仓库内部的 workspace 引用中。因此，改名需要同步这些引用，才能继续保持本地开发和公开安装的一致性。

以 SDK 对 protocol 的依赖为例，改名后的 sdk/package.json 保留本地开发方式：

```json
{
  "name": "@cxdlogver/browser-monitor-sdk",
  "dependencies": {
    "@cxdlogver/browser-monitor-protocol": "workspace:*"
  }
}
```

这是相关字段的节选。dependencies 的键必须对应 protocol/package.json 中的 name；workspace:\* 要求 pnpm 使用本工作区中的这个包。因此，即使两个新包还没有发布到 npm，本地开发也能继续，改名本身不要求先发布。[pnpm workspace 说明](https://pnpm.io/workspaces)

源码中的导入也使用新名称，子路径同样需要同步：

```ts
import { createMonitor } from "@cxdlogver/browser-monitor-sdk";
import type { TelemetryEventV3 } from "@cxdlogver/browser-monitor-protocol";
import { createBatchFixture } from "@cxdlogver/browser-monitor-protocol/fixtures";
```

本项目的同步范围还包括平台对 protocol 的依赖、根目录脚本的 pnpm --filter 名称，以及 sdk/tsup.config.ts 中的 noExternal。noExternal 用包名指定需要随 SDK 打包的依赖，遗漏它会使改名前后产生不同的打包结果。官网和走航车前端位于父级 workspace，也需要更新它们的依赖名称、业务导入和 TypeScript 类型引用。

protocol/src/constants.ts 中的 SDK_NAME 用于上报数据中的运行库名称，本项目也将它同步为 @cxdlogver/browser-monitor-sdk。因此，测试夹具和上报示例中的 sdk.name 同样使用新名称，便于从数据中识别对应的 SDK。

pnpm-workspace.yaml 中的 sdk、protocol 等条目描述目录位置，包改名后目录仍可沿用。pnpm-lock.yaml 则记录依赖名称和本地 link 关系；引用同步后，需要刷新 node_modules 中的 workspace 链接。锁文件更新与重新安装解决的是依赖解析，重新构建解决的是 dist 中仍然存在的旧导入和类型声明，二者作用不同。

可以通过新名称选中包并检查类型和构建：

```bash
pnpm --filter @cxdlogver/browser-monitor-protocol typecheck
pnpm --filter @cxdlogver/browser-monitor-protocol build
pnpm --filter @cxdlogver/browser-monitor-sdk typecheck
pnpm --filter @cxdlogver/browser-monitor-sdk build
```

protocol 先构建，是因为 SDK 的类型检查和构建需要读取它导出的声明文件。改名验证还要检查业务项目能否解析新入口，以及生成的 SDK 声明是否引用新 protocol 名称；这些检查针对名称和依赖关系，并不代表 npm 包已经发布。

## 三、从工作区代码到可安装的 npm 包

包名与引用关系确定后，接下来要解决的是“独立项目实际会拿到什么”。workspace 联调时，包目录、源代码和构建工具都在本机；独立项目安装 npm 包时，拿到的是打包后的一组文件。因此，本地业务能运行，还需要进一步验证安装包是否包含完整的代码、类型和说明。

先把构建、打包和发布三个动作联系起来理解：

| 动作    | 本项目中的作用                                     | 结果                               |
| ------- | -------------------------------------------------- | ---------------------------------- |
| build   | 用 tsup 将 TypeScript 源码转换为分发代码与类型声明 | 包目录中的 dist 文件               |
| pack    | 按包配置收集文件，并处理 workspace 依赖声明        | 本地 .tgz 安装包                   |
| publish | 将包及其版本提交到目标 registry                    | 独立项目可以从 registry 安装的版本 |

执行 build 后，dist 只存在于本地。执行 pack 后，可以提前查看和安装 .tgz，但 npm 上仍然没有这个版本。这个区分让我们可以在正式发布前，先验证独立项目的安装体验。[pnpm pack 说明](https://pnpm.io/10.x/cli/pack)

本项目的 SDK 生成三类主要文件：dist/index.js 是 ESM 代码入口，dist/index.d.ts 是 TypeScript 声明，dist/index.global.js 是浏览器全局脚本入口，提供 CXMonitorSDK.createMonitor。protocol 生成 root、constants、fixtures 三个 ESM 入口及对应声明；它的声明还会引用 dist 内的共享 schemas 声明文件。Source Map 也随当前 dist 配置进入安装包，用于定位构建前的代码。

这些文件的职责不同：JavaScript 用于实际执行，声明文件用于编辑器提示和 TypeScript 检查，Source Map 用于调试。只生成 JavaScript，可能让 JS 项目正常运行，却使 TS 项目无法获取公开类型；只生成声明文件，也不能提供可运行的 SDK。

生成文件以后，需要告诉安装方从哪里加载。以下是 SDK 现有入口配置的节选：

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  }
}
```

业务代码写 import { createMonitor } from '@cxdlogver/browser-monitor-sdk' 时，包入口将它映射到 dist/index.js；TypeScript 则根据 types 条件获取 dist/index.d.ts。protocol 的 ./constants 和 ./fixtures 也通过 exports 映射到各自文件。因此，检查入口既要确认路径配置正确，也要确认对应文件确实进入安装包。exports 定义的是公开导入路径，不能仅凭某个文件存在，就假设任意内部路径都是可用的公共 API。[npm 包入口配置说明](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#exports)

文件是否进入安装包，由 files 等打包规则控制。本项目用白名单明确分发范围。例如，protocol 的配置是：

```json
{
  "files": ["dist", "README.md", "LICENSE"]
}
```

SDK 的白名单还包含 CHANGELOG.md、THIRD_PARTY_NOTICES.md 和 LICENSES。package.json、README、LICENSE 属于 npm 特殊处理的文件；即使没有逐项写进 files，已有的这些文件通常也会被包含，但配置不会凭空生成缺失文件。本次检查发现 protocol 只有 license: MIT 元数据，却没有 LICENSE 文件，因此补入了与项目许可一致的正文。仓库的 .gitignore 忽略 dist，也不意味着 dist 无法分发；实际打包已确认 files 中的 dist 会进入这两个包。[npm 文件收集规则](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#files)

白名单也影响 README 的写法。SDK 原先引用包目录之外的平台说明和未被打包的 docs，安装后这些相对链接没有对应文件。因此，包内说明保留指向 LICENSE、第三方声明等已分发文件的相对链接，仓库中的扩展说明改用 GitHub 地址。SDK 的描述和 CHANGELOG 也与当前 createMonitor、性能指标、页面、自定义事件及 Trace/Span API 保持一致，方便接入者判断实际能力。

打包还会带入内联的第三方代码。本项目的 IIFE 内联 web-vitals，ESM 和 IIFE 都通过协议 Schema 内联 zod。因此，SDK 同时保留自身 LICENSE、第三方声明及两份上游许可证；protocol 则将 zod 声明为安装依赖。检查分发文件时，要结合实际构建结果确认这些说明完整，而不能只检查自己写的源码。

除了文件，还要检查安装包内的依赖声明。本地 sdk/package.json 中的 protocol 仍写 workspace:\*，而 pnpm pack 会将它改写为当前工作区包的版本。本次实际打开 SDK 的 .tgz，包内字段为：

```json
{
  "dependencies": {
    "web-vitals": "6.2.1",
    "@cxdlogver/browser-monitor-protocol": "3.0.0"
  }
}
```

这使安装方可以通过普通版本依赖获取 protocol，无须拥有原工作区。workspace:\* 在本地要求使用工作区包，在打包后转换为精确版本；它与 workspace:^ 转换成兼容版本范围的行为不同。[pnpm workspace 发布说明](https://pnpm.io/10.x/workspaces#publishing-workspace-packages)

dependencies 是接入项目需要安装的依赖，devDependencies 中的 tsup、TypeScript、Vitest 等是维护这个包时使用的工具，业务项目安装 SDK 不会连带安装 SDK 的开发依赖。SDK 虽然内联了部分 protocol 代码，其公开声明仍引用 protocol 类型，因此不能仅凭 JavaScript 已经打包，就删除这个依赖。protocol 的运行时代码还需要 zod，SDK 的 ESM 入口还需要 web-vitals。

为了避免忘记构建而把旧 dist 打入包，本项目为两个包添加了自动脚本：

```json
{
  "scripts": {
    "build": "tsup",
    "prepack": "pnpm build",
    "prepublishOnly": "pnpm check"
  }
}
```

这是脚本节选，check 的具体内容在两个包中不同。SDK 检查格式、Lint、类型、测试、构建和 publint；protocol 检查类型、测试和构建。对包目录执行打包时，prepack 自动构建；执行发布时，prepublishOnly 先运行发布检查，再进入包含 prepack 的打包流程。这些脚本服务于维护者的打包和发布过程，接入方安装已经分发的包，不需要自行执行 pnpm build。SDK 构建前仍需要先准备 protocol 的 dist，prepack 本身不会替我们构建整个工作区。[npm 生命周期脚本说明](https://docs.npmjs.com/cli/v10/using-npm/scripts/)

公开发布的目标也写入两个包自己的配置：

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

这里将前面确定的公开 scoped 包方案落到发布配置中。仓库根目录的 private: true 用于防止根项目被发布，SDK 和 protocol 的发布设置分别检查。SDK 还保留开发用的 packageManager: pnpm@10.28.2，并移除了 engines.pnpm；发布包的开发工具版本与接入项目使用哪个包管理器是两个不同的问题。SDK 当前仍声明 engines.node >=20，用于表达 Node 环境要求。

配置完成后，从 browser-monitor 根目录先生成本地安装包。本次使用 pnpm 10.28.2，命令中的输出目录按当前项目位置填写：

```bash
pnpm --filter @cxdlogver/browser-monitor-protocol pack --pack-destination F:/CX_notes/cx-learn-notes/browser-monitor/artifacts/npm --json
pnpm --filter @cxdlogver/browser-monitor-sdk pack --pack-destination F:/CX_notes/cx-learn-notes/browser-monitor/artifacts/npm --json
```

protocol 在前，SDK 在后，保证 SDK 构建时可以读取协议产物。--pack-destination 指定输出目录，--json 输出文件清单。若只想预览而不生成 .tgz，可以使用 pack --dry-run；这个选项从 pnpm 10.26.0 起可用，仍会执行相应的打包前流程。[pnpm pack 参数说明](https://pnpm.io/10.x/cli/pack)

本项目得到的安装包内容如下：

| 安装包                                       | 文件数 | 主要内容                                                                           |
| -------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| cxdlogver-browser-monitor-protocol-3.0.0.tgz | 13     | 三个代码入口、对应声明与共享声明、Source Map、README、LICENSE、package.json        |
| cxdlogver-browser-monitor-sdk-0.3.0.tgz      | 12     | ESM、IIFE、类型声明、Source Map、README、CHANGELOG、自身及第三方许可、package.json |

生成安装包以后，如何知道它真的可以被别人安装？可以把自己当作接入方：不使用仓库已有的 workspace 链接，准备一个只有这两个安装包依赖的测试项目，再分别检查代码加载、类型解析和公开入口。下面使用本项目的包名与路径说明完整过程；命令在 Windows PowerShell 中执行，pnpm 版本为 10.28.2。

先进入 browser-monitor 根目录，直接查看压缩包，而不是只看 sdk/package.json：

```powershell
Set-Location 'F:\CX_notes\cx-learn-notes\browser-monitor'

tar -tf artifacts/npm/cxdlogver-browser-monitor-sdk-0.3.0.tgz
tar -tf artifacts/npm/cxdlogver-browser-monitor-protocol-3.0.0.tgz
tar -xOf artifacts/npm/cxdlogver-browser-monitor-sdk-0.3.0.tgz package/package.json
```

tar -tf 列出包内文件，tar -xOf 将指定文件内容输出到终端，不需要先解压到项目目录。包内路径以 package/ 开头。例如，SDK 的清单中应看到 package/dist/index.js、package/dist/index.d.ts、package/dist/index.global.js 和许可证文件；protocol 应包含三个入口的代码、声明以及共享 schemas 声明。它们分别对应前面 exports、types 和全局脚本配置指向的文件。

第三条命令输出的是“接入者拿到的 package.json”。重点查看 dependencies：protocol 已变成 3.0.0，而不是本地源文件中的 workspace:\*。本项目的清单也确认安装包没有携带 src、测试目录或 node_modules。这一步回答的是“打进去的文件和依赖是否正确”，还没有验证安装后的实际加载。

接着准备独立测试目录：

```powershell
New-Item -ItemType Directory -Path '.release-tools/consumer' -Force
```

在 .release-tools/consumer/package.json 中写入：

```json
{
  "name": "browser-monitor-tarball-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@cxdlogver/browser-monitor-sdk": "file:../../artifacts/npm/cxdlogver-browser-monitor-sdk-0.3.0.tgz",
    "@cxdlogver/browser-monitor-protocol": "file:../../artifacts/npm/cxdlogver-browser-monitor-protocol-3.0.0.tgz"
  },
  "pnpm": {
    "overrides": {
      "@cxdlogver/browser-monitor-protocol": "file:../../artifacts/npm/cxdlogver-browser-monitor-protocol-3.0.0.tgz"
    }
  }
}
```

这里的 file: 指向打好的 .tgz，路径从 consumer 目录计算，向上两层即可回到 browser-monitor。它与 file:../../sdk 引用源包目录不同：这次安装方只能使用压缩包内已收集的文件，因此能发现“仓库里存在，但发布包里遗漏”的文件。private: true 防止临时测试项目被发布；type: module 表明这个接入示例使用 ESM。

为什么已经写了两个本地依赖，还要配置 overrides？因为“测试项目直接依赖 protocol”与“SDK 自己依赖 protocol”是依赖图中的两条边。SDK 的安装包内保留的是普通版本 3.0.0；本地文件依赖并不会把 SDK 包内的声明改成 file: 路径。为了明确让整个测试依赖图中的 protocol 都解析到同一个本地安装包，我们在测试项目根配置覆盖规则：

```text
测试项目 → SDK 本地 tgz
测试项目 → protocol 本地 tgz
SDK → protocol 3.0.0 → 经 overrides 解析到 protocol 本地 tgz
```

这条规则解决了 protocol 尚未发布时的测试依赖来源问题；它只影响测试项目的解析，不会修改 SDK 的 .tgz。protocol 同时列在测试项目的 dependencies 中，是为了让测试代码能够直接导入它的三个入口。overrides 用于覆盖依赖图中的解析规则，需要定义在使用它的项目根；这里采用 pnpm 10.28.2 已验证可用的 package.json 写法。[pnpm overrides 说明](https://pnpm.io/10.x/settings#overrides)

现在执行安装。命令仍从 browser-monitor 根目录运行：

```powershell
pnpm --dir .release-tools/consumer install --ignore-workspace --offline --ignore-scripts
```

--dir 将安装位置切到 consumer；--ignore-workspace 使这个目录按独立项目处理，避免复用父级 workspace 中的包链接。--offline 使用本机已有的依赖缓存，本项目之前的安装已准备好 web-vitals 和 zod；--ignore-scripts 让验证直接使用已构建的分发文件，不执行安装脚本。

本次安装成功的关键输出为：

```text
Packages: +4

dependencies:
+ @cxdlogver/browser-monitor-protocol 3.0.0
+ @cxdlogver/browser-monitor-sdk 0.3.0

Done ... using pnpm v10.28.2
```

四个包分别是 SDK、protocol、web-vitals 和 zod。前两个来自本地 .tgz，后两个是它们需要的依赖。如果在另一台机器复现时缓存不足，离线安装会失败，可以移除 --offline 允许获取这些上游依赖；protocol 的来源仍由本地 overrides 确定。如果报错指向 protocol 的 registry 查询，则应先检查覆盖规则的包名和路径。[pnpm 安装参数说明](https://pnpm.io/10.x/cli/install)

安装成功只说明依赖已经落到 node_modules，接下来需要验证入口确实能加载。在 .release-tools/consumer/smoke.mjs 中写入：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createMonitor } from "@cxdlogver/browser-monitor-sdk";
import { telemetryBatchV3Schema } from "@cxdlogver/browser-monitor-protocol";
import { PROTOCOL_VERSION } from "@cxdlogver/browser-monitor-protocol/constants";
import { createBatchFixture } from "@cxdlogver/browser-monitor-protocol/fixtures";

assert.equal(typeof createMonitor, "function");
console.log("SDK ESM entry: PASS");

const batch = createBatchFixture();
assert.equal(batch.protocolVersion, PROTOCOL_VERSION);
telemetryBatchV3Schema.parse(batch);
console.log("Protocol root/constants/fixtures and Schema: PASS");

const sdkEntry = new URL(import.meta.resolve("@cxdlogver/browser-monitor-sdk"));
const bundlePath = new URL("./index.global.js", sdkEntry);
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(bundlePath, "utf8"), context);
assert.equal(typeof context.CXMonitorSDK.createMonitor, "function");
console.log("IIFE global factory: PASS");
```

执行这个文件：

```powershell
node .release-tools/consumer/smoke.mjs
```

第一处检查从安装包导入的 createMonitor 是否为函数，验证 SDK 的 ESM 入口。第二处实际使用 protocol 的 root、constants 和 fixtures 三个导入路径，并用 Schema 解析夹具数据，验证这些公开入口及其依赖能共同工作。最后通过已安装 SDK 的入口定位同目录的 index.global.js，在独立执行上下文中检查 CXMonitorSDK.createMonitor 全局工厂是否存在。

预期输出如下；任何导入错误、Schema 校验失败或断言失败，都会使命令报错，而不是继续显示所有 PASS：

```text
SDK ESM entry: PASS
Protocol root/constants/fixtures and Schema: PASS
IIFE global factory: PASS
```

这里导入 SDK，并未调用 createMonitor 或 start。IIFE 检查也只验证全局脚本可加载并暴露工厂，没有模拟完整浏览器。浏览器采集、网络上报，以及服务端调用 SDK 时的行为，是另外的运行行为验证；不能根据这三行输出就推断它们已经通过。

JavaScript 入口通过后，再验证 TypeScript。运行时代码与声明文件是两套入口，尤其 SDK 的声明还引用 protocol 类型，必须确认安装后的声明能够完整解析。在 .release-tools/consumer/types.ts 中写入：

```ts
import {
  createMonitor,
  type Monitor,
  type MonitorOptions,
} from "@cxdlogver/browser-monitor-sdk";
import {
  telemetryBatchV3Schema,
  type TelemetryBatchV3,
} from "@cxdlogver/browser-monitor-protocol";
import { PROTOCOL_VERSION } from "@cxdlogver/browser-monitor-protocol/constants";
import { createBatchFixture } from "@cxdlogver/browser-monitor-protocol/fixtures";

const factory: (options: MonitorOptions) => Monitor = createMonitor;
const batch: TelemetryBatchV3 = createBatchFixture();
const version: typeof PROTOCOL_VERSION = batch.protocolVersion;
telemetryBatchV3Schema.parse(batch);
void factory;
void version;
```

在 .release-tools/consumer/tsconfig.json 中写入：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": false,
    "types": [],
    "noEmit": true
  },
  "include": ["types.ts"]
}
```

这个示例明确检查工厂的参数和返回类型、协议数据类型与版本常量。NodeNext 按 Node ESM 的规则解析公开入口，DOM 提供浏览器相关类型；strict 启用严格检查，skipLibCheck: false 保留对声明文件的检查，避免跳过声明之间的问题。types: [] 关闭自动引入环境中的 @types 包，不影响显式 import 的 SDK 和 protocol 类型；noEmit 表示只检查、不生成代码。[TypeScript 声明检查选项](https://www.typescriptlang.org/tsconfig/skipLibCheck.html)

本项目直接使用 SDK 开发依赖中已有的 TypeScript 编译器运行它：

```powershell
node sdk/node_modules/typescript/bin/tsc --project .release-tools/consumer/tsconfig.json
$LASTEXITCODE
```

编译器来自仓库，但被检查的文件位于 consumer，包导入从 consumer 的安装结果解析；这与直接检查 sdk/src 是不同的。成功时 tsc 没有诊断输出，PowerShell 的 $LASTEXITCODE 为 0。缺少声明、导出的类型名称不匹配，或者声明引用的 protocol 无法解析时，这一步会给出相应错误。

最后，把“接入方验证”和“包自身检查”联系起来理解。从 browser-monitor 根目录还可以执行：

```powershell
pnpm --filter @cxdlogver/browser-monitor-sdk publint
pnpm --filter @cxdlogver/browser-monitor-protocol check
```

publint 检查包元数据和入口声明，本次输出 All good!；protocol 的 check 依次执行类型检查、5 个测试和构建，均已通过。它们各自验证包的配置或源码质量；前面的 consumer 验证则直接使用实际 .tgz。几类检查互相补充，能区分“配置写得正确”与“安装后实际能够解析”。

到这里，可以得到有具体依据的结论：当前两个安装包可在独立项目中安装，公开代码入口能够加载，TypeScript 声明能够解析。测试过程中没有改变两个源包的依赖方案；临时验证目录可以清理，artifacts/npm 中的 .tgz 保留供检查。正式发布后，还需要去掉这个测试覆盖，从公开 registry 安装验证；SDK 在 SSR 中何时可以调用、误在服务端调用时如何处理，也需要结合执行环境单独确认。

## 四、发布前验证接入环境

上一章回答了“独立项目能否安装这个包，找到代码和类型”。接下来要回答“安装后，接入方能否在我们承诺的环境中使用它”。这属于发布前的兼容性验证：验证结果会决定 README 应如何说明初始化位置，以及 SDK 是否需要提供环境保护。

npm 分发本身并不要求重新分析 SDK 的采集流程。本项目检查 SSR，是因为前面已选定现代前端和 SSR 两类接入场景；对于只承诺浏览器使用的包，检查范围可以相应缩小。这里需要验证的只是公开入口和运行环境之间的关系。

SSR 会在服务端生成页面，再由浏览器接管交互。共享模块可能在两端加载，因此浏览器 SDK 需要说明两个问题：服务端能否 import；createMonitor 和 start 应在何处调用。支持 SSR 应用接入，仍然是在浏览器中采集性能和交互数据。[Vue SSR 的平台 API 说明](https://vuejs.org/guide/scaling-up/ssr.html#access-to-platform-specific-apis)

三个动作需要分别检查，不能用导入成功代替后续验证：

| 动作          | 检查目的                                                 |
| ------------- | -------------------------------------------------------- |
| import        | 服务端加载导出时，是否报错或启动后台任务                 |
| createMonitor | 创建实例时，是否立即访问浏览器对象、启动定时器或发送请求 |
| start         | 如果接入方误在服务端启动，SDK 会如何处理                 |

这里的目标是确定接入约束，源码只用于解释检查结果。package.json 的 type: module 决定模块格式，engines.node 描述 Node 版本要求，它们都不会自动判断浏览器环境。

先看目前的启动条件。以下节选来自 [Monitor.start](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/src/core/monitor.ts:172) 和 [Lifecycle.canStart](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/src/core/lifecycle.ts:55)，省略其他成员：

```ts
class BrowserMonitor implements Monitor {
  start(): void {
    if (!this.lifecycle.canStart()) return;
    if (this.lifecycle.current === "created") {
      this.registry.install();
      this.lifecycle.markInstalled();
    }
    this.registry.start();
    this.lifecycle.markRunning();
  }
}

class Lifecycle {
  canStart(): boolean {
    return (
      this.state === "created" ||
      this.state === "installed" ||
      this.state === "stopped"
    );
  }
}
```

canStart 检查的是实例状态，允许新实例启动；这里没有判断 window 或 document 是否存在。所以，服务端调用 start 也会尝试启动注册的模块。

其中，[Transport.start](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/src/transport/flush/index.ts:69) 会启动发送调度：

```ts
class Transport implements MonitorModule {
  // 省略其他成员。
  start(): void {
    if (this.active) return;
    this.active = true;
    this.timer = setInterval(
      () => void this.flush(false),
      this.options.flushIntervalMs,
    );
  }
}
```

Node 也有 setInterval，因此这个方法可以在服务端创建周期任务。active 只用于避免重复启动。页面模块访问 document 时可能报错，但[模块注册表](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/src/core/module-registry.ts:71)会捕获单个模块的异常，继续执行；所以，外层 start 没有报错，并不能证明所有模块都没有启动。

同样，[HttpSender.send](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/src/transport/sender/index.ts:67) 的发送条件也没有限制浏览器环境。下面是方法内部的相关节选；body 在该方法前面生成，请求体构造和响应处理均省略：

```ts
if (typeof fetch !== "function") return { success: false, retryable: false };

try {
  const response = await fetch(this.options.dsn, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...this.options.headers,
    },
    body,
    keepalive: preferBeacon,
  });
  // 省略响应处理。
} catch {
  return { success: false, retryable: true };
}
```

本次使用的 Node v22.12.0 提供 fetch，所以“有 fetch”不能等同于“在浏览器中”。如果误启动后又记录事件、主动 flush，就可能尝试发送。[Node fetch 说明](https://nodejs.org/api/globals.html#fetch)

这些源码已足以提出要验证的假设：服务端导入可能正常，但启动后仍可能创建定时器和尝试发送。下面只通过公开 API 检查这个假设，无须展开内部的事件采集和处理流程。

测试不使用 jsdom，确保没有 window 和 document；用记录器替代 setInterval 和 fetch。这样能观察 SDK 的调用行为，同时不会创建真实周期任务，也不会向示例 DSN 发出请求。脚本读取上一章生成的 sdk/dist/index.js，用于检查运行环境；上一章的独立 .tgz 安装验证则检查分发文件和依赖，两者检查的对象不同。

先从 browser-monitor 根目录准备脚本目录：

```powershell
Set-Location 'F:\CX_notes\cx-learn-notes\browser-monitor'
New-Item -ItemType Directory -Path '.release-tools' -Force
```

在 .release-tools/ssr-probe.mjs 中写入：

```js
import assert from "node:assert/strict";

assert.equal(typeof window, "undefined");
assert.equal(typeof document, "undefined");

const original = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  fetch: globalThis.fetch,
};
const timers = new Set();
const requests = [];

globalThis.setInterval = (callback, delay) => {
  const handle = { callback, delay };
  timers.add(handle);
  return handle;
};
globalThis.clearInterval = (handle) => {
  timers.delete(handle);
};
globalThis.fetch = async (url, options) => {
  requests.push({ url, body: JSON.parse(options.body) });
  return { ok: true, status: 204 };
};

try {
  const { createMonitor } = await import("../sdk/dist/index.js");
  console.log(
    "import:",
    typeof createMonitor,
    "timers:",
    timers.size,
    "requests:",
    requests.length,
  );

  const monitor = createMonitor({
    app: { name: "ssr-probe", version: "1.0.0", environment: "test" },
    transport: {
      dsn: "https://monitor.example.test/api/v3/ingest/bm_pk_test/envelopes",
    },
  });
  console.log("create: OK, timers:", timers.size, "requests:", requests.length);
  console.log("capabilities:", JSON.stringify(monitor.getCapabilities()));

  try {
    monitor.start();
  } catch (error) {
    console.log("start error:", error.message);
  }
  console.log("after start, timers:", timers.size);

  monitor.track("ssr_probe", { attributes: { source: "server" } });
  await monitor.flush();
  console.log("after track/flush, intercepted requests:", requests.length);
  console.log("first event URL:", requests[0]?.body.events[0]?.context.url);

  try {
    monitor.destroy();
  } catch (error) {
    console.log("destroy error:", error.message);
  }
  console.log("after destroy, timers:", timers.size);
} finally {
  globalThis.setInterval = original.setInterval;
  globalThis.clearInterval = original.clearInterval;
  globalThis.fetch = original.fetch;
}
```

在根目录运行：

```powershell
node .release-tools/ssr-probe.mjs
```

这里的 sdk/dist/index.js 是上一章构建生成的入口。如果还没有 dist，应先构建 protocol，再构建 SDK。本次使用 Node v22.12.0 运行，以下输出对应当前尚未增加统一 SSR 防护的实现：

```text
import: function timers: 0 requests: 0
create: OK, timers: 0 requests: 0
capabilities: {"performance":{"LCP":false,"FCP":false,"INP":false,"CLS":false,"FPS":false,"LoAF":false}}
after start, timers: 1
after track/flush, intercepted requests: 1
first event URL: about:blank
after destroy, timers: 0
```

把输出与前面的检查目的对应起来：

| 动作          | 观察结果                                     | 对接入说明的影响                       |
| ------------- | -------------------------------------------- | -------------------------------------- |
| import        | 工厂导出存在，定时器与请求均为 0             | 当前构建入口可以在这个 Node 环境中加载 |
| createMonitor | 合法配置下创建成功，定时器与请求仍为 0       | 本次创建没有启动发送调度               |
| start         | 记录到 1 个定时器，外层没有报错              | 目前没有统一阻止服务端启动             |
| track + flush | 拦截到 1 次发送调用，事件 URL 为 about:blank | 服务端误调用仍可能生成并尝试发送事件   |
| destroy       | 定时器记录回到 0                             | 本次主动销毁清理了调度                 |

getCapabilities 返回的性能能力全部为 false，只说明这些浏览器指标不可用，没有关闭发送模块。本次请求被 fetch 替身拦截，输出证明的是尝试发送，并没有真实网络请求。

这项检查给出的接入要求是：真实采集应在客户端创建并启动。当前官网已将接入放在 official-network/app/plugins/monitor.client.ts 的插件回调中。主动调用 destroy 可以清理这个实例，但 SSR 中不能假定浏览器卸载钩子会执行。[Vue SSR 生命周期说明](https://vuejs.org/guide/scaling-up/ssr.html#component-lifecycle-hooks)

例如，下面的接入代码允许模块在服务端加载，但只在浏览器中创建、启动监控。示例 DSN 需要替换为平台提供的地址：

```ts
import { createMonitor } from "@cxdlogver/browser-monitor-sdk";

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const monitor = createMonitor({
    app: { name: "checkout-web", version: "1.0.0", environment: "production" },
    transport: {
      dsn: "https://monitor.example.com/api/v3/ingest/bm_pk_xxx/envelopes",
    },
  });
  monitor.start();
}
```

这段判断属于接入方代码。当前 SDK 不会自动替每个调用方执行同样的环境判断，所以 README 需要明确初始化位置。它也应在应用的客户端初始化入口执行一次，避免多次创建监控实例。

服务端可以加载 SDK、客户端负责实际初始化，就能够支持 SSR 应用接入。是否再为服务端误调用提供保护，是 SDK 公开 API 的额外设计选择，不是 npm 注册表要求的发布条件。发布前可以从三个方案中选择：

| 方案               | 接入方看到的行为                                                            | 取舍                                                     |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| 仅说明客户端初始化 | 保持当前实现，README 明确要求在浏览器创建并启动                             | 不增加运行逻辑；调用方仍须遵守初始化位置约定             |
| 空操作实例         | API 可调用，但不采集、不启动定时器、不发送；Trace/Span 的业务回调仍正常执行 | 共享初始化不会因监控中断渲染，但服务端监控调用不产生数据 |
| 创建时明确报错     | import 可用，createMonitor 提示只能在浏览器初始化                           | 容易发现调用位置错误，接入方需要处理该错误               |

本项目本次发布采用“仅说明客户端初始化”：服务端可以导入 SDK，由接入方保证在浏览器创建并启动。SDK README 的快速开始已标明浏览器执行环境，并增加了上面的 SSR 接入示例。README 会随 files 配置进入 npm 包，因此独立项目安装后也能看到这项要求。

这个方案保持现有运行行为，服务端误调用仍由接入方避免。将来如果增加空操作或报错保护，应补充 Node 环境的验证；现有 Vitest 配置使用 jsdom，不能代替这项检查。protocol 用于服务端 Schema 校验，它的使用范围独立于浏览器 SDK 的初始化限制。

本节要得到的是能够写进接入文档、并通过验证证明的环境约定。它让发布包的使用说明有依据；SDK 内部如何采集、加工和批量发送事件，不需要在 npm 发布教程中逐一展开。

## 五、从试运行到正式发布

发布前需要检查：将上传哪个包、哪个版本、哪些文件，以及上传到哪里。pnpm 提供的基本写法是：

```powershell
pnpm publish --dry-run
```

这里的命令是 pnpm publish，--dry-run 是它的选项，表示先执行发布准备、显示结果，最后不上传。它会运行检查和构建，因此本地 dist 可能更新。[pnpm dry-run 说明](https://pnpm.io/10.x/cli/publish#--dry-run)

要读懂这个命令，需要把三个位置联系起来：**待发布包的 package.json 保存配置，在该包目录的终端输入命令，同一个终端显示执行结果。** 下面以本项目的两个包为例说明。

**先定位配置文件：每个待发布的包都有自己的 package.json。**

本项目的文件位置如下：

| 文件                                                                                         | 用途                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [SDK 的 package.json](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/package.json)           | 定义 SDK 的名称、版本、入口、依赖和发布脚本             |
| [protocol 的 package.json](F:/CX_notes/cx-learn-notes/browser-monitor/protocol/package.json) | 定义协议包的名称、版本、入口、依赖和发布脚本            |
| [仓库根目录的 package.json](F:/CX_notes/cx-learn-notes/browser-monitor/package.json)         | 管理整个项目；它设置了 private: true，不作为 npm 包发布 |

publishConfig 和 scripts 是写在这两个包各自的 package.json 顶层的字段。下面是已有文件的相关内容节选；阅读时保留文件中的其他字段，修改时合并已有的 scripts，不要用节选覆盖整个文件。

SDK 的配置位于 F:\CX_notes\cx-learn-notes\browser-monitor\sdk\package.json：

```json
{
  "name": "@cxdlogver/browser-monitor-sdk",
  "version": "0.3.0",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "publint": "publint",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm publint",
    "prepublishOnly": "pnpm check",
    "prepack": "pnpm build"
  }
}
```

protocol 的配置位于 F:\CX_notes\cx-learn-notes\browser-monitor\protocol\package.json：

```json
{
  "name": "@cxdlogver/browser-monitor-protocol",
  "version": "3.0.0",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm test && pnpm build",
    "prepublishOnly": "pnpm check",
    "prepack": "pnpm build"
  }
}
```

先理解发布目标。publishConfig.access 为 public，表示公开访问；publishConfig.registry 是目标包注册表地址，本项目使用官方 npm。name 和 version 则决定发布的包名与版本，命令不会自动递增 version。[npm 发布说明](https://docs.npmjs.com/cli/v10/commands/npm-publish/#description)

再理解自动执行的脚本。scripts.check 是项目自定义的脚本名，所以 pnpm check 会执行 check 对应的那串命令。prepublishOnly 和 prepack 则是发布工具识别的生命周期脚本：前者在发布准备阶段运行，后者在收集分发文件前运行。

例如，在 SDK 目录执行 pnpm publish --dry-run 时，工具发现 prepublishOnly 的值是 pnpm check，就会自动运行 SDK 的格式、Lint、类型、测试、构建和 publint 检查；随后发现 prepack 的值是 pnpm build，又运行 tsup 生成 dist。这里不需要手动再输入 prepublishOnly。当前 check 已包含 build，prepack 又包含 build，所以会出现两次构建。[pnpm 发布生命周期说明](https://pnpm.io/10.x/cli/publish#life-cycle-scripts)

**再执行命令：打开 PowerShell 终端，进入待发布的包目录。**

下面的命令使用本项目的 pnpm 10.28.2 和 npm 10.9.0。以 protocol 为例，先输入 Set-Location 切换目录，再输入发布试运行命令。这两行都是你需要在终端执行的命令：

```powershell
Set-Location 'F:\CX_notes\cx-learn-notes\browser-monitor\protocol'
pnpm publish --dry-run --no-git-checks --access public --tag latest --registry=https://registry.npmjs.org/ --json
```

PowerShell 的提示符应显示当前位于 protocol 目录，例如 PS F:\CX_notes\cx-learn-notes\browser-monitor\protocol>。pnpm 根据这个目录找到 protocol/package.json，知道要处理的是协议包。

protocol 完成后，再切换到 SDK 目录执行相同的试运行：

```powershell
Set-Location 'F:\CX_notes\cx-learn-notes\browser-monitor\sdk'
pnpm publish --dry-run --no-git-checks --access public --tag latest --registry=https://registry.npmjs.org/ --json
```

此时读取的是 sdk/package.json。先 protocol、再 SDK，是因为 SDK 的类型检查需要协议包生成的声明。进入根目录直接执行发布命令，会选到根目录的包；不能通过只修改 SDK 配置来改变当前目录。

先前给出的 pnpm publish --dry-run 是基本写法。上面完整命令的其余参数，是为本项目明确发布目标和便于检查输出而添加的：

| 参数            | 含义                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| --dry-run       | 只执行发布准备，最后不上传                                                   |
| --no-git-checks | 跳过 pnpm 的分支、未提交改动和远端同步检查；本项目试运行时仍有发布准备的改动 |
| --access public | 再次明确公开访问，与 package.json 中的发布配置保持一致                       |
| --tag latest    | 指定版本标签；latest 是默认标签，表示不指定版本安装时通常选择的版本          |
| --registry=...  | 再次明确官方 npm 地址，与 package.json 中的发布配置保持一致                  |
| --json          | 在末尾输出结构化的包信息和文件清单                                           |

--no-git-checks 只跳过 Git 状态检查，prepublishOnly 中的质量检查仍会执行。它不是 dry-run 的必需参数，也没有更改仓库的全局配置。latest 是指向版本的标签，不是版本号；试运行不会在 registry 创建或更新它。[pnpm 发布参数说明](https://pnpm.io/10.x/cli/publish)

**最后阅读输出：结果就在输入命令的同一个终端中。**

按回车运行命令后，终端会在命令下方陆续显示脚本名称、测试结果、构建结果和包信息。下面使用 SDK 的实际输出节选讲解这些内容；路径和中间构建明细已省略。它们是命令输出，你不需要复制回终端执行。

首先会看到生命周期脚本被调用：

```text
> @cxdlogver/browser-monitor-sdk@0.3.0 prepublishOnly
> pnpm check
```

这两行说明 pnpm 已读到 SDK 的配置，并开始自动执行 prepublishOnly。接着会显示 check 中各个脚本的输出。测试完成时，例如：

```text
Test Files  8 passed (8)
     Tests  26 passed (26)
```

它表示测试阶段有 8 个测试文件、26 个测试通过，只能说明这个检查阶段的结果。publint 完成时的 All good! 则表示发布包检查通过。出现错误时，先处理对应脚本的错误，不能只看后面有没有包信息。

进入打包前阶段时，会看到：

```text
> @cxdlogver/browser-monitor-sdk@0.3.0 prepack
> pnpm build
```

它对应 sdk/package.json 中的 prepack 配置，下面的 tsup 输出说明 dist 正在重新生成。构建后，终端显示发布目标：

```text
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)
```

阅读这行时，要同时检查 registry 地址、latest 标签、public 访问级别和最后的 dry-run。Publishing 描述的是预期目标；因为启用了 dry-run，这里并未上传。

--json 使末尾进一步输出包信息。下面从 SDK 实际输出中选取字段，files 每项只保留 path，方便对照文件；原输出还包含文件大小、权限、摘要等字段：

```json
{
  "id": "@cxdlogver/browser-monitor-sdk@0.3.0",
  "name": "@cxdlogver/browser-monitor-sdk",
  "version": "0.3.0",
  "size": 321590,
  "unpackedSize": 1492184,
  "filename": "cxdlogver-browser-monitor-sdk-0.3.0.tgz",
  "files": [
    { "path": "CHANGELOG.md" },
    { "path": "LICENSE" },
    { "path": "LICENSES/web-vitals-LICENSE.txt" },
    { "path": "LICENSES/zod-LICENSE.txt" },
    { "path": "README.md" },
    { "path": "THIRD_PARTY_NOTICES.md" },
    { "path": "dist/index.d.ts" },
    { "path": "dist/index.global.js" },
    { "path": "dist/index.global.js.map" },
    { "path": "dist/index.js" },
    { "path": "dist/index.js.map" },
    { "path": "package.json" }
  ],
  "entryCount": 12
}
```

这些数据用于回答发布前的几个具体问题：

| 要检查的问题               | 对应字段及判断方式                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| 发布的是哪个包、哪个版本？ | 对照 name、version、id 与 sdk/package.json，本例是 SDK 0.3.0                                  |
| 安装方能拿到代码和类型吗？ | 对照 package.json 的 exports、types 等入口与 files；本例包含 dist/index.js 和 dist/index.d.ts |
| 浏览器全局入口在包中吗？   | 检查 files 中的 dist/index.global.js                                                          |
| 使用说明和许可完整吗？     | 检查 README.md、LICENSE、THIRD_PARTY_NOTICES.md 和 LICENSES 下的文件                          |
| 需要下载多大的包？         | size 是压缩包字节数，本例约 314.1 KiB；unpackedSize 是解压后总字节数                          |

entryCount 是文件总数，本例的 12 与上面列出的 12 个文件对应。filename 是生成包的名称，看到它不表示文件已保存到 artifacts/npm；dry-run 也不会自动替换第三章保存的 .tgz。大小和文件数会随包内容改变，阅读自己的输出时应核对文件用途，而不是要求数字与示例相同。

protocol 的输出用同样的方法阅读：name 应为 @cxdlogver/browser-monitor-protocol，version 应为 3.0.0，files 应包含 root、constants、fixtures 的代码与声明，以及被声明文件引用的共享 schemas 声明。它与 SDK 是两个独立包，各自的 name、version 和文件清单分别来自各自配置。

本项目使用 pnpm 进行这一步，还因为 SDK 依赖中有 workspace:\*。pnpm 在准备分发包时，将它转换成 protocol 的具体版本 3.0.0；第三章已经通过 .tgz 中的 package.json 展示了这一转换。它让外部项目能按普通版本依赖安装协议包。[pnpm workspace 发布说明](https://pnpm.io/10.x/workspaces#publishing-workspace-packages)

如果终端出现 EUSAGE，表示命令用法需要检查。先阅读错误中的 Usage，再核对当前目录和参数；npm 调试日志中与 argv 有关的行会显示实际传入的参数。本文统一先用 Set-Location 进入包目录，再执行 pnpm publish，便于确认读取的配置文件，并避免把目录名误作为额外的包参数传入。

试运行结束时，没有脚本错误、发布目标正确、入口文件齐全、包名和版本符合预期，才能说明发布准备可继续。这个判断仍不代表账号已获准上传，也不代表其他项目已经能从 registry 安装。正式发布后，同一个包名与版本组合不能重复发布。[npm 版本规则](https://docs.npmjs.com/cli/v10/commands/npm-publish/#description)

**进入正式发布：以 protocol 为例，去掉试运行选项。**

SDK 的分发依赖指定 protocol 3.0.0，因此需要先让这个协议版本在 registry 中可获取。发布目标仍由 [protocol/package.json](F:/CX_notes/cx-learn-notes/browser-monitor/protocol/package.json) 中的 name、version 和 publishConfig 定义。

先在终端核对当前账号与远端版本：

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm view @cxdlogver/browser-monitor-protocol@3.0.0 name version --registry=https://registry.npmjs.org/ --json
```

第一条应返回我们确定的 cxdlogver 身份。第二条查询的是 registry，而不是本地文件；如果已有这个版本，就应先确认已有内容，不能重复覆盖。本项目首次发布前查询返回 E404，说明没有找到可访问的目标版本。网络解析失败与 E404 的含义不同。

确认包内容、版本和账号，并按第一章完成 2FA 设置后，进入协议包目录执行正式命令：

```powershell
Set-Location 'F:\CX_notes\cx-learn-notes\browser-monitor\protocol'
pnpm publish --no-git-checks --access public --tag latest --registry=https://registry.npmjs.org/ --json
```

与试运行相比，这条命令去掉了 --dry-run，所以检查和打包结束后会向 registry 提交发布请求。--no-git-checks 仍仅跳过 pnpm 的 Git 状态检查，适用于这里已有改动尚未提交的工作区；它不会跳过 npm 的账号认证。prepublishOnly 和 prepack 都仍会执行，终端中的目标提示也不再带 dry-run。

这里有一个需要读懂的失败示例：包的类型检查、测试和构建可以全部通过，但上传仍可能被拒绝。本项目账号尚未启用 2FA 时，终端返回以下关键信息：

```text
npm error code E403
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

E403 是 registry 对发布请求的拒绝。它后面的具体文字说明了这里需要二次认证；并不是每个 E403 都由相同原因引起，所以应阅读具体原因，再决定处理方式。此例可以通过账号信息中的 tfa: false 对照确认，处理位置是官网 Account 的 2FA 设置，不能靠再次构建、改包名或重复运行同一发布命令解决。

**发布中遇到浏览器认证：保留终端，完成这一次操作的验证。**

账号开启 2FA 后，发布过程可能在终端出现以下实际提示：

```text
Press ENTER to open in the browser...
```

此时检查和构建可以已经完成，命令仍在等待账号持有人验证本次发布。按回车后，工具会打开认证页面，并给出 Authenticate your account at 和本次页面的 URL；使用 --json 时，这些内容可能以 title、url 两个字段显示。应打开终端实际提供的网址，按网页及系统提示使用绑定的验证设备。

认证期间保留正在执行发布的终端。完成网页验证后，命令会继续处理上传结果；看到认证网页或按过回车，都不等于包已发布。若命令已结束或认证链接失效，先查询 registry，确认版本是否存在，再决定是否重新执行发布。

**确认上传结果：查询 registry，而不只看发布命令。**

认证完成后，发布命令可以返回退出码 0，并显示如下实际提示：

```text
npm notice Your package is being processed and may take a few minutes to become available.
```

这表示发布请求已被接受，服务端仍在处理，公开查询可能暂时返回 E404。此时应等待再查询，不能把它当成前面的认证失败，也不应立即重复发布相同版本。发布命令报告的包名和版本，用于核对提交对象；registry 查询则用于确认外部项目是否能获取该版本。

在 PowerShell 中执行以下命令，无须进入包目录，因为查询对象已经由完整包名和版本指定：

```powershell
npm view @cxdlogver/browser-monitor-protocol@3.0.0 name version dist-tags dist.shasum dist.tarball dependencies --registry=https://registry.npmjs.org/ --prefer-online --json
```

这里的 --prefer-online 会要求 npm 立即检查缓存数据是否有更新，适合确认刚发布的版本；它不会执行发布。参数含义见 [npm 官方配置说明](https://docs.npmjs.com/cli/v10/using-npm/config/#prefer-online)。

命令执行成功后，**同一个终端**返回以下实际结果：

```json
{
  "name": "@cxdlogver/browser-monitor-protocol",
  "version": "3.0.0",
  "dist-tags": {
    "latest": "3.0.0"
  },
  "dist.shasum": "a9a0cfad0c122fa9f3dcfe5090a47222cc2adb6d",
  "dist.tarball": "https://registry.npmjs.org/@cxdlogver/browser-monitor-protocol/-/browser-monitor-protocol-3.0.0.tgz",
  "dependencies": {
    "zod": "^3.24.2"
  }
}
```

这些字段来自远端 registry，不是本地 package.json。应按以下顺序阅读：

| 字段             | 判断什么                         | 本项目示例的含义                              |
| ---------------- | -------------------------------- | --------------------------------------------- |
| name、version    | 发布对象是否正确                 | 官方 registry 已能找到目标协议包的 3.0.0 版本 |
| dist-tags.latest | 默认安装选择哪个版本             | 不指定版本安装时，latest 指向 3.0.0           |
| dist.tarball     | 安装包从哪里下载                 | 地址指向官方 registry 中该版本的 .tgz 文件    |
| dist.shasum      | 远端记录的安装包是否与提交的一致 | 与发布输出的 shasum 对照，摘要相同            |
| dependencies     | 消费项目需要安装哪些运行依赖     | protocol 声明依赖 zod ^3.24.2                 |

其中，发布命令的实际输出包含以下字段；这里仅选取用于对照的部分：

```json
{
  "id": "@cxdlogver/browser-monitor-protocol@3.0.0",
  "shasum": "a9a0cfad0c122fa9f3dcfe5090a47222cc2adb6d"
}
```

两处摘要相同，说明远端元数据对应此次提交的安装包。结合正确的包名、版本和 latest 标签，可以确认 protocol 的正式发布已完成。也可以打开 [npm 上的 protocol 包页面](https://www.npmjs.com/package/@cxdlogver/browser-monitor-protocol)查看发布信息；独立安装和运行验证则用于进一步确认接入行为。

认证被拒绝且远端仍返回 E404 时，不能宣称版本已发布；请求被接受但服务端仍处理中时，也要等待 registry 可查询。SDK 安装需要 protocol 3.0.0，因此应等这个协议版本可获取，再继续 SDK 发布。独立安装验证使用这个远端版本，不再依靠本地 workspace 链接。

**把同一发布流程用于 SDK：先确认依赖，再提交 SDK 的版本。**

protocol 发布后，接入项目就有了 SDK 所需协议包的下载来源。SDK 是另一个 npm 包，必须单独发布；发布 protocol 不会自动上传 SDK，也不会把 SDK 的版本改成 3.0.0。

这次读取的配置文件是 [sdk/package.json](F:/CX_notes/cx-learn-notes/browser-monitor/sdk/package.json)。把名称、版本和依赖放在一起阅读，相关源码如下：

```json
{
  "name": "@cxdlogver/browser-monitor-sdk",
  "version": "0.3.0",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "dependencies": {
    "@cxdlogver/browser-monitor-protocol": "workspace:*",
    "web-vitals": "6.2.1"
  }
}
```

这是现有文件的节选。源配置中的 `workspace:*` 用于工作区开发，pnpm 在准备分发包时把它转换为 protocol 的 3.0.0 版本。SDK 自己的版本仍是 0.3.0，两个包的版本独立管理；这里不会修改源配置中的 `workspace:*`。

正式提交前，在 PowerShell 终端执行以下查询。查询命令不要求进入 SDK 目录：

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm view @cxdlogver/browser-monitor-protocol@3.0.0 name version --registry=https://registry.npmjs.org/ --prefer-online --json
npm view @cxdlogver/browser-monitor-sdk@0.3.0 name version --registry=https://registry.npmjs.org/ --prefer-online --json
```

同一个终端中，账号应返回 cxdlogver，依赖查询应能找到 protocol 3.0.0。首次发布这个 SDK 时，最后一条查询返回 E404，表示尚未找到可访问的目标版本；如果返回已有版本，就应核对已有内容，不能再次提交相同版本。这三条查询分别检查账号、依赖和发布对象。

然后切换到 SDK 目录执行正式发布。以下两行才是提交 SDK 的命令，第二行没有 --dry-run：

```powershell
Set-Location 'F:\CX_notes\cx-learn-notes\browser-monitor\sdk'
pnpm publish --no-git-checks --access public --tag latest --registry=https://registry.npmjs.org/ --json
```

pnpm 会读取 sdk/package.json，自动运行 SDK 的 prepublishOnly 检查和 prepack 构建，再向 npm 提交 @cxdlogver/browser-monitor-sdk@0.3.0。脚本输出、文件清单和认证提示都显示在这个终端。若 npm 要求浏览器认证，按前面的方式完成本次操作验证，并保留终端直到命令结束；认证页面链接以本次终端提供的地址为准。

阅读正式命令输出时，先判断自动检查是否通过。SDK 的测试部分实际输出如下，说明 8 个测试文件中的 26 个测试均通过：

```text
Test Files  8 passed (8)
     Tests  26 passed (26)
```

随后构建生成 ESM、IIFE 和声明文件，publint 输出 All good!；prepack 又执行一次构建。这些结果对应前面 sdk/package.json 的脚本配置。它们说明待分发的包通过了检查，但上传是否完成仍要看认证后的结果。

认证完成后，SDK 发布命令返回退出码 0。它仍会显示前面解释过的服务端处理中提示；下面选取末尾 JSON 中用于核对发布对象和安装包的实际字段：

```json
{
  "id": "@cxdlogver/browser-monitor-sdk@0.3.0",
  "name": "@cxdlogver/browser-monitor-sdk",
  "version": "0.3.0",
  "size": 321590,
  "unpackedSize": 1492184,
  "shasum": "bf84d998c2f3cc50248f856381b497f9c2190e09",
  "filename": "cxdlogver-browser-monitor-sdk-0.3.0.tgz",
  "entryCount": 12
}
```

这里的版本属于 SDK；文件数、大小和摘要属于这次提交的安装包。此次正式提交的文件清单与前面 SDK 试运行的 12 个文件对应，其中 README.md 为 11095 字节，包含浏览器初始化说明。末尾的包信息用于核对提交内容，不表示已经完成独立安装验证。

接着在同一个 PowerShell 终端查询 SDK 的远端元数据。查询不要求退出 SDK 目录：

```powershell
npm view @cxdlogver/browser-monitor-sdk@0.3.0 name version dist-tags dist.shasum dist.tarball dependencies --registry=https://registry.npmjs.org/ --prefer-online --json
```

除包名、版本、latest 标签和摘要外，这里还要阅读 dependencies。远端 SDK 应依赖 @cxdlogver/browser-monitor-protocol 的 3.0.0，而不能保留 `workspace:*`；web-vitals 则应为 6.2.1。这样才能确认外部项目安装 SDK 时，可从 registry 解析它所声明的运行依赖。若发布命令已成功、查询暂时返回 E404，应按前面的方式等待处理并再次查询，不要重复发布同一版本。

服务端处理完成后，上面的查询命令退出码为 0，**同一个终端**返回以下实际输出：

```json
{
  "name": "@cxdlogver/browser-monitor-sdk",
  "version": "0.3.0",
  "dist-tags": {
    "latest": "0.3.0"
  },
  "dist.shasum": "bf84d998c2f3cc50248f856381b497f9c2190e09",
  "dist.tarball": "https://registry.npmjs.org/@cxdlogver/browser-monitor-sdk/-/browser-monitor-sdk-0.3.0.tgz",
  "dependencies": {
    "web-vitals": "6.2.1",
    "@cxdlogver/browser-monitor-protocol": "3.0.0"
  }
}
```

name 和 version 确认官方 registry 已收录 SDK 0.3.0，latest 确认默认版本指向本次发布，dist.shasum 与前面发布输出中的 shasum 相同。dependencies 则确认 `workspace:*` 已转换为普通版本依赖。这些结果共同说明 SDK 的正式发布已完成；[SDK 的 npm 页面](https://www.npmjs.com/package/@cxdlogver/browser-monitor-sdk)也可用于查看包信息。

两个包都已发布后，外部项目可以通过包名请求安装，不再需要第三章的本地 .tgz 或 protocol overrides。接入项目只使用 SDK 时，可以在它自己的项目根目录执行：

```powershell
pnpm add @cxdlogver/browser-monitor-sdk@0.3.0
```

这条命令声明 SDK 为项目依赖，包管理器会同时解析 SDK 声明的 protocol 和 web-vitals，以及 protocol 所需的 zod；仅使用 SDK 时不必手工把所有传递依赖逐个加入项目。这里给出接入命令，下一步再用独立项目从 registry 实际安装，验证发布后的代码入口和类型声明。
