# Browser Monitor SDK 目标、监控链路与目录设计

这份文档只回答三个问题：Browser Monitor SDK 要解决什么问题；一条监控数据怎样从浏览器行为走到上报出口；为什么仓库要按照现有目录拆分。

仓库使用统一 `createMonitor()` 门面组织监控能力。Performance 数据经过 Web Vitals、PerformanceObserver 和 AnimationFrame Instrumentation 形成 Raw Signal，再由 Collector 转换为 Payload，绑定 App、Session、View 与 Runtime Context，进入统一 Processing 和 Transport。View 与 Custom Event 使用同一 Envelope 和发送链路；Error、Network 和自动 Action 继续沿本文定义的模块边界扩展。

## 1. Monitor SDK 是什么

### 【从一个实际问题开始】

用户打开一个网页，点击“提交订单”，页面随后发起接口请求。如果请求失败，开发人员通常想知道：

- 用户当时位于哪个页面；
- 用户执行了什么操作；
- 请求访问了哪个接口、持续多久、返回什么状态；
- 页面是否同时产生 JavaScript 异常；
- 页面加载或交互是否已经很慢；
- 这些信息能否被完整、安全地发送到监控系统。

浏览器不会自动把这些信息组织成一条可查询的故障链路。点击来自 DOM Event，请求来自 Fetch 或 XHR，错误来自 `error` 或 `unhandledrejection`，性能数据来自 Performance API，页面变化来自 History 和 Page Lifecycle。它们是不同时间产生的不同浏览器事实。

Monitor SDK 的作用，就是在不修改业务代码执行结果的前提下观察这些事实，把它们转换成可以理解、关联和上报的监控数据。

> **Monitor SDK 不是一个错误监听器，也不是一个性能统计函数。它是运行在页面中的数据采集流水线。**

### 【监控与业务逻辑的区别】

业务逻辑负责完成用户目标，例如提交订单、加载列表或切换页面。Monitor SDK 只观察这些过程，不决定业务是否成功，也不能替业务处理异常。

以 Fetch 为例：业务代码调用 Fetch，SDK 可以观察请求开始、请求结束、HTTP 状态和耗时，但必须把原来的 Response 或异常继续交还给业务。SDK 不能因为自己的采集代码出错而改变请求结果，也不能为了读取响应内容而消耗业务需要使用的 Response Body。

这形成项目最重要的边界：**业务执行是主流程，监控是旁路观察者。** 监控失败可以少一条数据，但不能让业务失败。

### 【SDK 最终产出的不是浏览器事件】

浏览器提供的是原始事实。例如：

- DOM 告诉我们某个元素发生了 click；
- Fetch 告诉我们 Promise fulfilled 或 rejected；
- PerformanceObserver 告诉我们出现了一条 PerformanceEntry；
- Window 告诉我们发生了 error 或 unhandledrejection；
- History 告诉我们 URL 被修改。

监控系统需要的是具有明确含义的数据。例如：

- 用户在商品详情页执行了“立即购买”；
- `/api/orders` 请求失败，持续 820 毫秒；
- 某个未处理异常发生在结算页面；
- 当前页面的 LCP 指标为某个值；
- 应用已经从商品页进入结算页。

从“浏览器告诉了我们什么”到“监控系统应该记录什么”，中间存在语义转换。理解这个转换，是理解整个目录结构的前提。

## 2. Monitor SDK 的目标

### 【目标一：让页面中发生的问题可见】

线上问题往往无法在开发环境稳定复现。Monitor SDK 需要记录问题发生时浏览器能够提供的必要信息，让开发人员知道问题发生在哪里、发生了什么以及可能与什么相关。

这里的“可见”不是无限采集。SDK 只应记录定位问题所需要的数据，并在进入发送队列前处理敏感信息。

### 【目标二：把分散事实连接起来】

一次用户操作可能同时产生页面切换、网络请求、性能变化和错误。如果这些数据彼此没有共同上下文，开发人员只能看到一堆孤立记录。

Monitor SDK 需要在事件发生时补充页面、视图和会话等上下文，使不同类型的数据能够回答“是否发生在同一次访问、同一个页面或同一个请求中”。

### 【目标三：统一不同监控数据的处理方式】

性能、事件、错误和请求的业务含义不同，但它们都会遇到相同问题：字段需要规范化；敏感内容需要移除；重复数据需要控制；数据需要进入队列并批量发送。

