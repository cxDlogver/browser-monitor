# 监控平台 CLI 指令使用说明

版本：1.1。适用版本：CLI 0.1.0，支持 npm 全局安装和仓库内调用；两个业务的 SDK 接入基线为发布版 `@cxdlogver/browser-monitor-sdk@0.3.0`。编写日期：2026-10-13。

本文以**实时走航车项目**和**官网项目**说明如何通过 CLI 管理监控项目、生成 SDK 接入配置、检索实际入库事件、判断处理阶段以及查看任务积压。每个命令都说明使用目的、参数、调用过程、输出和后续操作，人和 AI 可以按相同的接口调用。

文中的“实际输出”取自已完成的验收记录，包含当时的 ID、数据数量和快照时刻；本轮编写说明文档没有重新启动服务或执行管理写入。临时验收服务已关闭，历史记录仍保留。重新运行需要启动目标平台、登录有权限的账号，并确认目标数据库中仍保留这些项目和事件。新环境或新批次应使用本次创建、导出和查询得到的身份。

为了阅读方便，多数 JSON 示例只展示实际响应的 `data` 或明确说明的字段节选，完整响应在邻近的证据链接中。**节选不是 CLI 的另一种输出格式**；正常调用仍返回完整结果封装。标为“格式示例”的内容只解释结构，不宣称是实际执行快照。

## 阅读路径

