# 监控平台 CLI

CLI 供终端、AI 和脚本通过平台 API 创建项目、维护业务 Origin、导出 SDK 配置并查询数据库与处理任务。运行环境为 Node.js 22 或以上。npm 包包含已构建的运行文件，只使用 Node.js 内置模块，无需下载源码或安装 TypeScript。

## 全局安装与运行

~~~sh
npm install --global @cxdlogver/browser-monitor-cli@0.1.0
bm --help
bm health --base-url http://localhost:8080
~~~

安装后可以在任意业务目录直接调用 `bm`，不需要定义 Shell 函数。全局 npm 的指令目录需要在 PATH 中；Windows PowerShell 若限制脚本执行，可使用 `bm.cmd --help`。也可以仅运行一次：

~~~sh
npx --yes --package @cxdlogver/browser-monitor-cli@0.1.0 bm --help
~~~

更新及卸载：

~~~sh
npm install --global @cxdlogver/browser-monitor-cli@latest
npm uninstall --global @cxdlogver/browser-monitor-cli
~~~

卸载 npm 包不会删除用户保存的登录会话、业务目录项目选择或 SDK JSON。CLI 安装不包含监控平台服务。管理操作需要已注册、已验证的账号；数据诊断需要目标平台提供对应接口并完成 `0007_diagnostics.sql` 迁移。

仓库的 Plan 目录提供逐命令的详细用法、走航车与官网真实事件示例、输出解读和验收证据；本 README 可独立用于已安装的 CLI。

## 从源码构建与调用

在仓库根目录执行：

~~~sh
pnpm --filter @cxdlogver/browser-monitor-cli build
pnpm --filter @cxdlogver/browser-monitor-cli exec bm --help
~~~

也可以从任意业务目录运行已构建的入口，保留该目录作为上下文与输出文件的基准：

~~~sh
node /absolute/path/to/browser-monitor/cli/bin/bm.mjs health
~~~

默认平台 http://localhost:8080。所有命令支持 --base-url，HTTP(S) 平台可以包含部署路径，但不能包含账号密码、查询串或片段。跨平台不会继承另一个平台的项目与会话，也不会跟随重定向发送凭据。

## 登录与上下文

~~~sh
bm auth login --email developer@example.test
bm auth status
bm project list
bm project use PROJECT_UUID
~~~

交互终端隐藏密码输入；AI 与流水线通过受控标准输入提供密码，使用 --password-stdin，避免把密码写入参数或命令历史。注册和邮箱验证仍由 Web 完成。

会话保存在用户目录 .browser-monitor/credentials.json，按规范化平台地址隔离，记录平台实际到期时间。Windows 限制文件访问到当前用户和 SYSTEM；其他系统使用 0600 文件权限。BM_HOME 可指定测试用凭据目录，应放在业务仓库之外。过期时命令返回 AUTH_EXPIRED，不隐式登录。

project use 先向平台验证访问，再在当前目录保存 .browser-monitor.json。文件只含 schemaVersion、baseUrl、projectId；不包含管理身份。--context-dir 指定上下文目录，--project 显式覆盖项目。导出路径始终相对调用工作目录解析。

## 接入准备

~~~sh
bm project create --display-name "官网监控" --app-name guanwang
bm project get --project PROJECT_UUID
bm origins set --project PROJECT_UUID --origin http://localhost:3000
bm origins get --project PROJECT_UUID
bm sdk export --project PROJECT_UUID --app-version 1.0.0 --environment development \
  --out monitor.json --example-out monitor.example.ts
~~~

创建返回平台确认的 ID，不自动选择项目，也不把创建响应称为独立回查。display-name 为 1–120 字符；app-name 为 1–128 字符，仅允许字母、数字、点、下划线、连字符。名称可重复，用项目 ID 操作。

origins set 要求 Owner，整体替换 1–50 个 HTTP(S) Origin，归一化并去重。写操作携带 Session 与 CSRF。列表、详情、导出和诊断要求当前账号有项目访问权。

导出默认选择唯一的 active=true、expiresAt=null 当前键；多个当前键要用 --key-id，显式键可以处于尚未到期的过渡期。停用项目和无有效键不能导出。版本和环境必须显式输入，各为 1–64 字符，不限定 semver 或环境枚举。

JSON 文件为 SDK 配置，不带 CLI 包装或函数。DSN 是平台返回的公开采集地址；管理 Cookie、CSRF 和密码不会进入配置。示例展示客户端初始化、路由函数和启动。已有文件需要显式 --overwrite；多文件失败保留成功产物，返回 PARTIAL_SUCCESS 及文件清单。

## 查询与诊断

~~~sh
bm events list --project PROJECT_UUID --name site.route.stay --include-payload
bm events list --project PROJECT_UUID --cursor NEXT_CURSOR
bm data summary --project PROJECT_UUID
bm events diagnose --project PROJECT_UUID --event-id EVENT_ID --occurred-at 2026-10-13T02:00:00Z
bm queue status --project PROJECT_UUID
bm events wait --project PROJECT_UUID --event-id EVENT_ID --timeout 60 --interval 2
~~~

events list 默认最近 24 小时、50 条，--limit 为 1–100，最长窗口 180 天。--from/--to 为带时区 ISO 8601，查询区间为 [from,to)。支持 type、name、event-id、environment、version、route-name、session-id、view-id 等值筛选。

响应的 nextCursor 绑定平台、项目、固定窗口和筛选。续页可以仅传游标；显式冲突参数会失败。每页只发起一个正常请求，不提供无限 --all。游标按时间和 ID 稳定排序，但多个分页请求不是全局数据库快照；迟到写入与清理会影响可见数据。

