# 监控平台 CLI 验收计划

文档版本：1.2。编写日期：2026-10-13。状态：首版验收通过；执行批次 2026-10-13T12-18-35-945Z-2bbc01。

验收依据为[需求文档](监控平台CLI需求文档.md)和[技术设计文档](监控平台CLI技术设计文档.md)，实施顺序见[实施计划](监控平台CLI实施计划.md)。本计划逐项定义验收步骤，以及预期结果、实际观察和证据的对应关系。

本文共有 47 个独立验收项、94 条结果核对点，覆盖 FR-01 至 FR-12、公共可靠性和 CLI 真实读写流程。实时走航车和官网是配置与真实事件的数据源，验收对象始终是 CLI 功能。两业务页面、地图、模拟器、内容展示及停留时间精度不作为本计划的通过条件。下文保留全部用例与执行步骤，观察栏已填写本批次实际结果；每项通过记录均链接其命令输出、独立基准和 manifest。旧失败批次保留，完整结果见本批次验收执行记录。

## 1. 验收方式与通过条件

第 3 章的每个 AC 编号是一项独立验收；PREP 编号是执行准备，GATE 编号是最终完成检查。执行前确认前置条件，按步骤记录每次调用，再逐条填写 R1、R2 的实际观察、判定和证据。只有该项全部结果符合预期、必要产物存在且能够复查，才可以勾选通过。

观察结果不能只写“符合预期”或“测试通过”。需要记录实际返回值、状态、条数、时间、退出码、请求次数或文件变化；有多个子输入时，逐个子运行填写，任何一个失败都不能把整项标为通过。

证据需要指向具体文件和字段、记录身份、时间位置或日志段落。命令行截图可以补充人工展示，但不能代替原始 JSON、请求追踪、数据库基准或文件内容。验证写入时需要平台实际保存或独立回查证据；验证诊断时需要阶段事实，不能仅凭空队列或无报错。

验收状态为未执行、通过、失败或阻塞。首版功能项均适用；平台不支持或环境无法准备应记录阻塞，不能改成“不适用”规避。复验建立新批次或保留新尝试目录，旧失败和证据不能覆盖。

## 2. 环境、数据与验收产物

### 2.1 固定测试输入

固定输入统一读取[验收输入 JSON](监控平台CLI验收输入.json)。该文件定义明确可固定的地址、包版本、业务参数、真实事件定义、可选探针与边界输入；执行时把文件原文和 SHA-256 保存到本批次 setup/inputs.json 与 setup/inputs.sha256。下面的说明使读者无需了解业务源码，也能理解输入用途。

**监控平台。** 主平台地址为 http://localhost:8080。平台 B 是用于测试地址覆盖与认证隔离的受控独立端点，端口由执行环境分配后写入运行记录，不能假定另一端口存在真实第二套部署。首版 CLI 按独立本地包调用，文中 bm 为已构建的本地二进制简写，建议入口为 pnpm --filter @cxdlogver/browser-monitor-cli exec bm。

**实时走航车数据源。** 仓库 F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform，前端包 qhzhc-project。项目显示名称为“实时走航车项目-CLI验收”，appName=qhzhc；业务上报 version=1.0.0、environment=cli-acceptance。业务 Origin=http://127.0.0.1:9527，浏览器入口为 http://127.0.0.1:9527/#/dataVisualization，路由名为 /dataVisualization。配置导出目标为 QHZHC_Web/src/config/monitor.local.json。

**官网数据源。** 仓库 F:/CX_notes/cx-learn-notes/official-network，包 official-network。项目显示名称为“官网项目-CLI验收”，appName=guanwang；业务上报 version=1.0.0、environment=cli-acceptance。Origin=http://localhost:3000，浏览器入口为 http://localhost:3000/solution，路由名为 /solution。配置导出目标为 app/config/monitor.local.json。localhost 和 127.0.0.1 不是同一 Origin，不能随意替换。

