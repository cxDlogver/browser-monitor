# 监控平台 CLI 实施计划

文档版本：1.2。编写日期：2026-10-13。状态：首版实施及验收完成。

本计划以[需求文档](监控平台CLI需求文档.md)和[技术设计文档](监控平台CLI技术设计文档.md)为依据，说明实现顺序、依赖、交付物和完成检查。每个功能使用原 FR 编号，对应检查方法见[验收计划](监控平台CLI验收计划.md)。

## 1. 实施目标与执行规则

最终交付仓库内可本地调用的独立 CLI 包。人、AI 和脚本能使用同一套入口完成登录、项目管理、来源更新、SDK 配置导出、原始数据读取、事件与队列诊断、有界等待及平台健康检查。

首版管理写入只覆盖创建项目和更新业务来源；事件由业务 SDK 正常上报。保留全部 47 项 CLI 验收，不压缩或删除功能检查。实时走航车和官网仅作为真实 SDK 接入与事件数据源，不验收它们的地图、模拟器、内容展示或业务指标正确性。业务无法产生数据时记录输入准备阻塞，不能直接归因于 CLI。

已按后续“开始开发”指令执行首版。下文保留具体实施步骤，已完成任务的产物和检查引用见实施记录；历史计划状态不再代表当前执行状态。SDK 接入可以按需重写，业务原有监控范围与信号保留；正常输入优先使用这些已定义的事件，探针为可选辅助；当前基线使用已发布 SDK 0.3.0，不通过链接本地源码绕过发布包验收。

本文件 checklist 已按实际产物与检查结果更新，执行者为当前开发代理，实现版本 CLI 0.1.0，源码提交及未提交修改以验收 setup/source-versions.json 和文件哈希记录为准。任务只有在交付物已形成、对应检查通过后才能勾选；编写了代码、发出了请求或建立了测试文件都不单独代表完成。

尚未执行的任务保持未勾选。失败、阻塞、部分完成另记状态及原因；不得通过勾选隐藏它们。需求或契约变化时先更新依据文档，再修改任务和验收项，保留编号与变更记录。

## 2. 固定输入与运行时输入

固定输入以[验收输入 JSON](监控平台CLI验收输入.json)为单一基线，验收计划使用同一文件。不要把业务 package version、SDK version 和遥测 app.version 混成一个版本。

**平台与发布包。** 平台地址固定 http://localhost:8080。两业务消费 @cxdlogver/browser-monitor-sdk 的精确 0.3.0，其 Protocol 依赖为 3.0.0，使用 https://registry.npmjs.org/。2026-10-13 已查询官方 Registry 验证；实施时再次取得精确版本元数据及 integrity，不追随 latest 自动升级。[SDK 官方元数据](https://registry.npmjs.org/@cxdlogver/browser-monitor-sdk/0.3.0)；[Protocol 官方元数据](https://registry.npmjs.org/@cxdlogver/browser-monitor-protocol/3.0.0)。

**走航车输入。** 仓库为 F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform，前端包名 qhzhc-project。监控项目显示名称固定“实时走航车项目-CLI验收”，appName=qhzhc、app.version=1.0.0、environment=cli-acceptance。Origin 为 http://127.0.0.1:9527，数据产生页面为 /#/dataVisualization，routeName=/dataVisualization。配置输出到 QHZHC_Web/src/config/monitor.local.json。

**官网输入。** 仓库为 F:/CX_notes/cx-learn-notes/official-network，包名 official-network。显示名称固定“官网项目-CLI验收”，appName=guanwang、app.version=1.0.0、environment=cli-acceptance。Origin 为 http://localhost:3000，数据产生页面为 /solution，routeName=/solution。配置输出到 app/config/monitor.local.json。官网没有 package version 字段，不能在验收时臆造版本来源。

**运行时输入。** 每批次生成唯一 runId，通过 CLI 新建上述两个监控项目，把返回 projectId、keyId 和 DSN 绑定到相应 profile。账号与会话、事件 ID、发生时间、SDK 会话/视图 ID、查询窗口、服务端 asOf、夹具地址与实际部署保留/锁配置均运行时取得。重复显示名称不能当作本次项目身份；创建结果未知时先核查，不重建。

**真实业务事件。** 固定输入 JSON 的 profiles.businessEvents 给出事件定义。走航车主输入是进入 /#/dataVisualization 产生的 type=view、name=view.start；官网主输入是进入 /solution 后通过应用路由切换到 /，结算 type=span、name=site.route.stay。目录说明触发条件、路由、预期字段、单位、上报时机与身份关联。官网 site.visit 与走航车 view.end 可作补充输入，不能把所有信号当作普通 track 事件。

**身份与可选探针。** runId 用于分批保存验收证据，不要求真实事件名称或属性带该值。记录动作时间与实际采集的 sessionId/viewId/eventId，存在 trace/业务关联身份时一并核对；用现有查询参数定位，再以实际 eventId/occurredAt 进入诊断。多候选时补充采集依据，不能猜选。只有需要受控指定内容时才启用 optionalProbe，保留其单独来源；未使用探针不阻塞验收，探针成功不替代真实业务事件证据。track 返回 void，flush 只说明发送尝试，不新增属性筛选参数。