如果每种监控都实现一套处理和发送逻辑，同一个问题会出现多份代码和多种行为。因此这些公共步骤必须形成统一链路。

### 【目标四：不破坏被监控页面】

SDK 会接触 Fetch、XHR、History 和全局事件等关键浏览器能力。任何包装错误都可能影响整个应用。

所以项目结构必须能够集中管理浏览器 Hook、监听器和 Observer，使它们可以安装、停止和释放，并避免多个模块重复修改同一个全局 API。

### 【目标五：让功能可以独立演进】

浏览器采集方式、监控数据语义、隐私规则和发送策略的变化原因不同。例如浏览器新增 PerformanceEntry，不应该迫使 Transport 改动；上报接口变化，也不应该影响 Error Collector。

目录划分的目的不是让文件看起来整齐，而是隔离这些变化，使一类改动不会扩散到整条链路。

## 3. SDK 需要理解的五类监控数据

### 【为什么先从 View 开始理解】

虽然目录中 Performance、Event、Error、Network、View 是并列 Collector，但从用户行为角度看，View 是其他数据的发生场所。

一个 View 可以理解为用户正在浏览的一次页面视图。传统多页应用每次加载会产生新页面；SPA 不刷新文档，却会通过 History 改变路由。若没有 View 边界，点击、请求、错误和性能数据就无法准确回答“发生在哪个页面”。

View 不负责采集所有数据，它只提供归属边界。这也是 View 必须独立于 Event、Error 和 Performance 的原因。

---

### 【Event：用户或业务做了什么】

Event 回答“发生了什么操作”。它包含两类不同来源：

- Action 来自浏览器中的用户操作，例如点击或提交；
- Custom Event 来自业务主动表达的事件，例如订单创建成功。

浏览器 click 不等于最终监控事件。原始 click 只说明某个节点被点击；Event Collector 还需要判断它是否值得记录、怎样形成安全且稳定的名称、属于哪个 View。

Event 不应该承担网络和路由逻辑。点击之后是否发请求、是否跳转页面，是其他事实，由 Network 和 View 分别记录。

---

### 【Network：浏览器请求发生了什么】

Network 回答“页面请求了什么、请求持续多久、结果如何”。主要事实来源是 Fetch、XHR 和 Resource Timing。