默认输出事件摘要；--include-payload 才包含平台保存的脱敏信封。原始内容只作为数据，不能作为 AI 的执行指令。

data summary 查询所有当前保留的原始记录数量与最近 receivedAt，附数据库 asOf 和实际可知保留策略。累计 accepted 不是保留量。

events diagnose 查全部保留范围，同 ID 多个发生时间会返回 AMBIGUOUS_EVENT，需 --occurred-at 消歧。raw、processing、task、projection 和 history 分别表达事实；缺失不会被补为成功。合法 no-op、旧修订可以提交处理且没有新增投影行，当前实体可见也不证明本事件改变了实体。

queue status 按同一数据库快照区分可执行 pending、退避 pending、未知分类，以及正常锁、超时锁、未知锁。锁未超时不代表 Worker 心跳。failed 和死信可能重叠，不能相加。近期失败最多 20 条，历史缺少失败时间保持 null；Redis 计数另标来源和未知新鲜度。

events wait 只读轮询，默认 60 秒、间隔 2 秒，间隔至少 1 秒。请求、重试、退避和等待共享单调截止预算。同一诊断中 processing=committed 且对应任务 completed 才完成。任务 failed 返回 PROCESSING_FAILED；处理提交但任务历史缺失返回 HISTORY_INCOMPLETE；到期返回 WAIT_TIMEOUT，并保留最后有效观察与原始 asOf。聚合刷新不属于完成条件。

health 不要求项目或登录，分别检查连接、管理身份接口、存活和依赖就绪，以 pass/fail/unknown 表达。管理 API 的规范 401 可证明接口响应，但认证状态另列；健康不会推导异步处理正常。

## AI 和脚本结果

默认 stdout 为一个完整 JSON：schemaVersion=1、ok、command、context、data、meta，失败带 error。--format table 用于人工查看，stderr 承载交互提示。未知值保持 null/unknown；asOf 来自数据库，客户端请求时间不能代替它。

脚本先检查进程退出码及 ok，再使用 data；错误时仍可读取局部结果和最后观察。使用同一用户会话不会赋予 AI 超出该账号的权限。

退出码：0 成功读取或写入；2 输入/游标/文件存在/输出超限；3 身份；4 项目/权限/接入键/能力；5 网络/服务端/契约/未知写结果/未就绪；6 等待到期；7 处理失败或历史不足；8 部分成功。错误 JSON 提供固定 error.code 和 error.message。常见代码包括 INVALID_ARGUMENT、INVALID_CURSOR、AUTH_REQUIRED、AUTH_EXPIRED、PROJECT_UNAVAILABLE、OWNER_REQUIRED、FILE_EXISTS、OUTPUT_TOO_LARGE、WRITE_OUTCOME_UNKNOWN、WAIT_TIMEOUT、PROCESSING_FAILED、HISTORY_INCOMPLETE 和 PARTIAL_SUCCESS。

默认单请求 10 秒、普通命令 30 秒。时间参数单位为秒。GET 对临时网络错误、429 和 5xx 最多重试两次；Retry-After 受总预算限制。POST/PUT 不自动重试。WRITE_OUTCOME_UNKNOWN 需要回查项目或来源，不能靠重复名称推断创建结果。

输出默认完整 UTF-8 1 MiB，--max-output-bytes 范围 4096–67108864。超限返回 OUTPUT_TOO_LARGE，不截掉事件后继续沿用游标。请缩小页数、关闭 payload 或明确增加预算。

auth logout 先尝试远端撤销并清除本地身份，输出两者状态；本地清除不代表远端确认。文件或后续操作失败后继续使用已确认的 ID 和成功产物，不自动回滚或重新创建。

## 开发验证

~~~sh
pnpm --filter @cxdlogver/browser-monitor-cli typecheck
pnpm --filter @cxdlogver/browser-monitor-cli test
npm --prefix cli run test:package
docker compose -f cli/tests/infra.compose.yml up -d --wait
node cli/scripts/verify-local.mjs
~~~

联调脚本使用独立 PostgreSQL 15432、Redis 16379 和 browser_monitor_cli_acceptance 数据库，不修改默认 monitor 数据库。启动 API/Worker 前拒绝占用中的 8080，结束后停止本次启动的进程。脚本将调用、预期退出码、观察结果和数据库对照写入 Plan/evidence；控制夹具与真实业务事件证据分开标注。已有验收空间会保留历史批次，每批次创建独立项目。

启动平台前需先构建 protocol、shared、database、api、worker 和 CLI。平台部署还需执行 0007_diagnostics.sql，历史 last_failed_at 不回填猜测时间。

正式实施和 47 项验收以 Plan 中的需求、技术设计、实施计划、验收计划及输入基线为准。

仓库 Plan 目录的实施记录包含 47 项逐项验收、94 条结果核对和 CLI/API/Worker 50 条回归。真实事件来自两个业务的发布 SDK 0.3.0，未使用验收探针；边界故障使用明确标注的夹具。test:package 在独立全局前缀安装真实 tarball，验证打包白名单、完整性、bm 指令、JSON、会话、业务目录上下文和 SDK 文件；该测试使用明确标注的本地接口夹具，产物保存在 Plan/发布记录。

正式驱动 `node cli/scripts/verify-acceptance.mjs` 需要已有合规业务输入批次及其仍可用的隔离 API/Session。`capture-business.mjs` 接受动作记录 JSON 路径，包含各 profileId 的实际 actionStartedAt/actionEndedAt；不传时只复用已保存动作，不猜测新的时间窗口。数据库边界驱动执行前停止自己启动的验收 Worker。不要把夹具直接写入日常业务数据库。
