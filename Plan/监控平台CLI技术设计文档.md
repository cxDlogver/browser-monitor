# 监控平台 CLI 技术设计文档

文档版本：1.2。编写日期：2026-10-13。状态：首版契约已实现；执行证据见实施记录。

本文按[需求文档](监控平台CLI需求文档.md)中的 FR-01 至 FR-12 逐项给出设计方案。先说明所有功能共用的架构与规范，再说明每项功能的入口、接口与数据、执行步骤、异常处理及验证方式。本文保留首版功能契约；文末记录已经落地的参数、查询与文件行为，实际执行结果在实施记录和逐项验收产物中核对。

## 1. 整体架构与公共技术规范

### 1.1 架构目标与边界

CLI 以平台 HTTP API 为数据与管理入口。读取时取得平台保存的项目、配置、原始事件和任务证据；写入时通过业务 API 创建项目或整体更新来源集合，取得服务端确认及可回查身份。

CLI 不承担监控事件的后台处理或聚合计算。首版遥测事件由业务 SDK 上报，CLI 负责接入准备、读取和诊断。历史事件覆盖、任意 SQL、任务重试等操作不混入通用管理接口。

“及时查询”在技术上落实为：普通命令按调用发起新请求，诊断与概况接口返回服务端查询时刻，关键数据库统计使用新查询快照。本地不缓存事件或任务查询结果；身份和非敏感项目上下文可以保存。

对于平台缓存或非数据库统计，结果必须标注来源和可知新鲜度。客户端发起请求的时间只记作 requestedAt，不能代替数据库 asOf。

### 1.2 调用结构与工程组织

~~~mermaid
flowchart LR
    U[终端 / AI / 自动化脚本] --> C[CLI 命令入口]
    C --> X[上下文与身份]
    C --> R[资源服务与流程编排]
    X --> H[HTTP 客户端]
    R --> H
    H --> P[平台 API]
    P --> A[认证与项目管理]
    P --> D[数据库查询与诊断]
    P --> Q[异步任务状态]
    R --> O[结果格式与文件输出]
~~~

CLI 的核心层只依赖标准资源契约，不依赖 Web 页面组件或数据库表实现。平台 API 适配层负责把资源操作映射到实际接口，并将响应转换成统一类型。

适配可以改变路径与字段名称，但不能把累计接收量当作保留量，也不能从缺失记录推导成功或失败。平台缺少所需事实时，应补齐服务端能力或返回明确不足，不能用推测制造字段。

命令入口负责识别命令、参数、输出模式和非交互状态。输入校验模块负责类型、时间、范围、来源和文件参数校验，在请求前发现明显无效输入。

上下文模块负责平台与项目解析、业务目录上下文读写和覆盖规则。身份模块负责登录、会话保存、CSRF、有效性检查和退出，不负责业务资源授权。

HTTP 客户端负责请求、认证附加、超时、有限重试、请求追踪与响应解析。资源服务分别实现项目、来源、SDK 导出、事件、数据概况、队列和健康检查。

等待编排模块管理整体截止时间，消费单事件诊断结果，不复制服务端判定规则。输出模块把结果转换成 JSON 或表格；文件模块负责纯 SDK 配置和参考示例写入，隔离正式结果与产物内容。

建议采用独立 Node.js / TypeScript CLI 包，在工程工作区使用 pnpm 本地入口。包声明运行环境要求，提供命令帮助、类型检查、构建和核心验证入口。

建议模块结构：

~~~text
cli/
  src/
    commands/
    context/
    auth/
    http/
    services/
      projects/
      origins/
      sdk/
      events/
      data/
      queue/
      health/
    output/
    files/
    contracts/
  tests/
~~~

该结构是实现组织建议。需求与设计文档保存在 Plan，使用手册随 CLI 包提供。独立发布与全局安装后续处理。

### 1.3 命令公共规则

首版命令名暂定为 bm；可以替换命令名称，功能语义和数据含义保持一致。

--base-url 明确平台地址，--project 明确项目 ID，--context-dir 指定业务上下文目录。--format 支持 json 或 table，默认 json。

--request-timeout 控制单请求时间，默认 10 秒；--command-timeout 控制普通网络命令总执行时限，默认 30 秒。--max-output-bytes 控制输出预算，默认 1 MiB。参数必须能够通过帮助信息发现并明确单位。

所有需要项目的命令在解析上下文后检查项目身份。缺少必要身份时，不自动选择名称匹配项或唯一列表项。

参数在发起请求前校验。所有命令经过上下文解析、凭据附加、资源服务、结果转换四个公共步骤；纯本地输入错误不请求平台。平台仍是权限判断来源，本地上下文和角色缓存不能授予访问能力。

JSON 模式下 stdout 只输出一个结果对象，stderr 输出日志与提示，退出码供脚本判断。具体格式由 FR-11 定义。SDK 文件写入纯配置，不能写入结果包装。

### 1.4 请求、重试与写入恢复

普通网络命令总预算默认 30 秒，单请求默认 10 秒。GET 最多重试两次，总请求不超过三次，只针对暂时网络问题、429 和临时服务端错误。Retry-After 与退避不得超过剩余预算。

交互密码输入阶段不计入网络预算；非交互缺少输入直接返回错误。等待命令使用自己的总预算，不再嵌套一个可无限延长的命令预算。

POST/PUT 首版不自动重试未知结果。服务端返回明确失败时按失败处理；请求已发出但响应丢失、写响应无法可靠解析时使用 WRITE_OUTCOME_UNKNOWN。若已获得对象 ID 等部分证据，保留并提供回查方向。

项目创建、来源更新、文件导出分步骤执行，不设置一个掩盖中间结果的假事务。后续失败不自动重新创建或删除成功项目。

如果未来增加自动创建重试，需要服务端幂等键、同请求结果复用和到期规则，不能仅凭 appName 判重。

HTTP 客户端统一映射认证、授权、参数、网络和服务端错误。响应不符合必要契约时返回 API_CONTRACT_INVALID，保留调用目标及可知请求标识，不替缺失字段猜默认值。平台没有某项必需能力时返回 CAPABILITY_UNAVAILABLE。