Fetch/XHR 能观察业务主动发起的接口请求；Resource Timing 还能描述图片、脚本、样式等页面资源。W3C Resource Timing 定义了浏览器可以暴露的资源时序信息，同时说明跨域资源的部分细节会受到同源策略和 `Timing-Allow-Origin` 限制。[[1]](https://www.w3.org/TR/resource-timing/)

Network 记录请求事实，不负责把所有失败都解释成程序异常。一个 HTTP 500 首先是一条失败的网络记录；如果项目希望从错误中心检索它，Error 还可以基于同一请求事实生成一条错误记录。两条数据含义不同，但应通过同一请求标识关联。

---

### 【Error：页面为什么失败】

Error 回答“页面出现了什么异常”。浏览器中的异常来源不止一种：JavaScript 运行时错误、未处理 Promise、脚本或图片等资源加载错误，以及失败请求的错误视角。

不同来源提供的原始信息不同。运行时错误可能带 Error 对象和堆栈；Promise rejection 的 reason 可以是字符串、对象甚至 null；资源加载错误可能没有普通 Error 对象。因此 Error 不能只是把 `window.onerror` 参数原样发送，而需要把不同来源转换成统一、可理解的错误语义。

Error 不应该自己包装 Fetch。Fetch 是共享浏览器事实，Network 和 Error 都可能需要它。如果 Error 单独包装一次，Network 再包装一次，就会形成重复 Hook。

---

### 【Performance：页面体验如何】

Performance 回答“页面加载和交互是否足够快”。浏览器通过 Performance Timeline 和 PerformanceObserver 暴露导航、绘制、布局变化、交互和长任务等性能事实。[[2]](https://www.w3.org/TR/performance-timeline/)

Performance Collector 的职责是把 PerformanceEntry 转换为有意义的指标，而不是把浏览器返回的所有对象原样上传。当前实现不会向订阅者暴露原始 Entry、DOM 节点、脚本 URL 或导航 URL。

性能指标分成三路：Web Vitals Instrumentation 提供 LCP、FCP、INP、CLS 指标事实；PerformanceObserver Instrumentation 提供 LoAF 事实；AnimationFrame Instrumentation 在源头完成帧窗口机械统计。三路 Raw Signal 都由 Performance Collector 转换为统一 Performance Payload，再进入公共 Envelope、Processing 和 Transport。

Resource Timing 同时带有“资源”和“性能”属性，但完整请求记录归 Network。Performance 如果需要分析资源对页面体验的影响，应使用关联关系，而不是再次生成一份相同资源记录。

### 【五类数据分别回答什么】

| 类型        | 回答的问题         | 典型浏览器事实                      | 为什么独立                 |
| ----------- | ------------------ | ----------------------------------- | -------------------------- |
| View        | 用户在哪个页面     | 初始 URL、History、Page Lifecycle   | 它是所有数据的归属边界     |
| Event       | 用户或业务做了什么 | DOM Event、业务主动调用             | 它描述行为，不描述请求结果 |
| Network     | 请求发生了什么     | Fetch、XHR、Resource Timing         | 它拥有请求事实和耗时       |
| Error       | 页面为什么失败     | error、unhandledrejection、失败请求 | 它负责异常语义和聚合       |
| Performance | 用户体验如何       | PerformanceEntry                    | 它负责性能指标语义         |

## 4. 一条监控数据的完整链路

### 【先看完整流程】

```text
浏览器或业务发生行为
        ↓
Instrumentation 捕获浏览器事实
        ↓
Raw Signal 在 SDK 内部传递
        ↓
Collector 把事实解释为某类监控数据
        ↓
Context 补充事件发生时的页面环境
        ↓
Protocol 约束不同模块之间的数据形状
        ↓
Processing 规范化、脱敏并控制数据量
        ↓
Transport 排队、组批并发送到采集端
```

这条链路就是目录结构的来源。每个目录负责一个连续步骤，并把产物交给下一步。下面逐步说明每一步为什么不能省略或混在一起。

---

### 【第一步：页面发生行为】

链路从真实页面行为开始。例如用户点击按钮、业务调用 Fetch、Promise 被拒绝、浏览器完成一次绘制，或者 SPA 修改了 History。

此时还没有“监控数据”，只有浏览器行为。业务代码和浏览器按照原有方式运行，SDK 不能要求业务改写所有调用才能观察。

---

### 【第二步：Instrumentation 捕获事实】

Instrumentation 直接面对浏览器 API。它负责监听或包装 Fetch、XHR、PerformanceObserver、Window Error、DOM Event、History 和 Page Lifecycle。

这一层只陈述事实。例如：“某个请求开始了”“某个请求结束并返回 500”“发生了一次 click”“出现了一条 layout-shift Entry”。它不判断这些事实最终应该变成哪种监控数据。

把事实捕获独立出来有两个原因：

1. 同一个浏览器事实可能被多个领域使用。失败请求同时服务 Network 和 Error；PerformanceEntry 中的 Resource 数据可能服务 Network；页面隐藏同时影响 View 和 Transport。
2. 浏览器 Hook 风险很高，必须集中管理。如果每个 Collector 各自包装 Fetch 或注册全局监听，安装、停止和恢复会互相冲突。

---

### 【第三步：Raw Signal 传递事实】

Raw Signal 是 SDK 内部对浏览器事实的表达。它的作用是让 Instrumentation 不需要知道谁会使用这个事实。

例如 Fetch Instrumentation 只发出“请求结束、状态为 500、对应某次请求”的信号。Network Collector 可以订阅它并生成网络记录；Error Collector 也可以订阅并生成错误记录。两个 Collector 不需要互相调用。

Raw Signal 不是上报数据。它可以非常接近浏览器 API，并且只在 SDK 内部短暂存在。它没有最终上下文、采样结果或发送信息。

---

### 【第四步：Collector 解释语义】

Collector 决定一条事实对监控系统意味着什么。

同一个“请求返回 500”的事实，在 Network 中表示请求的状态和耗时；在 Error 中表示一个可聚合、可检索的失败问题。两者不是重复数据，因为它们回答不同问题。

Collector 只处理自己的领域。Network 不计算页面性能评分；Error 不管理请求队列；View 不处理点击名称；Performance 不包装 Fetch。

---

### 【第五步：Context 固定发生环境】

Collector 生成数据时，需要补充事件发生时的页面和会话信息。

假设页面 A 发起请求，随后用户进入页面 B，请求才返回。如果等到请求返回或发送时才读取当前 URL，请求会被错误地归到 B。因此请求开始时就需要记住对应 View，错误发生时也需要固定当时的页面环境。

Context 的核心不是“存放几个全局变量”，而是保证异步行为仍然拥有正确归属。

---

### 【第六步：Signal 与共享 Protocol 约束模块交接】

Instrumentation、Collector、Processing 和 Transport 是独立模块，它们必须对交接的数据达成一致。SDK 内部的浏览器事实契约保存在 `src/signals`；跨 SDK、API 和 Worker 的线上事件契约由 monorepo 根目录的 `protocol/` 包统一提供。

没有共同契约时，每个模块可能使用不同字段名、时间单位和可选值，改动一个字段就会隐式破坏其他模块。Signal 和 Protocol 的作用不是集中保存所有 TypeScript 类型，而是分别保存“SDK 内部必须共同理解的事实”和“三个项目必须共同理解的线上事件”。

模块自己的临时状态和私有类型仍然留在所属目录，不能全部放进 Protocol。

---

### 【第七步：Processing 统一处理】

Collector 产出的数据不能直接发送。URL 可能包含 Token，错误信息可能过长，同一错误可能短时间重复出现，高频请求可能填满内存。

Processing 负责所有监控类型共同需要的处理：

- Normalize 统一 URL、时间、状态和字段表达；
- Redact 移除或替换敏感信息；
- Dedupe 控制短时间重复数据；
- Sampling 控制保留比例；
- Rate Limit 防止异常流量拖垮页面。

这些能力放在公共管线中，是为了保证 Event、Error、Network 等数据遵循同一安全标准，而不是每个 Collector 各写一份。

---

### 【第八步：Transport 发送】

Transport 接收已经完成语义转换和安全处理的数据。它负责排队、把多条数据组成批次、调用浏览器发送能力、处理有限重试以及在页面隐藏时尝试刷新。

Transport 不理解 LCP、点击或错误堆栈。它只处理可以发送的数据。这样采集端点或发送方式变化时，不需要修改所有 Collector。

Beacon 规范提供了适合页面进入后台时使用的异步、非阻塞发送机制，同时明确说明其没有响应回调、存在可排队数据量限制，也不负责离线持久化。[[3]](https://www.w3.org/TR/beacon/)

Transport 发出的请求必须被 Network Instrumentation 排除，否则 SDK 会监控自己的上报请求，上报又产生新监控数据，最终形成递归循环。

## 5. 用一次失败请求理解完整链路

### 【场景】

用户位于“订单确认页”，点击提交按钮。页面通过 Fetch 请求 `/api/orders`，服务端返回 500。

这个场景至少包含四种信息：用户点击了提交；页面发起一次请求；请求失败；这些行为发生在订单确认页。SDK 不能靠某一个模块独立得到全部信息。

### 【链路展开】

```text
用户点击提交
  └─→ DOM Events Instrumentation 捕获 click
      └─→ Event Collector 形成用户操作数据
          └─→ Context 绑定“订单确认页”

业务调用 Fetch
  └─→ Fetch Instrumentation 记录请求开始
      └─→ 保存这次请求与“订单确认页”的关系

Fetch 返回 500
  └─→ Fetch Instrumentation 发出请求结束事实
      ├─→ Network Collector 形成请求状态和耗时数据
      └─→ Error Collector 形成请求失败的错误数据

三类数据
  └─→ Processing 统一规范化和脱敏
      └─→ Transport 排队、组批、发送
```

### 【为什么不能让 Error 直接调用 Network】

如果 Error Collector 调用 Network Collector 获取请求，Error 就依赖 Network 的内部实现。Network 一旦调整存储方式，Error 也会被迫修改；关闭 Network 时，Error 可能无法工作。

更合理的方式是让两个 Collector 订阅同一原始请求事实，并通过请求关联信息表达它们属于同一次请求。这样 Network 和 Error 可以独立启停、独立测试。

### 【为什么 Context 不能等发送时再补】

请求结束前用户可能已经离开订单确认页。Transport 发送时读取的是“现在的页面”，不是“请求发生时的页面”。所以 Context 必须在事实发生和领域转换时固定，而不是交给发送层临时查询。

### 【为什么必须先处理再入队】

如果原始 URL 带有 Token，先入队再脱敏意味着敏感数据已经进入内存缓存、调试日志或重试状态。Processing 必须位于 Collector 与 Transport 之间，使 Transport 只接触已经安全处理的数据。

## 6. 为什么按照现有目录划分

### 【目录对应的是变化原因】

目录不是按照“代码长得像什么”划分，而是按照“什么原因会让它变化”划分：

| 变化原因                         | 归属目录          | 例子                            |
| -------------------------------- | ----------------- | ------------------------------- |
| 浏览器 API 或 Hook 方式变化      | `instrumentation` | Fetch、XHR、PerformanceObserver |
| 某类监控数据的语义变化           | `collectors`      | 错误归一化、性能指标解释        |
| 页面、视图和会话归属变化         | `context`         | 路由切换后的 viewId             |
| SDK 内部浏览器事实的约定变化     | `signals`         | Web Vital、View Raw Signal      |
| 跨项目线上协议的数据约定变化     | 根目录 `protocol` | Envelope、Payload、批次         |
| 所有数据共同的安全和流量规则变化 | `processing`      | 脱敏、去重、采样                |
| 队列和网络发送方式变化           | `transport`       | 批量发送、重试、刷新            |
| SDK 创建、启动和模块编排变化     | `core`            | 生命周期、内部通信              |
| 无领域归属的纯能力变化           | `shared`          | 时间、ID、URL 基础操作          |

如果把不同变化原因放在一起，一次改动就会触碰无关代码。如果把同一变化原因拆到多个领域，又会产生重复实现。现有结构的目标是在这两种问题之间建立清晰边界。

### 【为什么 Instrumentation 与 Collector 分开】

这是整个结构最关键的一次拆分。

Instrumentation 关心的是“浏览器怎样暴露事实”；Collector 关心的是“事实在监控领域中代表什么”。前者会因浏览器 API、兼容性和 Hook 安全发生变化，后者会因数据产品和问题分析方式发生变化。

成熟开源 Browser SDK 也没有简单地把所有代码平铺成 Performance、Event、Error。DataDog 的 RUM domain 包含 action、error、resource、view、vital 等领域，同时有共享的请求与生命周期能力；Sentry 把通用 instrumentation 从具体集成中抽离；OpenTelemetry 则明确区分 instrumentation 与处理、导出链路。[[4]](https://github.com/DataDog/browser-sdk/tree/main/packages/browser-rum-core/src/domain) [[5]](https://github.com/getsentry/sentry-javascript/tree/develop/packages/core/src/instrument) [[6]](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/sdk-trace/src)

这些项目不是本仓库的实现模板，但它们共同验证了一个边界：底层 Hook 与上层遥测语义不应该互相绑死。

### 【为什么 Collector 不只保留三类】

只保留 Performance、Event、Error 会留下两个无法归属的重要概念：Network 和 View。

把 Network 放入 Performance，会让接口请求错误、HTTP 状态和请求关联依赖性能模块；把它放入 Error，又无法自然表示大量成功请求。Network 自己回答请求事实，因此应该独立。

把 View 放入 Event，会让所有性能和错误数据依赖事件模块；把它放入 Core，又会让 Core 携带具体监控语义。View 是所有数据的共同归因边界，也应该独立。

### 【为什么 Processing 与 Transport 分开】

Processing 决定“一条数据是否安全、有效并值得保留”；Transport 决定“已经保留的数据怎样送出去”。前者处理数据内容，后者处理传输状态。

把两者混在一起，会导致脱敏只在某种 Sender 中执行，或者重试时重复采样。分开后，进入 Transport 的数据已经完成内容处理，Transport 可以专注于队列和发送。

### 【为什么 Protocol 与 Shared 分开】

Protocol 保存跨模块的数据约定，天然带有项目语义；Shared 保存无领域归属的基础能力，不应该知道 Event、Error 或 Network。

如果两者都放入 `utils` 或 `types`，任何模块都可以向里面添加内容，依赖方向会逐渐消失。明确拆分后，可以直接判断一段代码是在定义模块协作，还是提供普通基础能力。

## 7. 源码目录逐项说明

### 【目录总览】

```text
src/
├─ index.ts
├─ core/
├─ instrumentation/
│  ├─ fetch/
│  ├─ xhr/
│  ├─ web-vitals/
│  ├─ performance-observer/
│  ├─ animation-frame/
│  ├─ global-errors/
│  ├─ dom-events/
│  ├─ history/
│  └─ page-lifecycle/
├─ collectors/
│  ├─ performance/
│  ├─ event/
│  │  ├─ action/
│  │  └─ custom/
│  ├─ error/
│  ├─ network/
│  └─ view/
├─ context/
├─ processing/
│  ├─ normalize/
│  ├─ validate/
│  ├─ redact/
│  ├─ filter/
│  ├─ dedupe/
│  ├─ sampling/
│  └─ rate-limit/
├─ transport/
│  ├─ queue/
│  ├─ batch/
│  ├─ sender/
│  ├─ retry/
│  └─ flush/
├─ signals/
│  ├─ index.ts
│  ├─ performance.ts
│  └─ view.ts
└─ shared/
```

这棵目录树描述的是从浏览器事实到发送出口的完整责任链，而不是表示其中已经存在采集实现。

---

### 【index.ts：包入口】

`src/index.ts` 是 npm 包唯一入口。它导出 `createMonitor()`、统一 Monitor 配置与生命周期接口，以及 Envelope、Context、Correlation 和各类 Payload 协议；内部 Collector、Instrumentation、Processing 和 Transport 实现不作为公共入口导出。

保留单一入口可以防止业务代码直接依赖内部 Collector 或 Instrumentation。只有真正稳定、需要对调用方承诺兼容性的能力，才应从这里导出。

---

### 【core：组织整条链路】

Core 位于入口和各功能模块之间，职责是管理 SDK 的整体运行，并把 Instrumentation、Collector、Context、Processing 和 Transport 连接起来。

它不应该实现具体性能指标、错误格式化或 HTTP 发送。Core 类似总控台：知道有哪些模块以及启动顺序，但不替每个模块完成专业工作。

如果没有 Core，各模块只能自行创建依赖和注册全局资源，最终会出现重复实例、无法统一停止以及隐式单例。

---

### 【instrumentation：只捕获浏览器事实】

`instrumentation` 下每个子目录对应一种浏览器事实来源。Performance 使用 Web Vitals、PerformanceObserver、AnimationFrame、History 和 Page Lifecycle Instrumentation；其他领域继续按照相同规则增加浏览器事实来源：

| 子目录                 | 面对的浏览器能力               | 产生的事实                      |
| ---------------------- | ------------------------------ | ------------------------------- |
| `fetch`                | `window.fetch`                 | 请求开始、完成、拒绝            |
| `xhr`                  | `XMLHttpRequest`               | 请求生命周期和结果              |
| `web-vitals`           | `web-vitals`                   | LCP、FCP、INP、CLS 指标事实     |
| `performance-observer` | `PerformanceObserver`          | LoAF、Resource 等性能条目       |
| `animation-frame`      | requestAnimationFrame、Timer   | 帧数和窗口时长                  |
| `global-errors`        | error、unhandledrejection      | 运行时、资源和 Promise 异常事实 |
| `dom-events`           | DOM Event                      | 白名单用户操作事实              |
| `history`              | History、popstate、hashchange  | URL 与路由变化                  |
| `page-lifecycle`       | visibility、pagehide、pageshow | 页面可见、隐藏和恢复            |

这些目录按浏览器机制拆分，而不是按最终数据类型拆分。这样 Fetch 事实可以同时提供给 Network 和 Error，Page Lifecycle 事实也可以同时提供给 View 和 Transport。

---

### 【collectors：形成监控语义】

`collectors` 按最终要回答的问题拆分：

- `performance` 把 WebVital、LoAF 和 FrameWindow Signal 转换为 LCP、FCP、INP、CLS、FPS 和 LoAF Payload；
- `event/action` 把允许记录的 DOM 操作解释为用户行为；
- `event/custom` 接收业务明确表达的自定义事件；
- `error` 把不同异常来源转换为统一错误语义；
- `network` 形成请求与资源的权威记录；
- `view` 管理初始页面与 SPA 路由形成的页面视图。

Collector 之间是并列关系，不形成调用链。它们都接收事实、取得 Context，然后把结果交给公共 Processing。

---

### 【context：回答事情发生在哪里】

Context 保存和提供页面、View、Session、用户及应用环境。它的关键价值是“发生时快照”，而不是简单的全局配置。

所有需要归因的 Collector 都可以读取 Context，但 Context 不应该反向依赖某个 Collector。否则关闭某类监控可能导致整个页面归因失效。

---

### 【processing：所有数据的公共处理管线】

`processing` 的五个子目录按处理目的拆分：

- `normalize` 让不同来源的数据表达一致；
- `redact` 防止敏感数据离开页面；
- `dedupe` 控制短时间重复记录；
- `sampling` 控制总体数据规模；
- `rate-limit` 在异常高频时保护页面和网络。

这些步骤都作用于 Collector 已经生成的监控数据，不应直接操作 Fetch、DOM 或 PerformanceObserver。

---

### 【transport：让处理后的数据离开页面】

`transport` 的子目录表示发送过程中的不同状态：

- `queue` 保存等待发送的数据；
- `batch` 把多条数据组织为一次发送；
- `sender` 调用浏览器网络能力；
- `retry` 处理可以恢复的发送失败；
- `flush` 响应主动刷新和页面生命周期。

Transport 只能接收已经处理完成的数据。如果 Transport 还需要理解错误堆栈或点击名称，说明上游 Collector 或 Processing 的边界没有完成。

---

### 【signals 与共享 Protocol：定义不同范围的契约】

`src/signals` 描述 Raw Signal，只服务 SDK 内部 Instrumentation、Signal Hub 与 Collector。线上 Envelope、Context、Correlation 和 Payload 则直接从 `@browser-monitor/protocol` 导入；它位于 monorepo 根目录的 `protocol/`，同时被 SDK、采集 API 和 Worker 使用。SDK 不再保留 `src/protocol` 转发文件，避免本地类型与 Zod Schema 成为两个协议来源。

Signal 与 Protocol 都不处理数据、不访问浏览器、不保存状态。某个类型如果只被一个实现内部使用，就应该放回该模块；只有线上三端需要共同理解的数据才进入共享协议包。

---

### 【shared：严格受限的基础能力】

Shared 只容纳没有领域归属、被多个模块共同需要的纯基础能力。它不是旧式 `utils` 杂物目录。

判断一段代码是否可以进入 Shared，需要同时满足：它不理解任何监控类型；不持有 Collector 或 Transport 状态；不访问业务上下文；至少被两个模块稳定复用。否则应留在具体领域。

## 8. 模块之间如何协作

### 【允许的依赖方向】

```text
index → core
core → instrumentation / collectors / context / processing / transport
instrumentation → signals / shared
collectors → context / signals / @browser-monitor/protocol / shared
context → @browser-monitor/protocol / shared
processing → @browser-monitor/protocol / shared
transport → @browser-monitor/protocol / shared
signals → @browser-monitor/protocol（只复用枚举与字段类型）
shared → 不依赖业务模块
```

Core 负责组合，因此可以看到各层；被组合的模块不能反向依赖具体 Core。Collector 之间不能直接导入彼此实现。Instrumentation 不能调用 Transport。

### 【为什么禁止 Collector 互相依赖】

Network 和 Error 会处理同一个失败请求，但它们应该依赖同一原始事实，而不是依赖彼此。Performance 和 Network 会同时关注资源，但应通过明确所有权和关联信息协作，而不是复制数据。

这样做可以保证单个 Collector 独立启停，也让每种语义能够单独测试。

### 【为什么数据只能向前流动】

如果 Transport 在发送失败时创建普通 Error，Error 又进入 Transport，就会形成递归。如果 Processing 回头读取浏览器对象，脱敏和发生时归因就无法保证。如果 Instrumentation 直接生成最终数据，它会被某个领域绑死。

因此数据沿主链路单向前进；内部故障进入独立诊断通道，不重新进入普通监控链路。

## 9. 另外四条典型监控链路

### 【JavaScript 运行时错误】

页面抛出异常 → Global Errors 捕获浏览器事实 → Error Collector 解释错误 → Context 固定发生页面 → Processing 脱敏与去重 → Transport 发送。

这里不需要 Network 或 Performance 参与。Global Errors 只负责捕获，Error Collector 才负责错误语义。

---

### 【用户点击后发生 SPA 跳转】

```text
点击发生
  └─→ DOM Events 捕获操作
      └─→ Event Collector 把操作归入旧 View

History 随后变化
  └─→ History Instrumentation 捕获 URL 变化
      └─→ View Collector 结束旧 View、建立新 View

跳转后产生的请求和错误
  └─→ Context 将它们归入新 View
```

Event 与 View 分开后，点击和路由顺序可以被正确表达。如果 View 属于 Event 内部，其他 Collector 将难以获得统一页面边界。

---

### 【页面性能数据】

浏览器生成 PerformanceEntry → PerformanceObserver Instrumentation 捕获 → Performance Collector 解释指标 → Context 绑定 View → Processing 控制数据 → Transport 发送。

如果 Entry 表示资源请求，Network 负责形成资源记录。Performance 不重复上传整份资源数据。

---

### 【页面隐藏时刷新队列】

Page Lifecycle 捕获 hidden/pagehide → 同一事实分别通知 View 与 Transport → View 判断页面边界 → Flush 尝试发送已处理队列。

Page Lifecycle 不直接调用 View Collector 或 Sender。它只发布事实，使两个模块分别完成自己的责任。

## 10. 怎样判断新代码应该放在哪里

### 【按问题判断，而不是按文件名判断】

遇到新功能时依次询问：

1. 它是否直接监听或修改浏览器 API？是则属于 Instrumentation。
2. 它是否把浏览器事实解释成某类监控数据？是则属于对应 Collector。
3. 它是否提供事件发生时的页面或会话信息？是则属于 Context。
4. 它是否定义两个以上模块必须共同理解的数据？是则属于 Protocol。
5. 它是否对所有监控数据执行相同处理？是则属于 Processing。
6. 它是否管理队列、发送或失败重试？是则属于 Transport。
7. 它是否只负责模块创建、生命周期或内部编排？是则属于 Core。
8. 它是否完全没有领域含义且被多处复用？满足全部条件才属于 Shared。

### 【几个容易放错的位置】

| 代码                     | 错误位置             | 正确位置与原因                                     |
| ------------------------ | -------------------- | -------------------------------------------------- |
| Fetch 包装               | `collectors/network` | `instrumentation/fetch`，因为 Error 也需要请求事实 |
| URL 脱敏                 | 每个 Collector       | `processing/redact`，因为所有数据必须一致处理      |
| Resource Timing 完整记录 | Performance          | Network，因为它是资源请求事实                      |
| SPA 路由状态             | Event                | View，因为其他监控类型也需要页面归因               |
| 批量发送                 | Core                 | Transport，因为它只负责传输状态                    |
| 错误临时解析类型         | Protocol             | Error 内部，因为其他模块不需要理解                 |

### 【出现以下情况说明边界已经出错】

- 两个 Collector 分别包装同一个浏览器 API；
- Collector 直接调用另一个 Collector；
- Instrumentation 直接发 HTTP 请求；
- Transport 读取 `window.location` 决定事件归属；
- 敏感数据在进入 Queue 后才脱敏；
- `shared` 开始出现 Error、Network、View 等领域名称；
- `signals` 保存只有单个实现文件使用的临时类型，或重新定义共享 Protocol 已有字段；
- Core 中出现具体性能指标或错误解析算法。

## 11. 仓库中已经存在的内容

### 【源码状态】

`src/index.ts` 公开统一 `createMonitor()` 门面和协议类型。Core 负责配置、生命周期、模块注册、Signal Hub 和管线编排；Performance、View、Custom Event、Context、Processing 与 Transport 共用一条可执行链路。Error、Network 和自动 Action 仍按照相同协议和依赖方向继续扩展，不建立独立旁路。

### 【工程能力】

仓库已经存在 TypeScript、tsup、Vitest、ESLint 和 Prettier 配置。构建目标包括 ESM、IIFE、类型声明和 Source Map；测试使用可控的 Web Vitals、PerformanceObserver 与 requestAnimationFrame 替身验证采集算法、协议、兼容性和生命周期。

这些工程能力保证目录可以继续承载实现，但它们本身不等于监控能力。

### 【文档与源码的关系】

本文中的目标链路既约束目录划分，也约束实现方式。已经接入的模块必须遵守统一生命周期、Signal、Envelope、Processing 和 Transport 契约；新增监控类型只能沿相同边界扩展，不能恢复 Performance 专用工厂、订阅出口或终止式 `stop()`。

## 12. 参考文献

[1] W3C. [Resource Timing](https://www.w3.org/TR/resource-timing/)[EB/OL]. [2026-09-11].

[2] W3C. [Performance Timeline](https://www.w3.org/TR/performance-timeline/)[EB/OL]. [2026-09-11].

[3] W3C. [Beacon](https://www.w3.org/TR/beacon/)[EB/OL]. 2022-08-03[2026-09-11].

[4] DATADOG. [Browser SDK: browser-rum-core domain](https://github.com/DataDog/browser-sdk/tree/main/packages/browser-rum-core/src/domain)[EB/OL]. [2026-09-11].

[5] SENTRY. [Sentry JavaScript: core instrumentation](https://github.com/getsentry/sentry-javascript/tree/develop/packages/core/src/instrument)[EB/OL]. [2026-09-11].

[6] OPEN TELEMETRY. [OpenTelemetry JavaScript: trace SDK](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/sdk-trace/src)[EB/OL]. [2026-09-11].
