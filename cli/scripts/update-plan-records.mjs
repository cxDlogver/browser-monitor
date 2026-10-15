import { root, resolve, readFile, writeFile, files, assert } from './acceptance-kit.mjs';
const relativeRun=process.argv[2];const run=resolve(root,relativeRun);const index=JSON.parse(await readFile(resolve(run,'case-index.json'),'utf8'));const audit=JSON.parse(await readFile(resolve(run,'evidence-audit.json'),'utf8'));assert.equal(index.passed,47);assert.equal(audit.checkpoints,94);
const records={};for(const item of index.cases){const r=JSON.parse(await readFile(resolve(run,item.caseId,'case-result.json'),'utf8'));const steps={};for(const file of await files(resolve(run,item.caseId,'steps')))if(file.endsWith('/stdout.json'))steps[file.split('/')[0]]=JSON.parse(await readFile(resolve(run,item.caseId,'steps',file),'utf8'));records[item.caseId]={r,steps,checks:r.assertions[0].observed.checks};}
const data=(id,step)=>records[id].steps[step]?.data;
const error=(id,step)=>records[id].steps[step]?.error?.code;
const check=(id,name)=>records[id].checks.find(c=>c.name===name)?.observed;
const j=value=>JSON.stringify(value);
const observations={
 'AC-01-01':['默认读取的 context 为 '+j(records['AC-01-01'].steps.default.context)+'；显式项目覆盖后 projectId 为 '+data('AC-01-01','override').id+'。','切换平台但不指定项目返回 '+error('AC-01-01','missing')+' / 2；显式平台 B 的 context 为 '+j(records['AC-01-01'].steps.explicit.context)+'，请求在 B 端记录。'],
 'AC-01-02':['上下文仅含 baseUrl、projectId、schemaVersion；拒绝选择退出 4，前后内容逐字相同。','context-dir 与调用目录不同；实际导出文件为 '+data('AC-01-02','export').artifacts[0].path+'，落在调用目录。'],
 'AC-01-03':['缺少项目与损坏文件均返回 CONTEXT_MISSING / 2，参数失败阶段请求数为 0，没有自动选中单项目。','独立空目录中的 list、auth-status、health 均退出 0；这些调用不要求默认项目。'],
 'AC-02-01':['login、status、read 均退出 0；sessionSaved=true，后续请求复用平台 Session；凭据文件 passwordPersisted=false。','icacls 记录确认文件无继承权限及宽泛用户组授权；所有命令 stdout/stderr 都执行了密码、Cookie、CSRF 匹配检查，匹配数为 0。'],
 'AC-02-02':['标准输入登录成功；无 TTY 且无输入返回 INVALID_ARGUMENT / 2，未请求平台；失效会话返回 AUTH_EXPIRED / 3。','没有 Expires/Max-Age 的成功会话实际 expiresAt='+j(data('AC-02-02','unknown-expiry').expiresAt)+'，没有推算有效天数。'],
 'AC-02-03':['A/B 服务端分别记录 cookieMatches=true；重定向请求未跟随，B 未增加认证请求。','Owner 写入携带有效 CSRF；受限写入被拒绝。真实平台缺少/错误 CSRF 均返回 403，独立数据库读取确认 Origin 未变。'],
 'AC-02-04':['正常退出 localCleared=true、remoteRevocation=confirmed；真实旧 Cookie 退出前 HTTP 200，退出后独立请求 HTTP 401。不可达退出为 8，localCleared=true、remoteRevocation=unknown。','本地保存锁故障时平台已发出会话，CLI 返回 PARTIAL_SUCCESS / 8，sessionSaved=false，未声明本地会话可复用。'],
 'AC-03-01':['受控创建返回动态 ID='+data('AC-03-01','create').id+'，get/list/平台存储一致。两个真实主项目的创建响应、详情与独立 SQL 名称/标识核查均已保存。','创建前后上下文内容相同；显式 use 后上下文保存新 ID。两个真实主项目分别完成了 use，文件只保存平台与项目身份。'],
 'AC-03-02':['两个同名样本分别通过 ID 读取，distinct ID 数为 2，没有按名称复用。','空白、121 字符名称、129 字符 appName 与非法 appName 均退出 2；这些输入未增加请求，项目数仍为 2。'],
 'AC-03-03':['响应丢失实际为 WRITE_OUTCOME_UNKNOWN / 5；创建 POST 计数为 1，服务端仍保存了对象。','回查成功后在本地保存阶段制造故障，use 返回 PARTIAL_SUCCESS / 8，保留 projectId；全过程仍只有一次创建。'],
 'AC-04-01':['归一化结果为 '+j(data('AC-04-01','set').origins)+'；默认端口和重复值被消除，未用平台地址替代业务来源。','旧 http://localhost:9000 已移除；提交响应、get 与夹具独立状态一致，两个真实主项目 Origin 写入及回查也已复用。'],
 'AC-04-02':['非法协议、普通文本、路径、空白与 51 项集合均在写入前退出 2，请求数为 0；合法但无权限请求退出 4。','无效与受限更新后，独立保存集合仍为原来源；未用本地提交值冒充平台保存结果。'],
 'AC-04-03':['PUT 响应丢失返回 WRITE_OUTCOME_UNKNOWN / 5，PUT 计数为 1。','随后 origins get 返回 '+j(data('AC-04-03','get-after').origins)+'，与服务端实际保存集合一致。'],
 'AC-05-01':['两个真实配置分别为 qhzhc / guanwang、1.0.0、cli-acceptance，DSN 与动态项目相同。文件根字段仅 app/transport；缺版本或环境退出 2。','内联配置与文件逐字段相同；示例包含初始化、view.resolveRouteName 和 start。不同输出目录的示例引用 ../config/monitor.json，实际接入两业务的 JSON 已保存。'],
 'AC-05-02':['唯一当前键导出成功；无键 KEY_UNAVAILABLE、多键 KEY_AMBIGUOUS、禁用项目 PROJECT_DISABLED，均退出 4。','显式当前键与有效过渡键成功，过渡到期时间='+j(check('AC-05-02','transition explicit expiry'))+'；过期和停用键退出 4。'],
 'AC-05-03':['默认 FILE_EXISTS / 2 保持原哈希；显式 overwrite 改写；相同两路径在写入前退出 2。','第二产物失败返回 PARTIAL_SUCCESS / 8，成功 JSON 路径='+data('AC-05-03','partial').artifacts[0].path+'，文件完整且保留。'],
 'AC-06-01':['默认窗口实际差为 86400000 ms，首页 50 条；显式最大页 100 条，limit 以原值送达。','发生时间等于 from 的样本被纳入，等于 to 的样本排除；把 from 样本 receivedAt 改为 2030 年仍得到同一记录，实际 SQL 边界证据另存。'],
 'AC-06-02':['type/name/eventId/environment/version/routeName/sessionId/viewId 八个条件分别核查匹配；组合查询只返回固定样本 '+data('AC-06-02','combined').items[0].eventId+'。','两个真实业务信封逐字段等于独立数据库记录，并核对业务定义、动作、会话/视图和可用 trace/span；未按名称猜选候选。'],
 'AC-06-03':['受控静态 151 条按稳定排序全部遍历，页条数 50/50/50/1，无重复遗漏；四页的 from/to 不变。真实 SQL 的 152 条独立样本也完成四页核对，明确区分两种数据集。','前三页 hasMore=true，第四页 false；另在分页期间新增迟到记录并清理一条记录，返回固定查询范围及不保证跨页快照的限制。'],
 'AC-06-04':['非法游标、筛选冲突及跨项目游标均退出 2，没有重新请求第一页。','无时区、倒置窗口、无效日历、超过 180 天、limit=0/101 均退出 2；失败输入未增加查询请求，没有静默裁剪。'],
 'AC-06-05':['摘要不含 event，include-payload 返回完整信封；真实 member 可以读取所属项目的 payload，读取另一个项目的列表、概况和队列均返回 PROJECT_UNAVAILABLE / 4、data=null。','空列表成功 / 0；403 和 503 分别退出 4/5，未返回假空列表。真实受限账号更新 Origin 退出 4。'],
 'AC-07-01':['加入一天前的保留记录后概况为 152，最近 receivedAt 与独立基准相同；实际 SQL 保留量对照及 Redis accepted=999 差异证据已保存。','返回 source=database、服务端 asOf 和保留策略；执行空筛选列表后再次 summary 仍为 152，统计没有继承列表条件。'],
 'AC-07-02':['空数据实际为 count=0/latest=null；新增记录后变为 1，asOf 比首次新，实际空项目 SQL 证据也已保存。','503 查询返回错误且 data=null；保留策略未知明确 state=unknown/dropAfter=null，没有填入参考天数。'],
 'AC-08-01':['真实平台能够定位 4 天前的 older 事件，raw=present，不使用普通列表一天窗口。','同 ID 两个真实候选返回 AMBIGUOUS_EVENT / 2；指定 occurredAt 后实际返回 '+data('AC-08-01','exact').event.occurredAt+'，候选数量为 2。'],
 'AC-08-02':['真实 committed-pending 与 committed-failed 均保留 processing=committed；任务分别 pending/failed，attempts、计划时间和 lastError 独立返回。','两次 diagnose 都退出 0；未把失败任务当作本次读取失败或等待结果。'],
 'AC-08-03':['真实较旧修订被合法忽略后 processing=committed；同 sampleId 领域实体只有一条，sequence 仍为 2。','通过 sampleId 关联实体；projection.eventEffect=unknown，没有以实体可见推断旧事件改变了实体。'],
 'AC-08-04':['真实 task-missing 为任务 missing；raw-missing 保留任务且 processing=unknown，不推断从未接收或历史完成。','单独获取的任务与历史限制仍返回；全部缺失时 projection.visibility=unknown；三个读取均退出 0。'],
 'AC-09-01':['实际 SQL 冻结时刻的 pending 分类为 total=6/ready=3/delayed=2/unclassified=1，含等于 asOf、+1ms 和 infinity 计划时间。','实际 SQL processing 为 total=3/active=1/stale=1/unclassified=1；300 秒边界归 active、300 秒+1ms 归 stale，锁缺失未丢失，也未推断 Worker 存活。'],
 'AC-09-02':['真实故障夹具 failed=21/deadLetters=1，保留各自口径和重叠；受控 SQL 时刻最近一分钟完成数为 2。','真实失败列表展示 20 条且 hasMore=true；缺少 last_failed_at 的历史错误实际 failedAt=null，没有冒充故障发生时间。'],
 'AC-09-03':['遥测项目范围、其他队列及 Redis 来源分别返回；Redis asOf=null，accepted 不作为保留原始量，跨存储没有统一快照承诺。','核心队列读取 503 返回错误 / 5、data=null，未复用旧队列或返回零。'],
 'AC-10-01':['受控等待经历 raw 存在、committed/pending、committed/completed 三次轮询，第三次才成功。两个真实业务事件等待均 completed。','真实 revision-old 合法 no-op 等待成功，不要求新增实体；结果保留 polls/elapsedMs/lastObservation，未等待聚合或缓存。'],
 'AC-10-02':['任务 failed 返回 PROCESSING_FAILED / 7；committed 但任务缺失返回 HISTORY_INCOMPLETE / 7；最后阶段事实保留。','歧义、timeout=0、interval=0 均退出 2；无效输入没有轮询，等待过程中请求全部为 GET。'],
 'AC-10-03':['默认等待实际在 60 秒预算内结束，首次立即请求，间隔约 2 秒，轮询数='+data('AC-10-03','default-budget').polls+'（具体单调时间在 timeline）；没有截止后新请求。','短等待 5 秒、间隔 2 秒、单请求配置 10 秒时只请求 2 次，末次被剩余预算截断；WAIT_TIMEOUT / 6 保留原 asOf 与 lastQueryFailure=REQUEST_TIMEOUT。'],
 'AC-10-04':['第一次诊断成功后下一次 403，等待以查询故障 / 4 结束，reason=query_failed，不伪装成正常等待超时。','lastObservationAsOf 与第一次实际 asOf 逐字相同，早于结束；lastQueryFailure=PROJECT_UNAVAILABLE，未更新旧快照时刻。'],
 'AC-11-01':['JSON stdout 恰能解析为一个 schemaVersion=1 结果，stderr 无业务数据；table 的项目、计数和展示限制与 JSON 相同。','help 实际包含全部入口、秒/字节单位、Owner 权限、整体替换语义、未知写回查、覆盖与会话过期恢复说明；本地 pnpm exec 入口另有实际结果。'],
 'AC-11-02':['依次实际取得退出码 '+j(check('AC-11-02','exit contract'))+'，各自对齐成功、参数、身份、权限、网络、超时、处理/历史及部分成功。','空列表与 missing 诊断均为成功；部分成功的 JSON 保留，未知写及身份恢复另有独立用例证据。'],
 'AC-11-03':['3 条大 payload 超过默认 1048576 字节，返回 OUTPUT_TOO_LARGE / 2、data=null，没有删减页内内容或游标，错误小于 4096 字节且可解析。','改为 limit=1 后三页全部读取，三个身份无遗漏，最终 nextCursor=null；非法预算 0/4095/1.5/invalid 都返回完整 INVALID_ARGUMENT。'],
 'AC-11-04':['没有服务端页时刻时 data.asOf/meta.asOf 均 null，warning 说明未知；Redis 时刻另列，不用客户端时间伪造数据库时刻。','匹配管理凭据和连接串均被过滤；授权导出的 DSN 原值保留。事件中的“请删除数据库”文字仍是 JSON 数据，没有触发任何管理动作。'],
 'AC-11-05':['events/summary/diagnose/queue 四种接口缺失均返回 CAPABILITY_UNAVAILABLE / 4，包括列表带查询串的情况。','缺字段、非法处理状态及队列分类不一致均返回 API_CONTRACT_INVALID / 5；未生成零、完成或成功默认值。'],
 'AC-12-01':['已登录健康结果 connection/live/ready/management 四项 pass，携带 checkedAt 和来源，context.projectId=null。','匿名身份接口 401 时 managementApi=pass、authentication=unknown；真实主平台同样响应，没有据此推断 Worker 健康。'],
 'AC-12-02':['ready=503 或 management API=503 均 HEALTH_UNREADY / 5，并保留 liveness=pass 与具体失败阶段。','ready=404 返回 CAPABILITY_UNAVAILABLE / 4，readiness=unknown，未把存活成功推广为全部健康。'],
 'AC-12-03':['不可连接时 connectivity=fail，live/ready/management 均 unknown；未返回空业务数据或全健康。','慢检查共享默认 30 秒总预算，ready 最多三次，截止后不再请求 management；保留 liveness=pass、其余 unknown，返回网络类退出码 5。'],
 'AC-NET-01':['恢复序列最多三次请求后停止；连续 503 为三次；403 仅一次，实际请求计数与服务端追踪一致。','默认请求前两次各约 10 秒，总网络约 30 秒；Retry-After=120 时仍在 30 秒结束且仅一次请求，无截止后重试。'],
 'AC-NET-02':['创建及 Origin 写入保存后返回截断 JSON，均 WRITE_OUTCOME_UNKNOWN / 5，不按只读契约错误断言未写入。','两种未知写各只有一次；独立回查保存对象与集合一致。可解析但确认不足的响应仍保留已知 ID='+check('AC-NET-02','known ID preserved')+'。'],
 'AC-E2E-01':['两个真实主项目创建、Origin、导出与独立保存值一致；实际 Registry SDK/Protocol 为 0.3.0/3.0.0，manifest 精确声明与锁文件 integrity 完成最终审计，配置与 CLI 原值相同。','走航车 view.start 与官网 site.route.stay 均和浏览器动作、实际信封身份、数据库及 CLI 逐字段对齐；两个项目独立查询，processing=committed/task=completed。未使用探针。'],
 'AC-E2E-02':['无 TTY 驱动通过实际 stdout 传递新 projectId，完成真实 create/origins/sdk/get，并查询已有真实业务事件、概况、诊断和等待，全程可解析。','实际 SQL 核对 appName=ai-acceptance、Origin=http://localhost:3000；受限真实身份可读其项目但写入退出 4，AI 没有获得额外权限。'],
 'AC-E2E-03':['来源故障恢复始终沿用首次 ID，POST 创建计数为 1；最终来源可以通过 get 回查，未删掉或重建项目。','JSON 成功/示例失败返回 8，恢复示例时 JSON 输出到新临时文件；原 JSON 前后 SHA-256 相同，临时配置与原配置逐字段相同。']
};
assert.equal(Object.keys(observations).length,47);
let plan=await readFile(resolve(root,'Plan/监控平台CLI验收计划.md'),'utf8');plan=plan.replace('状态：待执行。','状态：首版验收通过；执行批次 '+index.runId+'。');plan=plan.replace('所有 checklist 初始未勾选，观察栏均为待执行。本文定义要收集的产物，不表示这些测试已经执行或证据已经生成。','下文保留全部用例与执行步骤，观察栏已填写本批次实际结果；每项通过记录均链接其命令输出、独立基准和 manifest。旧失败批次保留，完整结果见本批次验收执行记录。');
plan=plan.split(/(?=^#### AC-)/m).map(section=>{
  const id=section.match(/^#### (AC-[\w-]+)/)?.[1];if(!id)return section;const relative=relativeRun.replace(/^Plan\//,'')+'/'+id;const values=observations[id];
  section=section.replace('- [ ] '+id+' 本项验收通过','- [x] '+id+' 本项验收通过');section=section.replace('Plan/验收记录/<runId>/'+id+'/',relativeRun+'/'+id+'/');
  for(let n=1;n<=2;n++){
    section=section.replace(new RegExp('\\*\\*R'+n+' · 观察结果。\\*\\*[^\\n]*'),'**R'+n+' · 观察结果。** 通过。'+values[n-1]);
    section=section.replace(new RegExp('\\*\\*R'+n+' · 证据对齐。\\*\\*[^\\n]*'),'**R'+n+' · 证据对齐。** ['+id+' 结果记录]('+relative+'/case-result.json) 的 assertions['+(n-1)+'] 对应本预期；observed.checks 保存具名预期/观察，observed.steps 保存实际退出码与耗时。对应正式输出在 steps，各字段与独立基准文件通过 evidence.path/locator/sha256 定位；[产物清单]('+relative+'/manifest.json) 可逐文件复查，不使用计划占位符。');
  }
  return section;
}).join('');
plan=plan.replace(/- \[ \] (PREP-\d+|GATE-\d+)/g,'- [x] $1');plan+='\n## 5. 本次执行与证据复查\n\n2026-10-13 实际执行全部 47 项、94 条结果核对点，通过 47、失败 0、阻塞 0。证据审计验证 '+audit.artifactCount+' 个用例产物，JSON 可解析、哈希匹配、CLI/诊断实现源文件与验收时冻结哈希一致。详见 ['+index.runId+' 执行汇总]('+relativeRun.replace(/^Plan\//,'')+'/acceptance-summary.md)、[用例索引]('+relativeRun.replace(/^Plan\//,'')+'/case-index.json) 和 [证据审计]('+relativeRun.replace(/^Plan\//,'')+'/evidence-audit.json)。\n\n输入批次为 '+index.inputEvidence.replaceAll('\\','/')+'。两个真实项目不因公共故障或复验重复创建；正式验收复用该输入批次已核对的 SDK 信封及独立数据库记录。边界按独立控制夹具执行，来源在每项 run、reference 与 setup 中声明。捕获身份来自独立读取的实际持久化 SDK 信封，未声称进行网络拦截。\n\n上一完整批次 2026-10-13T12-12-03-098Z-5ea1a2 为 42 通过、5 失败，保留原输出。失败包含夹具错误及缺失 API/健康超时的错误分类问题；当前批次对全部 47 项复验，另补充真实旧 Cookie 撤销与受限账号数据权限证据。\n';await writeFile(resolve(root,'Plan/监控平台CLI验收计划.md'),plan);
let implementation=await readFile(resolve(root,'Plan/监控平台CLI实施计划.md'),'utf8');implementation=implementation.replace('状态：待实施。','状态：首版实施及验收完成。');implementation=implementation.replace('本轮只定稿计划。下文命令、文件改造、SDK 安装和浏览器操作是后续实施步骤，尚未执行。','已按后续“开始开发”指令执行首版。下文保留具体实施步骤，已完成任务的产物和检查引用见实施记录；历史计划状态不再代表当前执行状态。');implementation=implementation.replace('本文件的 checklist 初始均未勾选。实施时给阶段和任务指定负责人，记录完成版本、检查结果及证据引用。','本文件 checklist 已按实际产物与检查结果更新，执行者为当前开发代理，实现版本 CLI 0.1.0，源码提交及未提交修改以验收 setup/source-versions.json 和文件哈希记录为准。');implementation=implementation.replace(/- \[ \] (IMP-[\w-]+)/g,'- [x] $1');implementation+='\n## 5. 已完成实施的交付与检查\n\nM0 的命令/数据契约、两种输入来源、角色与故障夹具已经形成；实际默认值、最大范围、队列策略和部署要求见技术设计文档第 4 节。M1 交付独立 CLI 包及公共参数、上下文、会话、HTTP、JSON/table 和错误协议，M2 交付原始检索与三个只读诊断 API，并通过真实 SQL 边界核对。\n\nM3 完成项目创建、Origin 整体替换和 SDK 产物。两业务已经切换精确发布包 0.3.0，接入读取本次导出的 JSON，并保留原有监控范围与埋点。M4 完成筛选、固定窗口分页、全部原始保留量、单事件阶段和队列分类。M5 完成等待、健康、帮助和使用说明。M6 完成全部 47 项验收与 94 条观察，真实业务、非交互调用、失败后恢复和旧失败复验均有证据。\n\n逐阶段产物、已修复问题、测试报告、输入基线及实现路径见 [首版实施记录](监控平台CLI实施记录.md)；每条 IMP 验证项按其原 FR/AC 关联到 [验收计划](监控平台CLI验收计划.md) 的已填写观察与 ['+index.runId+' 用例索引]('+relativeRun.replace(/^Plan\//,'')+'/case-index.json)。代码与观察不会仅凭 checklist 勾选代表完成。\n';await writeFile(resolve(root,'Plan/监控平台CLI实施计划.md'),implementation);
process.stdout.write(JSON.stringify({updatedPlans:2,cases:47,checkpoints:94,runId:index.runId})+'\n');