读取重试由公共 HTTP 客户端管理，资源服务不能再次叠加自己的无限重试。等候编排把剩余预算传入客户端，任何退避或新请求都必须受截止时间约束。

创建、更新、文件输出分别保留结果。首版没有跨平台与本地文件的分布式事务；公共恢复规则不执行自动回滚、删除新项目或重复创建。

### 1.5 平台接口与数据来源规范

以下为规范接口建议，适配层可以映射等价路径。P 表示 /api/v1/projects/:projectId。

| 接口 | 职责 |
| --- | --- |
| POST /api/v1/auth/login | 返回会话与 CSRF |
| GET /api/v1/auth/me | 当前身份与会话有效性 |
| POST /api/v1/auth/logout | 撤销会话 |
| GET/POST /api/v1/projects | 项目列表与创建 |
| GET P | 项目详情、来源、键与 DSN |
| PUT P/origins | 校验 Owner 与 CSRF，整体替换允许来源 |
| PUT P/origins | 整体保存来源集合 |
| GET P/events | 原始事件检索与分页 |
| GET P/diagnostics/events/:eventId | 单事件阶段证据 |
| GET P/diagnostics/data | 当前原始数据概况 |
| GET P/diagnostics/queue | 精确队列与失败信息 |
| GET /health/live、GET /health/ready | 存活与依赖就绪 |

三个诊断接口需要真实的服务端查询能力，不能在 CLI 中仅用多个不完整计数拼接。所有项目读取校验项目访问，来源修改要求 Owner，并校验 CSRF。

路径是适配建议。接口响应的必要字段、数据来源和语义由各 FR 方案定义；实际平台路径不同可以映射，实际平台缺少证据则需要服务端补齐。管理员在规范层对应 Owner 或平台等价的配置管理角色。

所有服务端数据时刻采用带时区时间并归一化为 UTC。数据库 asOf 由服务端提供；客户端 requestedAt 只说明请求发起时刻。多个数据来源分别标明时刻，不能包装成一个不存在的全局快照。

## 2. 逐功能技术设计

本章与需求文档的功能编号和名称逐项对应。每项先确定责任，再给出执行逻辑；公共规范已经定义的能力复用实现，功能特有的规则在本节展开。

### 2.1 FR-01：选择平台并管理项目上下文

**入口与模块。** ContextResolver 负责参数和目录上下文解析，ContextStore 负责非敏感文件保存。所有命令复用解析器，project use 触发项目验证及保存。账号操作、健康检查、项目列表和项目创建只要求平台；操作已有项目的命令要求项目 ID。

~~~text
bm project use PROJECT_ID [--context-dir DIRECTORY]
bm COMMAND [--base-url URL] [--project PROJECT_ID] [--context-dir DIRECTORY]
~~~

**数据与覆盖规则。**

业务目录 .browser-monitor.json：

~~~json
{
  "schemaVersion": 1,
  "baseUrl": "http://localhost:8080",
  "projectId": "00000000-0000-4000-8000-000000000001"
}
~~~

平台优先级为显式 --base-url、指定上下文、本地默认 http://localhost:8080。项目优先级为显式 --project、同平台上下文。

--context-dir 默认当前工作目录，不从无关目录猜测项目。显式平台不同于上下文平台时，不继承旧项目，要求明确项目身份。角色信息不作为本地授权依据，每次由服务端校验。

上下文文件写入前验证项目可访问。输出文件路径相对调用工作目录解析，独立于上下文目录，避免隐式改变文件落点。

平台地址必须为 HTTP(S) URL，拒绝内嵌账号密码、查询串和片段。规范化协议、主机、默认端口和末尾分隔符，用于上下文比较及会话隔离；不把 localhost 与其他主机名擅自视为同一平台。

**执行步骤。**

1. 读取参数和指定目录上下文，检查文件版本及字段结构。文件损坏直接返回上下文错误，不静默丢弃后使用另一平台。
2. 先解析 baseUrl，再判断项目是否可从同平台上下文继承。显式 --project 优先；没有项目且命令不需要项目时继续，否则返回 CONTEXT_MISSING。
3. project use 调用项目详情接口验证目标可访问。读取成功后通过临时文件及替换写入上下文；平台失败时不改文件。
4. 形成不可变 ResolvedContext，包含 baseUrl、projectId 和参数来源。后续资源服务直接消费该对象，正式结果附上实际目标。

**异常与验证。** 覆盖规则、跨平台切换、损坏文件、缺少项目、平台拒绝访问以及写文件失败分别验证。保存上下文是本地写入，验证项目通过但保存失败时返回可访问事实与文件失败信息。检查输出路径相对工作目录解析，不能因指定上下文目录而移动产物位置。

### 2.2 FR-02：登录、检查身份与退出

**入口与模块。** AuthService 调用认证接口，CredentialStore 管理按平台分隔的会话，HTTP 客户端附加 Cookie 与 CSRF。

~~~text
bm auth login --email ACCOUNT [--password-stdin]
bm auth status
bm auth logout
~~~

交互终端可以隐藏输入密码；非交互调用需要 --password-stdin 或等价受控输入，没有输入直接返回错误。密码不放在命令参数、普通日志或持久记录中。

**会话与认证协议。**

会话保存于用户目录 .browser-monitor/credentials.json，使用归一化平台地址作为隔离键。记录包括账号非敏感身份、认证 Cookie、CSRF、实际 expiresAt 与 schemaVersion。

只保存必要管理凭据，密码不持久化。文件限制当前用户访问，不能进入业务目录或 SDK 配置。会话写入应避免中途失败留下损坏文件。

到期时间来自平台返回值，例如登录 Cookie 的到期属性。未知时间保存 null，通过身份接口检查，不猜测固定有效期。服务端返回会话失效时清除或标记本地记录并返回 AUTH_EXPIRED，不保存密码进行隐式重新登录。

管理读取携带 Session Cookie，改变状态的管理请求再携带 CSRF。平台负责验证会话、项目访问与管理员角色。

