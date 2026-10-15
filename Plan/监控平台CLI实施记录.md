# 监控平台 CLI 首版实施记录

执行日期：2026-10-13。交付版本：@cxdlogver/browser-monitor-cli 0.1.0，仓库内私有包。需求基线 1.3、技术设计 1.2，固定验收输入 schemaVersion=2。

首版已完成接入准备与诊断闭环：人、AI 和脚本可以通过 API 登录、选择或创建项目、整体替换业务 Origin、导出 SDK JSON 与示例，并查询原始事件、当前保留量、单事件处理阶段、任务积压与平台健康。等待命令有明确截止和终止原因。命令默认返回完整 JSON，人工可以选择表格。

实际执行的 47 项验收全部通过，94 条结果均有预期、观察和具体证据。验收清单仍保留每项步骤，未合并或删除功能项；走航车和官网用于提供真实事件输入，没有扩大为业务页面功能验收。

## 交付内容及其作用

[CLI 包](../cli/README.md)提供 bm 二进制。参数、上下文、受保护的 Session、HTTP 时间预算、响应契约、错误代码与格式化分别在 cli/src 中实现。根工作区包含 CLI，并通过本地 workspace 引用链接二进制，实际 pnpm exec 入口已经验证；首版没有执行 npm 发布或全局安装。

登录复用平台账号、Session Cookie 和 CSRF。凭据位于用户目录，业务目录只存平台与项目选择。管理能力使用原有平台权限，AI 与人工同权：创建要求登录，Origin 更新要求 Owner。非交互登录必须用受控标准输入；普通读取不会在会话失效后等待人工输入。

[诊断 API](../platform/apps/api/src/diagnostics/diagnostics.controller.ts)新增原始事件检索及三个只读诊断资源。概况统计全部当前保留原始记录；事件诊断分别返回原始记录、处理提交、Outbox、领域关联及历史限制；队列以同一数据库 asOf 区分可执行、退避、无法分类、正常锁、超时锁和缺锁。Redis 采集计数单列，不当作数据库保留量，也不冒充同一快照。

[数据库迁移](../platform/packages/database/migrations/0007_diagnostics.sql)增加实际失败时刻及索引。Worker 写入真实 last_failed_at，历史错误没有时间时保持 null。锁超时与已完成任务保留策略由共享常量提供，诊断与 Worker 使用相同规则。当前实体存在不证明某条事件改变了实体，合法 no-op 不需要新增领域行。

SDK 产物保持纯配置，app/name/version/environment 与 DSN 来自明确业务参数及平台值。示例补充客户端初始化、路由函数、start 和生命周期说明；不同文件目录使用正确相对引用。已有文件需要明确覆盖，多产物失败保留成功 JSON，后续可以沿用已确认对象和文件继续恢复。

现有三个容器配方同步复制 CLI workspace manifest 与二进制入口，避免根本地依赖导致安装失败。后端容器已实际完成冻结锁文件安装和 Protocol/Shared/Database/API/Worker 构建，日志见 [容器构建记录](docker-backend-build.log)。验收证据目录从镜像上下文排除，构建不复制本地凭据或测试产物。

## 两个真实输入项目

实时走航车前端从 QHZHC_Web/src/config/monitor.local.json 读取 CLI 配置，保留只监控 dataVisualization 的规则及原有启用开关。实际进入该页面后生成 view.start / view 事件。官网客户端插件从 app/config/monitor.local.json 读取配置，保留 site.visit 与 site.route.stay 的 Span 生命周期；进入 /solution 后经应用路由切换到 /，结算上一栏目停留事件。

两个业务包的 manifest 与父锁文件均精确声明 SDK 0.3.0，实际解析为 Registry 包，Protocol 为 3.0.0；没有解析成本地 workspace 源码。发布元数据 integrity、锁文件 importer、实际模块路径、配置哈希、接入变化及源码提交均保存在正式验收 setup 目录。业务 version=1.0.0、environment=cli-acceptance，与 SDK 版本分别记录。

本次两个监控项目通过 CLI 新建，动态身份为：

- 走航车：c374e6cd-4d9b-4045-8678-0d0f5b3ca6dd；实际 view.start 为 event-mv6lymu3-3-as5ip2jy，occurredAt=2026-10-13T11:39:07.419Z。
- 官网：9d0d0f78-cefc-46d5-9543-7682587db457；实际 site.route.stay 为 event-mv6m7o46-p-fgojbyio，occurredAt=2026-10-13T11:46:08.982Z。

两个查询信封与独立读取的数据库原值逐字段相同，诊断 processing=committed、task=completed，等待结果 completed。官网另核对 section/path=/solution、visibleMs 的非负数值与 ms 单位、traceId/spanId。这里不验收停留计时精度或页面全部功能。

没有新增或使用验收探针。身份依据为真实浏览器动作记录与独立读取的持久化 SDK 信封；记录明确说明没有进行网络拦截。查询限定实际项目、事件、类型/名称、业务参数、路由、时间及可用会话/视图身份，没有取第一条候选猜测本次动作。

## 验收结果、来源与复查