**共享边界输入。** 分页夹具 151 条、非法 limit=101；来源、创建、等待、网络与近期失败的固定输入见 JSON 的 controlledInputs。冻结时刻、最大跨度与实际队列数量仍由运行记录给出。

**命令约定。** 后续新增包建议放在 cli，包名 @cxdlogver/browser-monitor-cli，提供 bm 二进制。下文 bm 是该已构建本地二进制的简写；本仓库调用约定为 pnpm --filter @cxdlogver/browser-monitor-cli exec bm。SDK 配置与示例文件路径是目标设计，当前文件是否已存在由实施前检查。

## 3. 阶段依赖与交付顺序

~~~mermaid
flowchart LR
    M0["M0 契约与环境准备"] --> M1["M1 CLI 基础与身份"]
    M0 --> M2["M2 平台 API 与诊断"]
    M1 --> M3["M3 项目、来源与 SDK 产物"]
    M2 --> M3
    M2 --> M4["M4 数据读取与状态解释"]
    M1 --> M4
    M3 --> M5["M5 等待、健康与体验完善"]
    M4 --> M5
    M5 --> M6["M6 真实链路验收与交付"]
~~~

M1 和 M2 可以在契约一致后分别推进。M3 使用已经可用的项目与来源 API；M4 使用准确的诊断 API。统一结果与错误处理从 M1 开始接入所有功能，不能拖到最后补齐。

这里按阶段控制交付，不预设工期或人员。实际开工时根据平台 API 缺口和人员情况填写负责人、预计完成时间与阻塞依赖。

### M0：契约与环境准备

**交付物。** 冻结的命令与接口契约、平台能力清单、开发环境说明、验收数据准备方案，以及可记录证据的目录规范。能力清单说明已经满足、需要适配和需要补齐的部分，不以仓库内部知识作为使用说明前提。

**实施步骤。**

1. 读取固定输入 JSON，检查两个仓库与目标入口存在。记录源码版本、Node / pnpm 版本和端口使用情况，不启动会主动清理旧进程的走航车根 dev 脚本。
2. 逐项对照技术契约核查现有 API。建立 auth、projects、origins、events、三个 diagnostics 与 health 的“实际路径 → 规范操作”映射，并把缺失事实列为平台改造任务。
3. 固定成功和失败响应样例、Cookie / CSRF 处理、时间参数单位及游标结构。建立业务动作→事件定义→关联身份目录，对每项 AC 指定真实业务事件或控制夹具，探针标为可选；不能把模拟响应作为真实入库证据。
4. 创建验收驱动的 batch / case / step 记录器：每次调用独立保存命令、stdout、stderr、退出码、UTC 与单调时间，并生成 case-result 与 manifest。
5. 准备管理员、受限身份、空数据、同 ID 多候选、合法 no-op、历史缺失和分类队列夹具。记录生成方法及部署真实配置，不依赖历史业务数据库数量。
6. 基于上述结果确认接口缺口和依赖，才能开始 M1 / M2；本阶段产物为契约清单、输入基线、夹具清单及可生成证据的记录器。

- [x] IMP-M0-01 核对 FR-01 至 FR-12 的命令、输入、权限、数据语义和异常结果，列出平台现有能力与目标契约的差距。
- [x] IMP-M0-02 固定接口响应的必要字段、未知与空值规则、统一 JSON 包装、错误代码和退出码；明确写入响应与独立回查的区别。
- [x] IMP-M0-03 固定时间参数单位、范围、游标版本、输出预算的最小值，以及适配平台的最大查询跨度。
- [x] IMP-M0-04 获取部署实际保留策略和锁时限；未能取得的值按 unknown 设计，不能把参考的 30 天、7 天或 300 秒当作部署事实。
- [x] IMP-M0-05 准备本地平台、独立验收数据空间、已验证账号、管理员与权限受限账号、真实 SDK 业务应用。
- [x] IMP-M0-06 整理业务事件定义与关联取证方法，设计事件、任务和错误响应夹具；明确真实业务事件、可选探针与控制夹具各自的用途。
- [x] IMP-M0-07 建立验收批次与证据记录方式，确保每个 AC 编号可追溯到步骤、预期、观察及产物。
- [x] IMP-M0-GATE 契约与环境能够支持后续开发，缺口有负责人和处理任务，未解决事项没有被描述成已有能力。

### M1：CLI 基础、上下文、身份与统一输出

**交付物。** 可本地运行的独立包，公共命令入口、HTTP 客户端、上下文与凭据存储、统一结果格式，以及基础帮助信息。此阶段需要提供项目读取适配，支持 project use 验证；完整项目管理在 M3 交付。

**工程与公共网络能力。**

**实施步骤。**

1. 新建 cli/package.json、TypeScript 构建配置和 src/index.ts，声明 bm 入口；把 cli 加入工作区，提供 build、typecheck 和必要测试脚本。
2. 建立 contracts、commands、context、auth、http、services、output 与 files 目录。公共接口先定义 ResolvedContext、Result、TypedError 与时间预算，资源模块不能各写一套输出协议。
3. 实现 HTTP 请求与响应解析、认证附加、单调截止、有限 GET 重试和写入未知处理；记录请求身份但过滤凭据。
4. 运行 pnpm --filter @cxdlogver/browser-monitor-cli build，再用同包 exec bm --help 核对命令可发现；用受控服务验证超时、重试与契约错误。
5. 逐项接入下述上下文、身份和输出模块，保存构建与公共测试报告。