不同平台不共享管理凭据。跨平台重定向不得附加认证信息。原始事件中的文字始终作为数据返回，不拼接成命令或作为自动执行指令。

退出先尝试远端撤销，并清除本地使用记录。明确区分远端确认撤销、服务端已确认会话失效和远端结果未知；本地清除不等同于远端确认。

**执行步骤。**

1. 登录请求只使用调用者本次提供的账号密码。适配器从成功响应、认证 Cookie 与 CSRF 信息建立会话；必要凭据缺失则返回契约错误。
2. 保存会话成功后返回账号、平台和可知到期时间。登录已建立但本地保存失败时返回局部成功，说明后续命令暂时不能复用身份。
3. auth status 调用身份接口核实当前会话。没有本地身份返回 AUTH_REQUIRED；平台确认失效返回 AUTH_EXPIRED 并清除或标记本地记录。
4. auth logout 在预算内尝试远端撤销，并清除本地记录。结果包含 localCleared、remoteRevocation 和可知错误。远端结果未知时不宣称已撤销；本地清除失败同样明确返回。

**异常与验证。** 验证不同平台会话不会混用、到期未知不猜测、普通命令遇到过期不会自动提示登录，以及密码不落盘。退出覆盖远端成功、服务端已确认失效、网络未知和本地清除失败。凭据文件在 Windows 使用当前用户访问权限或等价系统保护，不能依赖业务仓库忽略规则保护凭据。

### 2.3 FR-03：查询、创建并选择项目

**入口与模块。** ProjectService 负责列表、详情和创建；选择项目通过 FR-01 的 project use 完成。

~~~text
bm project list
bm project get [--project PROJECT_ID]
bm project create --display-name NAME --app-name APP_NAME
bm project use PROJECT_ID
~~~

**接口与数据。** 列表读取 GET /api/v1/projects，详情读取 GET P，创建调用 POST /api/v1/projects。列表至少标准化 id、displayName、appName、enabled、role；详情增加 origins、keys 及接入信息。缺少字段时不能自行补成项目启用或管理员角色。

显示名称 trim 后 1–120 字符；应用标识 trim 后 1–128 字符，允许字母、数字、点、下划线和连字符。显示名称与应用标识都不作为唯一选择或幂等判断依据。

请求包含 displayName、appName。服务端校验后持久化项目及必要接入对象，返回明确项目 ID、最终保存值、调用者角色和接入信息。

创建成功的返回必须来自服务端确认。CLI 允许随后回查详情，但没有实际执行回查时，不标记“已验证数据库读取”。平台读写可见性存在延迟时，在回查结果中说明。

首版不假设创建幂等。网络异常发生在请求发出之后时，返回 WRITE_OUTCOME_UNKNOWN。名称与应用标识可能重复，因此列表中找到同名项也不能自动证明就是本次创建。

**执行步骤。**

1. 读取列表或详情时附加会话，由服务端限定可见项目；明确目标 ID 和访问失败结果。
2. 创建前校验名称及标识，构造一次写请求。服务端应把项目与必要接入对象一致保存，返回创建对象身份及最终值。
3. 适配器校验成功响应包含可靠 ID。只取得部分身份时保留可知事实；没有可靠确认则按写结果未知处理。
4. 创建结果不自动覆盖业务目录默认项目。调用者可以单独 get 回查或 use 保存默认项目，这两个步骤的失败不能触发重新创建。

**异常与验证。** 验证真实创建后可以按 ID 回查；验证同名项目仍可明确区分。模拟请求已发出而响应丢失，确认没有自动重试创建。权限错误沿用平台资源可见性策略；服务端确认写入不等于 CLI 已执行独立回查，两者分别表达。

### 2.4 FR-04：查看并设置业务来源

**入口与模块。** OriginService 读取项目详情中的来源，或调用来源更新接口。此功能不推断业务端口，也不提供未经并发控制的隐式追加。

~~~text
bm origins get
bm origins set --origin ORIGIN [--origin ORIGIN ...]
~~~

**接口与规则。** origins get 可从 GET P 取得来源；origins set 使用 PUT P/origins。每项为 HTTP(S) Origin，按协议、主机和端口归一化、去重，集合 1–50 条。明确拒绝非法 URL；归一化后展示实际提交集合。

请求示例：

~~~json
{
  "origins": [
    "http://localhost:5173",
    "https://business.example.com"
  ]
}
~~~

服务端以事务或等价原子机制整体替换来源集合，返回实际保存集合。CLI 不能仅回显请求数组作为写入证明。

整体替换表达调用者完整设置意图。若未来提供增删单项，应引入单项 API 或版本控制，不将读取后合并再 PUT 视为原子增删。

**执行步骤。**

1. 解析项目、会话及完整来源集合，完成输入校验；错误发生在请求之前时不改变平台数据。
2. 携带 CSRF 提交整体替换，由平台校验 Owner 权限。
3. 平台在一个原子写入中保存集合，响应返回最终 origins。CLI 校验并输出该集合，不能只用本地数组构造成功证明。
4. 调用者可以再次 get 回查；PUT 响应丢失时返回 WRITE_OUTCOME_UNKNOWN，并建议用 get 查看实际集合。

**异常与验证。** 验证整体替换会移除不在新集合中的旧项、重复来源归一化、协议和端口差异，以及权限不足。并发更新首版仍采用整体替换语义；后续增删命令需服务端单项操作或版本控制，避免客户端读取合并覆盖他人更新。

### 2.5 FR-05：导出 SDK 配置 JSON 与接入示例

**入口与模块。** SdkExportService 使用 ProjectService 取得接入信息，ConfigBuilder 生成纯配置，ExampleBuilder 生成示例，ArtifactWriter 负责文件保护与写入。

~~~text
bm sdk export --app-version VERSION --environment ENVIRONMENT
  [--key-id KEY_ID] [--out CONFIG_FILE]
  [--example-out EXAMPLE_FILE] [--overwrite]
~~~

**数据与产物。**

project get 的标准化契约应包含 enabled、appName 和 keys；每个键包含 id、active、expiresAt、dsn，以及可展示的标签。