**SDK 来源。** 两数据源都使用官方 Registry 发布的 @cxdlogver/browser-monitor-sdk 精确 0.3.0，Protocol 为 3.0.0。业务上报版本 1.0.0 不代表 SDK 版本，业务 package version 也不作为其隐式来源。2026-10-13 已核实发布元数据，实施时仍保存精确版本元数据、tarball integrity、依赖声明、父锁文件 importer 和实际模块解析路径。[SDK 元数据](https://registry.npmjs.org/@cxdlogver/browser-monitor-sdk/0.3.0)、[Protocol 元数据](https://registry.npmjs.org/@cxdlogver/browser-monitor-protocol/3.0.0)。实际解析为 workspace/link/file 或落入本地 SDK / Protocol 源码时，数据准备未完成。

**真实业务事件定义。** 固定输入 profiles.businessEvents 说明业务动作、触发、名称/类型、路由、必要字段、上报时机与身份关联。走航车主输入为 view.start / view 类型：已登录后进入或重新加载 /#/dataVisualization，建立新视图即生成；记录 app.name=qhzhc、routeName=/dataVisualization 及实际 sessionId/viewId。view.end 可补充验证同一视图结束，不将进入页面后自然出现的其他性能记录混作该事件。

官网主输入为 site.route.stay / span 类型：客户端进入 /solution，再通过应用路由切换到 /，结束上一栏目 Span 后才形成记录。期望 context.routeName=/solution、payload.attributes.section=/solution、path=/solution，visibleMs 为非负实际数值、单位 ms；traceId/spanId 按实际采集记录取得。Span 保留开始时的页面上下文，occurredAt 是结束时刻，不能把新页面路由或 Span 开始时刻作为这条记录的归属与筛选时刻。site.visit 是访问结束时形成的根 Span，作为补充信号，不要求页面刚打开就已上报。

**关联规则。** runId 只标识本批次产物，真实事件名和属性无需包含它。执行动作前保存预期定义与实际项目参数，执行后提取对应采集信封的 eventId、发生时间、sessionId/viewId 及可用 trace/业务身份。查询结果与这份独立采集依据对齐，再独立回查数据库。仅项目名、事件名或一个时间窗口不能证明是哪一次动作，存在多候选时补充身份，不取第一条冒充本次结果。

**可选验收探针。** optionalProbe 默认不启用，也不是输入准备或通过验收的必需条件。它可以在需要固定自定义内容时补充 track 事件；名称带 runId、checkpoint=1/count 的规则仅适用于这类可选输入。使用时标记 eventSource=optional_probe，说明目的、实际记录和证据；不得拿探针成功替代 AC-E2E-01 中已定义真实业务事件的查询证据。未新增探针不会使正常用例阻塞，首版不因此增加属性筛选 API。

**边界输入。** 静态分页数据固定 151 条匹配记录、单页 50，发生时间边界样本另行准备，分页上限 100、非法 limit=101；来源旧值固定 http://localhost:9000，非法来源包括 not-a-url、ftp://localhost:3000 和带 /path 的地址；创建无效名称用三个空格、无效 appName 用 invalid app name。短等待用 timeout=5 秒、interval=2 秒、request timeout=10 秒，另测试 timeout=0 和 interval=0；读取故障分别返回 503→200、连续三个 503、403 和 Retry-After=120 秒。近期失败夹具准备 21 条，验证最多展示 20 条。超长字段与超出集合上限输入依据冻结契约生成，长度记录为“实际上限+1”，不编造未知上限。

### 2.2 运行时绑定与输入准备流程

每批次生成一个唯一 runId。两个专用监控项目都通过 CLI 新建，项目 ID、keyId、DSN 以实际响应及独立回查为准，不复用旧接入配置，不根据同名项目猜测身份。新增故障夹具项目可以独立创建，但不能混淆为两个主数据源项目。

批次 setup/bindings.json 记录平台、账号角色绑定、两个 profile 的 projectId / keyId / DSN、源码版本、真实 SDK 来源及配置文件 SHA-256。event-definitions.json 固定本批次采用的业务事件定义；events.json 记录 eventSource、eventDefinitionId、动作与采集证据路径、实际 eventId/occurredAt/receivedAt/type/name、环境、版本、路由及可用 session/view/trace 身份。真实事件身份不能在计划中预设。认证账号从实际验收环境提供，记录角色与输入方式，不固定密码、Cookie 或 CSRF。事件 ID、查询时刻、保留策略和锁时限均不是静态输入。

输入准备按以下次序执行；可由同批次对应功能用例提供证据，不要求先重复执行一套创建、来源与导出命令：

1. 用管理员登录主平台，保存 CLI / 平台 / Node / pnpm 版本及实际命令入口。账号不足或平台缺少必要能力时标记相关用例阻塞。
2. 在 AC-03-01 的 qhzhc 与 official 子运行中分别创建两个项目，独立回查并保存返回身份，作为后续用例的共享批次输入。正常创建每个数据源只执行一次；故障案例使用另行声明的隔离对象。
3. 在 AC-04-01 读取旧来源、替换并回查；最终恢复为各 profile 的固定 Origin。在 AC-05-01 导出业务 1.0.0 / cli-acceptance 的 JSON 与示例，保存产物哈希。将实际配置部署到对应数据源。
4. 按实施计划的发布包安装及接入步骤改造两个监控入口，保留走航车只采集 dataVisualization 的规则，以及官网 site.visit / site.route.stay 的规则。这些接入检查只用于确认输入有效，不增加业务验收项。
5. 在两个数据源分别按事件定义执行真实动作：走航车进入或重新加载固定页面产生 view.start；官网进入 /solution 后通过应用路由切换到 /，使 site.route.stay 结束。分别保存 action-record.json，记录 profile、动作、UTC 时间范围、预期类型/名称和上报条件。捕获实际 SDK 信封身份到 capture-identity.json，保留必要脱敏字段；不以发送尝试、flush 或 HTTP 200 断言入库。
6. 按各事件定义，以实际平台/项目、明确时间范围、type/name、environment/version、route-name 和已知 session/view 身份调用 CLI 列表，include-payload 核对预期字段、实际采集 eventId 与可用关联身份。trace 或业务属性只在返回内容核对，不新增筛选参数。多个候选时补充依据，不猜选；SDK track 返回 void，身份取自实际信封或有证据支持的记录，不虚构返回值。
7. 将获取的身份用于正常查询、诊断与等待；按 case 需要另建静态数据、状态与故障夹具。记录每个夹具的生成方法、实际端点、权限、时钟和数据基准，不以自然业务事件替代可控边界。
8. 数据源构建、启动或真实业务信号采集失败导致无法提供输入时，记录“输入准备阻塞”与日志；未启用可选探针不属于阻塞。只有已提供合规输入且 CLI 行为偏离功能预期，才判定 CLI 验收失败。不能因页面功能异常直接判 CLI 不通过。

### 2.3 用例执行范围与证据复用

全部 47 项验收保留，按 CLI 功能执行，不形成两个业务各自的业务验收报告。共享夹具用例执行一次完整子输入集合即可，不把每一项机械复制到两个项目。每个用例在 run.json 声明 inputBinding、profileId 或 fixtureId、实际 projectId、平台与证据来源。事件输入的 eventSource 为 business_event、optional_probe 或 controlled_fixture；真实输入另记录 eventDefinitionId 及动作/采集身份依据，未使用探针无需其产物。

项目创建、Origin 与 SDK 导出在两个 profile 的输入准备中各执行一次，证据同时用于 AC-03-01、AC-04-01、AC-05-01 和 AC-E2E-01。这是核对 CLI 对输入的读写与参数传递，观察标准相同。AC-E2E-01 使用两个数据源各自已定义的真实业务事件，验证项目切换后的读取与身份关联；只检查这些输入的约定内容，不扩大到业务页面的完整功能验收。

事件过滤、概况、正常诊断与等待可以选择一个已绑定真实业务事件做正常子运行，其余组合、边界和状态使用共享夹具。账号、参数、文件保护、跨平台隔离、网络故障、历史缺失、分页和队列分类均按冻结契约准备完整夹具。AC-E2E-02 使用一个非交互驱动核对 CLI 授权管理及查询；AC-E2E-03 使用独立恢复夹具核对已有对象与产物能否继续使用。

共享证据必须指向本批次的具体产物文件、字段或断言，case-result.json 中使用相对路径并记录 SHA-256。不得复制“某项目整体通过”结论。已经成功创建或生成的主项目与文件不为复用证据重做；需要不同故障状态时创建隔离夹具或保存/恢复明确状态，并记录变化时间线。

下面的结构是待生成的批次输入与共享证据目录：

~~~text
Plan/验收记录/<runId>/
  setup/
    inputs.json
    inputs.sha256
    bindings.json
    events.json
    event-definitions.json
    source-packages/<profileId>/
      registry-sdk.json
      registry-protocol.json
      package.json
      lock-importer.json
      resolved-modules.json
      source-check.json
    business-integration/<profileId>/
      integration.patch
      sdk-config.json
      sdk-example.ts
      build.log
      action-record.json       真实业务动作、时刻与预期定义
      capture-identity.json     对应实际 SDK 信封的必要身份
      probe-invocation.json     仅启用可选探针时生成
    fixtures/<fixtureId>/
      definition.json
      reference-snapshot.json
  <caseId>/                 每项独立结果与证据目录，格式见 2.5
  case-index.json
  acceptance-summary.md
~~~

所有文件都是执行期产物；计划定稿不会生成通过证据。

### 2.4 执行准备 checklist

- [x] PREP-01 记录本次 CLI / 平台版本、需求 1.3 与设计 1.2 基线、运行环境及实际命令入口；基线改变时同步验收规则。
- [x] PREP-02 准备本地验收平台、隔离的数据空间、已验证账号、项目管理员和权限受限账号。
- [x] PREP-03 按两个 profile 准备发布 SDK 0.3.0 的真实事件输入，记录 registry / lock / 实际解析来源、配置哈希、业务事件定义及实际采集身份；这是输入准备，不是业务验收。
- [x] PREP-04 建立两个平台地址及业务目录夹具，记录项目、键、事件、任务、保留与锁配置的基准数据。
- [x] PREP-05 准备受控时钟、请求追踪及故障注入能力，能分别模拟读取故障、写响应丢失、历史缺失和文件局部成功。
- [x] PREP-06 确认每个用例可生成命令、退出状态、stdout、stderr、相关基准、检查报告和结果记录。
- [x] PREP-07 确认产物不复制密码、认证 Cookie、CSRF 或数据库连接串；证据脱敏不删除核对所需身份、状态和时间。

默认网络参数为单请求 10 秒、普通网络命令 30 秒；等待默认 60 秒、间隔 2 秒；列表默认最近 24 小时、50 条且最大 100；输出默认上限 1 MiB。保留期限、锁时限与平台最大查询跨度使用实际部署值，不以参考默认值充当事实。

边界用例可以使用专门测试夹具与故障注入；记录证据时标明真实平台、模拟响应或受控时钟。实际写入闭环 AC-E2E-01 必须使用真实平台、两个数据源消费的发布 SDK 0.3.0 和实际数据库记录，模拟响应不能替代该验收。

统计基准要与被测结果处于可比较时刻。可以在隔离环境冻结数据、使用同一快照或记录可解释的变更时间线；不能用稍后变化的数据库状态武断否定先前有效结果。所有预算检查使用单调时间，网络 / 轮询阶段与输出 / 退出耗时分别记录，截止后不允许再发新请求。

### 2.5 每项验收的产物目录

每次执行建立一个批次，建议位置为 Plan/验收记录/<runId>/<caseId>/。其中 runId 在真正执行时生成，caseId 使用本文 AC 编号。下面是待生成的目录规范：

~~~text
Plan/验收记录/<runId>/<caseId>/
  case-result.json           预期、观察、判定与证据映射
  run.json                   执行人、版本、目标、时间、子运行与退出码
  steps/
    <步骤名称>/
      command.txt            实际执行命令，凭据输入不记录
      stdout.json            原始 JSON 正式结果
      stdout.txt             table 或帮助等文本模式结果
      stderr.log             单独保存的日志与提示
  reference/                 平台基准、数据夹具、独立回查及请求追踪
  artifacts/                 SDK 文件、业务接入变化及事件身份
  checks/                    比对、解析、字节、时间、权限等检查报告
  manifest.json              实际产物路径、来源、生成时间和 SHA-256
~~~

每项必备 case-result.json、run.json、reference/input-binding.json、相关步骤输出和 manifest.json。本文 R1 / R2 后列出的额外产物也是该项必要证据。文件名中的 * 表示按实际子运行展开，例如 invalid-url、invalid-limit；manifest 必须列出实际文件，不允许只记录通配符。

run.json 记录每个子运行的具体命令名称、平台、项目、参数、步骤名、开始结束时间、退出码与实现版本。凭据只记录输入方式，不保存值。产物缺失、文件无法解析或版本不一致时，验收记录不能标为通过。

SDK DSN 使用专用验收项目的接入信息，核对时保留平台原值与导出值的可比较依据。管理凭据脱敏不能改变项目身份、计数、状态和时间等被验事实；检查报告说明脱敏字段与取证来源。

### 2.6 预期、观察与证据的记录格式

每项使用 R1 / R2 定位核对点。实际记录必须带 AC 编号和 R 编号，并指向可复查的文件及字段。示例只展示记录结构：

~~~json
{
  "runId": "<实际批次>",
  "caseId": "AC-01-01",
  "status": "not_run",
  "executor": null,
  "implementationVersion": null,
  "inputBinding": {
    "profileId": "qhzhc",
    "eventSource": "business_event",
    "eventDefinitionId": "qhzhc.visualization.view-start",
    "fixtureId": null,
    "projectId": "<本批次实际 ID>",
    "setupEvidence": ["../setup/bindings.json"]
  },
  "requirementsVersion": "1.3",
  "designVersion": "1.2",
  "assertions": [
    {
      "id": "R1",
      "expected": "<复制本项 R1 的预期>",
      "observed": null,
      "verdict": "not_run",
      "evidence": [
        {
          "path": "steps/default/stdout.json",
          "locator": "context.baseUrl 与 context.projectId",
          "sha256": null
        }
      ]
    }
  ]
}
~~~

执行后填写实际值与判定，为本项全部 R 编号生成记录，并把 evidence 指向真实存在的产物。预期来自冻结事件定义或夹具基准，观察来自实际 CLI 返回，身份依据来自动作及采集记录，入库和处理事实另有数据库证据；不能四者都只引用同一份 CLI 输出。若一个核对点覆盖多个输入，每个子运行均保留观察和证据，不能只记录最后一次。

## 3. 逐项功能验收

以下步骤中的 NAME、PROJECT_ID、EVENT_ID、TIME 等输入从固定输入 JSON、本批次绑定或已声明夹具中取得，实际值记录到 run.json。命令名称暂按 bm，工程冻结不同入口时更新记录与帮助。每组列出执行入口，每个用例分别记录步骤和结果，不共享一个笼统“整组通过”结论。

### 3.1 FR-01：选择平台并管理项目上下文

**执行入口。** bm project use PROJECT_ID；需要项目的命令携带 --base-url / --project / --context-dir。

#### AC-01-01：平台、项目与目录覆盖规则

- [x] AC-01-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 两个主项目用于同平台覆盖；平台 B 项目来自独立受控端点，目录使用隔离副本。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备两个平台地址和至少两个可访问项目，业务目录已有指向平台 A / 项目 A 的上下文。

**验收步骤。**

1. 记录上下文原内容与两平台项目清单，保存为 reference/context-before.json 和 reference/projects.json。

2. 不传覆盖参数执行项目读取，记录步骤 default；再显式指定同平台另一项目，记录 override。

3. 显式切换到平台 B，先不传项目记录 missing，再传平台 B 项目记录 explicit。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认调用使用平台 A / 项目 A，显式项目覆盖后使用指定项目。

**R1 · 观察结果。** 通过。默认读取的 context 为 {"baseUrl":"http://127.0.0.1:52228","projectId":"00000000-0000-4000-8000-000000000001"}；显式项目覆盖后 projectId 为 00000000-0000-4000-8000-000000000003。

**R1 · 证据对齐。** [AC-01-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 切换平台而没有新项目时返回 CONTEXT_MISSING，不能继承项目 A；提供新项目后请求平台 B。

**R2 · 观察结果。** 通过。切换平台但不指定项目返回 CONTEXT_MISSING / 2；显式平台 B 的 context 为 {"baseUrl":"http://127.0.0.1:52236","projectId":"00000000-0000-4000-8000-000000000003"}，请求在 B 端记录。

**R2 · 证据对齐。** [AC-01-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-01-02：保存项目上下文与输出目录独立

- [x] AC-01-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 可访问目标用 qhzhc 主项目，拒绝对象由权限夹具提供，目录与输出路径分别隔离。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备可访问项目、不可访问项目、业务目录和与其不同的调用目录。

**验收步骤。**

1. 对可访问项目执行 project use，记录 use；读取新上下文文件并保存 reference/context-after.json。

2. 对不可访问项目执行 project use，记录 denied；再次保存上下文内容作为 reference/context-after-denied.json。

3. 从调用目录指定其他 context-dir 导出到相对文件位置，记录 export，并保存实际文件路径清单。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 成功选择后文件只含非敏感平台与项目上下文；不可访问选择失败后原上下文保持不变。

**R1 · 观察结果。** 通过。上下文仅含 baseUrl、projectId、schemaVersion；拒绝选择退出 4，前后内容逐字相同。

**R1 · 证据对齐。** [AC-01-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 相对产物路径落在调用工作目录，不随 context-dir 移动。

**R2 · 观察结果。** 通过。context-dir 与调用目录不同；实际导出文件为 C:\WINDOWS\TEMP\bm-acceptance-0U7P9b\call-directory\monitor.json，落在调用目录。

**R2 · 证据对齐。** [AC-01-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-01-03：上下文损坏与缺少项目不能隐式选中对象

- [x] AC-01-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享单项目平台、缺失/损坏上下文目录夹具，不依赖主平台实际项目数量。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 使用只有一个可访问项目的平台，并准备缺少项目的目录和结构损坏的上下文文件。

**验收步骤。**

1. 在缺少项目的目录执行需要项目的数据查询，记录 missing。

2. 在损坏上下文目录执行查询，记录 broken，并捕获网络请求清单。

3. 在没有默认项目的目录执行项目列表、账号状态和健康检查，分别记录 list、auth-status、health。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 需要项目时明确报错，不因平台仅有一个项目而自动选择；损坏文件不被静默忽略，未发出错误目标查询。

**R1 · 观察结果。** 通过。缺少项目与损坏文件均返回 CONTEXT_MISSING / 2，参数失败阶段请求数为 0，没有自动选中单项目。

**R1 · 证据对齐。** [AC-01-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 不需要项目的命令不会因 CONTEXT_MISSING 被拒绝；其业务结果按身份和平台状态分别解释。

**R2 · 观察结果。** 通过。独立空目录中的 list、auth-status、health 均退出 0；这些调用不要求默认项目。

**R2 · 证据对齐。** [AC-01-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-01-03/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.2 FR-02：登录、检查身份与退出

**执行入口。** bm auth login --email ACCOUNT --password-stdin；bm auth status；bm auth logout。

#### AC-02-01：登录成功、会话复用与凭据保护

- [x] AC-02-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 主平台已验证管理员与 qhzhc 主项目；用户会话目录隔离，账号运行时提供。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备已验证账号及可访问项目，采用隔离的验收用户目录。

**验收步骤。**

1. 通过受控输入登录，记录 login；记录会话文件字段和访问权限，敏感值仅做存在性检查。

2. 不再输入密码执行 auth status 和项目读取，记录 status、read。

3. 检查正式输出、日志、命令记录、业务上下文及配置文件是否包含本次密码、Cookie 或 CSRF。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 登录建立有效身份，后续命令通过已保存会话访问同一平台；会话文件没有持久密码。

**R1 · 观察结果。** 通过。login、status、read 均退出 0；sessionSaved=true，后续请求复用平台 Session；凭据文件 passwordPersisted=false。

**R1 · 证据对齐。** [AC-02-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 会话文件限制当前用户访问，业务文件和输出没有管理凭据泄露。

**R2 · 观察结果。** 通过。icacls 记录确认文件无继承权限及宽泛用户组授权；所有命令 stdout/stderr 都执行了密码、Cookie、CSRF 匹配检查，匹配数为 0。

**R2 · 证据对齐。** [AC-02-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-02-02：非交互登录、会话过期与到期未知

- [x] AC-02-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享认证夹具分别返回有效、过期和到期未知会话，进程无 TTY。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备可返回有效、失效和无到期时间会话的受控认证环境，调用进程没有交互终端。

**验收步骤。**

1. 通过 password-stdin 登录并读取身份，记录 stdin-login；另执行缺少密码输入的调用，记录 no-input。

2. 让平台确认会话失效后执行普通查询，记录 expired，监测进程是否等待输入。

3. 使用没有明确到期属性的成功会话登录并检查身份，记录 unknown-expiry。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 受控输入可以登录；缺少输入立即返回错误，失效会话返回 AUTH_EXPIRED / 退出码 3，均不进入无人应答提示。

**R1 · 观察结果。** 通过。标准输入登录成功；无 TTY 且无输入返回 INVALID_ARGUMENT / 2，未请求平台；失效会话返回 AUTH_EXPIRED / 3。

**R1 · 证据对齐。** [AC-02-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 到期时间未知明确为空或 unknown，不推算固定剩余天数。

**R2 · 观察结果。** 通过。没有 Expires/Max-Age 的成功会话实际 expiresAt=null，没有推算有效天数。

**R2 · 证据对齐。** [AC-02-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-02-03：跨平台隔离与管理写入认证

- [x] AC-02-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 平台 A/B 独立认证，来源更新用隔离项目与合法固定 Origin，角色运行时绑定。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备平台 A 与 B，可监测两端认证附加情况；准备管理员及非管理员账号。

**验收步骤。**

1. 分别建立两平台会话，执行各自项目读取，记录 read-a、read-b。

2. 用管理员执行来源更新，记录 owner-write；在受控服务端检查 Session 和 CSRF 是否按契约送达。

3. 用无配置管理权限的账号提交更新，记录 denied-write，并回查来源。

4. 在受控请求中移除或替换 CSRF，分别记录 missing-csrf、invalid-csrf，回查来源并保存验证结果。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 请求只使用对应平台凭据；跨平台请求或重定向不携带另一平台认证信息。

**R1 · 观察结果。** 通过。A/B 服务端分别记录 cookieMatches=true；重定向请求未跟随，B 未增加认证请求。

**R1 · 证据对齐。** [AC-02-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 授权写请求带必要认证并成功；无权限、缺少 CSRF 或错误 CSRF 的写入被拒绝且配置未改变。

**R2 · 观察结果。** 通过。Owner 写入携带有效 CSRF；受限写入被拒绝。真实平台缺少/错误 CSRF 均返回 403，独立数据库读取确认 Origin 未变。

**R2 · 证据对齐。** [AC-02-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-03/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-02-04：退出与本地身份保存失败的部分结果

- [x] AC-02-04 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享撤销、远端不可达、本地保存失败夹具，使用独立会话目录。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备可撤销会话、远端不可达会话，以及可模拟会话文件保存失败的用户目录。

**验收步骤。**

1. 正常退出后检查本地记录，并向平台核查旧会话失效，记录 logout、verify-remote。

2. 另一次会话在远端不可达时退出，记录 logout-unreachable，检查本地清除状态。

3. 成功认证但模拟本地保存失败，记录 login-save-failed。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 正常退出分别确认本地清除和远端撤销；远端不可达时不宣称已撤销，仍说明本地实际结果。

**R1 · 观察结果。** 通过。正常退出 localCleared=true、remoteRevocation=confirmed；真实旧 Cookie 退出前 HTTP 200，退出后独立请求 HTTP 401。不可达退出为 8，localCleared=true、remoteRevocation=unknown。

**R1 · 证据对齐。** [AC-02-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 平台认证已成功但本地保存失败作为部分结果返回，不宣称会话可继续复用。

**R2 · 观察结果。** 通过。本地保存锁故障时平台已发出会话，CLI 返回 PARTIAL_SUCCESS / 8，sessionSaved=false，未声明本地会话可复用。

**R2 · 证据对齐。** [AC-02-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-02-04/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.3 FR-03：查询、创建并选择项目

**执行入口。** bm project list；bm project create --display-name NAME --app-name APP_NAME；bm project get；bm project use PROJECT_ID。

#### AC-03-01：项目列表、创建与独立回查

- [x] AC-03-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** qhzhc、official 各执行创建、回查和选择；显示名称/appName 取 profiles，两个 ID 写入 setup/bindings.json。后续不再创建主项目。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备可登录账号；业务目录已有默认项目，保留其创建前上下文。

**验收步骤。**

1. 分别读取两个 profile 的显示名称和 appName，保存业务上下文原文到 reference/context-before.json；执行 list-before。

2. 按 qhzhc、official 子运行分别调用 project create，记录 qhzhc-create、official-create；把返回 ID 写入 setup/bindings.json，不依据名称查找并复用旧项目。

3. 分别使用真实 ID 调用 get 和 list-after，步骤名使用 <profileId>-get / <profileId>-list-after；独立平台读取核查显示名称、appName 和角色，保存 reference/project-saved.json。

4. 比较每个目录在创建后的上下文，再各自执行 project use 保存选择。记录 profile 下 create/get/use 的输出路径以及创建前后上下文；后续用例引用这些产物，不重复创建主项目。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 新项目返回可靠 ID、最终名称和应用标识，详情、列表及独立平台读取指向同一对象。

**R1 · 观察结果。** 通过。受控创建返回动态 ID=68af1bd1-7411-48e1-82eb-569dc9d4d9a5，get/list/平台存储一致。两个真实主项目的创建响应、详情与独立 SQL 名称/标识核查均已保存。

**R1 · 证据对齐。** [AC-03-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 创建本身没有更改默认项目；明确 use 后才保存新项目上下文。

**R2 · 观察结果。** 通过。创建前后上下文内容相同；显式 use 后上下文保存新 ID。两个真实主项目分别完成了 use，文件只保存平台与项目身份。

**R2 · 证据对齐。** [AC-03-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-03-02：重复名称与无效创建参数

- [x] AC-03-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享同名与非法参数夹具：CLI重复名称夹具、三个空格、invalid app name，以及冻结上限+1的超长值。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备允许出现重复名称的项目样本，及名称和应用标识的边界输入。

**验收步骤。**

1. 读取同名项目清单，逐个按 ID 查询，记录 duplicate-list、get-a、get-b。

2. 提交空白、超长或非法应用标识等无效创建输入，逐次记录 invalid-*。

3. 记录请求数量和创建前后项目清单。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 同名项目可以分别读取，名称不被当作可靠唯一身份或自动复用依据。

**R1 · 观察结果。** 通过。两个同名样本分别通过 ID 读取，distinct ID 数为 2，没有按名称复用。

**R1 · 证据对齐。** [AC-03-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 输入校验明确拒绝无效值，未发出创建写请求，平台对象清单没有增加。

**R2 · 观察结果。** 通过。空白、121 字符名称、129 字符 appName 与非法 appName 均退出 2；这些输入未增加请求，项目数仍为 2。

**R2 · 证据对齐。** [AC-03-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-03-03：创建响应丢失和后续步骤失败

- [x] AC-03-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 独立创建故障对象，控制响应丢失和后续 get/use 失败，不复用两个主项目。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 使用能保存创建请求但丢弃响应的故障注入环境，保留原始请求与真实保存记录。

**验收步骤。**

1. 只发起一次创建调用并丢弃返回，记录 create-lost。

2. 独立读取平台对象和请求清单，确认是否已经保存。

3. 另一次正常创建后，使 get 或 use 失败，记录 create-ok、followup-failed。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 响应丢失返回 WRITE_OUTCOME_UNKNOWN / 退出码 5，创建写请求只有一次，不自动重试或依据同名项宣称成功。

**R1 · 观察结果。** 通过。响应丢失实际为 WRITE_OUTCOME_UNKNOWN / 5；创建 POST 计数为 1，服务端仍保存了对象。

**R1 · 证据对齐。** [AC-03-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 后续回查或本地选择失败保留已创建身份，不重建或删除成功项目。

**R2 · 观察结果。** 通过。回查成功后在本地保存阶段制造故障，use 返回 PARTIAL_SUCCESS / 8，保留 projectId；全过程仍只有一次创建。

**R2 · 证据对齐。** [AC-03-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-03-03/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.4 FR-04：查看并设置业务来源

**执行入口。** bm origins get；bm origins set --origin ORIGIN，可重复提供 --origin。

#### AC-04-01：读取、归一化与整体替换来源

- [x] AC-04-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 两个主项目分别执行；旧 Origin=http://localhost:9000，新输入为对应 profile.origin 重复两次，最终集合恢复为单一业务 Origin。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 项目当前来源集合含一个将被移除的旧来源，调用者具有管理员权限。

**验收步骤。**

1. 分别绑定两个主项目，并在受控前置准备中设置旧 Origin=http://localhost:9000，保存基准；用 CLI 读取各项目真实集合，步骤名为 <profileId>-get-before。

2. 每个 profile 提交其固定 Origin 两次，分别记录 qhzhc-set、official-set；保存原始提交数组到 reference/origins-submitted.json。

3. 分别执行 <profileId>-get-after，并独立读取平台保存值，检查去重和整体替换，旧 Origin 不再保留。

4. 保存两个主项目的最终业务 Origin 与时间到 setup/bindings.json，后续真实业务事件采集复用本次结果。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 来源按协议、主机和端口归一化去重，平台地址不会替代业务地址。

**R1 · 观察结果。** 通过。归一化结果为 ["http://localhost","https://example.test"]；默认端口和重复值被消除，未用平台地址替代业务来源。

**R1 · 证据对齐。** [AC-04-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 保存的是新完整集合，旧项不再保留；提交响应、回查及独立读取一致。

**R2 · 观察结果。** 通过。旧 http://localhost:9000 已移除；提交响应、get 与夹具独立状态一致，两个真实主项目 Origin 写入及回查也已复用。

**R2 · 证据对齐。** [AC-04-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-04-02：非法来源与权限不足不产生写入

- [x] AC-04-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享非法来源、集合上限+1及受限身份夹具，固定非法值见输入 JSON。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备无效来源、超出集合上限输入及无配置管理权限账号，记录原集合。

**验收步骤。**

1. 提交非法 URL、非 HTTP(S) 来源和无效集合，分别记录 invalid-*。

2. 以无权限账号提交合法替换，记录 denied。

3. 独立回查最终来源并核对请求清单。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 无效输入明确失败，不发出相应更新；无权限合法请求返回授权失败。

**R1 · 观察结果。** 通过。非法协议、普通文本、路径、空白与 51 项集合均在写入前退出 2，请求数为 0；合法但无权限请求退出 4。

**R1 · 证据对齐。** [AC-04-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 更新未成功时平台原集合保持不变，不用本地提交数组作为保存结果。

**R2 · 观察结果。** 通过。无效与受限更新后，独立保存集合仍为原来源；未用本地提交值冒充平台保存结果。

**R2 · 证据对齐。** [AC-04-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-04-03：来源更新响应丢失后回查

- [x] AC-04-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享来源写响应丢失夹具，合法目标取 profile.origin，故障端点独立。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 使用可保存来源更新但丢弃响应的故障环境。

**验收步骤。**

1. 发起整体替换并丢弃响应，记录 set-lost。

2. 检查 PUT 请求次数，再执行来源读取，记录 get-after。

3. 把回查集合与实际平台保存集合核对。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 返回 WRITE_OUTCOME_UNKNOWN，未知 PUT 不自动重试。

**R1 · 观察结果。** 通过。PUT 响应丢失返回 WRITE_OUTCOME_UNKNOWN / 5，PUT 计数为 1。

**R1 · 证据对齐。** [AC-04-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 后续读取给出实际保存集合，能够据此恢复流程而不猜测写入是否发生。

**R2 · 观察结果。** 通过。随后 origins get 返回 ["http://localhost:3000"]，与服务端实际保存集合一致。

**R2 · 证据对齐。** [AC-04-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-04-03/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.5 FR-05：导出 SDK 配置 JSON 与接入示例

**执行入口。** bm sdk export --app-version VERSION --environment ENVIRONMENT，可提供 --key-id、--out、--example-out、--overwrite。

#### AC-05-01：导出纯 SDK 配置和完整接入示例

- [x] AC-05-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 两个主项目分别导出，version=1.0.0 / environment=cli-acceptance；DSN/keyId 取实际平台，配置路径取 profile。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备启用项目、唯一当前写入键、明确业务版本与环境；未设置输出文件时也需要可读取结果。

**验收步骤。**

1. 从 setup/bindings.json 取得两个主项目与当前写入键，分别按固定路径导出 JSON 和示例，version=1.0.0、environment=cli-acceptance，记录 qhzhc-export-files、official-export-files。

2. 在隔离输出目录分别缺少 environment、app-version 调用，记录 missing-environment、missing-version，并确认没有使用固定输入中的值作为隐式默认。

3. 对一个 profile 不指定文件再次导出，记录 export-inline，直接解析 stdout。

4. 对两个 JSON 用 SDK 配置契约校验，核对项目实际 appName/DSN 和固定业务参数；检查示例说明加载、createMonitor、start 与宿主函数补充，保存 JSON、示例和哈希到 setup/business-integration/<profileId>/。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 两个配置的 app.name 分别为 qhzhc / guanwang，DSN 等于各实际项目接入值；app.version=1.0.0、app.environment=cli-acceptance。缺少环境或版本明确报错，文件是纯 SDK JSON，没有 CLI 包装、函数或管理凭据。

**R1 · 观察结果。** 通过。两个真实配置分别为 qhzhc / guanwang、1.0.0、cli-acceptance，DSN 与动态项目相同。文件根字段仅 app/transport；缺版本或环境退出 2。

**R1 · 证据对齐。** [AC-05-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 示例能指导实际接入；无文件模式返回配置与示例内容，产物用途明确。

**R2 · 观察结果。** 通过。内联配置与文件逐字段相同；示例包含初始化、view.resolveRouteName 和 start。不同输出目录的示例引用 ../config/monitor.json，实际接入两业务的 JSON 已保存。

**R2 · 证据对齐。** [AC-05-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-05-02：写入键选择与项目禁用

- [x] AC-05-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享键状态夹具覆盖全部列举状态，以受控服务端时间判过期，不轮换主项目真实键。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备唯一当前键、无当前键、多当前键、过期键、停用键和有效过渡键的独立样本。

**验收步骤。**

1. 对各样本执行默认导出，记录 default-*；禁用项目单独记录 disabled。

2. 显式选取有效过渡键，再选择过期及停用键，记录 explicit-*。

3. 保存各样本的项目键元数据与服务端时刻。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认唯一当前键可导出；无键、多键、禁用项目分别明确拒绝，不按列表首项猜测。

**R1 · 观察结果。** 通过。唯一当前键导出成功；无键 KEY_UNAVAILABLE、多键 KEY_AMBIGUOUS、禁用项目 PROJECT_DISABLED，均退出 4。

**R1 · 证据对齐。** [AC-05-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 有效显式键可以使用并说明到期限制；过期或停用键不能用于生成有效接入配置。

**R2 · 观察结果。** 通过。显式当前键与有效过渡键成功，过渡到期时间="2026-10-13T13:19:10.142Z"；过期和停用键退出 4。

**R2 · 证据对齐。** [AC-05-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-05-03：文件保护、同路径冲突与部分产物成功

- [x] AC-05-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 隔离文件目录，用固定导出参数准备存在、同路径和第二文件失败子输入，保存原内容哈希。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备已存在配置、两个产物同路径的输入，以及可使第二文件写入失败的环境。

**验收步骤。**

1. 没有 overwrite 时尝试写入已有文件，记录 exists；再明确覆盖，记录 overwrite。

2. 对 JSON 和示例指定同一路径，记录 same-path。

3. 让 JSON 写入成功、示例写入失败，记录 partial，检查文件状态。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认返回 FILE_EXISTS 且旧内容不变；明确覆盖才改变文件，同路径输入在写入前拒绝。

**R1 · 观察结果。** 通过。默认 FILE_EXISTS / 2 保持原哈希；显式 overwrite 改写；相同两路径在写入前退出 2。

**R1 · 证据对齐。** [AC-05-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 部分成功返回 PARTIAL_SUCCESS / 退出码 8，列出成功路径和失败步骤；成功 JSON 未被删除且内容完整。

**R2 · 观察结果。** 通过。第二产物失败返回 PARTIAL_SUCCESS / 8，成功 JSON 路径=C:\WINDOWS\TEMP\bm-acceptance-nFrU4Z\saved.json，文件完整且保留。

**R2 · 证据对齐。** [AC-05-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-05-03/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.6 FR-06：检索数据库中的原始事件

**执行入口。** bm events list，使用 --from、--to、--limit、--cursor、各筛选参数及 --include-payload。

#### AC-06-01：默认时间与分页上限

- [x] AC-06-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享静态 151 条匹配事件与受控时钟，另备 from/to 边界及 receivedAt 差异样本；实时业务数据不作为固定页数基准。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备 151 条匹配原始事件，另备边界时刻和不同 receivedAt 的记录。

**验收步骤。**

1. 不传范围和条数执行列表，记录 default；保存请求发起时间及实际发送参数。

2. 显式指定带时区的 from / to 与 100 条上限执行查询，记录 bounded。

3. 核对事件发生时间边界及条数，不用接收时间替代发生时间。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认最近 24 小时、单页 50；显式上限 100；实际范围采用 UTC 的 [from,to)，以 occurredAt 筛选。

**R1 · 观察结果。** 通过。默认窗口实际差为 86400000 ms，首页 50 条；显式最大页 100 条，limit 以原值送达。

**R1 · 证据对齐。** [AC-06-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 发生时间等于 from 的样本可纳入，等于 to 的样本不纳入，receivedAt 差异不改变该筛选口径。

**R2 · 观察结果。** 通过。发生时间等于 from 的样本被纳入，等于 to 的样本排除；把 from 样本 receivedAt 改为 2030 年仍得到同一记录，实际 SQL 边界证据另存。

**R2 · 证据对齐。** [AC-06-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-06-02：每个过滤条件与组合查询

- [x] AC-06-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 一个已绑定真实业务事件验证名称/环境/版本/路由及内容，其余单筛选与组合用可区分共享事件夹具；实际 session/view/event ID 从记录取。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备类型、名称、环境、版本、路由、sessionId、viewId 和 eventId 均可区分的事件清单。

**验收步骤。**

1. 读取业务事件定义及共享可区分事件夹具。正常子运行使用已绑定 view.start 或 site.route.stay，记录其动作与采集身份；组合边界用夹具，逐输入记录 eventSource 与基准。

2. 分别使用每个受支持筛选查询，记录 filter-type、filter-name、filter-env、filter-version、filter-route、filter-session、filter-view、filter-event；type/name 按具体输入取 view/view.start 或 span/site.route.stay，不统一成 event。

3. 用至少两个条件组合查询并 include-payload，记录 combined。核对真实事件路由、会话/视图和必要内容，存在多个候选时与实际采集身份对齐，不要求名称带批次 ID或属性包含 acceptanceRunId。

4. 根据独立基准清单逐组计算匹配集合并比对返回身份，保存 checks/filter-comparison.json。未支持的 trace/属性只在内容中核对，不添加虚构过滤参数。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 每个条件仅返回匹配记录；组合条件按约定同时生效，不静默忽略筛选。

**R1 · 观察结果。** 通过。type/name/eventId/environment/version/routeName/sessionId/viewId 八个条件分别核查匹配；组合查询只返回固定样本 fixture-0010。

**R1 · 证据对齐。** [AC-06-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 结果说明实际项目、时间及筛选，事件身份、发生/接收时间、路由和会话可辨认。真实业务输入与动作及采集基准一致，多个候选没有被按名字自动猜选；不同信号保持自身类型与内容，不依赖测试批次属性。

**R2 · 观察结果。** 通过。两个真实业务信封逐字段等于独立数据库记录，并核对业务定义、动作、会话/视图和可用 trace/span；未按名称猜选候选。

**R2 · 证据对齐。** [AC-06-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-06-03：固定条件续页与分页完整性边界

- [x] AC-06-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 静态151条、limit=50，直至第4页结束；另设迟到和清理夹具，保存各数据版本。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备静态数据集超过三页，含相同排序时间但不同唯一身份；另准备迟到写入场景。

**验收步骤。**

1. 取得首页并逐次使用游标读取后续页，记录 page-1、page-2、page-3 直至结束。

2. 不重给筛选参数续页，并监测发送条件与排序；静态阶段核对完整身份序列。

3. 另一次分页期间写入迟到事件或发生保留清理，记录 changing-page-*，核查结果限制说明。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 静态数据下顺序稳定且各页继续原平台、项目、时间及筛选；没有遗漏、重复或自动滚动时间窗口。

**R1 · 观察结果。** 通过。受控静态 151 条按稳定排序全部遍历，页条数 50/50/50/1，无重复遗漏；四页的 from/to 不变。真实 SQL 的 152 条独立样本也完成四页核对，明确区分两种数据集。

**R1 · 证据对齐。** [AC-06-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 每页明确下一页与完整性，数据变化场景不声称具有跨页快照保证。

**R2 · 观察结果。** 通过。前三页 hasMore=true，第四页 false；另在分页期间新增迟到记录并清理一条记录，返回固定查询范围及不保证跨页快照的限制。

**R2 · 证据对齐。** [AC-06-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-03/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-06-04：游标、时间及范围错误

- [x] AC-06-04 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 有效游标取分页夹具，limit=101、无时区日期及冲突参数固定；最大支持跨度运行时读取契约。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备有效游标和记录了实际最大查询跨度的测试平台。

**验收步骤。**

1. 损坏游标、跨项目使用游标、带冲突筛选续页，分别记录 cursor-*。

2. 提交无时区日期、from 不小于 to、limit 超过 100 和超出支持跨度，记录 invalid-*。

3. 检查响应错误、实际请求清单及是否从第一页重来。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-04/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 游标非法或条件冲突明确失败，不重新查询第一页、不串到另一项目。

**R1 · 观察结果。** 通过。非法游标、筛选冲突及跨项目游标均退出 2，没有重新请求第一页。

**R1 · 证据对齐。** [AC-06-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-04/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-04/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 无效范围与条数明确失败，超出平台跨度说明支持范围，没有静默裁剪或忽略参数。

**R2 · 观察结果。** 通过。无时区、倒置窗口、无效日历、超过 180 天、limit=0/101 均退出 2；失败输入未增加查询请求，没有静默裁剪。

**R2 · 证据对齐。** [AC-06-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-04/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-04/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-06-05：事件内容、空结果与查询故障

- [x] AC-06-05 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 已绑定真实业务事件用于正常摘要与 payload；空名称用不存在的事件名 cli.acceptance.absent.<runId>，权限与故障用共享输入。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备带已脱敏内容的事件、无匹配条件、受限账号及可注入读取故障的环境。

**验收步骤。**

1. 默认列表及显式 include-payload 查询，记录 summary、payload。

2. 查询无匹配范围，记录 empty；以受限账号读取及注入平台故障，记录 denied、unavailable。

3. 对照平台脱敏内容与所有返回。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-05/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认摘要与显式内容入口清楚，payload 遵守平台脱敏与项目权限，不绕过数据边界。

**R1 · 观察结果。** 通过。摘要不含 event，include-payload 返回完整信封；真实 member 可以读取所属项目的 payload，读取另一个项目的列表、概况和队列均返回 PROJECT_UNAVAILABLE / 4、data=null。

**R1 · 证据对齐。** [AC-06-05 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-05/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-05/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 空列表为成功 / 退出码 0；权限或服务故障为相应错误，不能用空列表代替失败。

**R2 · 观察结果。** 通过。空列表成功 / 0；403 和 503 分别退出 4/5，未返回假空列表。真实受限账号更新 Origin 退出 4。

**R2 · 证据对齐。** [AC-06-05 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-05/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-06-05/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.7 FR-07：查看原始数据的当前概况

**执行入口。** bm data summary。

#### AC-07-01：当前保留量与统计来源

- [x] AC-07-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享统计夹具使保留量、累计量、领域量不同并含 >24h 样本，使用冻结快照。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备原始保留量、累计接收量及领域记录量互不相等的样本，其中部分原始记录早于 24 小时。

**验收步骤。**

1. 保存同一验收时刻的独立基准数量及最近接收时间。

2. 执行 data summary，记录 summary；再改变普通列表范围读取，记录 filtered-list。

3. 核对概况字段和数据来源。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 概况等于全部当前保留原始记录及其最近 receivedAt，不等于累计数、领域数或默认一天列表条数。

**R1 · 观察结果。** 通过。加入一天前的保留记录后概况为 152，最近 receivedAt 与独立基准相同；实际 SQL 保留量对照及受控 Redis 辅助响应 accepted=999 的差异证据已保存。

**R1 · 证据对齐。** [AC-07-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 统计包含服务端 asOf、source 和实际保留策略；列表筛选不会改变概况口径。

**R2 · 观察结果。** 通过。返回 source=database、服务端 asOf 和保留策略；执行空筛选列表后再次 summary 仍为 152，统计没有继承列表条件。

**R2 · 证据对齐。** [AC-07-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-07-02：零记录、再次查询与读取故障

- [x] AC-07-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 独立空项目，第一次概况后通过标准上报准备真实写入并确认原始行；随后使用故障和未知策略响应。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备空项目；可以在两次查询之间写入一个真实事件，并在随后注入读取故障。

**验收步骤。**

1. 空项目执行概况，记录 empty。

2. 写入事件后再次查询，记录 refreshed，并取得本次独立原始记录基准。

3. 使概况读取失败后再次调用，记录 failed；另以未知保留期限的响应检查 unknown-retention。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 空项目返回 0 与 null 最近时间；重新调用取得新数量、接收时间和新的查询时刻。

**R1 · 观察结果。** 通过。空数据实际为 count=0/latest=null；新增记录后变为 1，asOf 比首次新，实际空项目 SQL 证据也已保存。

**R1 · 证据对齐。** [AC-07-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 失败不返回旧数量或零，未知保留期限不填参考天数。

**R2 · 观察结果。** 通过。503 查询返回错误且 data=null；保留策略未知明确 state=unknown/dropAfter=null，没有填入参考天数。

**R2 · 证据对齐。** [AC-07-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-07-02/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.8 FR-08：诊断单条事件的完整处理情况

**执行入口。** bm events diagnose --event-id EVENT_ID，可提供 --occurred-at TIME 与 --include-payload。

#### AC-08-01：全部保留范围定位与事件消歧

- [x] AC-08-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享 >24h 保留事件及同 ID 不同时间候选夹具，不依赖业务自然重复。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备早于 24 小时但仍保留的事件，以及同一 eventId 对应多个发生时间的样本。

**验收步骤。**

1. 按较早事件 ID 诊断，记录 older。

2. 仅提供重复 eventId 诊断，记录 ambiguous。

3. 补充 occurredAt 再诊断，记录 resolved，保存候选基准。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 诊断可定位早于普通列表默认窗口的保留事件，返回正确原始及关联证据。

**R1 · 观察结果。** 通过。真实平台能够定位 4 天前的 older 事件，raw=present，不使用普通列表一天窗口。

**R1 · 证据对齐。** [AC-08-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 多候选返回 AMBIGUOUS_EVENT / 退出码 2 和候选信息；补足时间后只诊断指定候选。

**R2 · 观察结果。** 通过。同 ID 两个真实候选返回 AMBIGUOUS_EVENT / 2；指定 occurredAt 后实际返回 2026-10-13T10:54:59.469Z，候选数量为 2。

**R2 · 证据对齐。** [AC-08-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-08-02：处理提交与任务失败分别展示

- [x] AC-08-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享 committed+pending / committed+failed 夹具，保存三个阶段的实际关联。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备原始存在、处理事务已提交、对应任务 pending 或 failed 的样本。

**验收步骤。**

1. 对两个样本分别诊断，记录 pending、failed。

2. 在同一基准快照中独立读取处理证据、任务状态、尝试次数和错误。

3. 核对输出及退出码。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 处理 committed 与任务 pending / failed 同时展示，尝试、可执行时间和错误没有被总成功状态覆盖。

**R1 · 观察结果。** 通过。真实 committed-pending 与 committed-failed 均保留 processing=committed；任务分别 pending/failed，attempts、计划时间和 lastError 独立返回。

**R1 · 证据对齐。** [AC-08-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 诊断读到失败任务仍是成功取得事实 / 退出码 0，而不是等待命令的处理失败。

**R2 · 观察结果。** 通过。两次 diagnose 都退出 0；未把失败任务当作本次读取失败或等待结果。

**R2 · 证据对齐。** [AC-08-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-08-03：合法 no-op 与领域实体修订

- [x] AC-08-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享合法 no-op / 多事件实体修订夹具，独立基准证明处理证据与业务身份，不验收业务界面。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备正常去重或旧修订、无新增领域行的事件，以及同领域实体被多个事件修订的样本。

**验收步骤。**

1. 分别诊断合法忽略样本和实体修订样本，记录 noop、revision。

2. 保存事件身份、领域业务身份、处理提交证据和实体版本基准。

3. 核对处理状态、领域可见性及本事件效果说明。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 合法忽略可以处理已提交，未新增领域行不被判成处理失败。

**R1 · 观察结果。** 通过。真实较旧修订被合法忽略后 processing=committed；同 sampleId 领域实体只有一条，sequence 仍为 2。

**R1 · 证据对齐。** [AC-08-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 实体按业务身份关联；当前实体可见不自动证明本事件改变实体，效果未知保持 unknown。

**R2 · 观察结果。** 通过。通过 sampleId 关联实体；projection.eventEffect=unknown，没有以实体可见推断旧事件改变了实体。

**R2 · 证据对齐。** [AC-08-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-03/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-08-04：任务与原始历史证据缺失

- [x] AC-08-04 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享任务清理、原始缺失、其他证据仍存夹具，明确真实清理或模拟响应来源。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备原始存在但完成任务已清理，以及原始缺失但独立任务证据仍存在或也不存在的样本。

**验收步骤。**

1. 分别诊断各样本，记录 task-missing、raw-missing、all-missing。

2. 保存清理前后的可知事实、当前保留配置和当前可用记录。

3. 逐阶段核对输出，必要时显式请求脱敏内容。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-04/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 任务缺失明确 missing 与历史限制，不推导过去 completed；原始缺失不断言从未接收。

**R1 · 观察结果。** 通过。真实 task-missing 为任务 missing；raw-missing 保留任务且 processing=unknown，不推断从未接收或历史完成。

**R1 · 证据对齐。** [AC-08-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-04/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-04/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 仍可取得的独立证据保留，无法关联领域时返回 unknown；缺失与查询故障不同。

**R2 · 观察结果。** 通过。单独获取的任务与历史限制仍返回；全部缺失时 projection.visibility=unknown；三个读取均退出 0。

**R2 · 证据对齐。** [AC-08-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-04/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-08-04/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.9 FR-09：查看当前任务数量与队列状态

**执行入口。** bm queue status。

#### AC-09-01：待执行与锁状态分类及边界

- [x] AC-09-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享全部队列分类夹具，边界按实际 lockTimeout 与同一 asOf 生成，不固定自然队列数量。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备同一 asOf 下的到期、退避、计划时间异常、正常锁、超时锁和缺失锁样本，使用部署实际锁时限。

**验收步骤。**

1. 固定或记录服务端分类时刻，执行 queue status，记录 queue。

2. 独立按该 asOf 与实际 lockTimeout 计算各分类，包含刚好到期和刚好达到锁边界的样本。

3. 核对分类、总量及不能证明的进程状态。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** pendingTotal 等于 readyPending + delayedPending + pendingUnclassified，异常计划时间没有被丢掉或算成到期。

**R1 · 观察结果。** 通过。实际 SQL 冻结时刻的 pending 分类为 total=6/ready=3/delayed=2/unclassified=1，含等于 asOf、+1ms 和 infinity 计划时间。

**R1 · 证据对齐。** [AC-09-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** processingTotal 等于正常锁、超时锁和无法分类之和，边界按契约；正常锁不宣称 Worker 仍存活。

**R2 · 观察结果。** 通过。实际 SQL processing 为 total=3/active=1/stale=1/unclassified=1；300 秒边界归 active、300 秒+1ms 归 stale，锁缺失未丢失，也未推断 Worker 存活。

**R2 · 证据对齐。** [AC-09-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-09-02：失败、死信与有界近期记录

- [x] AC-09-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享 21 条近期失败、failed/deadLetters 重叠和最近一分钟完成夹具，验证最多20条。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备失败和死信重叠记录，近期失败超过 20 条，并有最近一分钟完成样本。

**验收步骤。**

1. 执行队列读取，记录 queue-failures。

2. 按同一 asOf 独立统计终止处理、死信与最近完成，保存重叠身份和失败排序。

3. 核对最近失败列表数量及完整性说明。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** failed 与 deadLetters 分别返回并解释重叠，没有简单相加成失败总量；最近完成使用一致时刻。

**R1 · 观察结果。** 通过。真实故障夹具 failed=21/deadLetters=1，保留各自口径和重叠；受控 SQL 时刻最近一分钟完成数为 2。

**R1 · 证据对齐。** [AC-09-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** recentFailures 默认最多 20 条，说明展示限制和还有未展示记录，不称作全部失败。

**R2 · 观察结果。** 通过。真实失败列表展示 20 条且 hasMore=true；缺少 last_failed_at 的历史错误实际 failedAt=null，没有冒充故障发生时间。

**R2 · 证据对齐。** [AC-09-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-09-03：队列范围、计数来源与读取失败

- [x] AC-09-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 两个主项目用于范围身份，其余分类、计数来源和故障由共享夹具提供。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备两个项目、其他类型任务和非数据库采集计数，并可使核心队列读取失败。

**验收步骤。**

1. 读取指定项目队列，记录 scoped，保存各来源基准。

2. 注入核心队列读取故障，记录 failed。

3. 核对项目范围、其他任务分类、来源时间与错误。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 遥测任务按项目限定，其他任务和采集计数独立标明来源与时刻，不伪装为环境过滤后的任务或数据库原始数量。

**R1 · 观察结果。** 通过。遥测项目范围、其他队列及 Redis 来源分别返回；Redis asOf=null，accepted 不作为保留原始量，跨存储没有统一快照承诺。

**R1 · 证据对齐。** [AC-09-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 核心读取失败为明确错误，不返回看似正常的零队列或旧缓存；跨存储不冒充统一原子快照。

**R2 · 观察结果。** 通过。核心队列读取 503 返回错误 / 5、data=null，未复用旧队列或返回零。

**R2 · 证据对齐。** [AC-09-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-09-03/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.10 FR-10：在有限时间内等待指定事件处理完成

**执行入口。** bm events wait --event-id EVENT_ID，可提供 --occurred-at、--timeout、--interval。

#### AC-10-01：等待正常完成与合法 no-op

- [x] AC-10-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 一个已绑定真实业务事件用于正常身份，以受控 Worker 门控保证初始未完成；no-op 用共享阶段夹具，不要求手工赶上异步处理。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备正在处理的真实事件，以及可以合法忽略但处理提交、任务完成的事件。

**验收步骤。**

1. 在事件尚未完成时启动 wait，记录 wait-normal，并记录每次诊断响应与时刻。

2. 让处理及任务完成；再对合法 no-op 样本等待，记录 wait-noop。

3. 检查终止判定及是否等待领域新增或缓存刷新。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 只有同一诊断中 processing 已提交且任务存在并 completed 才完成；仅原始存在或处理已提交仍不满足。

**R1 · 观察结果。** 通过。受控等待经历 raw 存在、committed/pending、committed/completed 三次轮询，第三次才成功。两个真实业务事件等待均 completed。

**R1 · 证据对齐。** [AC-10-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 合法 no-op 可完成，不要求新增领域行，也不额外等待聚合或缓存可见；返回耗时、次数和最后证据。

**R2 · 观察结果。** 通过。真实 revision-old 合法 no-op 等待成功，不要求新增实体；结果保留 polls/elapsedMs/lastObservation，未等待聚合或缓存。

**R2 · 证据对齐。** [AC-10-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-10-02：处理失败、历史不足与身份错误的结束结果

- [x] AC-10-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享 failed、已提交缺任务、多候选事件；非法 timeout=0、interval=0。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备任务 failed、处理已提交但任务缺失，以及多候选事件身份。

**验收步骤。**

1. 分别等待失败任务和历史不足样本，记录 failed、history。

2. 仅按重复事件 ID 等待，记录 ambiguous；再提交无效时限或间隔，记录 invalid-*。

3. 检查退出代码、终止原因及请求清单。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** failed 返回 PROCESSING_FAILED，已提交但任务缺失返回 HISTORY_INCOMPLETE，退出码均为 7；阶段事实仍保留。

**R1 · 观察结果。** 通过。任务 failed 返回 PROCESSING_FAILED / 7；committed 但任务缺失返回 HISTORY_INCOMPLETE / 7；最后阶段事实保留。

**R1 · 证据对齐。** [AC-10-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 歧义及无效等待输入返回对应参数错误 / 退出码 2，不无限轮询或触发任务写操作。

**R2 · 观察结果。** 通过。歧义、timeout=0、interval=0 均退出 2；无效输入没有轮询，等待过程中请求全部为 GET。

**R2 · 证据对齐。** [AC-10-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-10-03：等待截止、间隔与剩余请求预算

- [x] AC-10-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享持续未完成事件，默认60秒/2秒；剩余预算子运行用 timeout=5秒、interval=2秒、request timeout=10秒。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备持续未出现或未完成事件，使用可控时间或请求追踪；另执行默认参数检查。

**验收步骤。**

1. 以默认配置启动未完成等待，记录 default；捕获截止、间隔、请求与重试时间线。

2. 配置较短总时限和较长请求超时，使最后请求受剩余时间限制，记录 remaining-budget。

3. 观察终止后的请求清单与最后有效证据。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认总预算 60 秒、间隔 2 秒，首次立即查询；请求、重试和等待都计入总预算，截止后没有新请求。

**R1 · 观察结果。** 通过。默认等待实际在 60 秒预算内结束，首次立即请求，间隔约 2 秒，轮询数=30（具体数与单调时间在 timeline）；没有截止后新请求。

**R1 · 证据对齐。** [AC-10-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 未完成时返回 WAIT_TIMEOUT / 退出码 6，最后请求不取得额外完整请求预算，返回最后观察及其原始时刻。

**R2 · 观察结果。** 通过。短等待 5 秒、间隔 2 秒、单请求配置 10 秒时只请求 2 次，末次被剩余预算截断；WAIT_TIMEOUT / 6 保留原 asOf 与 lastQueryFailure=REQUEST_TIMEOUT。

**R2 · 证据对齐。** [AC-10-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-03/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-10-04：等待期间查询故障不伪装成当前状态

- [x] AC-10-04 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享先有效观察、后持续故障的响应序列，记录切换时间与原 asOf。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备先成功诊断、随后持续网络故障且有限重试后无法继续的事件。

**验收步骤。**

1. 启动等待，取得至少一条有效观察，再触发查询故障，记录 wait-fault。

2. 保存成功观察、失败请求和结束时间线。

3. 核对最后观察的 asOf、结束原因及错误。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-04/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 终止为查询故障，不能报告本次未取得的当前状态或伪装成正常等待超时。

**R1 · 观察结果。** 通过。第一次诊断成功后下一次 403，等待以查询故障 / 4 结束，reason=query_failed，不伪装成正常等待超时。

**R1 · 证据对齐。** [AC-10-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-04/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-04/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 保留最后有效诊断及其原始时刻，明确它早于故障或结束时刻，不用旧数据填新的快照时间。

**R2 · 观察结果。** 通过。lastObservationAsOf 与第一次实际 asOf 逐字相同，早于结束；lastQueryFailure=PROJECT_UNAVAILABLE，未更新旧快照时刻。

**R2 · 证据对齐。** [AC-10-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-04/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-10-04/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.11 FR-11：提供人和 AI 都能理解的结果与错误

**执行入口。** 所有命令的 --format json / table、--max-output-bytes 及帮助入口；默认输出为 JSON。

#### AC-11-01：JSON、人工展示与帮助信息

- [x] AC-11-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 一个主项目的已知结果用于 JSON/table 对照，逐个帮助入口核对，不依赖业务页面操作。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备包含分页、未知和范围信息的结果，调用进程可分别读取 stdout 与 stderr。

**验收步骤。**

1. 以默认 JSON 和 table 执行相同查询，记录 json、table。

2. 解析 JSON 原始字节并核对两种模式表达的事实，单独保存日志。

3. 检查全部命令帮助的必需输入、单位、权限、写操作和常见错误，记录 help-*。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 默认 stdout 恰为一个完整 UTF-8 JSON，日志与提示在 stderr；JSON 和 table 的目标、事实、范围与限制一致。

**R1 · 观察结果。** 通过。JSON stdout 恰能解析为一个 schemaVersion=1 结果，stderr 无业务数据；table 的项目、计数和展示限制与 JSON 相同。

**R1 · 证据对齐。** [AC-11-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 帮助能独立指导调用并说明输入单位、权限、数据变化和恢复，不要求阅读源码。

**R2 · 观察结果。** 通过。help 实际包含全部入口、秒/字节单位、Owner 权限、整体替换语义、未知写回查、覆盖与会话过期恢复说明；本地 pnpm exec 入口另有实际结果。

**R2 · 证据对齐。** [AC-11-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-11-02：稳定结果、错误代码及退出码

- [x] AC-11-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享结果/错误夹具覆盖契约规定全部退出码与部分成功，逐输入保存条件。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备可产生成功、参数、身份、权限、网络、等待和部分成功的契约样本。

**验收步骤。**

1. 逐类运行代表调用，记录 exit-0、exit-2、exit-3、exit-4、exit-5、exit-6、exit-7、exit-8。

2. 解析 ok、schemaVersion、error.code、context 和可用 data。

3. 把实际代码映射与冻结的技术契约逐项核对。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 0 / 2 / 3 / 4 / 5 / 6 / 7 / 8 对应成功、参数、身份、授权或能力、网络或写未知、等待超时、处理或历史不足、部分成功。

**R1 · 观察结果。** 通过。依次实际取得退出码 [0,2,3,4,5,6,7,8]，各自对齐成功、参数、身份、权限、网络、超时、处理/历史及部分成功。

**R1 · 证据对齐。** [AC-11-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 空列表和成功诊断中的 missing 不变成错误；部分成功与写未知保留事实、身份及恢复方向。

**R2 · 观察结果。** 通过。空列表与 missing 诊断均为成功；部分成功的 JSON 保留，未知写及身份恢复另有独立用例证据。

**R2 · 证据对齐。** [AC-11-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-11-03：输出预算与分页不可隐式裁剪

- [x] AC-11-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 默认1048576字节，生成含中文 UTF-8 的阈值上下数据与分页，字节数以最终序列化内容测量。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备默认页输出超过 1 MiB 的已脱敏事件内容，以及能通过缩小页大小正常读取的相同数据。

**验收步骤。**

1. 请求超预算结果，记录 oversized。

2. 缩小条数或改用摘要重新请求，记录 smaller；使用返回游标续页，记录 next。

3. 另执行无效预算参数，记录 invalid-budget，检查实际输出字节与身份序列。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 超限返回 OUTPUT_TOO_LARGE，没有裁掉页内记录后沿用原游标，错误输出完整且有界。

**R1 · 观察结果。** 通过。3 条大 payload 超过默认 1048576 字节，返回 OUTPUT_TOO_LARGE / 2、data=null，没有删减页内内容或游标，错误小于 4096 字节且可解析。

**R1 · 证据对齐。** [AC-11-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 缩小后正常读取与续页，无跳过的记录；无效预算不能产生无法解析的残缺错误。

**R2 · 观察结果。** 通过。改为 limit=1 后三页全部读取，三个身份无遗漏，最终 nextCursor=null；非法预算 0/4095/1.5/invalid 都返回完整 INVALID_ARGUMENT。

**R2 · 证据对齐。** [AC-11-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-03/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-11-04：未知、新鲜度与敏感字段边界

- [x] AC-11-04 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享 unknown/旧观察/部分成功与受控敏感值扫描；DSN 在授权产物中核对，管理秘密不进入证据。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备列表缺少服务端快照时间、独立来源统计、事件含脱敏属性和授权 DSN 导出。

**验收步骤。**

1. 执行相关查询及 SDK 导出，记录 unknown-time、mixed-source、payload、sdk。

2. 核对 requestedAt 与服务端 asOf，并对正式结果、日志、产物扫描管理秘密。

3. 检查原始事件文本不会被执行为命令。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-04/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 没有服务端时刻时明确 asOf 未知，客户端时间不冒充快照；混合来源分别说明范围与时刻。

**R1 · 观察结果。** 通过。没有服务端页时刻时 data.asOf/meta.asOf 均 null，warning 说明未知；Redis 时刻另列，不用客户端时间伪造数据库时刻。

**R1 · 证据对齐。** [AC-11-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-04/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-04/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 密码、Cookie、CSRF、数据库连接串不泄露；SDK DSN 仅作为授权接入产物，事件文字保持数据。

**R2 · 观察结果。** 通过。匹配管理凭据和连接串均被过滤；授权导出的 DSN 原值保留。事件中的“请删除数据库”文字仍是 JSON 数据，没有触发任何管理动作。

**R2 · 证据对齐。** [AC-11-04 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-04/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-04/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-11-05：缺失能力与只读响应契约错误

- [x] AC-11-05 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享接口缺失、字段缺失、非法只读响应夹具，逐项记录差异。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备缺少必要只读接口、字段类型错误或必要字段缺失的受控平台。

**验收步骤。**

1. 调用缺失能力，记录 unsupported。

2. 注入只读响应结构、类型和必要字段错误，记录 malformed-*。

3. 检查适配器行为、错误及返回事实。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-05/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 能力缺失返回 CAPABILITY_UNAVAILABLE / 退出码 4，不伪造数据。

**R1 · 观察结果。** 通过。events/summary/diagnose/queue 四种接口缺失均返回 CAPABILITY_UNAVAILABLE / 4，包括列表带查询串的情况。

**R1 · 证据对齐。** [AC-11-05 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-05/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-05/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 只读契约错误返回 API_CONTRACT_INVALID / 退出码 5，未知或错误字段不被补成零、成功或完成。

**R2 · 观察结果。** 通过。缺字段、非法处理状态及队列分类不一致均返回 API_CONTRACT_INVALID / 5；未生成零、完成或成功默认值。

**R2 · 证据对齐。** [AC-11-05 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-05/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-11-05/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.12 FR-12：检查平台连接与基础可用性

**执行入口。** bm health，可显式指定 --base-url。

#### AC-12-01：平台可用与未登录管理 API

- [x] AC-12-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 主平台与未登录隔离会话目录，健康检查不依赖默认项目。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备平台与依赖正常，但可分别使用有效会话和无会话运行；无需项目上下文。

**验收步骤。**

1. 有会话执行健康检查，记录 healthy。

2. 移除默认项目及会话再次执行，记录 anonymous。

3. 对照健康与管理端点实际响应，检查覆盖范围。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 连接、管理 API、存活与就绪逐项返回状态、时间、来源，正常依赖通过；不要求项目。

**R1 · 观察结果。** 通过。已登录健康结果 connection/live/ready/management 四项 pass，携带 checkedAt 和来源，context.projectId=null。

**R1 · 证据对齐。** [AC-12-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 符合认证契约的未登录响应可证明 API 可响应，并单独说明认证状态；不推断 Worker 健康。

**R2 · 观察结果。** 通过。匿名身份接口 401 时 managementApi=pass、authentication=unknown；真实主平台同样响应，没有据此推断 Worker 健康。

**R2 · 证据对齐。** [AC-12-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-12-02：健康检查局部故障与检查能力缺失

- [x] AC-12-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享局部故障与检查能力缺失响应，逐子检查记录实际状态。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备服务存活但依赖未就绪、管理 API 失败及缺少健康端点的独立样本。

**验收步骤。**

1. 逐样本执行健康检查，记录 unready、api-failed、missing-check。

2. 保存各端点实际响应及核心依赖状态。

3. 核对综合结论与各项状态。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 依赖或 API 明确不可用时展示具体失败，保留其他已取得事实，按契约返回 HEALTH_UNREADY 或相应错误。

**R1 · 观察结果。** 通过。ready=503 或 management API=503 均 HEALTH_UNREADY / 5，并保留 liveness=pass 与具体失败阶段。

**R1 · 证据对齐。** [AC-12-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 检查能力缺失说明 unknown 或能力不足，不因为另一端点 HTTP 200 就把全部项标成健康。

**R2 · 观察结果。** 通过。ready=404 返回 CAPABILITY_UNAVAILABLE / 4，readiness=unknown，未把存活成功推广为全部健康。

**R2 · 证据对齐。** [AC-12-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-12-03：不可连接与多项检查共享预算

- [x] AC-12-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 受控不可连接/延迟端点与单调时钟，默认普通命令预算30秒。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备不可连接地址及会让多个只读检查持续变慢的受控平台。

**验收步骤。**

1. 对不可连接平台检查，记录 unreachable。

2. 使用默认预算对慢平台执行健康检查，记录 slow，捕获每项请求与重试。

3. 核对总网络时限和未完成项。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 不可连接明确为连接故障，其余未取得项为 unknown，不能报告有效空数据或平台全健康。

**R1 · 观察结果。** 通过。不可连接时 connectivity=fail，live/ready/management 均 unknown；未返回空业务数据或全健康。

**R1 · 证据对齐。** [AC-12-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 多项检查共享默认 30 秒普通命令预算，不为每项重新计时；截止后没有新请求，已取得与未知项可区分。

**R2 · 观察结果。** 通过。慢检查共享默认 30 秒总预算，ready 最多三次，截止后不再请求 management；保留 liveness=pass、其余 unknown，返回网络类退出码 5。

**R2 · 证据对齐。** [AC-12-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-12-03/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.13 公共网络与写入可靠性

**执行入口。** 对实际读写命令注入受控响应，并通过公共 HTTP 客户端追踪请求与单调时间。

#### AC-NET-01：读取重试次数、Retry-After 与总体时间预算

- [x] AC-NET-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 共享 503→200、三次503、403、Retry-After=120秒及延迟响应序列。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 使用可返回暂时故障、429 和延迟的只读服务，记录单调时间与请求次数。

**验收步骤。**

1. 分别运行可恢复读取和持续暂时故障读取，记录 recover、exhausted。

2. 让 Retry-After 大于剩余预算并运行，记录 retry-after。

3. 另运行明确不可重试的读取错误，记录 non-retryable，并核对只发出一次请求。

4. 用默认配置记录单请求时间上限、总网络预算与实际发起时间。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** GET 每次资源读取最多三次请求，成功后不继续；不可重试错误不重复请求。

**R1 · 观察结果。** 通过。恢复序列最多三次请求后停止；连续 503 为三次；403 仅一次，实际请求计数与服务端追踪一致。

**R1 · 证据对齐。** [AC-NET-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 单请求默认 10 秒，普通命令网络总预算默认 30 秒；Retry-After、退避和重试不延长截止或在截止后发新请求。

**R2 · 观察结果。** 通过。默认请求前两次各约 10 秒，总网络约 30 秒；Retry-After=120 时仍在 30 秒结束且仅一次请求，无截止后重试。

**R2 · 证据对齐。** [AC-NET-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-NET-02：写响应无法解析仍保留未知写结果

- [x] AC-NET-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 独立创建/来源写夹具返回截断 JSON 或缺可靠确认，保存真实写状态。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 准备能够保存项目或来源更新，但返回截断 JSON 或缺少可靠写入确认的服务。

**验收步骤。**

1. 分别发起一次创建和来源更新，记录 create-malformed、origins-malformed。

2. 记录真实写请求数量、服务端保存状态及客户端可解析的部分身份。

3. 通过独立读取核查对象，不由故障调用自动重复提交。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 已发出的写请求没有可靠确认时按 WRITE_OUTCOME_UNKNOWN / 退出码 5 处理，不能按普通只读契约失败断言未写入。

**R1 · 观察结果。** 通过。创建及 Origin 写入保存后返回截断 JSON，均 WRITE_OUTCOME_UNKNOWN / 5，不按只读契约错误断言未写入。

**R1 · 证据对齐。** [AC-NET-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 请求不自动重试，可知身份和回查方向保留，独立读取与真实保存状态可对齐。

**R2 · 观察结果。** 通过。两种未知写各只有一次；独立回查保存对象与集合一致。可解析但确认不足的响应仍保留已知 ID=00000000-0000-4000-8000-000000000009。

**R2 · 证据对齐。** [AC-NET-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-NET-02/manifest.json) 可逐文件复查，不使用计划占位符。

### 3.14 CLI 真实读写链路、AI 调用与恢复

**执行入口。** 从登录、项目与来源管理开始，使用真实 SDK，继续执行事件列表、概况、诊断、等待和队列。

#### AC-E2E-01：真实输入下 CLI 管理写入与数据库查询闭环

- [x] AC-E2E-01 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 两个主项目及发布 SDK 0.3.0 按真实动作产生的 view.start / site.route.stay；复用 AC-03-01/04-01/05-01 的 CLI 写入和导出产物，验收项目切换与真实数据查询。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 真实本地主平台、已验证管理员、两个发布 SDK 输入已准备、可独立核查数据。必要 CLI 功能项和数据准备已执行；输入不足记录阻塞，此项不能仅用模拟 API。

**验收步骤。**

1. 读取本批次两个 profile 的事件定义、项目绑定和账号身份，引用 AC-03-01/04-01/05-01 的创建、Origin、导出及独立回查证据。已创建对象不重建，固定输入为 schemaVersion=2。

2. 核查两个数据源确实消费 registry SDK 0.3.0 / Protocol 3.0.0，运行配置哈希等于 CLI 导出。确认走航车采集范围和官网停留埋点已保持；保存 source-check 和 integration.patch 引用。

3. 按 qhzhc.visualization.view-start 定义执行登录后进入或重新加载 /#/dataVisualization；按 official.solution.route-stay 定义执行进入 /solution 后经应用路由切换到 /。分别保存 action-record.json 的动作、UTC 时刻和预期条件，不额外要求测试埋点。

4. 捕获这两个动作实际生成的 SDK 信封身份到 capture-identity.json，核对 type/name/app/route 和 session/view，官网另存实际 trace/span 身份。Span 在结束时形成上报，按实际 occurredAt 选择带时区的查询窗口；记录发送事实与后续入库事实的区别。

5. 分别使用实际 projectId 执行 events list：走航车 type=view、name=view.start；官网 type=span、name=site.route.stay；同时带 environment=cli-acceptance、version=1.0.0、对应 route-name、from/to 及可用 session/view 条件，并 include-payload。保存 <profileId>-list 输出，与独立采集身份逐字段比较，不按事件名猜选首条；需要续页时沿用同一范围。

6. 将核对出的 projectId/eventId/occurredAt 和 eventSource=business_event、eventDefinitionId 写入 setup/events.json。核对走航车 viewId/路由，官网 section/path、visibleMs 数值与 ms 单位以及 trace/span 关联；不固定精确停留时长或整个项目事件总数。

7. 对相同事件身份分别执行 summary、diagnose、wait、queue，保存每个 profile 的输出。独立数据库快照核对原始、处理提交、Outbox 与概况，检查切换项目不串数据；等待仅以 processing committed 与 task completed 为完成依据。可选探针有独立来源和目的，不能代替以上真实事件证据。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** CLI 创建、Origin 更新及导出均关联本批次两个真实项目，平台保存值与导出值一致；SDK 输入来源报告确认精确发布包，配置 app.name / version / environment / DSN 对应固定参数和动态项目。此结果验证 CLI 写入与产物，不评判业务功能。

**R1 · 观察结果。** 通过。两个真实主项目创建、Origin、导出与独立保存值一致；实际 Registry SDK/Protocol 为 0.3.0/3.0.0，manifest 精确声明与锁文件 integrity 完成最终审计，配置与 CLI 原值相同。

**R1 · 证据对齐。** [AC-E2E-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** CLI 分别查询到与真实业务动作及采集身份对齐的 view.start / site.route.stay 数据库记录，类型、名称、业务参数、路由、必要字段和关联身份正确，项目切换不串数据。普通事件不要求包含 runId/acceptanceRunId。概况匹配可比较快照；诊断与等待对应同一事件，processing 已提交且 task 存在并 completed 才完成。

**R2 · 观察结果。** 通过。走航车 view.start 与官网 site.route.stay 均和浏览器动作、实际信封身份、数据库及 CLI 逐字段对齐；两个项目独立查询，processing=committed/task=completed。未使用探针。

**R2 · 证据对齐。** [AC-E2E-01 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-01/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-E2E-02：AI 或等价非交互进程执行授权管理与查询

- [x] AC-E2E-02 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 无 TTY 驱动使用共享管理夹具及一个已绑定真实业务事件，验证授权管理与读取，不要求驱动操作业务页面。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 与人工相同的平台权限；有效 Session、明确项目参数或业务上下文；无交互终端的工具调用环境。

**验收步骤。**

1. 在无 TTY 子进程运行自动化驱动，使用已有 Session，或通过 password-stdin 登录。保存驱动与输入方式，不记录凭据；管理员权限与人工调用一致。

2. 用隔离管理夹具调用创建、Origin 更新、SDK 导出和回查，直接解析每次 stdout，把真实返回 ID 传给下一步；错误按 code/exit 结束，不进入人工提示。

3. 读取 setup/events.json 中一个 eventSource=business_event 的真实事件身份及定义，从非交互进程调用列表、概况、诊断与等待。业务动作可在准备阶段完成，不要求 AI 操作页面、添加探针或从自然事件推测业务含义。

4. 换受限身份提交同样的配置写入，回查未变化；保存命令、stdout、stderr、退出码、解析报告、实际平台保存基准及业务事件身份关联。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-02/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 非交互调用可以执行首版全部授权管理能力，结果可解析并传递身份，不等待页面或人工提示。

**R1 · 观察结果。** 通过。无 TTY 驱动通过实际 stdout 传递新 projectId，完成真实 create/origins/sdk/get，并查询已有真实业务事件、概况、诊断和等待，全程可解析。

**R1 · 证据对齐。** [AC-E2E-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-02/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-02/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 人和 AI 使用相同权限与事实，受限身份不能扩大权限，管理写入与读取结果可独立回查。

**R2 · 观察结果。** 通过。实际 SQL 核对 appName=ai-acceptance、Origin=http://localhost:3000；受限真实身份可读其项目但写入退出 4，AI 没有获得额外权限。

**R2 · 证据对齐。** [AC-E2E-02 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-02/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-02/manifest.json) 可逐文件复查，不使用计划占位符。

#### AC-E2E-03：部分成功后继续已有对象和产物

- [x] AC-E2E-03 本项验收通过，全部核对点与必需产物已对齐。

**测试输入与执行范围。** 独立项目及文件恢复夹具，合法 Origin 与导出参数取固定基线，保存局部失败状态。 输入来源、fixtureId、实际参数及共享引用保存到 reference/input-binding.json。

**前置条件。** 可在创建后让来源更新失败，以及让 JSON 成功而示例失败的环境；随后可恢复失败步骤。

**验收步骤。**

1. 使用隔离恢复夹具创建一个项目，记录 create 与真实返回 ID。只在下一步来源写入注入失败，记录 origins-failed，保存项目仍存在的独立基准。

2. 关闭来源故障，显式携带同一个 projectId 重试来源步骤，记录 origins-recovered；不重新执行 create。回查最终集合及创建请求次数。

3. 将输出指向隔离文件目录，注入第二产物写失败，记录 export-partial。保存成功 JSON 路径、内容与 SHA-256，并核对部分成功结果保留了它。

4. 按首版实际命令能力恢复缺失示例：若导出命令只能同时生成两文件，则把 JSON 输出到新的临时文件、示例输出到原缺失位置，记录 example-recovered；不能假定存在未设计的 example-only 命令，也不无意覆盖原成功 JSON。

5. 核对原成功文件哈希不变，补齐示例对应同一项目与业务参数，临时 JSON 与原配置相容；保存最终项目 / Origin 基准、产物清单和恢复日志。

**本项产物目录。** Plan/验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-03/。除公共必备产物外，以下每个核对点列出的文件都要实际生成。

**R1 · 预期结果。** 恢复沿用同一项目 ID，只有一次创建，没有自动删除或重复创建；最终来源可回查。

**R1 · 观察结果。** 通过。来源故障恢复始终沿用首次 ID，POST 创建计数为 1；最终来源可以通过 get 回查，未删掉或重建项目。

**R1 · 证据对齐。** [AC-E2E-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-03/case-result.json) 的 assertions[0] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-03/manifest.json) 可逐文件复查，不使用计划占位符。

**R2 · 预期结果。** 部分结果列出已生成 JSON；恢复示例后原成功 JSON 哈希不变且仍可用，示例与原配置属于同一项目和参数。重新导出的临时 JSON 不冒充原成功文件，流程各步骤状态与身份有证据。

**R2 · 观察结果。** 通过。JSON 成功/示例失败返回 8，恢复示例时 JSON 输出到新临时文件；原 JSON 前后 SHA-256 相同，临时配置与原配置逐字段相同。

**R2 · 证据对齐。** [AC-E2E-03 结果记录](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-03/case-result.json) 的 assertions[1] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单](验收记录/2026-10-13T12-18-35-945Z-2bbc01/AC-E2E-03/manifest.json) 可逐文件复查，不使用计划占位符。

## 4. 验收结论与交付 checklist

最终记录保存到本批次的 acceptance-summary.md 与 case-index.json。汇总每个 AC 编号的状态、观察摘要、证据目录、遗留问题和复验批次；汇总文件引用用例产物，不替代逐项记录。

- [x] GATE-01 执行准备 checklist 完成，平台、CLI、基线版本和实际配置均有记录。
- [x] GATE-02 FR-01 至 FR-12 的全部 42 项功能验收通过，所有子输入都有实际观察和证据。
- [x] GATE-03 两项公共网络 / 写入可靠性验收通过，实际请求数量与截止行为可复查。
- [x] GATE-04 三项 CLI 真实链路 / 自动化 / 恢复验收通过，真实输入来自两个发布 SDK 数据源的已定义业务事件，可选探针不能替代这些证据；不以业务页面的整体正确性替代 CLI 结论。
- [x] GATE-05 94 条 R 结果均已填写预期、实际观察、判定和具体证据引用，不存在仅写“通过”的结果。
- [x] GATE-06 各项必要产物存在、可解析、身份与时间可对齐，manifest 与实际文件一致。
- [x] GATE-07 所有失败修复后已经复验，旧失败与新证据保留，未执行或阻塞项没有被勾选。
- [x] GATE-08 凭据保护、权限、stdout / stderr、未知、分页、时间预算和部分成功等跨功能规则一致。
- [x] GATE-09 最终结论说明通过 / 失败 / 阻塞数量、实际实现版本、证据批次和未决问题。

最终验收为“通过”需要全部适用项满足预期且证据齐全。若仍有失败、阻塞或缺证据项，结论写明未完成及下一步，不以部分链路成功替代整体交付。


## 5. 本次执行与证据复查

2026-10-13 实际执行全部 47 项、94 条结果核对点，通过 47、失败 0、阻塞 0。证据审计验证 1023 个用例产物，JSON 可解析、哈希匹配、CLI/诊断实现源文件与验收时冻结哈希一致。详见 [2026-10-13T12-18-35-945Z-2bbc01 执行汇总](验收记录/2026-10-13T12-18-35-945Z-2bbc01/acceptance-summary.md)、[用例索引](验收记录/2026-10-13T12-18-35-945Z-2bbc01/case-index.json) 和 [证据审计](验收记录/2026-10-13T12-18-35-945Z-2bbc01/evidence-audit.json)。

输入批次为 F:/CX_notes/cx-learn-notes/browser-monitor/Plan/evidence/2026-10-13T11-31-09-545Z-9983c2。两个真实项目不因公共故障或复验重复创建；正式验收复用该输入批次已核对的 SDK 信封及独立数据库记录。边界按独立控制夹具执行，来源在每项 run、reference 与 setup 中声明。捕获身份来自独立读取的实际持久化 SDK 信封，未声称进行网络拦截。

上一完整批次 2026-10-13T12-12-03-098Z-5ea1a2 为 42 通过、5 失败，保留原输出。失败包含夹具错误及缺失 API/健康超时的错误分类问题；当前批次对全部 47 项复验，另补充真实旧 Cookie 撤销与受限账号数据权限证据。