- [x] IMP-M1-01 建立独立 Node.js / TypeScript 包、本地 pnpm 调用入口、类型检查、构建与必要验证命令。
- [x] IMP-M1-02 实现公共参数校验、命令分发及非交互识别；缺少必要参数立即返回错误。
- [x] IMP-M1-03 实现默认 10 秒单请求与 30 秒普通网络命令预算；请求、退避和重试共享预算。
- [x] IMP-M1-04 实现只读请求最多两次重试，以及写入未知结果不自动重试；记录可知请求身份。
- [x] IMP-M1-05 对接口缺失及响应契约错误提供明确错误，不为必要字段生成虚假默认值。

**FR-01：选择平台并管理项目上下文。**

**具体实施步骤。**

1. 在 context 模块读取当前目录或 --context-dir 中的 .browser-monitor.json，校验 schemaVersion 与 URL，保留原文件内容用于保存失败比较。
2. 先解析平台，再解析该平台下的项目。账号、健康、列表和创建不要求项目；需要项目的命令缺失身份时直接结束。
3. 实现 project use：GET 项目确认可访问后再完整写入上下文；失败不替换旧文件。
4. 分别用显式参数、同平台上下文、跨平台和损坏文件调用，核对实际 context 与请求追踪。随后执行 AC-01 组，记录每个观察值。

- [x] IMP-01-01 实现平台及项目优先级，平台切换时禁止继承旧项目，不自动选择唯一项目或同名项目。
- [x] IMP-01-02 实现业务目录上下文读取、结构校验和保存；保存前验证项目可访问。
- [x] IMP-01-03 将实际平台、项目及参数来源传入资源服务；文件输出位置不随上下文目录隐式变化。
- [x] IMP-01-04 完成 AC-01 组验证并记录证据，确认账号操作、健康检查、项目列表和创建无需默认项目。

**FR-02：登录、检查身份与退出。**

**具体实施步骤。**

1. 实现 login 的隐藏密码与 password-stdin 输入，向认证接口提交，解析 Session、CSRF 和实际到期信息，不保存密码。
2. 在用户目录保存按规范平台地址隔离的会话，限制访问权限；保存失败要区分已认证与未能复用。
3. auth status 请求平台确认身份；普通命令遇到失效按错误结束，不自动提示输入。
4. logout 尝试远端撤销并清除本地记录，分别记录两个结果。用成功、远端不可达、本地写失败和错误 CSRF 夹具执行 AC-02 组。

- [x] IMP-02-01 实现隐藏密码输入与受控标准输入；密码不进入参数回显、日志和持久记录。
- [x] IMP-02-02 实现按平台隔离的 Session 与 CSRF 保存、用户文件访问保护，以及实际到期时间或未知值。
- [x] IMP-02-03 实现向平台核实身份；过期会话返回明确错误，普通命令不自动进入登录提示。
- [x] IMP-02-04 实现远端撤销与本地清除的独立状态，覆盖远端未知和本地保存失败。
- [x] IMP-02-05 完成 AC-02 组验证，检查跨平台凭据隔离和管理写入认证。

**FR-11：人和 AI 的结果与错误协议。**

**具体实施步骤。**

1. 在 output 模块建立统一 ResultBuilder 和退出码映射，所有资源服务只返回类型化事实或错误。
2. JSON 先完整序列化再计算 UTF-8 字节数；默认 1 MiB，超限生成有界错误，不能裁掉记录后沿用游标。
3. 让 JSON / table 共用同一结果对象，stderr 接收日志，正式输出只写 stdout；部分成功保留对象身份和成功文件。
4. 以 subprocess 捕获原始输出，对照 error code、退出码、敏感字段和分页。把 AC-11 公共测试接入每个后续命令。

- [x] IMP-11-01 实现统一 schemaVersion、ok、command、context、data、meta 与 error；保留未知、局部成功和分页信息。
- [x] IMP-11-02 默认 stdout 输出完整 JSON，日志与提示走 stderr；实现稳定错误代码与退出码。
- [x] IMP-11-03 实现 JSON / table 两种展示，确保目标、数据事实、范围和限制一致。
- [x] IMP-11-04 实现真实 UTF-8 字节预算检查，默认 1 MiB；超限返回明确错误，不截掉记录后沿用游标。
- [x] IMP-11-05 实现敏感管理凭据过滤和契约错误映射；授权 SDK 接入产物保持正确用途说明。
- [x] IMP-11-06 先完成 AC-11 的公共协议验证，后续每个命令联调时重复检查其协议接入。
- [x] IMP-M1-GATE 基础命令能非交互运行，上下文、身份、网络预算和结果协议检查通过，并保留可复查记录。

### M2：平台业务 API 与准确诊断能力