默认筛选 active=true 且 expiresAt=null 的当前写入键。恰好一个时采用；零个返回 KEY_UNAVAILABLE，多个返回 KEY_AMBIGUOUS。显式 --key-id 需要键启用且尚未到期，过渡期到期时间返回在元数据中。

配置示例：

~~~json
{
  "app": {
    "name": "demo-web",
    "version": "1.0.0",
    "environment": "development"
  },
  "transport": {
    "dsn": "http://localhost:8080/ingest/example-project-key"
  }
}
~~~

DSN 是示例占位地址，实际必须原样使用平台返回值。app 三个字符串 trim 后非空，上限为 128、64、64。version 不限定 semver，environment 不固定枚举。

文件只包含 SDK 可序列化选项。函数通过示例补充，示例应解释 JSON 加载、配置传入、SDK 初始化和启动，不自动注入业务入口。

文件输出采用 UTF-8。写入前检查路径与覆盖意图，单文件通过临时文件和替换避免残缺内容。多个产物写入若部分成功，保留成功文件清单并返回 PARTIAL_SUCCESS，不能隐式删除已成功产物。

没有 --out 时，把配置放入结果 data.config。没有 --example-out 时，把接入说明或示例文本放入 data.example；指定输出路径时返回实际文件路径和生成状态。--overwrite 只允许覆盖本次显式目标。

**执行步骤。**

1. 检查环境、版本及目标路径。两个输出目标不能指向同一文件，输入缺少时不使用示例默认值。
2. 取得项目 enabled、appName 和 keys。项目禁用立即结束；默认键或显式键按有效性规则选择，并记录键身份与到期限制。
3. 生成仅含 SDK 支持字段的配置，再生成加载 JSON、初始化、启动采集及补充函数的示例。保持平台 DSN 原值，不按 CLI 端口重写。
4. 预先检查可发现的文件冲突，再逐文件写入。不能承诺两个文件原子成功；写入竞态或后续错误时保留已生成路径。
5. 正式结果返回项目、键、配置来源、产物和警告。业务接入者自行把示例应用到业务入口；CLI 不执行示例或注入业务文件。

**异常与验证。** 覆盖无当前键、多个当前键、过期或停用显式键、项目禁用、路径冲突及单文件成功。用 SDK 的配置契约校验 JSON，检查不混入会话、CLI 包装或函数；真实接入验证 DSN 来自目标项目。

### 2.6 FR-06：检索数据库中的原始事件

**入口与模块。** EventQueryService 负责条件标准化与分页，CursorCodec 负责条件绑定，API 适配器读取 GET P/events。

~~~text
bm events list [--from TIME --to TIME] [--limit COUNT] [--cursor CURSOR]
  [--type TYPE] [--name NAME] [--event-id EVENT_ID]
  [--environment ENVIRONMENT] [--version VERSION]
  [--route-name ROUTE] [--session-id SESSION_ID] [--view-id VIEW_ID]
  [--include-payload]
~~~

**查询规则。** 默认时间轴是事件发生时间，不是接收时间。首次调用未给 to 时用本次调用时间；未给 from 时取 to 前 24 小时。单页默认 50，最大 100；参数单位及支持过滤条件写入帮助信息。

首次列表查询冻结 from、to，默认使用调用时确定的过去 24 小时，区间 [from,to)。日期必须包含时区，CLI 归一化成 UTC；要求 from < to。

方案最大查询跨度为 180 天，适配平台限制更短时明确返回支持范围。不能静默裁剪。原始保留策略另行说明，查询跨度不代表数据库保存时长。

服务端采用稳定排序和 keyset 分页，例如按 occurredAt、eventId 倒序；存在同键多条的实现应增加稳定唯一排序键。每页返回 items 和不透明 serverCursor。

CLI 可封装自己的游标，保存协议版本、服务端游标、平台项目身份、固定时间和筛选指纹。续页恢复同一范围，校验条件兼容及游标结构。非法游标不能退回第一页。

固定时间窗口不等于完整快照。迟到写入或保留清理仍可能影响分页，结果应说明没有快照保证。首版不提供无界 --all 遍历，调用者按页继续。

默认摘要包含 eventId、occurredAt、receivedAt、type/name、environment、version、routeName、sessionId、viewId，以及可用关联身份。字段无法取得时按契约返回 null 或明确缺失，不编造内容。

**真实业务事件的定位方案。** 接入说明和验收输入记录一份业务事件定义，至少包括 eventDefinitionId、业务动作、触发条件、type/name、路由、必要属性或指标、上报时机和身份关联规则。该定义由业务接入者维护，供人、AI 或验收驱动使用，不增加 CLI 的业务规则推断能力，也不引入新的必需配置文件或命令。

查询先用现有参数限定实际项目、type/name、environment/version、routeName 与带时区的 [from,to)，已知 sessionId / viewId 时一并限定。采集请求中实际存在的 eventId 可以使用 --event-id 查询。traceId、spanId 或业务关联属性在已授权返回内容中核对，首版不因此增加 --trace-id 或属性过滤参数。返回存在多个候选时，由调用者按独立操作/采集证据消歧，再把 projectId/eventId/occurredAt 传给诊断与等待。

普通业务事件的名称无需带 runId，属性也无需包含 acceptanceRunId。runId 用于验收产物分批；同一次业务动作的关联来自实际 session/view/trace/业务标识及事件身份。事件从何处上报与本次动作是否对应，要分别记录依据。SDK 发送调用不证明落库，数据库读取不证明处理完成，领域记录可见也不自动证明某次业务动作成功。

--include-payload 返回平台已脱敏 event。平台若支持字段裁剪，优先在 API 层减少响应；不能因为 CLI 只展示摘要就认定平台返回内容已脱敏。

列表元数据包含实际发送范围、筛选、条数、是否仍有后续页和 cursor。服务器没有返回数据快照时，asOf 为 null，并说明 freshness 未知；客户端请求时间另存 requestedAt。

**执行步骤。**