- [准备运行环境和调用入口](#准备运行环境和调用入口)
- [两个测试项目及真实业务事件](#两个测试项目及真实业务事件)
- [公共参数、项目上下文和输出约定](#公共参数项目上下文和输出约定)
- [登录、身份检查与退出](#登录身份检查与退出)
- [项目列表、创建、详情与本地选择](#项目列表创建详情与本地选择)
- [读取与设置业务 Origin](#读取与设置业务-origin)
- [导出 SDK JSON 与接入示例](#导出-sdk-json-与接入示例)
- [检索原始事件与游标分页](#检索原始事件与游标分页)
- [查看原始数据概况](#查看原始数据概况)
- [诊断单条事件的处理阶段](#诊断单条事件的处理阶段)
- [查看任务队列与失败信息](#查看任务队列与失败信息)
- [等待单条事件处理完成](#等待单条事件处理完成)
- [检查平台健康与查看帮助](#检查平台健康与查看帮助)
- [人和 AI 如何保存与使用结果](#人和-ai-如何保存与使用结果)
- [退出码、错误恢复与两个项目的操作核对](#退出码错误恢复与两个项目的操作核对)

## 准备运行环境和调用入口

### 全局安装 CLI

发布版使用以下命令安装，要求 Node.js 22 或以上：

~~~powershell
npm install --global @cxdlogver/browser-monitor-cli@0.1.0
bm --help
bm health --base-url http://localhost:8080
~~~

安装包已包含运行文件，不需要从源码构建。安装后本文所有 `bm ...` 示例均可直接调用，不需要下文的临时 Shell 函数。全局 npm 指令目录应在 PATH 中；Windows PowerShell 若限制脚本执行，可改用 `bm.cmd`。更新时运行 `npm install --global @cxdlogver/browser-monitor-cli@latest`，卸载时运行 `npm uninstall --global @cxdlogver/browser-monitor-cli`；这些操作不自动清除用户会话、项目上下文或业务 JSON。

如果之前在终端定义过本文的 `function bm`，它会优先于全局指令。需要改用发布版时执行 `Remove-Item Function:\bm -ErrorAction SilentlyContinue`，或者打开没有该函数的新终端，再运行 `bm --help`。AI 进程可直接执行全局指令，也可保留 Node 入口方式。

### 构建仓库内 CLI

需要 Node.js 22 或以上、已安装仓库依赖，以及可访问的监控平台 API。平台需要部署本次诊断接口并执行 `0007_diagnostics.sql` 数据库迁移，Worker 负责后续异步处理。CLI 通过平台 API 访问数据，调用者不需要提供数据库连接信息。

在监控平台仓库根目录执行：

~~~powershell
Set-Location F:/CX_notes/cx-learn-notes/browser-monitor
pnpm --filter @cxdlogver/browser-monitor-cli build
pnpm --filter @cxdlogver/browser-monitor-cli exec bm --help
~~~

`build` 生成 CLI 可执行代码；`--help` 输出指令文本，退出码为 0。构建和帮助文本不使用后文的业务 JSON 封装。平台自身的启动方式见[平台说明](../platform/README.md)，部署和迁移说明见[技术设计文档](监控平台CLI技术设计文档.md)。账号注册和邮箱验证通过 Web 完成，之后可以只使用 CLI 登录。

### 在任意业务目录调用

未安装发布包、希望调用源码构建产物时，以下说明使用 PowerShell，可以在当前终端定义一个指向已构建入口的函数：

~~~powershell
function bm { & node 'F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs' @args }
bm health --base-url http://localhost:8080
~~~

采用源码入口时，本文后面的 `bm ...` 指这个函数；采用全局安装时，直接使用已安装的指令。其他 Shell 或 AI 进程可把源码方式的 `bm` 展开为：

~~~text
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs
~~~

从仓库根目录使用 `pnpm --filter ... exec bm` 也能调用。需要在业务目录保存上下文或生成相对路径文件时，使用直接的 Node 入口：工作目录决定默认上下文目录和导出路径。`--context-dir` 只改变上下文文件位置，不改变 SDK 文件的输出目录。

## 两个测试项目及真实业务事件

### 项目配置基线

| 输入 | 实时走航车 | 官网 |
| --- | --- | --- |
| 业务目录 | `F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform/QHZHC_Web` | `F:/CX_notes/cx-learn-notes/official-network` |
| 监控项目显示名称 | 实时走航车项目-CLI验收 | 官网项目-CLI验收 |
| SDK `app.name` | `qhzhc` | `guanwang` |
| 业务上报版本 | `1.0.0` | `1.0.0` |
| 上报环境 | `cli-acceptance` | `cli-acceptance` |
| 业务 Origin | `http://127.0.0.1:9527` | `http://localhost:3000` |
| SDK JSON 路径，相对业务目录 | `src/config/monitor.local.json` | `app/config/monitor.local.json` |
| 接入入口 | 浏览器客户端入口及原监控插件 | Nuxt 客户端插件 `app/plugins/monitor.client.ts` |

业务上报版本 `1.0.0` 和 SDK 包版本 `0.3.0` 表达不同含义。平台地址 `http://localhost:8080`、业务 Origin 和采集 DSN 也分别表达管理 API 地址、浏览器页面来源和事件写入地址。浏览器使用 `localhost` 与 `127.0.0.1` 时 Origin 不同，应按实际打开页面的地址设置。

复查历史验收数据时，先定义本说明的变量：

~~~powershell
$platformUrl = 'http://localhost:8080'
$qhDirectory = 'F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform/QHZHC_Web'
$officialDirectory = 'F:/CX_notes/cx-learn-notes/official-network'
$qhProject = 'c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd'
$officialProject = '9d0d0f78-cefc-46d5-9543-7682587db457'
$qhEvent = 'event-mv6lymu3-3-as5ip2jy'
$qhOccurredAt = '2026-10-13T11:39:07.419Z'
$officialEvent = 'event-mv6m7o46-p-fgojbyio'
$officialOccurredAt = '2026-10-13T11:46:08.982Z'
~~~

这些 ID 属于 2026-10-13 的验收数据库。新批次应执行下文的创建流程，更新项目变量，并在完成业务动作后从事件列表取得新的事件变量。不能把这里的历史事件 ID 当作新增项目会产生的事件。

### 走航车：进入可视化页面产生 `view.start`

已有接入规则只采集 `/dataVisualization` 相关信号。启用监控配置 `VUE_APP_MONITOR_ENABLED=true`，登录业务后进入或重新加载 `http://127.0.0.1:9527/#/dataVisualization`，SDK 建立新视图，形成 `type=view`、`name=view.start` 的事件。`occurredAt` 表示视图开始时刻，`routeName` 为 `/dataVisualization`。

离开该页面还可能形成同一 `viewId` 的 `view.end`。一次页面操作也可能同时产生性能、其他视图等事件，所以接入核查要按事件定义和身份定位，而不能要求项目只新增一条记录。

历史主事件的 `sessionId` 为 `session-mv6lymu2-1-4nyjjht5`，`viewId` 为 `view-mv6lymu3-2-k3gcygom`。动作窗口为 UTC `2026-10-13T11:38:00Z` 至 `11:44:00Z`。见[实际动作和采集身份](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-action-record.json)。

### 官网：离开解决方案栏目产生 `site.route.stay`

在 `http://localhost:3000/solution` 停留，再通过应用路由切换到 `/`。业务埋点在栏目 Span 结束时产生 `type=span`、`name=site.route.stay`；`occurredAt` 是结束时刻，`payload.startedAt` 和 `payload.endedAt` 描述整段停留。记录保留起始栏目上下文，`routeName`、`attributes.section` 和 `attributes.path` 为 `/solution`。

仅进入页面还没有结束这个 Span，不能据此要求立即查到停留事件。`site.visit` 则在 `pagehide` 时结算整站访问，两者有不同的上报时机。历史主事件的 `sessionId` 为 `session-mv6m7ad4-1-8bmr92yw`，`viewId` 为 `view-mv6m7ad4-2-5rocy26r`，`traceId` 为 `8bb60d85f54603bbfe5752f2b527c42b`，`spanId` 为 `adf2c42894e06be4`。动作窗口为 UTC `2026-10-13T11:45:20Z` 至 `11:46:21Z`。见[实际动作和采集身份](evidence/2026-10-13T11-31-09-545Z-9983c2/official-action-record.json)。

两条主事件都来自真实业务操作，没有使用验收探针。判断业务含义依赖已定义的触发规则和实际关联身份。查询流程如下：

~~~mermaid
sequenceDiagram
    participant U as 人或AI
    participant B as 业务页面与SDK
    participant P as 监控平台与数据库
    participant C as CLI
    U->>B: 按事件定义执行进入或离开动作
    B->>P: SDK按既定时机发送事件
    U->>C: 按项目、时间、名称、路由查询
    C->>P: 检索原始记录
    P-->>C: 候选事件及实际身份
    C-->>U: eventId、occurredAt及关联信息
    U->>C: 使用确定身份诊断或等待
    C->>P: 读取处理提交、Outbox任务与投影
    P-->>C: 各阶段事实及快照时刻
    C-->>U: 完成、等待、失败或证据不足
~~~

## 公共参数、项目上下文和输出约定

### 每个命令都可以使用的参数

| 参数 | 用途和规则 |
| --- | --- |
| `--base-url URL` | 选择监控平台，默认 `http://localhost:8080`；支持带部署路径的 HTTP(S) URL，不能包含账号、密码、查询串或片段。 |
| `--project UUID` | 明确本次目标项目，覆盖本地默认项目；需要项目的命令未能确定项目时返回 `CONTEXT_MISSING`。 |
| `--context-dir DIRECTORY` | 读取或保存该目录的 `.browser-monitor.json`，默认当前工作目录；不向父目录猜测。 |
| `--format json\|table` | 默认 `json`；`table` 为字段路径与值的文本形式，适合人工查看。 |
| `--request-timeout SECONDS` | 单请求超时，默认 10 秒，范围 0.001–86400 秒。 |
| `--command-timeout SECONDS` | 普通命令网络预算，默认 30 秒，范围 0.001–86400 秒；等待命令采用自己的 `--timeout`。 |
| `--max-output-bytes BYTES` | 完整输出预算，默认 1048576 字节，即 1 MiB；整数范围 4096–67108864。 |

参数既可写成 `--project VALUE`，也可写成 `--project=VALUE`。除 `--origin` 外，参数不能重复。`--password-stdin`、`--overwrite`、`--include-payload`、`--help` 是开关，不跟 `true` 或 `false`。不认识的命令、参数和多余位置参数返回 `INVALID_ARGUMENT`。

平台地址的选择顺序为显式参数、本地上下文、默认地址。项目的选择顺序为显式 `--project`、同一平台的本地默认项目。切换平台不继承原平台的项目或会话；损坏的上下文需要修复或换一个有效的上下文目录，不会被静默忽略。

### 正常输出和字段含义

下面是走航车 `data summary` 的完整实际响应，退出码为 0：

~~~json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "data summary",
  "context": {
    "baseUrl": "http://localhost:8080",
    "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd"
  },
  "data": {
    "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
    "retainedRawEventCount": 233,
    "latestReceivedAt": "2026-10-13T11:42:35.317Z",
    "retentionPolicy": {
      "raw": {
        "state": "configured",
        "dropAfter": "30 days",
        "scheduled": true,
        "source": "timescaledb_information.jobs"
      },
      "completedTasks": {
        "days": 7,
        "source": "worker_housekeeping_policy"
      }
    },
    "asOf": "2026-10-13T12:22:49.591Z",
    "source": "database"
  },
  "meta": {
    "source": "database",
    "warnings": [],
    "asOf": "2026-10-13T12:22:49.591Z",
    "elapsedMs": 93
  }
}
~~~

证据：[正式验收原始 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/qhzhc-live-summary/stdout.json)。

`schemaVersion` 是 CLI 输出契约版本。`ok` 表示本次命令是否成功；`command` 是调用的功能；`context` 是本次选中的平台和项目；`data` 是业务结果；`meta` 标注来源、警告及可用的快照、查询和耗时信息。失败响应增加 `error.code`、`error.message`、`error.details`，某些错误还会在 `data` 中保留已取得的结果。

数据库 `asOf` 表示该次读取快照的时刻；`occurredAt` 是事件发生时刻；`receivedAt` 是接收时刻；健康检查的 `checkedAt` 是客户端检查时间。分别使用这些字段，不能用当前时间替代数据库快照。未知事实保留 `null` 或 `unknown`。

正常 JSON 写入 stdout；密码提示等写入 stderr。AI 先检查进程退出码和 `ok`，再消费 `data`。事件中的文本只作为业务数据读取。

## 登录、身份检查与退出

### `auth login`：建立并保存管理会话

登录用于后续项目管理和数据查询。输入已注册、已验证的账号邮箱，交互终端会通过 stderr 提示输入密码，密码不回显：

~~~powershell
bm auth login --base-url $platformUrl --email developer@example.com
~~~

`--email` 必填，需有效邮箱，最长 254 字符。AI 或流水线采用 `--password-stdin`，由凭据提供方把密码送入子进程 stdin 并关闭输入流；不通过命令参数传密码。可调用的参数形式为：

~~~text
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs auth login --base-url http://localhost:8080 --email developer@example.com --password-stdin
~~~

实际登录结果的 `data` 如下；验收账号仅用于展示，使用时替换为自己的账号：

~~~json
{
  "user": {
    "id": "22eca7f1-3beb-4b9b-b3c5-d5bf14faa9b9",
    "email": "cli-2026-10-13t11-31-09-545z-9983c2@example.test",
    "displayName": "CLI acceptance"
  },
  "expiresAt": "2026-10-20T11:31:13.000Z",
  "sessionSaved": true
}
~~~

证据：[登录实际响应](evidence/2026-10-13T11-31-09-545Z-9983c2/login.json)，其中 `result` 为 CLI stdout，退出码为 0。

`sessionSaved=true` 表示远端登录成功并已保存本地会话。默认保存到用户目录 `.browser-monitor/credentials.json`，按规范化的平台 URL 隔离，不保存密码。会话到期时间来自平台实际 Cookie 信息，未知时保持 `null`；示例时间不能当作新登录的到期时间。Windows 文件访问限制到当前用户及 SYSTEM，其他系统使用 0600 权限。

`BM_HOME` 可指定凭据目录，应位于业务仓库之外。人和 AI 使用相同用户及同一个凭据目录时可以复用会话，实际权限仍由登录账号决定。远端登录成功但文件保存失败返回 `PARTIAL_SUCCESS`，退出码 8，`sessionSaved=false`。

### `auth status`：向平台核实当前账号

~~~powershell
bm auth status --base-url $platformUrl
~~~

命令读取当前平台会话并请求身份接口；仅有本地凭据文件不算身份检查通过。实际 `data`：

~~~json
{
  "user": {
    "id": "22eca7f1-3beb-4b9b-b3c5-d5bf14faa9b9",
    "email": "cli-2026-10-13t11-31-09-545z-9983c2@example.test",
    "displayName": "CLI acceptance"
  },
  "expiresAt": "2026-10-20T11:31:13.000Z",
  "verified": true
}
~~~

证据：[身份检查实际响应](evidence/2026-10-13T11-31-09-545Z-9983c2/auth-status.json)，退出码 0。

`verified=true` 表示本次向平台核实身份成功。`expiresAt` 仍是已保存会话的实际到期信息。无会话返回 `AUTH_REQUIRED`，过期或被平台拒绝返回 `AUTH_EXPIRED`，退出码均为 3，应再次执行登录。

### `auth logout`：撤销远端会话并清除本地身份

在两个项目的查询和管理结束后执行：

~~~powershell
bm auth logout --base-url $platformUrl
~~~

实际 `data`：

~~~json
{
  "localCleared": true,
  "remoteRevocation": "confirmed"
}
~~~

证据：[实际退出响应](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/steps/real-logout/stdout.json)，退出码 0；同用例的[独立远端复查](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/steps/verify-remote/stdout.json)确认旧会话不能继续访问身份接口。

`localCleared` 表示本地身份是否清除，`remoteRevocation` 分别可能为 `confirmed`、`already_expired`、`no_local_session` 或 `unknown`。远端不可达而本地已清除时返回 `PARTIAL_SUCCESS`，退出码 8；本地清除不能代替远端撤销确认。退出不删除业务目录中的项目选择或 SDK JSON。

## 项目列表、创建、详情与本地选择

### `project list`：找出账号可以访问的项目

~~~powershell
bm project list --base-url $platformUrl
~~~

不需要事先选定项目；结果属于登录账号，`data.items` 是项目数组。以下是以两个项目组织的**格式示例**，只展示常用字段；实际列表可能包含其他项目：

~~~json
{
  "items": [
    {
      "id": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
      "displayName": "实时走航车项目-CLI验收",
      "appName": "qhzhc",
      "enabled": true,
      "role": "owner"
    },
    {
      "id": "9d0d0f78-cefc-46d5-9543-7682587db457",
      "displayName": "官网项目-CLI验收",
      "appName": "guanwang",
      "enabled": true,
      "role": "owner"
    }
  ]
}
~~~

每项的 `id` 用于后续操作，`displayName` 用于展示，`appName` 用于接入识别，`enabled` 表示项目是否启用，`role` 表示账号在该项目中的角色。不要按数组顺序选项目，也不要把重名项目视为同一项目。CLI 列表没有分页参数，返回平台提供的可访问列表。

项目基础身份见[走航车详情](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-get.json)和[官网详情](evidence/2026-10-13T11-31-09-545Z-9983c2/official-get.json)。列表功能和重名行为的实际测试见[列表验收 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/steps/list-after/stdout.json)，该输出来自标明的控制夹具。

### `project create`：新建两个专用监控项目

两个必填参数分别是显示名称 `--display-name` 和应用标识 `--app-name`。显示名称去除首尾空格后为 1–120 字符；应用标识为 1–128 字符，只允许字母、数字、点、下划线和连字符。

新批次执行下面的创建流程。脚本检查成功后才把返回的 ID 传给后续命令：

~~~powershell
$qhCreateText = bm project create --base-url $platformUrl --display-name '实时走航车项目-CLI验收' --app-name qhzhc
$qhCreateExit = $LASTEXITCODE
$qhCreate = ($qhCreateText -join "`n") | ConvertFrom-Json
if ($qhCreateExit -ne 0 -or -not $qhCreate.ok) { throw '走航车项目创建未取得成功确认，请检查返回结果' }
$qhProject = $qhCreate.data.id

$officialCreateText = bm project create --base-url $platformUrl --display-name '官网项目-CLI验收' --app-name guanwang
$officialCreateExit = $LASTEXITCODE
$officialCreate = ($officialCreateText -join "`n") | ConvertFrom-Json
if ($officialCreateExit -ne 0 -or -not $officialCreate.ok) { throw '官网项目创建未取得成功确认，请检查返回结果' }
$officialProject = $officialCreate.data.id
~~~

历史实际响应的 `data` 分别如下；新批次的 ID 和 DSN 会变化：

走航车：

~~~json
{
  "id": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
  "displayName": "实时走航车项目-CLI验收",
  "appName": "qhzhc",
  "role": "owner",
  "dsn": "http://localhost:8080/api/v3/ingest/bm_pk_fTNFmFDG10_tD5j11NNfQldsvLCs2kP5_gqEulFOtbo/envelopes",
  "confirmation": "server_response",
  "independentlyReadBack": false
}
~~~

官网：

~~~json
{
  "id": "9d0d0f78-cefc-46d5-9543-7682587db457",
  "displayName": "官网项目-CLI验收",
  "appName": "guanwang",
  "role": "owner",
  "dsn": "http://localhost:8080/api/v3/ingest/bm_pk_qvR7cMKyfVgjCVPxoz4l86TYnV6Q47OWem69T4mUlZI/envelopes",
  "confirmation": "server_response",
  "independentlyReadBack": false
}
~~~

证据：[走航车创建](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-create.json)、[官网创建](evidence/2026-10-13T11-31-09-545Z-9983c2/official-create.json)，两次退出码均为 0。

`role=owner` 表示创建者身份，`dsn` 是该项目的采集地址。`confirmation=server_response` 表示创建响应已确认，`independentlyReadBack=false` 表示此响应尚未独立回查。创建后继续执行 `project get`；创建不会自动保存默认项目。平台允许重复名称，相同参数再次执行可能产生新的项目。

如果出现 `WRITE_OUTCOME_UNKNOWN`，写入可能已经发生。保留响应中可用的 ID，优先 `project get` 回查；没有可靠 ID 时结合项目列表和平台侧记录查明。名称重复不能证明上一次创建的身份，不自动重试创建。

### `project get`：读取项目详情并确认接入条件

~~~powershell
bm project get --base-url $platformUrl --project $qhProject
bm project get --base-url $platformUrl --project $officialProject
~~~

走航车实际详情的字段节选如下。该快照在设置业务 Origin 之前读取，因此当时 `origins` 仍是平台默认来源：

~~~json
{
  "id": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
  "displayName": "实时走航车项目-CLI验收",
  "appName": "qhzhc",
  "enabled": true,
  "role": "owner",
  "keys": [
    {
      "id": "f5aa2f20-b5d5-4507-a38d-326dc04e6392",
      "label": "default",
      "active": true,
      "expiresAt": null,
      "createdAt": "2026-10-13T11:31:14.191Z",
      "dsn": "http://localhost:8080/api/v3/ingest/bm_pk_fTNFmFDG10_tD5j11NNfQldsvLCs2kP5_gqEulFOtbo/envelopes"
    }
  ],
  "origins": [
    "http://localhost:8080"
  ]
}
~~~

官网同一阶段的字段节选：

~~~json
{
  "id": "9d0d0f78-cefc-46d5-9543-7682587db457",
  "displayName": "官网项目-CLI验收",
  "appName": "guanwang",
  "enabled": true,
  "role": "owner",
  "keys": [
    {
      "id": "cef0b6f0-44f4-47d2-be92-a822bb55b5cc",
      "label": "default",
      "active": true,
      "expiresAt": null,
      "createdAt": "2026-10-13T11:31:16.424Z",
      "dsn": "http://localhost:8080/api/v3/ingest/bm_pk_qvR7cMKyfVgjCVPxoz4l86TYnV6Q47OWem69T4mUlZI/envelopes"
    }
  ],
  "origins": [
    "http://localhost:8080"
  ]
}
~~~

完整响应还包含成员与阈值等平台返回的详情。证据：[走航车详情](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-get.json)、[官网详情](evidence/2026-10-13T11-31-09-545Z-9983c2/official-get.json)，退出码均为 0。

接入前检查项目启用状态、账号角色、Origin 及 `keys` 中的键 ID、活动状态、到期时间和 DSN。读取要求项目访问权；不存在或不可访问的项目返回 `PROJECT_UNAVAILABLE`，退出码 4。详情读取不会修改设置。

### `project use`：在业务目录保存默认项目

~~~powershell
bm project use $qhProject --base-url $platformUrl --context-dir $qhDirectory
bm project use $officialProject --base-url $platformUrl --context-dir $officialDirectory
~~~

命令先验证项目可访问，再写入指定目录的 `.browser-monitor.json`。该文件的**格式示例**为：

~~~json
{
  "schemaVersion": 1,
  "baseUrl": "http://localhost:8080",
  "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd"
}
~~~

命令实际验收 `data` 如下；验收为避免修改业务目录，使用了隔离的临时上下文，实际执行上述业务目录命令时 `path` 会指向对应业务目录：

~~~json
{
  "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
  "contextSaved": true,
  "path": "C:\\WINDOWS\\TEMP\\bm-acceptance-S6wj7h\\qhzhc\\.browser-monitor.json"
}
~~~

~~~json
{
  "projectId": "9d0d0f78-cefc-46d5-9543-7682587db457",
  "contextSaved": true,
  "path": "C:\\WINDOWS\\TEMP\\bm-acceptance-S6wj7h\\official\\.browser-monitor.json"
}
~~~

证据：[走航车项目选择](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/steps/qhzhc-use/stdout.json)、[官网项目选择](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/steps/official-use/stdout.json)，退出码均为 0。

`contextSaved=true` 表示文件保存成功。之后进入对应业务目录执行 `bm project get` 或 `bm data summary` 就能使用该目录的默认项目，仍可显式 `--project` 覆盖。本地文件不含管理身份；项目已验证但文件保存失败时返回 `PARTIAL_SUCCESS`，退出码 8，保留可访问的项目 ID 后只修复保存步骤。

## 读取与设置业务 Origin

### `origins get`：查看当前允许的浏览器来源

~~~powershell
bm origins get --base-url $platformUrl --project $qhProject
bm origins get --base-url $platformUrl --project $officialProject
~~~

在下面的设置操作完成后，两个实际 `data` 分别为：

~~~json
{
  "origins": [
    "http://127.0.0.1:9527"
  ]
}
~~~

~~~json
{
  "origins": [
    "http://localhost:3000"
  ]
}
~~~

证据：[走航车独立回查](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-origins-readback.json)、[官网独立回查](evidence/2026-10-13T11-31-09-545Z-9983c2/official-origins-readback.json)，退出码均为 0。读取无需 Owner，只需项目访问权。

### `origins set`：整体替换允许来源

使用 Owner 账号执行：

~~~powershell
bm origins set --base-url $platformUrl --project $qhProject --origin http://127.0.0.1:9527
bm origins set --base-url $platformUrl --project $officialProject --origin http://localhost:3000
~~~

两个实际 `data`：

~~~json
{
  "origins": [
    "http://127.0.0.1:9527"
  ],
  "confirmation": "server_response",
  "semantics": "replace_entire_set"
}
~~~

~~~json
{
  "origins": [
    "http://localhost:3000"
  ],
  "confirmation": "server_response",
  "semantics": "replace_entire_set"
}
~~~

证据：[走航车设置](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-origins.json)、[官网设置](evidence/2026-10-13T11-31-09-545Z-9983c2/official-origins.json)，退出码均为 0。

`semantics=replace_entire_set` 表示整体替换。要保留多个来源，必须在同一次调用中全部列出：

~~~powershell
# 示例：只有确实需要同时允许两种访问来源时才设置这个集合
bm origins set --project $officialProject --origin http://localhost:3000 --origin http://127.0.0.1:3000
~~~

输入需提供 1–50 个 HTTP(S) Origin。Origin 包含协议、主机和端口，不包含业务路由、查询串、片段或账号信息；CLI 会归一化并去重。`http://localhost:3000/solution` 会被拒绝。`confirmation=server_response` 表示写响应确认，随后用 `origins get` 独立回查。普通成员写入返回 `OWNER_REQUIRED`，退出码 4。写结果未知时回查集合，不自动重发 PUT。

## 导出 SDK JSON 与接入示例

### `sdk export`：生成业务可以读取的配置

`--app-version` 和 `--environment` 必填，分别为 1–64 字符；`app.name` 和 DSN 从平台项目取得，不由 CLI 运行目录或端口推断。

先不写文件，查看配置和生成的示例：

~~~powershell
bm sdk export --base-url $platformUrl --project $qhProject --app-version 1.0.0 --environment cli-acceptance
bm sdk export --base-url $platformUrl --project $officialProject --app-version 1.0.0 --environment cli-acceptance
~~~

走航车实际 `data` 字段节选：

~~~json
{
  "config": {
    "app": {
      "name": "qhzhc",
      "version": "1.0.0",
      "environment": "cli-acceptance"
    },
    "transport": {
      "dsn": "http://localhost:8080/api/v3/ingest/bm_pk_fTNFmFDG10_tD5j11NNfQldsvLCs2kP5_gqEulFOtbo/envelopes"
    }
  },
  "artifacts": [],
  "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
  "keyId": "f5aa2f20-b5d5-4507-a38d-326dc04e6392"
}
~~~

官网实际 `data` 字段节选：

~~~json
{
  "config": {
    "app": {
      "name": "guanwang",
      "version": "1.0.0",
      "environment": "cli-acceptance"
    },
    "transport": {
      "dsn": "http://localhost:8080/api/v3/ingest/bm_pk_qvR7cMKyfVgjCVPxoz4l86TYnV6Q47OWem69T4mUlZI/envelopes"
    }
  },
  "artifacts": [],
  "projectId": "9d0d0f78-cefc-46d5-9543-7682587db457",
  "keyId": "cef0b6f0-44f4-47d2-be92-a822bb55b5cc"
}
~~~

完整响应还包含 `data.example` 的 TypeScript 文本。证据：[走航车导出](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-export.json)、[官网导出](evidence/2026-10-13T11-31-09-545Z-9983c2/official-export.json)，退出码均为 0。

默认选择唯一一个 `active=true`、`expiresAt=null` 的当前键。没有可用键返回 `KEY_UNAVAILABLE`；有多个当前键返回 `KEY_AMBIGUOUS`，应先用 `project get` 取得键 ID，再指定 `--key-id ID`。显式选择允许尚未到期的活动过渡键，输出的 `meta.keyExpiresAt` 和 `meta.keyEligibilityTimeSource` 说明到期信息与判断时钟来源。停用项目返回 `PROJECT_DISABLED`。这些错误的退出码均为 4。

### 写到两个业务目录

以下命令把 JSON 写到业务约定位置，把初始化示例另存成参考文件；使用绝对路径，不依赖当前目录：

~~~powershell
bm sdk export --base-url $platformUrl --project $qhProject --app-version 1.0.0 --environment cli-acceptance --out "$qhDirectory/src/config/monitor.local.json" --example-out "$qhDirectory/src/config/monitor.cli.example.ts"
bm sdk export --base-url $platformUrl --project $officialProject --app-version 1.0.0 --environment cli-acceptance --out "$officialDirectory/app/config/monitor.local.json" --example-out "$officialDirectory/app/config/monitor.cli.example.ts"
~~~

这些业务配置在已完成的接入中已经存在，所以在当前目录状态下执行会返回 `FILE_EXISTS`，退出码 2。首次写到不存在的文件不需要额外参数；确认替换已有配置时在原命令后增加 `--overwrite`。不要用 `> monitor.local.json` 保存完整 stdout 代替 `--out`，SDK 需要的是纯配置，不是 CLI 结果封装。

两个目标都写入文件时，stdout 返回产物位置，不再重复放入 `data.config` 与 `data.example`。以下为文件导出的实际控制夹具 `data`，用于说明 `artifacts` 结构，临时目录和项目不是两个业务的路径与身份：

~~~json
{
  "artifacts": [
    {
      "kind": "out",
      "path": "C:\\WINDOWS\\TEMP\\bm-acceptance-YUZYvP\\monitor.json"
    },
    {
      "kind": "example-out",
      "path": "C:\\WINDOWS\\TEMP\\bm-acceptance-YUZYvP\\monitor.ts"
    }
  ],
  "projectId": "00000000-0000-4000-8000-000000000001",
  "keyId": "00000000-0000-4000-8000-000000000002"
}
~~~

证据：[文件模式 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-01/steps/export-files/stdout.json)，退出码 0。`kind=out` 表示纯 JSON，`kind=example-out` 表示 TypeScript 示例；`path` 为实际绝对路径。

只提供 `--out` 时，JSON 写文件、示例仍在 stdout；只提供 `--example-out` 时，示例写文件、配置仍在 stdout。相对路径按调用工作目录解析，生成示例的 JSON 引用按两个文件的实际位置计算。两个输出不能指向同一个文件。每个文件独立完整写入，多文件未全部成功时保留成功产物，返回 `PARTIAL_SUCCESS`，退出码 8，通过 `data.artifacts` 和 `error.details.failedArtifact` 确认应补写的文件。

### 把导出配置接入业务代码

生成的初始化示例形式如下：

~~~typescript
import { createMonitor } from "@cxdlogver/browser-monitor-sdk";
import config from "./monitor.json";

const monitor = createMonitor({
  ...config,
  view: { resolveRouteName: (location) => location.pathname },
});
monitor.start();
// 在业务需要结束监控时调用 monitor.destroy()。
~~~

这是通用客户端初始化示例，JSON 不能保存路由解析函数。走航车使用 Hash 路由，应保留已有 Hash 路由解析及仅采集 `/dataVisualization` 的规则，并读取 `src/config/monitor.local.json`；不能直接把通用 `location.pathname` 当作 Hash 路由名称。官网通过 Nuxt 客户端插件读取 `app/config/monitor.local.json`，保留 `site.visit`、`site.route.stay` 的埋点和生命周期顺序。

本次两个业务的实际安装来源均为 registry 发布版 `0.3.0`，接入产物见[走航车配置](验收记录/2026-10-13T12-18-35-945Z-2bbc01/setup/business-integration/qhzhc/sdk-config.json)、[官网配置](验收记录/2026-10-13T12-18-35-945Z-2bbc01/setup/business-integration/official/sdk-config.json)和[安装来源审计](验收记录/2026-10-13T12-18-35-945Z-2bbc01/setup/installation-audit.json)。CLI 导出配置和示例，代码初始化及业务动作由业务项目完成；SDK 数据里没有管理 Cookie、CSRF 或密码。

## 检索原始事件与游标分页

### `events list`：按已知业务定义定位入库事件

需要项目访问权。没有时间参数时查询最近 24 小时，默认一页 50 条；`--limit` 为 1–100 的整数。`--from`、`--to` 使用带时区的 ISO 8601，区间是 `[from,to)`，最长 180 天。只提供 `--to` 时从该时刻向前取 24 小时，只提供 `--from` 时截止当前时间。

查询依据是事件 `occurredAt`，不是 `receivedAt`。以下均使用历史业务动作窗口，不能把这些固定时间用于新动作：

~~~powershell
bm events list --base-url $platformUrl --project $qhProject --from 2026-10-13T11:38:00Z --to 2026-10-13T11:44:00Z --type view --name view.start --environment cli-acceptance --version 1.0.0 --route-name /dataVisualization --include-payload
bm events list --base-url $platformUrl --project $officialProject --from 2026-10-13T11:45:20Z --to 2026-10-13T11:46:21Z --type span --name site.route.stay --environment cli-acceptance --version 1.0.0 --route-name /solution --include-payload
~~~

这些命令先返回符合定义的候选记录。新动作时，记录本次起止时间，必要时增加本次实际 `sessionId` 或 `viewId`；多个候选要比较动作和关联信息再确定。不要把列表第一项直接视为刚刚执行的那次动作。

全部筛选参数如下，多个参数为同时满足的等值条件：

| 参数 | 含义及范围 |
| --- | --- |
| `--type TYPE` | `performance`、`view`、`event`、`trace`、`span`。 |
| `--name NAME` | 事件名称，1–128 字符，例如 `view.start`、`site.route.stay`。 |
| `--event-id ID` | 具体事件 ID，1–256 字符。 |
| `--environment ENV` | SDK 上报环境，1–64 字符。 |
| `--version VERSION` | SDK `app.version`，1–64 字符；不是 SDK 包版本。 |
| `--route-name ROUTE` | 事件记录的逻辑路由名，1–160 字符。 |
| `--session-id ID` | 实际会话 ID，1–256 字符。 |
| `--view-id ID` | 实际视图 ID，1–256 字符。 |
| `--include-payload` | 包含平台保存的脱敏事件信封，默认不包含。 |

首版不提供 `--trace-id`、任意业务属性筛选或 `--all`；可用的 trace、span 和属性从返回的信封中读取。官网 `visibleMs` 在 `data.items[i].event.payload.metrics.visibleMs`，是实际数值和 `ms` 单位，不应固定精确时长为验收值。

### 使用实际身份精确复查

得到事件身份后，可把事件 ID 及会话、视图条件同时加入查询。例如复查两条历史事件：

~~~powershell
bm events list --base-url $platformUrl --project $qhProject --from 2026-10-13T11:38:00Z --to 2026-10-13T11:44:00Z --event-id $qhEvent --type view --name view.start --environment cli-acceptance --version 1.0.0 --route-name /dataVisualization --session-id session-mv6lymu2-1-4nyjjht5 --view-id view-mv6lymu3-2-k3gcygom --include-payload
bm events list --base-url $platformUrl --project $officialProject --from 2026-10-13T11:45:20Z --to 2026-10-13T11:46:21Z --event-id $officialEvent --type span --name site.route.stay --environment cli-acceptance --version 1.0.0 --route-name /solution --session-id session-mv6m7ad4-1-8bmr92yw --view-id view-mv6m7ad4-2-5rocy26r --include-payload
~~~

走航车实际 `data` 字段节选如下，省略 `items[0].event` 信封，保留身份、分页和来源：

~~~json
{
  "items": [
    {
      "eventId": "event-mv6lymu3-3-as5ip2jy",
      "occurredAt": "2026-10-13T11:39:07.419Z",
      "receivedAt": "2026-10-13T11:39:10.065Z",
      "type": "view",
      "name": "view.start",
      "environment": "cli-acceptance",
      "version": "1.0.0",
      "sessionId": "session-mv6lymu2-1-4nyjjht5",
      "viewId": "view-mv6lymu3-2-k3gcygom",
      "routeName": "/dataVisualization",
      "correlation": {}
    }
  ],
  "nextCursor": null,
  "hasMore": false,
  "range": {
    "from": "2026-10-13T11:38:00.000Z",
    "to": "2026-10-13T11:44:00.000Z"
  },
  "asOf": "2026-10-13T11:48:00.729Z",
  "source": "database",
  "limitations": [
    "Keyset pagination is not a snapshot across separate page requests."
  ]
}
~~~

官网实际 `data` 同类节选：

~~~json
{
  "items": [
    {
      "eventId": "event-mv6m7o46-p-fgojbyio",
      "occurredAt": "2026-10-13T11:46:08.982Z",
      "receivedAt": "2026-10-13T11:46:11.176Z",
      "type": "span",
      "name": "site.route.stay",
      "environment": "cli-acceptance",
      "version": "1.0.0",
      "sessionId": "session-mv6m7ad4-1-8bmr92yw",
      "viewId": "view-mv6m7ad4-2-5rocy26r",
      "routeName": "/solution",
      "correlation": {
        "spanId": "adf2c42894e06be4",
        "traceId": "8bb60d85f54603bbfe5752f2b527c42b",
        "parentSpanId": "79b9f934eae822f7"
      }
    }
  ],
  "nextCursor": null,
  "hasMore": false,
  "range": {
    "from": "2026-10-13T11:45:20.000Z",
    "to": "2026-10-13T11:46:21.000Z"
  },
  "asOf": "2026-10-13T11:48:02.892Z",
  "source": "database",
  "limitations": [
    "Keyset pagination is not a snapshot across separate page requests."
  ]
}
~~~

证据：[走航车精确检索](evidence/2026-10-13T11-31-09-545Z-9983c2/qhzhc-business-list.json)、[官网精确检索](evidence/2026-10-13T11-31-09-545Z-9983c2/official-business-list.json)，退出码均为 0，完整信封在各文件的 `result.data.items[0].event` 中。

`receivedAt` 晚于 `occurredAt` 是采集、传输和接收过程的结果。走航车 URL 中的 Hash 在保存的 URL 中可能被脱敏移除，逻辑页面通过 `routeName` 核对。官网记录通过 `correlation.traceId` 和 `spanId` 关联访问与栏目 Span。

空列表是成功读取，`items=[]`、`hasMore=false`、`nextCursor=null`，退出码 0；它只能说明当前项目和条件下没有匹配的保留记录。先核查平台、项目、环境、时窗、路由及事件结束时机，再判断接入是否异常。

### `--cursor`：按同一查询继续下一页

先获取第一页并检查结果，再使用原样保存的 `nextCursor`：

~~~powershell
$pageText = bm events list --base-url $platformUrl --project $qhProject --limit 50
$pageExit = $LASTEXITCODE
$page = ($pageText -join "`n") | ConvertFrom-Json
if ($pageExit -ne 0 -or -not $page.ok) { throw '第一页读取失败' }
if ($page.data.hasMore) {
  bm events list --base-url $platformUrl --project $qhProject --cursor $page.data.nextCursor --limit 50
}
~~~

游标是不透明字符串，绑定平台、项目、已固定的时间窗口和筛选；续页可以只传游标，不要自行修改字符串。不能换项目、平台或冲突的筛选继续；冲突返回 `INVALID_CURSOR`，退出码 2。可以调整页大小和是否返回 payload。记录按发生时间倒序、事件 ID 倒序排列。

每页是一次独立数据库读取，跨页不是同一个数据库快照，迟到数据和清理可能改变可见记录。保存每页原始输出和 `asOf`。脚本自行设置最大页数或终止条件，只有 `hasMore=false` 才表示该查询不再有后续页。实际多页行为见[第一页证据](evidence/2026-10-13T11-31-09-545Z-9983c2/events-page-1.json)，该批次使用分页控制数据。

## 查看原始数据概况

### `data summary`：查询项目当前保留量和最近接收时间

~~~powershell
bm data summary --base-url $platformUrl --project $qhProject
bm data summary --base-url $platformUrl --project $officialProject
~~~

命令不接受时间窗口、环境或事件类型筛选，统计项目所有当前保留的原始记录。走航车实际 `data` 已在公共输出约定中完整展示；官网正式验收的实际 `data` 为：

~~~json
{
  "projectId": "9d0d0f78-cefc-46d5-9543-7682587db457",
  "retainedRawEventCount": 152,
  "latestReceivedAt": "2026-10-13T12:22:51.175Z",
  "retentionPolicy": {
    "raw": {
      "state": "configured",
      "dropAfter": "30 days",
      "scheduled": true,
      "source": "timescaledb_information.jobs"
    },
    "completedTasks": {
      "days": 7,
      "source": "worker_housekeeping_policy"
    }
  },
  "asOf": "2026-10-13T12:22:52.085Z",
  "source": "database"
}
~~~

证据：[走航车概况](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/qhzhc-live-summary/stdout.json)、[官网概况](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/official-live-summary/stdout.json)，退出码均为 0。

`retainedRawEventCount` 是快照时刻实际保留的原始行数；`latestReceivedAt` 是这些行中最近的接收时间，空项目为 `null`。它不是累计接收量，不等于筛选后的一页事件数，也不等于一次业务动作产生的记录数。历史验收中走航车为 233，官网为 152；项目可能还有其他业务信号或验收控制输入，不能据此声称两次主动作分别产生了这些数量。

`retentionPolicy.raw` 从部署的数据库保留任务读取，示例中为已配置 `30 days`，不是所有环境的固定承诺。未知或无法唯一确认时保留未知状态及原因。`completedTasks.days=7` 是该部署的已完成任务保留政策，过期后事件原始记录与任务历史可能不再同时存在。数据概况不会直接列出投影表总量或数据库运维指标。

## 诊断单条事件的处理阶段

### `events diagnose`：分别核查原始记录、处理提交、任务与投影

`--event-id` 必填；`--occurred-at` 可选，用带时区 ISO 8601 精确指定同 ID 的发生时间。命令查询所有当前保留范围，不受列表默认 24 小时窗口限制。可添加 `--include-payload` 读取已保存信封。

~~~powershell
bm events diagnose --base-url $platformUrl --project $qhProject --event-id $qhEvent --occurred-at $qhOccurredAt
bm events diagnose --base-url $platformUrl --project $officialProject --event-id $officialEvent --occurred-at $officialOccurredAt
~~~

走航车实际完整 `data`：

~~~json
{
  "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
  "event": {
    "eventId": "event-mv6lymu3-3-as5ip2jy",
    "occurredAt": "2026-10-13T11:39:07.419Z",
    "receivedAt": "2026-10-13T11:39:10.065Z",
    "type": "view",
    "name": "view.start"
  },
  "raw": {
    "recordState": "present"
  },
  "processing": {
    "state": "committed",
    "processedAt": "2026-10-13T11:39:10.287Z",
    "evidence": "telemetry_events.processed_at"
  },
  "task": {
    "recordState": "present",
    "taskId": "92e5e213-ce09-4e80-97ed-c432aa73473b",
    "status": "completed",
    "attempts": 1,
    "availableAt": "2026-10-13T11:39:10.065Z",
    "lockedAt": null,
    "completedAt": "2026-10-13T11:39:10.304Z",
    "lastFailedAt": null,
    "lastError": null
  },
  "projection": {
    "visibility": "visible",
    "eventEffect": "unknown",
    "identity": {
      "kind": "view",
      "viewId": "view-mv6lymu3-2-k3gcygom"
    },
    "currentEntity": {
      "view_id": "view-mv6lymu3-2-k3gcygom",
      "started_at": "2026-10-13T11:39:07.419Z",
      "ended_at": "2026-10-13T11:42:35.212Z"
    },
    "limitation": "Current entity visibility does not prove this event changed it; a committed no-op is valid."
  },
  "history": {
    "limitations": [],
    "completedTaskRetentionDays": 7
  },
  "asOf": "2026-10-13T12:22:50.087Z",
  "source": "database"
}
~~~

官网实际 `data` 字段节选，包含事件、提交、任务和投影：

~~~json
{
  "event": {
    "eventId": "event-mv6m7o46-p-fgojbyio",
    "occurredAt": "2026-10-13T11:46:08.982Z",
    "receivedAt": "2026-10-13T11:46:11.176Z",
    "type": "span",
    "name": "site.route.stay"
  },
  "raw": {
    "recordState": "present"
  },
  "processing": {
    "state": "committed",
    "processedAt": "2026-10-13T11:46:11.248Z",
    "evidence": "telemetry_events.processed_at"
  },
  "task": {
    "recordState": "present",
    "taskId": "618792ee-7afe-4c67-92a6-475160b7c889",
    "status": "completed",
    "attempts": 1,
    "availableAt": "2026-10-13T11:46:11.176Z",
    "lockedAt": null,
    "completedAt": "2026-10-13T11:46:11.263Z",
    "lastFailedAt": null,
    "lastError": null
  },
  "projection": {
    "visibility": "visible",
    "eventEffect": "unknown",
    "identity": {
      "kind": "custom_signal",
      "eventId": "event-mv6m7o46-p-fgojbyio",
      "occurredAt": "2026-10-13T11:46:08.982Z"
    },
    "currentEntity": {
      "event_id": "event-mv6m7o46-p-fgojbyio",
      "kind": "span",
      "trace_id": "8bb60d85f54603bbfe5752f2b527c42b",
      "span_id": "adf2c42894e06be4"
    },
    "limitation": "Current entity visibility does not prove this event changed it; a committed no-op is valid."
  },
  "asOf": "2026-10-13T12:22:52.658Z"
}
~~~

证据：[走航车诊断](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/qhzhc-live-diagnose/stdout.json)、[官网诊断](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/official-live-diagnose/stdout.json)，退出码均为 0。

按下面的顺序阅读结果：

1. `event` 给出本次诊断的实际事件身份和接收信息。加 `--include-payload` 时，完整信封位于 `data.event.payload`，信封中的业务 payload 是 `data.event.payload.payload`；列表则放在 `data.items[i].event`，不要混淆两个路径。
2. `raw.recordState=present` 证明原始记录仍在库中；`missing` 表示当前没有该保留记录，不足以证明它从未接收。
3. `processing.state=committed` 与 `processedAt`、`evidence` 共同证明处理提交。`notObserved` 表示尚未观察到提交，`unknown` 表示可用证据不足。
4. `task.recordState=present` 时读取 `status`、`attempts`、`availableAt`、`lockedAt`、`completedAt`、`lastFailedAt` 和 `lastError`。任务状态为 `pending`、`processing`、`failed` 或 `completed`；任务缺失不能填成完成。
5. `projection.visibility` 表示当前目标实体是否可见；`identity` 指明关联实体，`currentEntity` 给出可用实体信息。当前实体可见不证明本事件改变了实体，所以 `eventEffect` 可以保持 `unknown`。合法 no-op 或旧修订可能已经提交，但没有新增投影行。
6. `history.limitations` 解释历史不足，`asOf` 标注此次数据库快照。

走航车关联的是该次视图；官网关联的是该条自定义 Span 信号。两条主事件的处理提交和对应 Outbox 完成都有实际证据。`events diagnose` 是读取事实：读到任务失败仍可退出 0，表示查询成功；需要以失败作为流程终止时使用下文的 `events wait`。

同 ID 多个时间、未指定发生时间时返回 `AMBIGUOUS_EVENT`，退出码 2，按 `error.details` 的候选时间补充 `--occurred-at`。历史任务已经清理时保留缺失与限制，不能把“原始记录存在”“投影实体可见”自动合并为完整完成证据。

## 查看任务队列与失败信息

### `queue status`：回答当前还有多少待执行、退避、锁超时和失败任务

~~~powershell
bm queue status --base-url $platformUrl --project $qhProject
bm queue status --base-url $platformUrl --project $officialProject
~~~

命令读取当前项目的 telemetry Outbox 状态。数据库核心计数按同一快照分类，范围是项目全部环境，输出 `scope.environment=null`；首版没有队列环境筛选参数。

官网正式验收实际 `data` 字段节选如下，省略其他队列及限制文本，完整响应见证据：

~~~json
{
  "projectId": "9d0d0f78-cefc-46d5-9543-7682587db457",
  "pendingTotal": 48,
  "readyPending": 48,
  "delayedPending": 0,
  "pendingUnclassified": 0,
  "processingTotal": 0,
  "processingActive": 0,
  "processingStale": 0,
  "processingUnclassified": 0,
  "failed": 0,
  "processedLastMinute": 0,
  "deadLetters": 0,
  "deadLettersOverlappingFailed": 0,
  "recentFailures": [],
  "recentFailuresLimit": 20,
  "recentFailuresHasMore": false,
  "lockTimeoutSeconds": 300,
  "lockTimeoutSource": "shared_worker_policy",
  "scope": {
    "projectId": "9d0d0f78-cefc-46d5-9543-7682587db457",
    "taskType": "telemetry",
    "environment": null
  },
  "asOf": "2026-10-13T12:22:53.599Z",
  "source": "database",
  "ingestion": {
    "source": "redis",
    "scope": {
      "projectId": "9d0d0f78-cefc-46d5-9543-7682587db457"
    },
    "requestedAt": "2026-10-13T12:22:53.606Z",
    "asOf": null,
    "accepted": 152,
    "duplicate": 0,
    "rejected": 0,
    "limitation": "Counters can expire; missing values are unknown. They are not retained raw row counts or part of the database snapshot."
  }
}
~~~

证据：[官网队列 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/official-live-queue/stdout.json)，退出码 0。此时已经完成的主事件仍能通过单事件诊断确认，同时项目又有 48 条待执行任务；单事件完成与全项目清空是不同检查。

走航车同阶段的实际 `data` 字段节选如下，保留核心计数、近期失败的第一条及辅助来源：

~~~json
{
  "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
  "pendingTotal": 0,
  "readyPending": 0,
  "delayedPending": 0,
  "pendingUnclassified": 0,
  "processingTotal": 1,
  "processingActive": 0,
  "processingStale": 0,
  "processingUnclassified": 1,
  "failed": 21,
  "processedLastMinute": 0,
  "deadLetters": 1,
  "deadLettersOverlappingFailed": 1,
  "recentFailures": [
    {
      "taskId": "f1188003-24e1-4f66-b026-fbcf3e9fe554",
      "eventId": "queue-f1188003-24e1-4f66-b026-fbcf3e9fe554",
      "occurredAt": "2026-10-13T11:31:18.536Z",
      "status": "failed",
      "attempts": 0,
      "availableAt": "2026-10-13T11:31:27.926Z",
      "failedAt": "2026-10-13T11:31:27.926Z",
      "createdAt": "2026-10-13T11:31:27.926Z",
      "error": "fixture failure 20"
    }
  ],
  "recentFailuresLimit": 20,
  "recentFailuresHasMore": true,
  "lockTimeoutSeconds": 300,
  "lockTimeoutSource": "shared_worker_policy",
  "scope": {
    "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd",
    "taskType": "telemetry",
    "environment": null
  },
  "asOf": "2026-10-13T12:22:51.119Z",
  "source": "database",
  "ingestion": {
    "source": "redis",
    "scope": {
      "projectId": "c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd"
    },
    "requestedAt": "2026-10-13T12:22:51.131Z",
    "asOf": null,
    "accepted": 82,
    "duplicate": 0,
    "rejected": 0,
    "limitation": "Counters can expire; missing values are unknown. They are not retained raw row counts or part of the database snapshot."
  }
}
~~~

证据：[走航车队列 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/qhzhc-live-queue/stdout.json)，退出码 0。**这里的 21 条失败、死信和未分类锁含验收控制夹具，错误文本为 `fixture failure ...`，不能解释为走航车主事件失败。** 实际响应返回 20 条 `recentFailures`，文中节选仅展示一条。

核心字段的解释：

- `pendingTotal` 是待处理任务总数，等于 `readyPending + delayedPending + pendingUnclassified`。可执行表示 `availableAt <= asOf`；退避等待表示尚未到可执行时间；时间证据不足的任务放入未分类。
- `processingTotal` 等于 `processingActive + processingStale + processingUnclassified`。按 `lockTimeoutSeconds` 判断锁是否超时，示例为 300 秒；恰好到 300 秒边界仍属于未超时锁。缺失或无效锁时间放入未分类。
- `processingActive` 表示锁时间未超过阈值，不是 Worker 心跳证明。`processingStale` 表示锁超时事实，需要进一步检查处理进程。
- `failed` 是失败任务数，`deadLetters` 是死信数，`deadLettersOverlappingFailed` 表示两者重叠；不能直接把失败和死信相加。
- `processedLastMinute` 是数据库快照时刻之前一分钟内完成的任务数，窗口为 `(asOf-60秒, asOf]`。
- `recentFailures` 最多返回 `recentFailuresLimit=20` 条，`recentFailuresHasMore` 提示还有其他记录。每条包含事件身份、任务状态、尝试次数、可执行时间、实际失败时间和错误。历史没有失败时间时 `failedAt=null`，不能用创建时间冒充失败时间。

`otherQueues.labAudits` 单独标注实验室审计队列的数据库来源，不并入 telemetry 计数。`ingestion` 来自 Redis，包含 `accepted`、`duplicate`、`rejected`、请求时间及 `asOf=null` 的新鲜度限制。Redis 计数可能过期，缺失值保持未知；它不是保留原始行数，也不属于核心数据库的原子快照。

例如走航车保留原始行数 233，而 Redis `accepted=82`，它们的来源和范围不同，不能要求相等。Redis 不可用时核心数据库统计仍可返回，辅助计数标注未知；数据库核心读取失败则命令失败。

## 等待单条事件处理完成

### `events wait`：在有界时间内取得完成证据

`--event-id` 必填，`--occurred-at` 用于消歧。默认 `--timeout 60` 秒、`--interval 2` 秒，间隔至少 1 秒；超时范围 0.001–86400 秒，间隔范围 1–86400 秒。第一次立即查询，之后按间隔只读轮询。

~~~powershell
bm events wait --base-url $platformUrl --project $qhProject --event-id $qhEvent --occurred-at $qhOccurredAt --timeout 60 --interval 2
bm events wait --base-url $platformUrl --project $officialProject --event-id $officialEvent --occurred-at $officialOccurredAt --timeout 60 --interval 2
~~~

**完成条件是同一次有效诊断中，`processing.state=committed`，并且对应任务存在且 `task.status=completed`。** 等待不修改或重试任务，不等待后续聚合刷新，也不要求其他项目任务全部清空。请求、GET 重试、退避和轮询休眠共同消耗 `--timeout` 的总预算，`--command-timeout` 不覆盖它。

走航车正式验收实际 `data` 字段节选，省略最后诊断的部分字段：

~~~json
{
  "reason": "completed",
  "polls": 1,
  "elapsedMs": 130,
  "lastObservation": {
    "event": {
      "eventId": "event-mv6lymu3-3-as5ip2jy",
      "occurredAt": "2026-10-13T11:39:07.419Z",
      "receivedAt": "2026-10-13T11:39:10.065Z",
      "type": "view",
      "name": "view.start"
    },
    "raw": {
      "recordState": "present"
    },
    "processing": {
      "state": "committed",
      "processedAt": "2026-10-13T11:39:10.287Z",
      "evidence": "telemetry_events.processed_at"
    },
    "task": {
      "recordState": "present",
      "taskId": "92e5e213-ce09-4e80-97ed-c432aa73473b",
      "status": "completed",
      "attempts": 1,
      "availableAt": "2026-10-13T11:39:10.065Z",
      "lockedAt": null,
      "completedAt": "2026-10-13T11:39:10.304Z",
      "lastFailedAt": null,
      "lastError": null
    },
    "asOf": "2026-10-13T12:22:50.574Z"
  },
  "lastObservationAsOf": "2026-10-13T12:22:50.574Z",
  "lastQueryFailure": null
}
~~~

官网实际同类节选：

~~~json
{
  "reason": "completed",
  "polls": 1,
  "elapsedMs": 95,
  "lastObservation": {
    "event": {
      "eventId": "event-mv6m7o46-p-fgojbyio",
      "occurredAt": "2026-10-13T11:46:08.982Z",
      "receivedAt": "2026-10-13T11:46:11.176Z",
      "type": "span",
      "name": "site.route.stay"
    },
    "raw": {
      "recordState": "present"
    },
    "processing": {
      "state": "committed",
      "processedAt": "2026-10-13T11:46:11.248Z",
      "evidence": "telemetry_events.processed_at"
    },
    "task": {
      "recordState": "present",
      "taskId": "618792ee-7afe-4c67-92a6-475160b7c889",
      "status": "completed",
      "attempts": 1,
      "availableAt": "2026-10-13T11:46:11.176Z",
      "lockedAt": null,
      "completedAt": "2026-10-13T11:46:11.263Z",
      "lastFailedAt": null,
      "lastError": null
    },
    "asOf": "2026-10-13T12:22:53.136Z"
  },
  "lastObservationAsOf": "2026-10-13T12:22:53.136Z",
  "lastQueryFailure": null
}
~~~

证据：[走航车等待](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/qhzhc-live-wait/stdout.json)、[官网等待](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/official-live-wait/stdout.json)，退出码均为 0。历史主事件此前已完成，所以一次轮询就取得完成证据；这不是承诺任何新事件都只需一次轮询。

`reason` 说明结束原因，`polls` 是尝试的诊断次数，`elapsedMs` 是本次等待耗时，`lastObservation` 是最后有效诊断，`lastObservationAsOf` 保留它的原始快照时间，`lastQueryFailure` 记录可用的查询失败信息。

### 到期、失败和历史不足的输出

受控超时用例的实际完整 stdout 如下，退出码为 6。该事件、项目和平台地址均为故障夹具，不是两个真实业务主事件：

~~~json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "events wait",
  "context": {
    "baseUrl": "http://127.0.0.1:53349",
    "projectId": "00000000-0000-4000-8000-000000000001"
  },
  "data": {
    "reason": "deadline_reached",
    "polls": 2,
    "elapsedMs": 5007,
    "lastObservation": {
      "projectId": "00000000-0000-4000-8000-000000000001",
      "event": {
        "eventId": "event",
        "occurredAt": "2026-10-13T00:00:00.000Z"
      },
      "raw": {
        "recordState": "present"
      },
      "processing": {
        "state": "notObserved",
        "processedAt": null
      },
      "task": {
        "recordState": "present",
        "status": "pending",
        "completedAt": null
      },
      "projection": {
        "visibility": "missing",
        "eventEffect": "unknown"
      },
      "history": {
        "limitations": []
      },
      "source": "database",
      "asOf": "2026-10-13T12:20:45.560Z"
    },
    "lastObservationAsOf": "2026-10-13T12:20:45.560Z",
    "lastQueryFailure": {
      "code": "REQUEST_TIMEOUT",
      "details": {
        "lastError": "REQUEST_TIMEOUT"
      }
    }
  },
  "meta": {
    "source": "platform_api",
    "warnings": []
  },
  "error": {
    "code": "WAIT_TIMEOUT",
    "message": "等待到期，尚未取得完整完成证据。",
    "details": null
  }
}
~~~

证据：[5 秒等待超时实际结果](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-03/steps/short-budget/stdout.json)。

`WAIT_TIMEOUT` 表示预算内未取得完整完成证据，不证明事件永远不会完成；保存最后观察，再检查队列或平台。任务明确 `failed` 时返回 `PROCESSING_FAILED`，退出码 7；处理已提交而对应任务历史缺失时返回 `HISTORY_INCOMPLETE`，退出码 7。

等待中的独立查询错误沿用该错误的退出码，`reason=query_failed`，保留最后有效观察及其旧 `asOf`，并记录 `lastQueryFailure`。没有成功观察时为 `null`。不要把最后查询失败的时刻当作最后有效数据库快照，也不要只根据 `ok=false` 丢弃这些诊断信息。

## 检查平台健康与查看帮助

### `health`：检查管理 API、存活和依赖就绪

~~~powershell
bm health --base-url $platformUrl
~~~

不要求登录或选择项目。实际匿名健康检查的 `data`：

~~~json
{
  "target": "http://localhost:8080",
  "checkedAt": "2026-10-13T11:31:12.602Z",
  "connectivity": {
    "state": "pass",
    "source": "http_responses",
    "reason": "已收到平台响应"
  },
  "liveness": {
    "state": "pass",
    "source": "/health/live",
    "reason": "平台确认",
    "details": {
      "status": "ok"
    }
  },
  "readiness": {
    "state": "pass",
    "source": "/health/ready",
    "reason": "平台确认",
    "details": {
      "status": "ok"
    }
  },
  "managementApi": {
    "state": "pass",
    "authentication": "unknown",
    "source": "/api/v1/auth/me",
    "reason": "AUTH_REQUIRED"
  },
  "limitations": [
    "基础健康不证明 Worker 正常或特定项目已经写入、处理。"
  ]
}
~~~

证据：[匿名健康检查](evidence/2026-10-13T11-31-09-545Z-9983c2/health-anonymous.json)，退出码 0。

`connectivity` 检查是否取得平台响应，`liveness` 对应 `/health/live`，`readiness` 对应 `/health/ready`，`managementApi` 对应身份接口。每项的 `state` 为 `pass`、`fail` 或 `unknown`，并附 `source` 与 `reason`。匿名请求身份接口得到规范的认证错误可以证明接口响应正常，因此 `managementApi.state=pass`、`authentication=unknown` 可以同时存在。

健康检查共享普通命令预算。平台或依赖未就绪返回 `HEALTH_UNREADY`，退出码 5；无法取得部分必要能力证据返回 `CAPABILITY_UNAVAILABLE`，退出码 4。失败也保留已经取得的分项结果。基础健康通过不证明 Worker 正常或某个事件已入库，业务接入检查仍需列表、诊断和等待。

### `--help` / `-h`：查看全部命令和公共参数

~~~powershell
bm --help
bm -h
bm events list --help
~~~

三个调用均输出当前统一帮助文本，退出码 0；首版命令后追加 `--help` 也显示统一帮助，没有独立的子命令帮助页。以下为命令文本节选：

~~~text
auth login --email EMAIL [--password-stdin] | auth status | auth logout
project list | project get | project create --display-name NAME --app-name NAME
project use PROJECT_ID
origins get | origins set --origin ORIGIN [--origin ORIGIN ...]（整体替换）
sdk export --app-version VERSION --environment ENV [--key-id ID --out FILE --example-out FILE --overwrite]
events list [--from ISO --to ISO --limit 1..100 --cursor CURSOR]
events diagnose --event-id ID [--occurred-at ISO --include-payload]
events wait --event-id ID [--occurred-at ISO --timeout SECONDS --interval SECONDS]
data summary | queue status | health
~~~

帮助输出是普通文本，不要按标准业务 JSON 解析。实际帮助证据见[帮助 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/steps/help/stdout.txt)。

## 人和 AI 如何保存与使用结果

### 人工查看：使用表格格式

~~~powershell
bm queue status --base-url $platformUrl --project $officialProject --format table
~~~

表格按“字段路径 + Tab + JSON 值”输出，保留与 JSON 相同的事实。示例为实际控制夹具表格节选；数字与平台地址属于该夹具：

~~~text
schemaVersion	1
ok	true
command	"queue status"
data.pendingTotal	3
data.readyPending	1
data.delayedPending	1
data.pendingUnclassified	1
data.processingTotal	3
data.processingActive	1
data.processingStale	1
data.processingUnclassified	1
data.asOf	"2026-10-13T12:20:53.021Z"
meta.source	"database_and_labeled_auxiliary_sources"
~~~

证据：[完整表格 stdout](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/steps/table/stdout.txt)。数组会作为一个 JSON 值保留，并非自动展开成多行。AI 和脚本优先使用默认 JSON，不解析表格。

### 保存一份完整查询结果

在 PowerShell 中捕获 stdout，立即保存退出码，再解析 JSON。下面示例保存官网原始数据概况，文件编码明确为 UTF-8：

~~~powershell
$summaryText = bm data summary --base-url $platformUrl --project $officialProject
$summaryExit = $LASTEXITCODE
$summaryJson = $summaryText -join "`n"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'official-data-summary.json'), $summaryJson, [System.Text.UTF8Encoding]::new($false))
$summary = $summaryJson | ConvertFrom-Json
if ($summaryExit -ne 0 -or -not $summary.ok) {
  Write-Error ("CLI 查询失败：" + $summary.error.code)
} else {
  $summary.data.retainedRawEventCount
  $summary.data.asOf
}
~~~

保存的是诊断证据，使用时记录平台、项目、调用参数、退出码和快照时间。SDK 配置仍通过 `sdk export --out` 生成纯 JSON。重复读取会产生新的快照和数量，不能拿新结果覆盖旧结果后宣称两次观察相同。

### AI 进程调用的基本流程

通过子进程调用 Node 入口，显式设置业务工作目录，使用参数数组传递命令和筛选，分别读取 stdout 与 stderr。登录通过受控 stdin 提供密码；查询无需再次提供密码。业务目录上下文可以复用，也可为每次调用显式提供 `--base-url`、`--project`。

AI 应按顺序完成：检查退出码和 `ok`；读取可用的 `data`；保存事件身份和 `asOf`；需要后续页时原样传递游标；需要处理完成时执行有超时的 `events wait`。失败时按固定错误码处理，尤其保留部分文件产物、未知写入结果和最后诊断。用户账号的成员/Owner 权限同样适用于 AI。

普通 GET 对临时网络错误、429 和 5xx 最多重试两次，即最多三次请求，仍受单请求和总预算限制。POST/PUT 不自动重试；CLI 不跟随重定向发送管理凭据。处理 `WRITE_OUTCOME_UNKNOWN` 时先回查，避免重复创建或覆盖来源。

### 控制输出体积

需要返回信封时先缩小时间窗口和页数。两种输出格式都先检查完整结果大小；超限返回 `OUTPUT_TOO_LARGE`，退出码 2，不截断事件列表后继续提供可用游标。

~~~powershell
bm events list --project $officialProject --name site.route.stay --limit 10 --include-payload --max-output-bytes 2097152
~~~

这里明确把预算设为 2 MiB。AI 不应假定被截断的文本是完整 JSON；`OUTPUT_TOO_LARGE` 时缩小查询、关闭 payload 或明确调整预算后重查。

## 退出码、错误恢复与两个项目的操作核对

### 按错误码决定下一步

| 退出码 | 可能的 `error.code` | 应采取的操作 |
| --- | --- | --- |
| 0 | 无错误 | 使用 `data`；诊断读到失败任务仍可能是成功查询，要继续检查业务状态字段。 |
| 2 | `INVALID_ARGUMENT`、`INVALID_CURSOR`、`CONTEXT_MISSING`、`AMBIGUOUS_EVENT`、`FILE_EXISTS`、`OUTPUT_TOO_LARGE` | 修正输入或上下文；消歧时间；确认文件覆盖；缩小输出。 |
| 3 | `AUTH_REQUIRED`、`AUTH_EXPIRED` | 对目标平台重新登录，随后复查身份。 |
| 4 | `PROJECT_UNAVAILABLE`、`OWNER_REQUIRED`、`PROJECT_DISABLED`、`KEY_UNAVAILABLE`、`KEY_AMBIGUOUS`、`CAPABILITY_UNAVAILABLE` | 核对项目、角色、启用状态、有效键及平台能力。 |
| 5 | `NETWORK_UNREACHABLE`、`REQUEST_TIMEOUT`、`SERVER_ERROR`、`WRITE_OUTCOME_UNKNOWN`、`API_CONTRACT_INVALID`、`HEALTH_UNREADY` | 检查平台与预算；未知写结果优先回查；契约错误检查部署版本和返回内容。 |
| 6 | `WAIT_TIMEOUT` | 保存最后有效观察，结合队列诊断；需要再次等待时由调用者决定新的有界预算。 |
| 7 | `PROCESSING_FAILED`、`HISTORY_INCOMPLETE` | 查看失败详情或历史限制，不能声称处理完整成功。 |
| 8 | `PARTIAL_SUCCESS` | 检查已成功产物及未完成步骤，只补齐需要恢复的部分。 |

错误 JSON 一般仍包含 `schemaVersion`、`ok=false`、`command`、`context`、`data`、`meta` 和 `error`。上下文尚未解析成功时 `context` 可以是 `null`；失败的 `meta` 不保证有成功命令的 `elapsedMs`、`asOf`。等待错误等场景的 `data` 不是 `null`，应保留。

### 走航车操作链核对

1. 登录并运行 `auth status`；新批次运行 `project create` 并保存 `$qhProject`，复查历史时使用历史 ID。
2. `project get` 确认身份和启用状态，`origins set` 设置 `http://127.0.0.1:9527`，随后 `origins get` 回查。
3. `project use` 保存走航车目录上下文；`sdk export` 导出 `app.name=qhzhc`、版本 `1.0.0`、环境 `cli-acceptance` 的配置，业务读取纯 JSON，保留 Hash 路由和原采集规则。
4. 记录实际 UTC 动作窗口，登录业务后进入或重载可视化页面。`events list` 查询 `view / view.start / /dataVisualization`，关联本次会话和视图，保存实际事件 ID 与发生时间。
5. `events diagnose` 分别检查原始记录和处理阶段，`events wait` 核对处理提交及任务完成；`data summary`、`queue status` 读取项目概况。不要把项目夹具失败解释为主事件失败。

历史主事件核对结论：原始记录存在，处理于 `2026-10-13T11:39:10.287Z` 提交，对应任务于 `11:39:10.304Z` 完成，关联视图可见。原始信封上报 SDK 版本 `0.3.0`。见[正式验收检索](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/qhzhc-live-list/stdout.json)和前述诊断、等待证据。

### 官网操作链核对

1. 复用同一平台的登录会话；新批次运行 `project create` 并保存 `$officialProject`，用 `project get` 回查。
2. 设置并回查 `http://localhost:3000`，保存官网目录上下文，导出 `app.name=guanwang`、版本 `1.0.0`、环境 `cli-acceptance` 的配置。
3. 客户端插件读取纯 JSON，保留访问和栏目埋点。记录动作窗口，在 `/solution` 停留，再通过应用路由离开到 `/`，使 `site.route.stay` 结束并形成上报。
4. `events list` 查询 `span / site.route.stay / /solution`，检查属性、时间、会话、视图和 trace/span 关联，保存实际 ID 和发生时间。事件属性从信封读取，不能通过尚未提供的属性筛选参数查询。
5. 运行诊断、等待、原始概况和队列命令，分别保存结果与快照。其他待执行任务仍存在时，已经完成的主事件也能通过等待命令。

历史主事件核对结论：原始记录存在，处理于 `2026-10-13T11:46:11.248Z` 提交，对应任务于 `11:46:11.263Z` 完成，关联自定义 Span 信号可见，属性保留 `/solution`，`visibleMs` 的实际单位为 `ms`。原始信封上报 SDK 版本 `0.3.0`。见[正式验收检索](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/steps/official-live-list/stdout.json)和前述诊断、等待证据。

完成两条操作链后，保存命令、退出码、预期、实际响应和业务动作身份。逐项验收要求见[验收计划](监控平台CLI验收计划.md)，正式 47 项结果见[验收执行记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/acceptance-summary.md)。本文是使用说明，新增功能或改变参数时需同步更新示例及关联证据。