**交付物。** 可供 CLI 使用的项目、来源与认证契约，以及原始数据概况、单事件诊断和队列诊断三个只读接口。已有等价能力通过适配使用；缺失事实在平台端补齐。

**实施步骤。**

1. 在 API 适配层记录实际项目、来源与 raw-events 路径，保留已有等价业务接口；三个准确诊断接口是待补齐能力。
2. 在平台 API 的诊断服务实现 data 查询：同一数据库快照统计当前原始行与 max(receivedAt)，返回部署策略和 asOf。
3. 实现 event 查询：按 project/eventId/occurredAt 定位，关联处理证据、Outbox 和领域业务身份；完成记录缺失时保持 unknown。
4. 实现 queue 查询：同一 asOf 区分到期、退避、计划异常、正常锁、超时锁与锁缺失，并提供有限失败信息。
5. 校验账号项目权限、Owner / 等价管理员和 CSRF；响应脱敏遵守平台规则。
6. 以隔离数据生成每种阶段，保存参考快照与 API 响应；先验证服务端能证明事实，再交给 CLI 渲染。

- [x] IMP-M2-01 校验认证、项目列表 / 详情 / 创建和来源更新的实际返回值，补齐必要字段与权限契约。
- [x] IMP-M2-02 明确原始事件过滤、稳定排序、服务端游标和最大范围，不静默裁剪或忽略条件。
- [x] IMP-M2-03 为数据概况提供同一快照内的当前原始记录数量、最近接收时间、保留策略和 asOf。
- [x] IMP-M2-04 为单事件诊断提供明确定位、处理提交证据、任务信息、领域关联和历史限制；缺失证据保持 unknown。
- [x] IMP-M2-05 为队列诊断提供同一 asOf 的分类与合计、部署锁时限、失败 / 死信关系和有界近期失败。
- [x] IMP-M2-06 所有项目读取校验访问范围，配置修改校验管理员权限与 CSRF，数据遵守平台脱敏。
- [x] IMP-M2-07 准备准确的边界夹具，包括合法 no-op、同事件 ID 多候选、已处理但任务失败、历史任务清理与缺少锁信息。
- [x] IMP-M2-08 完成接口契约验证，保留请求、响应、数据准备清单及同一查询时刻的基准事实。
- [x] IMP-M2-GATE CLI 可取得需求所需事实；必要诊断不依靠客户端猜测，API 缺口已解决或明确阻塞相关交付。

### M3：项目管理、来源更新与 SDK 接入产物

**交付物。** 可回查的管理写操作、有效 SDK JSON、独立接入示例及文件恢复结果。项目创建、来源更新、上下文选择和文件生成各自保留状态。

**FR-03：查询、创建并选择项目。**

**具体实施步骤。**

1. 在 ProjectService 接通列表与详情，标准化 id、displayName、appName、enabled、role、origins 和 keys，缺少必要字段不猜值。
2. 实现创建输入校验与一次 POST，成功响应必须带可靠 ID；结果丢失或不可确认返回写入未知并保留可知身份。
3. 在批次准备中分别创建两个固定名称 / appName 的专用项目，保存 create 响应和独立 get 回查，不根据重复名称查找默认对象。
4. 将两个 projectId 写入本批次运行绑定；project use 是独立步骤，创建不自动覆盖目录上下文。执行 AC-03 组及未知写入回查。

- [x] IMP-03-01 完成列表和详情读取，返回项目身份、启用状态、角色及接入信息。
- [x] IMP-03-02 完成输入校验和创建；成功来自平台保存确认，不自动替换业务目录上下文。
- [x] IMP-03-03 完成创建响应丢失处理与后续回查路径，未知结果不自动重复创建。
- [x] IMP-03-04 完成 AC-03 组验证，核对创建对象的实际保存结果及相同名称的区分。

**FR-04：查看并设置业务来源。**

**具体实施步骤。**

1. OriginService 从详情读取当前集合，校验 HTTP(S)、协议、主机、端口与集合上限。
2. 使用完整集合执行一次 PUT：qhzhc 提交 http://127.0.0.1:9527，official 提交 http://localhost:3000；若实际使用其他主机名必须显式更新输入与来源。
3. 返回服务端最终保存集合，再用 origins get 回查。记录替换前后状态，不把输入数组当保存证明。
4. 执行无效来源、权限、CSRF 及响应丢失夹具，核对未授权写入不改数据；完成 AC-04 组。

- [x] IMP-04-01 完成来源读取、HTTP(S) 归一化、去重与集合校验。
- [x] IMP-04-02 完成整体替换写入，返回平台最终保存集合；权限不足不修改配置。
- [x] IMP-04-03 完成未知结果回查提示，不提供没有并发保障的隐式追加。
- [x] IMP-04-04 完成 AC-04 组验证，保留更新前后状态、提交内容和回查结果。

**FR-05：导出 SDK 配置 JSON 与接入示例。**

**具体实施步骤。**