1. 无游标时生成有效查询条件并冻结范围；有游标时恢复平台、项目、时间、筛选和服务端位置。
2. 续页未重给过滤参数时使用游标中的原条件；显式重给条件与原条件不一致时返回 INVALID_CURSOR 或参数冲突，不发出一个混合查询。
3. 请求平台在权限范围内读取一页，校验记录、分页字段及必需身份；服务端空页作为正常事实。
4. 适配器转换事件字段，按需返回已脱敏 payload，封装下一页游标及查询范围。结果整体超预算时交给 FR-11 返回错误。
5. 后续诊断使用 eventId 和必要 occurredAt，不把列表默认窗口带入诊断。

**异常与验证。** 验证筛选正确、默认时间冻结、连续页顺序、游标损坏及跨项目误用。构造相同排序值、迟到记录和清理场景，明确首版稳定分页仍不保证全程快照。平台不支持某筛选或范围时返回明确不足，不静默忽略。

### 2.7 FR-07：查看原始数据的当前概况

**入口与模块。** DataSummaryService 调用 GET P/diagnostics/data；此功能不在 CLI 中遍历事件页计算总数。

~~~text
bm data summary
~~~

**数据口径。**

diagnostics/data 读取项目当前保留原始事件，返回 retainedRawEventCount、latestReceivedAt、retentionPolicy、asOf。计数覆盖全部当前保留记录，不继承事件列表的默认时间窗。

计数与最大接收时间使用同一数据库快照。空项目返回 0 和 null。接口只读实际记录，不从缓存累计接收量推算，也不把领域样本数加入原始数量。

原始数据接口按调用取得新的查询快照，不默认复用旧结果。读取超时作为查询失败返回，不能用上次数量或零替代。

**执行步骤。**

1. CLI 确定项目并发起新读取，不继承 events list 的筛选或默认时间范围。
2. 平台验证项目访问，在同一数据库快照中统计当前原始记录总量与最大 receivedAt，并取得部署保留策略。
3. 返回 retainedRawEventCount、latestReceivedAt、retentionPolicy、asOf 和 source=database。空记录的最近时间为 null。
4. CLI 检查非负数量、时间与来源，使用 FR-11 格式返回。调用者每次重新执行均取得新的服务端查询结果。

**异常与验证。** 如果部署无法确定保留期限，retentionPolicy 明确未知并解释；不能填入参考默认值。若数据库统计读取失败，返回查询错误，不用缓存累计接收量、领域记录量或零替代。准备累计接收量和保留量不同的样本，验证不会被合并或自动解释为丢失。

### 2.8 FR-08：诊断单条事件的完整处理情况

**入口与模块。** EventDiagnosticService 调用 GET P/diagnostics/events/:eventId；CLI 消费服务端证据，服务端负责跨记录关联。

~~~text
bm events diagnose --event-id EVENT_ID
  [--occurred-at TIME] [--include-payload]
~~~

**事件定位与关联。**

事件以 projectId、eventId 及必要的 occurredAt 定位。先查全部当前保留候选；多个候选返回 AMBIGUOUS_EVENT 与候选时间，要求补足发生时间。

领域实体按其业务身份关联：性能类使用样本标识，页面类使用访问标识，自定义事件使用事件身份。性能样本可能被修订，不能仅按本次事件时间等值查询判断处理失败。

原始记录不存在时，仍可查询任务等可用独立证据，但无法解析领域身份的情况应返回 unknown，不将“没有查询依据”当作领域记录一定缺失。

**阶段数据契约。**

示例表示原始记录与领域处理证据存在，但任务当前仍待重试：

~~~json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "event": {
    "eventId": "00000000-0000-4000-8000-000000000002",
    "occurredAt": "2026-10-13T02:00:00Z",
    "receivedAt": "2026-10-13T02:00:01Z",
    "type": "event"
  },
  "raw": {
    "recordState": "present"
  },
  "processing": {
    "state": "committed",
    "processedAt": "2026-10-13T02:00:02Z"
  },
  "task": {
    "recordState": "present",
    "taskId": "00000000-0000-4000-8000-000000000003",
    "status": "pending",
    "attempts": 2,
    "availableAt": "2026-10-13T02:00:08Z",
    "lockedAt": null,
    "completedAt": null,
    "lastError": "后续步骤未完成"
  },
  "projection": {
    "visibility": "visible",
    "eventEffect": "unknown"
  },
  "history": {
    "limitations": []
  },
  "asOf": "2026-10-13T02:00:04Z"
}
~~~

processing.state=committed 表示有持久处理提交证据；notObserved 表示原始记录存在但尚无提交证据；unknown 表示证据不足。raw.recordState 与 task.recordState 表达当前是否存在，不承诺历史。

projection.visibility 为 visible、missing 或 unknown。eventEffect 在没有持久处理效果证据时为 unknown，不能根据实体可见就声称本事件改变了实体。

原始写入、领域处理、任务完成和后续缓存可能在不同事务或步骤中发生。平台必须提供各阶段事实，不能由 CLI 用其中一个字段代替全部阶段。

合法去重、旧修订或没有指标的事件可以完成处理而不新增对应领域行。处理是否生效和处理事务是否提交是不同问题。

记录保留策略由平台声明，方案可参考原始明细 30 天、完成任务 7 天，实际以部署配置为准。没有任务归档证据时，不能从任务缺失推导历史 completed。

原始缺失不能区分未接收、清理或删除。需要历史结论时，平台必须增加相应审计或归档能力，这不作为首版诊断已知事实。

诊断关键数据库证据应来自单条查询或同一事务快照，返回服务端 asOf。跨存储信息注明各自来源与时刻，不假装全局原子快照。

**执行步骤。**

1. 校验事件 ID 与可选发生时间，按全部保留范围请求诊断，不加最近 24 小时过滤。
2. 服务端先确定候选。多个候选返回身份歧义及候选时间；原始缺失时继续读取独立任务证据，并说明领域身份是否可解析。
3. 原始唯一时关联处理提交证据、任务及领域实体；在同一快照下返回能取得的数据库阶段，跨存储数据另标来源。
4. CLI 原样保留阶段区别，输出 raw、processing、task、projection 和 history。--include-payload 只增加平台允许查看的脱敏内容，不改变诊断判断。
5. 单次诊断读到失败、缺失或未知仍是成功取得事实。平台查询失败、权限拒绝或身份歧义才进入对应错误协议。