完整通过批次为 [2026-10-13T12-18-35-945Z-2bbc01](验收记录/2026-10-13T12-18-35-945Z-2bbc01/acceptance-summary.md)。

- [47 项用例索引](验收记录/2026-10-13T12-18-35-945Z-2bbc01/case-index.json)记录每项状态和结果路径。
- 每项 case-result.json 保留两条原始预期、具名实际断言、命令退出码与耗时，以及可复查证据路径、定位说明和 SHA-256。
- [证据审计](验收记录/2026-10-13T12-18-35-945Z-2bbc01/evidence-audit.json)核对 47 项、94 条结果、1,023 个用例产物，确认 JSON 可解析、哈希匹配、实现源文件未在验收中改变。
- [输入绑定](验收记录/2026-10-13T12-18-35-945Z-2bbc01/setup/bindings.json)、[事件身份](验收记录/2026-10-13T12-18-35-945Z-2bbc01/setup/events.json)、[安装来源审计](验收记录/2026-10-13T12-18-35-945Z-2bbc01/setup/installation-audit.json)和源码版本记录说明实际对象及输入来源。

核心真实 API/数据库/Worker 联调另有 29 条检查；数据库诊断边界有 10 条检查，包含同 ID 消歧、较旧修订 no-op、原始/任务历史缺失、处理与任务独立、时间窗口和精确队列边界。SQL 边界使用真实数据库查询，只把 transaction_timestamp 替换为注明的受控时刻；该组 Redis hgetall 使用注明的固定辅助响应，不冒充真实 Redis 读取。

公共参数、响应丢失、截断 JSON、文件失败和时间预算使用可追踪的独立 HTTP/文件夹具。静态 151 条分页与真实数据库的 152 条联调数据分别保存，不把不同数据集合或不同时刻的计数混为同一基准。真实权限补证确认 member 只能读取所属项目数据，另一个项目的列表、概况、队列均被拒绝；真实退出补证确认同一旧 Cookie 在撤销后返回 HTTP 401。

上一完整批次 [2026-10-13T12-12-03-098Z-5ea1a2](验收记录/2026-10-13T12-12-03-098Z-5ea1a2/acceptance-summary.md)保留 42 通过、5 失败的原始输出。夹具中的错误表名和错误故障注入阶段已修正；列表缺失能力映射、健康超时分类、跨目录 SDK 示例引用已修复。后续也修正本地二进制链接及 SDK 精确版本声明，并实际核对最终入口和安装来源。旧失败没有被覆盖为通过。

回归检查实际通过 50 条：CLI [27 条](cli-regression.json)、API [17 条](api-regression.json)、Worker [6 条](worker-regression.json)。本地 [pnpm 入口健康结果](cli-entry-health.json)为完整单个 JSON；匿名管理 API 可响应，认证状态单独为 unknown。后端 Docker 镜像实际构建成功，未进行发布。

## 使用与继续开发

在监控仓库先安装工作区依赖、构建 CLI，然后查看帮助：

~~~sh
pnpm install --frozen-lockfile
pnpm --filter @cxdlogver/browser-monitor-cli build
pnpm --filter @cxdlogver/browser-monitor-cli exec bm --help
~~~

从业务目录直接调用绝对入口，可让上下文和相对产物位置以该业务目录为基准：

~~~sh
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs auth login --email ACCOUNT
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs project list
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs project use PROJECT_UUID
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs events list --name site.route.stay --include-payload
node F:/CX_notes/cx-learn-notes/browser-monitor/cli/bin/bm.mjs queue status
~~~

注册和邮箱验证使用平台既有 Web 流程。AI 登录改用 --password-stdin，密码来自受控输入，不能放入命令参数或证据文件。SDK JSON 可以重新导出到业务配置目标，业务环境、版本与 Origin 均显式填写。走航车仍需 VUE_APP_MONITOR_ENABLED=true 才启动原有监控接入。

诊断接口首次部署前，在实际平台的 DATABASE_URL 环境下执行 pnpm --filter @browser-monitor/database migrate。该命令使用迁移台账，只应用未执行的迁移；不要把验收连接串当作日常平台配置。默认数据库已有不同凭据，本次没有修改其密码或数据；所有验收写入位于独立 15432/16379 的测试环境。

复验驱动与准备脚本位于 cli/scripts。verify-local 创建独立输入批次；真实业务动作需要按事件定义执行并保存实际时间和身份，再由 capture-business 读取动作记录。verify-acceptance 执行 47 项，complete-acceptance 补充真实权限/撤销证据并审计产物。边界 SQL 运行时需要停止本次验收 Worker，避免受控任务被并发消费；恢复运行或新查询时，不能把旧夹具时刻的状态当作当前事实。

实施计划的 97 条检查项和验收计划的 47 项 checklist 已按本次交付、检查与证据更新。后续需求变更继续沿 FR → IMP → AC → 预期/观察/证据追踪，保持计划和实际结果可独立阅读。

本轮自启动的浏览器标签页、API/业务服务及五个容器已经结束，数据库卷、业务配置和所有证据保留，详见 [服务清理记录](services-cleanup.json)。再次调用网络命令前按平台部署说明启动服务；本地 help 和文件入口无需平台。