1. 读取目标项目 enabled、appName 与 keys；实现唯一当前键和显式有效键选择，零个或多个候选先报错。
2. 从本批次绑定取得真实 DSN，用输入基线中的 version / environment 构建纯 SDK JSON，函数留在宿主接入代码。
3. 检查配置和示例目标不是同一路径，已有文件默认拒绝；明确覆盖时先保存基准，再完整写入并记录路径与哈希。
4. 输出两数据源的 monitor.local.json 与接入示例；模拟第二产物失败，保留成功 JSON。执行 AC-05 组，再进入本阶段 SDK 数据源准备。

- [x] IMP-05-01 从平台取得 enabled、appName、keys 与 DSN，按默认键或显式键规则选择有效接入身份。
- [x] IMP-05-02 环境和版本显式输入，生成纯 SDK 配置，不混入管理身份、函数或 CLI 包装。
- [x] IMP-05-03 生成加载 JSON、初始化、启动 SDK 和补充函数的示例；由业务接入者修改业务代码。
- [x] IMP-05-04 实现文件路径预检查、显式覆盖、单文件完整写入和多个产物局部成功报告。
- [x] IMP-05-05 完成 AC-05 组验证，使用实际 SDK 配置契约检查生成产物。

**真实事件数据源的准备步骤。**

该步骤只为 CLI 验收提供输入，不建立两业务的独立业务验收结论。使用以下实际文件和命令；修改范围为监控依赖、配置与包装插件。先利用已有真实信号，只有有明确辅助测试目的时才增加可选探针。