**异常与验证。** 验证旧修订和合法 no-op 不要求新增领域行；验证领域可见不能证明本事件实际生效。验证处理已提交但任务待重试、任务被清理、原始缺失及同 ID 多候选。查询无法支持必要证据时明确返回能力不足，不补出完成状态。

### 2.9 FR-09：查看当前任务数量与队列状态

**入口与模块。** QueueDiagnosticService 调用 GET P/diagnostics/queue。分类由平台使用同一 asOf 计算，CLI 不根据各接口不同时刻的零散数量拼接。

~~~text
bm queue status
~~~

**分类数据。**

分类使用统一 asOf；lockTimeout 由平台配置提供，方案参考 300 秒。

| 字段 | 条件 |
| --- | --- |
| pendingTotal | status=pending |
| readyPending | pending 且 availableAt <= asOf |
| delayedPending | pending 且 availableAt > asOf |
| pendingUnclassified | pending 但 availableAt 缺失或无法分类 |
| processingTotal | status=processing |
| processingActive | processing 且 lockedAt >= asOf - lockTimeout |
| processingStale | processing 且 lockedAt < asOf - lockTimeout |
| processingUnclassified | processing 但 lockedAt 缺失或无法分类 |
| failed | status=failed，停止自动处理 |
| deadLetters | 死信记录数，与 failed 可能重叠 |
| processedLastMinute | 完成时间落在 asOf 前一分钟内的任务记录数 |

pendingTotal 应等于 readyPending、delayedPending 与 pendingUnclassified 之和；processingTotal 应等于三个子类之和。正常数据的 pendingUnclassified 为 0；若必需计划时间缺失，计入该异常类别并说明原因，不强行放进到期或退避类别。

processingActive 只说明锁未超时，不构成 Worker 心跳。首次失败后等待重试的任务仍属于 pending，不计为终止处理的 failed。

**失败列表与其他来源。**

recentFailures 返回最近失败身份、事件关联、错误、重试信息和记录时间。首版默认最多 20 条，返回列表限制与是否还有未展示记录。完整失败分页后续扩展，不能将该列表称为所有失败。

采集 accepted、duplicate、rejected 以及最近接收量属于独立统计，返回 source、统计范围和可知观察时间。若来自非数据库计数存储，还应说明保留或遗漏边界。

遥测 Outbox 与其他任务类型分别统计，队列字段默认项目级，不将环境过滤伪装成任务过滤。平台全局统计需要单独授权与契约。

**执行步骤。**

1. 平台校验项目访问，建立项目遥测队列的统一统计范围与查询时刻。
2. 在同一快照中统计 pending 及其三个分类，processing 及其三个分类，失败与近期完成数量；lockTimeout 取平台实际配置。
3. 查询有界 recentFailures，返回总量与列表展示限制。failed 与 deadLetters 重叠关系必须说明，不能由 CLI 相加成新的总数。
4. 如果返回采集计数或其他队列类型，分别形成有来源、时间和范围的子结果，不覆盖遥测数据库统计。
5. CLI 校验子类合计，显示异常分类及局部证据限制；无法读取核心队列时返回查询失败，不补成空队列。

**异常与验证。** 构造到期与未到期边界、锁刚好达到超时边界、缺失时间、失败与死信重叠以及其他任务类型。验证参考锁时限不会代替部署配置，processingActive 不被解释成 Worker 心跳，近期失败列表不会声称是全量。

### 2.10 FR-10：在有限时间内等待指定事件处理完成

**入口与模块。** EventWaitOrchestrator 复用 FR-08 服务与公共 HTTP 客户端，使用单调时间维护预算。服务端 UTC 时间只用于解释数据事实。

~~~text
bm events wait --event-id EVENT_ID [--occurred-at TIME]
  [--timeout DURATION] [--interval DURATION]
~~~

**条件与预算。**

等待默认 60 秒，间隔 2 秒，可显式覆盖；总时限为正，间隔至少 1 秒。使用单调计时维护本地预算，服务端 UTC 时间用于解释事实。

每次轮询调用诊断接口。完成条件为同一响应内 processing.state=committed 且 task.recordState=present、task.status=completed。领域记录是否新增不参与判断，聚合或缓存可见也不参与首版条件。

failed 立即返回 PROCESSING_FAILED。处理已提交但任务记录 missing 返回 HISTORY_INCOMPLETE。多事件候选返回 AMBIGUOUS_EVENT。正常待处理或未出现继续到截止，返回 WAIT_TIMEOUT。

每次请求超时限制为单请求配置与剩余时间的较小值。请求、读取重试、退避和轮询间隔计入总预算；到期后不再发起新请求。

故障导致无法取得新结果时，说明本次查询故障及最后有效观察时间。不能把旧诊断当作截止时刻的新状态。终止结果带 polls、elapsed、lastObservation 及结束原因。

完成是对应查询时刻的证据。后续缓存处理失败可能改变任务状态，首版不承诺未来状态永远不再变化。

**执行步骤。**

1. 校验总时限和间隔，保存 monotonic deadline、polls=0 与空 lastObservation。首次诊断立即发出，不先睡一个间隔。
2. 发起诊断前检查剩余预算，把本次最大请求时间限制到剩余时间内。读取重试及退避由同一预算控制。
3. 成功响应更新最后有效观察及其 asOf；按完成、终止失败、历史不足、身份歧义、继续等待判定。没有达到条件不触发任何平台写操作。
4. 请求故障可在剩余预算内按公共规则有限重试，耗尽后以查询故障结束。保留旧观察时标注其原始时刻。
5. 仍需等待时睡眠不超过剩余时间，到期不发新请求。输出结束原因、polls、elapsed、lastObservation 和最后观察时间。

**异常与验证。** 单次诊断发现 task.failed 返回成功事实，但等待应退出为 PROCESSING_FAILED。原始和任务都尚未出现时可以继续观察；处理已提交而任务缺失按历史不足结束。通过可控时钟验证请求、重试、间隔均不延长总时限，并检查合法去重可满足完成条件而缓存刷新不参与判断。

### 2.11 FR-11：提供人和 AI 都能理解的结果与错误

**入口与模块。** ResultBuilder 接受各资源服务的事实与错误，JsonRenderer 与 TableRenderer 展示同一结果，ExitCodeMapper 统一设置退出码。所有命令接入这一管线。

~~~text
bm COMMAND [--format json|table] [--max-output-bytes BYTES]
~~~

**结果协议。**

stdout 在 JSON 模式只输出一份完整 UTF-8 JSON。stderr 用于日志、进度和交互提示。默认紧凑 JSON，表格模式表达相同状态、范围和限制。

统一结果示例：

~~~json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "data summary",
  "context": {
    "baseUrl": "http://localhost:8080",
    "projectId": "00000000-0000-4000-8000-000000000001"
  },
  "data": {
    "retainedRawEventCount": 42,
    "latestReceivedAt": "2026-10-13T02:00:00Z",
    "asOf": "2026-10-13T02:00:01Z"
  },
  "meta": {
    "source": "database",
    "warnings": []
  }
}
~~~

查询页增加有效范围、筛选和 nextCursor。混合来源不使用单一 database 标签，分别标记子数据来源。未知状态采用明确枚举或 null 与原因，不用零或 false 冒充已知否定。

错误返回 ok=false、error.code/message/details，必要时保留已完成步骤 data 和最后观察。管理凭据、Cookie、CSRF、密码及数据库连接串不进入正式结果。SDK DSN 作为受项目权限保护的接入产物返回，明确其采集用途，不把它当成管理身份。

**错误与退出状态。**

| 退出码 | 类别与示例 |
| --- | --- |
| 0 | 成功取得结果；包含空列表、零计数或正常诊断中的 missing |
| 2 | INVALID_ARGUMENT、INVALID_CURSOR、CONTEXT_MISSING、AMBIGUOUS_EVENT、FILE_EXISTS、OUTPUT_TOO_LARGE |
| 3 | AUTH_REQUIRED、AUTH_EXPIRED |
| 4 | PROJECT_UNAVAILABLE、OWNER_REQUIRED、PROJECT_DISABLED、KEY_UNAVAILABLE、KEY_AMBIGUOUS |
| 5 | NETWORK_UNREACHABLE、REQUEST_TIMEOUT、SERVER_ERROR、WRITE_OUTCOME_UNKNOWN |
| 6 | WAIT_TIMEOUT |
| 7 | PROCESSING_FAILED、HISTORY_INCOMPLETE |
| 8 | PARTIAL_SUCCESS |

一次诊断读到 task.failed 仍是成功获得事实；等待因此停止才使用处理失败退出码。访问受限沿用平台的不透露策略，不擅自区分资源不存在与无项目权限。

API_CONTRACT_INVALID、HEALTH_UNREADY 等接口或可用性错误使用退出码 5；CAPABILITY_UNAVAILABLE 使用 4。错误 code 与退出码是稳定协议，增加新字段保持 schemaVersion 兼容；破坏性格式变化需要新的版本和迁移说明。

**输出与文件限制。**

成功结果序列化后检查字节预算，默认 1 MiB。超限返回 OUTPUT_TOO_LARGE，并建议减少页大小或改为摘要，不能裁掉页内部分条目后使用原页游标跳过记录。

SDK 文件是纯配置，CLI stdout 是统一结果，两者不能混同。参考示例是独立文件，不执行或插入业务代码。

单文件写入尽量原子完成；不同文件不假定事务一致。出现局部成功时返回已完成路径、失败步骤和恢复方向。覆盖只作用于显式目标，不删除或移动无关业务文件。

**执行步骤。**

1. 资源服务提供 typed result 或 typed error，ResultBuilder 附加 command、context、scope、source、asOf、warnings 及分页。局部成功保留已完成 data。
2. 成功输出先序列化成 UTF-8，再计算真实字节长度；超限返回有界 OUTPUT_TOO_LARGE 错误，不截掉条目并沿用原游标。
3. JSON 直接输出完整对象；表格模式展示同样的目标、范围、事实、未知和后续页。两者不能改变业务含义。
4. 正式结果写 stdout；提示、请求日志和进度写 stderr。设置退出码后结束，非交互输入不足不转入提示流程。
5. SDK 与示例文件仍由 FR-05 写入，正式结果只记录内容或路径及生成状态。日志不会混入文件。

**异常与验证。** 默认成功结果预算为 1 MiB，显式预算参数须有可输出必要错误的最小值；错误说明有界，保留结果未知和部分成功等关键身份。验证空列表、未知、失败任务的成功诊断、等待失败、写入未知、分页和输出超限均可稳定解析；检查 Cookie、CSRF、密码与数据库连接串没有进入结果。

### 2.12 FR-12：检查平台连接与基础可用性

**入口与模块。** HealthService 使用同一平台解析和网络预算，执行多个只读检查，不要求项目上下文。

~~~text
bm health
~~~

**接口与数据。** 连接检查使用平台实际响应或明确网络故障；GET /health/live 表示服务存活，GET /health/ready 表示关键依赖就绪。管理 API 通过适配器选定的只读管理端点检查，例如 GET /api/v1/auth/me。该端点返回规范的未登录响应可以证明 API 可响应，同时单独表达认证状态，不能把 401 当成数据库未就绪。

结果包含 target、checkedAt、connectivity、managementApi、liveness、readiness、details 和 limitations。各项状态为 pass、fail 或 unknown，附上来源和原因；不包含未取得证据的 Worker 健康结论。

**执行步骤。**

1. 解析目标平台，启动普通命令总预算；必要时读取该平台会话，但没有会话仍能执行允许公开的检查。
2. 发起只读检查。明确网络不可达时保留连接错误，其余未完成项为 unknown；能够取得响应时按各端点分别判断。
3. 检查返回值是否符合各端点的已定义契约。不认识的响应作为未知或契约错误，不能只凭 HTTP 200 就给所有项通过。
4. 汇总各项数据及时间。检查均满足要求时成功；平台或依赖明确不可用时返回 HEALTH_UNREADY 及已取得事实；检查能力缺失则说明能力不足。
5. 提供继续查看队列和单事件诊断的方向。管理 API 与健康检查通过，不推导异步进程正常。