1. 在父工作区 F:/CX_notes/cx-learn-notes 保存两个 package.json 和父 pnpm-lock.yaml 基准。记录当前 workspace:* 与本地 link，查询精确发布版本及 integrity。
2. 从父工作区执行以下安装。显式禁止把同名发布版重新解析成本地工作区包；锁文件变化只接受本次依赖调整和必要传递依赖。[pnpm 10 add](https://pnpm.io/10.x/cli/add)、[Workspace 来源规则](https://pnpm.io/10.x/workspaces)。

~~~text
pnpm --filter qhzhc-project add @cxdlogver/browser-monitor-sdk@0.3.0 --save-exact --registry=https://registry.npmjs.org/ --config.link-workspace-packages=false --config.prefer-workspace-packages=false --config.save-workspace-protocol=false

pnpm --filter official-network add @cxdlogver/browser-monitor-sdk@0.3.0 --save-exact --registry=https://registry.npmjs.org/ --config.link-workspace-packages=false --config.prefer-workspace-packages=false --config.save-workspace-protocol=false
~~~

3. 从两个业务目录解析 SDK package.json 的真实路径和版本；检查父 lock importer 是精确 0.3.0 且不是 link:/file:/workspace:，integrity 对齐官方。SDK / Protocol 的真实路径不得落到 browser-monitor/sdk 或 protocol。仅 list / why 显示 0.3.0 不足以证明消费发布包。
4. 使用 AC-03-01 已创建的本批次两个新项目 ID、固定 Origin、业务 1.0.0 与 cli-acceptance 导出两个 JSON。不为数据准备重复创建主项目；同批次 AC-04-01 / AC-05-01 的产物可直接复用。以下 PROJECT_ID 是运行时绑定值，路径已固定；文件已存在时只有明确更新本批次配置才加 --overwrite。

~~~text
bm origins set --project QHZHC_PROJECT_ID --origin http://127.0.0.1:9527
bm sdk export --project QHZHC_PROJECT_ID --app-version 1.0.0 --environment cli-acceptance --out F:/CX_notes/cx-learn-notes/qhzhc-realtime-platform/QHZHC_Web/src/config/monitor.local.json

bm origins set --project OFFICIAL_PROJECT_ID --origin http://localhost:3000
bm sdk export --project OFFICIAL_PROJECT_ID --app-version 1.0.0 --environment cli-acceptance --out F:/CX_notes/cx-learn-notes/official-network/app/config/monitor.local.json
~~~

5. 走航车修改 QHZHC_Web/src/main.ts 与 src/plugins/monitor.ts：加载 JSON，用 app.name/version/environment 和 transport.dsn 替换旧构建值映射；保留单实例、仅 dataVisualization 启停、hash 路由命名和离开销毁。监控启用条件明确提供，DSN 使用平台绝对地址，不能进入业务 /api 代理。
6. 官网修改 app/plugins/monitor.client.ts：导入 JSON，用 createMonitor 合并宿主 resolveSectionName 函数。保持 client-only 与 createMonitor → createStayTracker → monitor.start → stayTracker.begin → provide.monitor 次序，复用同一实例。SSR 或 curl HTML 不会生成浏览器遥测。
将两个 monitor.local.json 加入各业务的本地忽略规则，提交可读占位示例与加载约定；实际专用 DSN 只保存在运行配置和授权验收产物中。

7. 整理已有业务事件定义并配置取证：走航车记录进入可视化页面时的 view.start，官网记录离开 /solution 时结算的 site.route.stay。明确 Span 结束后才生成记录，SDK 请求内的 eventId/sessionId/viewId 以及 trace 身份可用于关联；取证只保留核对必要字段。若另外需要固定自定义内容，可选择在 cli-acceptance 暴露探针，标记 eventSource=optional_probe 并说明目的。未选择时跳过以下示例，不增加强制埋点或第二 SDK 实例：

可选辅助事件的公开 API 示例：

~~~typescript
const eventName = `cli.acceptance.${business}.${runId}`;
monitor.track(eventName, {
  attributes: {
    acceptanceRunId: runId,
    business,
    action,
    sequence: 1,
  },
  metrics: { checkpoint: { value: 1, unit: 'count' } },
});
await monitor.flush();
// 无 eventId 返回；下一步从 CLI 原始事件查询获取。
~~~

8. 运行必要构建以确认接入配置能加载；这是数据准备检查。官网从其目录执行 pnpm build、必要时 pnpm test --run、pnpm dev。走航车从根目录分别 npm run dev:server 和 npm run dev:web，不调用会清理端口进程的根 dev 脚本。记录后端自动产生测试业务数据及启动日志脱敏。
9. 浏览器登录走航车，开始记录动作后进入或重新加载 /#/dataVisualization，捕获 view.start；官网完成客户端加载，进入 /solution 后通过应用路由切换到 /，捕获上一栏目 site.route.stay。保存 action-record.json 与 capture-identity.json：动作、时间、预期定义、实际采集名称/类型、app、路由和 SDK 生成身份。runId 只记录在验收产物中。核对 visibleMs 的存在、数值和 ms 单位，不验收业务计时算法精度、地图或页面内容。
10. 按各事件定义使用 CLI events list 的项目、type、name、environment、version、route-name 和有界时间窗口定位，已知 session/view/event ID 时使用对应现有参数。include-payload 对齐采集身份与预期字段，官网还核对 trace/span 关联和起始页面上下文。多个候选时补充身份依据，再取得真实 eventId/occurredAt 运行 diagnose/wait；不能默认取第一条，也不能把 flush 或网络 200 当作落库或处理完成。
11. 保留 package / lock 差异、registry 元数据、实际解析路径、接入配置、改造 patch、事件定义、真实动作与采集身份、CLI 结果及数据库回查；使用可选探针时另外记录其来源和目的。SDK 0.3.0 有阻塞问题时记录原因；如确需修改 SDK，先另定发布版本再更新基线，不用本地源码冒充 0.3.0。

- [x] IMP-SRC-01 两业务依赖及实际解析来源均为官方发布 SDK 0.3.0 / Protocol 3.0.0，保留完整来源证据。
- [x] IMP-SRC-02 两 JSON 来自本批次项目，固定 app / environment 与 Origin 正确，管理身份不进入业务文件。
- [x] IMP-SRC-03 接入包装保留现有监控范围、信号和生命周期；业务事件定义可独立阅读，可选探针若启用仅供验收环境使用。
- [x] IMP-SRC-04 两数据源的已定义真实业务事件可经 CLI 查询取得实际身份，与动作及采集依据对齐，不猜选候选或用发送状态证明落库。
- [x] IMP-SRC-05 数据准备有产物或明确阻塞，未生成数据不被误判成 CLI 业务功能失败。



- [x] IMP-M3-GATE 人和非交互调用者能创建或选择项目、写入来源并取得可接入产物；成功和异常均能继续核查。

### M4：原始数据、事件诊断与队列读取

**交付物。** 原始事件分页、当前保留概况、分阶段事件诊断及准确队列状态。每次调用取得本次查询事实，并附带来源、时刻与完整性边界。

**FR-06：检索数据库中的原始事件。**

**具体实施步骤。**

1. EventQueryService 校验范围与各过滤条件；首次冻结 [from,to)，默认最近 24 小时、50 条且最大 100。
2. CursorCodec 把平台、项目、原筛选与服务端游标绑定；续页恢复原条件，冲突或损坏时明确失败。
3. 标准化事件身份、发生 / 接收时间、环境、版本、页面和会话；include-payload 返回平台允许的脱敏内容。
4. 按业务事件定义检索真实事件，对齐项目、类型、名称、环境、版本、路由与实际关联身份；取得 eventId/occurredAt 后继续诊断，用有界夹具验证分页与范围，执行 AC-06 组。

- [x] IMP-06-01 完成时间、类型、名称、环境、版本、页面、会话及事件身份筛选。
- [x] IMP-06-02 实现默认最近 24 小时、单页 50 / 最大 100、固定范围续页与条件绑定游标。
- [x] IMP-06-03 提供摘要和显式脱敏内容读取；非法游标或不支持范围返回错误，不静默改条件。
- [x] IMP-06-04 完成 AC-06 组验证，检查重复排序值、无数据、迟到写入及清理边界。

**FR-07：查看原始数据的当前概况。**

**具体实施步骤。**

1. DataSummaryService 只调用原始数据概况接口，不遍历列表或读累计缓存推算总量。
2. 校验全部当前保留数量、最近接收、真实保留策略、source 与 asOf，未知策略保持未知。
3. 对空项目、真实业务事件到达前后和读取失败分别观察；有自动性能事件时用独立快照核对实际总量，不能预设总量为 1。
4. 执行 AC-07 组，把同一可比较时刻的数据库基准和 CLI 结果保存。

- [x] IMP-07-01 读取全部当前保留原始记录概况，不继承列表默认窗口。
- [x] IMP-07-02 返回当前数量、最近接收、asOf 和保留策略；不使用累计计数或领域记录量替代。
- [x] IMP-07-03 完成 AC-07 组验证，覆盖有效零结果、再次查询刷新和读取故障。

**FR-08：诊断单条事件的完整处理情况。**

**具体实施步骤。**

1. EventDiagnosticService 以本批次实际 projectId、eventId 和必要 occurredAt 请求全部保留范围；多候选返回身份歧义。
2. 原样保留 raw、processing、task、projection、history 各阶段，不合成一个掩盖差异的成功状态。
3. 用 no-op、领域修订、已提交但任务失败、任务缺失和原始缺失夹具验证推断边界；真实业务事件用于正常状态确认。
4. 执行 AC-08 组，逐项把观察与服务端阶段证据对齐。

- [x] IMP-08-01 支持全部保留范围定位和 occurredAt 消歧，不套用普通列表默认时间。
- [x] IMP-08-02 独立展示原始记录、处理提交、任务、领域可见性和历史限制，不制造合成成功状态。
- [x] IMP-08-03 处理合法 no-op、实体修订、任务缺失与原始缺失，不从数量或缺失推断历史。
- [x] IMP-08-04 完成 AC-08 组验证，保留阶段证据与领域关联依据。

**FR-09：查看当前任务数量与队列状态。**

**具体实施步骤。**

1. QueueDiagnosticService 读取服务端同一 asOf 的队列分类和真实 lockTimeout，不能按客户端时间再分类。
2. 核对 pending / processing 子类合计，包括缺少时间的异常类别；保留失败与死信重叠和有限失败列表说明。
3. 把采集计数、其他任务类型和数据库遥测队列分别展示，不能将正常锁当 Worker 心跳。
4. 执行 AC-09 的边界和故障夹具，记录统一时刻的任务基准、计算报告和实际 CLI 输出。

- [x] IMP-09-01 读取待执行、退避、无法分类、正常锁、超时锁和未知锁，并校验子类与总量。
- [x] IMP-09-02 返回终止处理、死信、近期完成和有界失败记录，解释重叠与列表限制。
- [x] IMP-09-03 独立标明非数据库采集计数、其他任务类型及其范围，不把正常锁等同于进程心跳。
- [x] IMP-09-04 完成 AC-09 组验证，核对同一时刻、分类边界与实际部署锁时限。
- [x] IMP-M4-GATE 人和 AI 能取得可解释的数据库和任务事实，空结果、未知与查询失败有明确区别。

### M5：有界等待、平台健康与使用说明

**交付物。** 有明确终止结果的单事件等待、逐项健康检查、完整命令帮助及从接入到排障的使用路径。

**FR-10：在有限时间内等待指定事件处理完成。**

**具体实施步骤。**

1. EventWaitOrchestrator 记录单调截止，首次立即诊断；每次把剩余预算传入 HTTP 客户端。
2. 只在同一结果中 processing committed 且对应 task completed 时完成；failed、历史不足和歧义分别结束。
3. 未完成时按间隔观察，重试与间隔计入总时限；故障时保留最后有效 asOf，不伪装成新状态。
4. 对真实业务事件和可控时钟夹具执行 AC-10，核对默认 60 秒 / 2 秒与截止后无请求。

- [x] IMP-10-01 复用单事件诊断，完成条件为同一结果中处理已提交且对应任务完成。
- [x] IMP-10-02 实现默认 60 秒 / 间隔 2 秒、可配置预算、单调截止与最后有效观察记录。
- [x] IMP-10-03 区分完成、终止失败、历史不足、身份歧义、等待超时和查询故障。
- [x] IMP-10-04 完成 AC-10 组验证，确认没有任务执行写入、无限轮询或对缓存刷新的额外承诺。

**FR-12：检查平台连接与基础可用性。**

**具体实施步骤。**

1. HealthService 使用平台上下文，不要求项目；分别请求管理 API、live 和 ready 检查。
2. 将规范的未登录响应与 API 不可响应区分，保留每项 pass / fail / unknown、来源和原因。
3. 所有检查共享普通命令预算，局部失败保留已取得事实；不输出未经证明的后台进程健康结论。
4. 执行 AC-12 的正常、局部故障、缺失检查和慢响应夹具，核对真实截止行为。

- [x] IMP-12-01 独立检查连接、管理 API、服务存活和关键依赖，不要求项目。
- [x] IMP-12-02 保留 pass / fail / unknown、来源与原因，未登录响应不自动代表平台不健康。
- [x] IMP-12-03 共享普通命令预算，健康结果不推断 Worker 状态。
- [x] IMP-12-04 完成 AC-12 组验证，覆盖局部故障、接口缺失和正确的失败范围。

**使用与恢复说明。**

**实施步骤。**

1. 为每个命令补充可复制的输入示例、单位、权限、数据变化、响应及恢复方向，并使用本计划固定输入演示。
2. 给非交互驱动实现前一步 ID 解析、下一步参数构造和错误终止，不通过 Web 页面推断平台状态。
3. 逐命令检查 stdout / stderr 和退出码；业务页面动作只用来准备事件，不能混成业务功能验收。
4. 保存帮助覆盖与 subprocess 解析报告，把最终未执行 AC 留为未勾选。

- [x] IMP-M5-01 补齐每个命令的输入、输出、单位、权限、数据变化、异常和恢复示例。
- [x] IMP-M5-02 提供人工接入、AI 非交互调用及脚本解析示例，说明 Session 过期后的处理。
- [x] IMP-M5-03 再次检查所有命令均接入 FR-11，标准输出不混入日志。
- [x] IMP-M5-GATE 全部功能可按文档独立使用，结束条件与默认参数符合技术契约。

### M6：真实链路验收与交付

**交付物。** 可运行版本、全部适用验收记录、真实 SDK 链路产物、问题闭环记录和最终验收结论。

**实施步骤。**

1. 为本批次生成 runId、两个真实数据源绑定和受控夹具目录。保留全部 47 个 AC 编号；以 CLI 功能决定输入，不机械地把每项重复运行两遍。
2. 项目创建、来源、JSON 导出准备产物可以供后续 AC 引用；每项仍独立填写预期、观察和 evidence 定位，不重复创建第二套业务接入对象。
3. 用两个数据源分别执行已定义的真实动作，CLI 查到 view.start / site.route.stay 并对齐配置、项目、关联身份与真实 eventId；使用 action-record/capture-identity 提供独立依据，验证 CLI 能力，不评判业务页面功能。
4. 按 AC 步骤执行 42 个功能用例、2 个可靠性用例和 3 个完整调用用例。故障、历史和参数矩阵使用标明来源的受控夹具。
5. 逐 R 填入实际值、退出码与证据；失败或输入不足标为失败 / 阻塞，不能直接勾选通过。
6. 生成 case-index、manifest 和总结，修复后建立复验记录并核对版本与证据。

- [x] IMP-M6-01 执行 AC-01 至 AC-12 全部功能验收，逐项填入预期、观察与证据，保留失败和复验历史。
- [x] IMP-M6-02 执行公共网络预算与协议恢复验收，检查真实请求次数和截止后是否继续请求。
- [x] IMP-M6-03 执行真实接入闭环，使用可追踪事件关联项目、SDK、原始记录、处理证据和任务结果。
- [x] IMP-M6-04 执行人、AI 或等价非交互调用的同权限管理与查询流程，证明结果可以直接解析和继续使用。
- [x] IMP-M6-05 执行部分成功后的恢复流程，不重复创建对象或删除成功产物。
- [x] IMP-M6-06 修复失败项并复验，核对实现版本、需求版本、观察时刻和证据一致。
- [x] IMP-M6-07 核对帮助、使用说明、需求、技术设计、计划和实际行为，记录部署保留与锁配置。
- [x] IMP-M6-GATE 所有适用验收项通过且有证据；未决问题明确记录，不以无日志、无报错或空队列替代交付结论。

## 4. 完成记录与变更管理

每个阶段维护以下记录。一个人可以承担多个角色，但记录必须能识别具体执行者和版本。

~~~text
阶段 / 任务编号：
负责人：
执行版本与环境：
开始时间 / 完成时间：
交付物：
关联验收项：
结果：未开始 / 进行中 / 通过 / 失败 / 阻塞
证据或记录位置：
遗留问题 / 阻塞依赖：
下次动作：
~~~

- [x] IMP-TRACK-01 每项已完成任务都有交付物和检查记录，未勾选项有当前状态或后续安排。
- [x] IMP-TRACK-02 需求调整、接口变更和验收规则变化同步到四份文档，保留影响范围。
- [x] IMP-TRACK-03 不把未执行用例记为通过；适用项因环境缺失无法验证时记录阻塞，不能用不适用规避。
- [x] IMP-TRACK-04 最终验收结论能够沿 FR → 实施任务 → AC 用例 → 预期与观察 → 证据追溯。


## 5. 已完成实施的交付与检查

M0 的命令/数据契约、两种输入来源、角色与故障夹具已经形成；实际默认值、最大范围、队列策略和部署要求见技术设计文档第 4 节。M1 交付独立 CLI 包及公共参数、上下文、会话、HTTP、JSON/table 和错误协议，M2 交付原始检索与三个只读诊断 API，并通过真实 SQL 边界核对。

M3 完成项目创建、Origin 整体替换和 SDK 产物。两业务已经切换精确发布包 0.3.0，接入读取本次导出的 JSON，并保留原有监控范围与埋点。M4 完成筛选、固定窗口分页、全部原始保留量、单事件阶段和队列分类。M5 完成等待、健康、帮助和使用说明。M6 完成全部 47 项验收与 94 条观察，真实业务、非交互调用、失败后恢复和旧失败复验均有证据。

逐阶段产物、已修复问题、测试报告、输入基线及实现路径见 [首版实施记录](监控平台CLI实施记录.md)；每条 IMP 验证项按其原 FR/AC 关联到 [验收计划](监控平台CLI验收计划.md) 的已填写观察与 [2026-10-13T12-18-35-945Z-2bbc01 用例索引](验收记录/2026-10-13T12-18-35-945Z-2bbc01/case-index.json)。代码与观察不会仅凭 checklist 勾选代表完成。