**异常与验证。** 覆盖不可连接、管理 API 失效、未登录但 API 可响应、服务存活但数据库未就绪，以及某健康接口缺失。所有检查共享总预算，不能每一项重新获得 30 秒。验证项目为空不会影响平台健康判断，服务就绪不会掩盖任务积压。

## 3. 实施与联调验证

先冻结需求含义、接口类型和公共结果协议，再实现服务端诊断与权限。CLI 按依赖顺序实现上下文和身份，随后接通项目、来源及配置导出，再完成原始数据、诊断、队列、等待和健康检查；统一输出贯穿各阶段。

各 FR 的验证要求已在对应设计方案中列明。联调还必须执行完整真实链路：在本地平台登录、创建项目、设置来源并回查，导出配置后接入发布版 SDK，按已定义的业务动作产生真实事件，再用 CLI 读取原始记录、取得数据概况、诊断处理阶段、等待完成并查看队列。

输入优先使用现有页面信号和业务埋点。为每次动作保存 action-record、事件定义和必要采集身份；通过独立数据库快照核对 CLI 返回，不把 CLI 自己的输出作为唯一预期依据。真实事件无法提供时记录输入阻塞，或准备明确标注的控制夹具验证对应边界。可选探针有单独来源标识，不是正常真实业务链路的强制前置条件。

发布 SDK 对不同信号采用不同上报时机：例如页面开始信号在视图开始时生成，自定义 Span 在 end 时形成记录。用例按对应时机设置窗口和取证步骤，不能把所有输入固定成 type=event、checkpoint=1 或 acceptanceRunId。验收驱动只比较约定字段和身份，不以地图、页面内容或业务指标算法的完整正确性作为 CLI 通过条件。

异常链路覆盖创建响应丢失、来源更新失败、会话过期、分页条件冲突、历史清理、正常 no-op、超时锁、读取故障、等待截止及文件局部成功。验证的目标是需求流程与结果含义一致，不是仅检查某个命令能够打印 JSON。

每个阶段交付可运行能力、接口契约、必要验证和独立使用说明。后续新增管理写操作与分析能力时，应增加对应 FR 及设计方案，不以调整一个泛化“管理”命令悄悄扩大首版范围。

具体阶段、依赖与 checklist 见[实施计划](监控平台CLI实施计划.md)；每项功能的验收步骤、预期、观察及证据对齐见[验收计划](监控平台CLI验收计划.md)。

## 4. 首版落地契约与部署要求

首版提供仓库内的 @cxdlogver/browser-monitor-cli 0.1.0，运行要求为 Node.js 22 或以上。仓库根目录引用这个本地包，安装后通过 pnpm --filter @cxdlogver/browser-monitor-cli exec bm 调用；直接调用已构建的 bin/bm.mjs 时，以调用目录解析业务上下文及相对产物路径。CLI 使用平台 HTTP API，运行时不持有数据库连接。

原始事件读取使用 P/events；三个诊断路径沿用第 1.5 节。每次数据库读取开启只读、可重复读事务，以数据库 transaction_timestamp 作为 asOf。数据概况、单事件阶段和队列核心统计各自属于一次独立快照；Redis 采集计数在数据库读取后单独获取，明确 source=redis、asOf=null，不能把它们描述成数据库同一原子快照。

事件窗口最大为 180 天，分页最大为 100，名称上限 128 字符，路由名上限 160 字符，环境及业务版本上限各 64 字符，事件、会话与视图身份上限各 256 字符。发生时间必须包含时区，范围采用 [from,to)。服务端游标包含版本、查询指纹、最后的发生时间与事件 ID；CLI 游标额外绑定平台、项目及原查询。迟到写入和保留清理可能影响后续页，分页不承诺跨请求快照。

Windows 会话文件限制当前用户和 SYSTEM 访问；其他平台使用 0600 文件权限。凭据变更通过独占锁与完整文件替换保存，锁占用时明确报错，避免两个调用覆盖彼此的会话。会话是否有效仍由平台核实，到期未知保存 null。业务上下文不保存 Cookie、CSRF 或密码。

SDK 示例中的路由函数使用 view.resolveRouteName(location)，JSON 引用相对于示例所在目录生成；内联示例相对于调用目录生成。两个产物使用不同目录时也必须指向实际配置文件。默认无覆盖通过完整临时文件和无覆盖链接落盘，已有文件不会被写入竞态悄悄覆盖；显式覆盖才替换目标。多文件失败保留已成功文件，不承诺两个文件原子提交。

等待默认 60 秒、间隔 2 秒，间隔下限 1 秒；单请求默认 10 秒、普通命令总预算 30 秒。等待结果保留最后有效观察的原始 asOf，另列 lastQueryFailure，避免查询故障或截止时用旧事实冒充当前状态。健康检查超时保留已经确认的阶段，尚未取得的阶段为 unknown，整体按网络类退出码 5 结束；端点能力缺失使用 CAPABILITY_UNAVAILABLE / 4。

完整输出预算为 4096–67108864 个 UTF-8 字节，默认 1048576；JSON 和表格都先检查完整结果。超限返回完整错误，data=null，不发送删减后的事件页或原游标。实际部署中的锁策略与 Worker 共用 OUTBOX_LOCK_TIMEOUT_SECONDS=300，已完成任务清理与 Worker 共用 7 天策略；原始数据的保留期限由实际 TimescaleDB retention job 查询，无法确认时保留 unknown。

部署诊断接口前执行数据库迁移 0007_diagnostics.sql，增加 outbox_tasks.last_failed_at 与近期失败查询索引。Worker 在实际失败时更新该时间，历史 last_error 没有可靠失败时刻时保持 null，不按 created_at 回填失败时间。现有 Web 原始数据接口继续保持原契约，CLI 使用上述独立检索与诊断接口。
