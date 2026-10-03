# SMTP 邮件传输体系源码学习

> **学习目标**：以当前 Browser Monitor 的真实邮件发送源码为入口，建立完整的邮件传输知识体系。学习顺序不是先背 \`EHLO / MAIL FROM / RCPT TO\`，而是按照“业务触发 → 邮件消息 → SMTP 提交 → 服务器传输 → 邮箱投递 → 邮件访问 → 身份认证与可靠性”逐层展开。
>
> **分析范围**：项目事实以当前 \`browser-monitor/platform\` 源码为准；SMTP、Internet Message Format、MIME、Message Submission、SPF、DKIM、DMARC 等通用知识以 IETF RFC 为主要依据；Nodemailer 与 Mailpit 部分以各自官方文档为参考。
>
> **与已有文档的关系**：[\`NestJS-Fastify-API源码学习.md\`](./NestJS-Fastify-API源码学习.md) 已经解释 API、Service 与 Infrastructure 的基本边界，[服务端数据管理源码学习-2.md](./服务端数据管理源码学习-2.md) 已经指出 PostgreSQL Transaction 无法覆盖 Redis、Mailer 等外部系统。本文从当前 \`MailerService\` 继续向外展开，解释一封业务邮件如何从 Browser Monitor 进入完整的 Internet Mail System。

邮件体系不按 SMTP、MIME、IMAP、SPF、DKIM 等名词平铺，而按下面的依赖关系展开：

~~~text
第一层：业务为什么需要邮件
Register / Verify Email / Reset Password / Project Invitation
            │
            ▼
第二层：一封邮件本身如何表达
RFC 5322 / Header / Body / MIME / Attachment
            │
            ▼
第三层：应用如何把邮件提交出去
Nodemailer / SMTP Client / MSA / 587 / 465 / TLS / AUTH
            │
            ▼
第四层：邮件服务器如何把邮件送到目标域
SMTP Relay / MTA / DNS MX / Port 25 / Queue / Retry
            │
            ▼
第五层：目标系统如何投递和访问邮件
Mailbox / MDA / IMAP / POP3 / Mail Client
            │
            ▼
第六层：邮件身份和可信度如何建立
Envelope / Header / SPF / DKIM / DMARC
            │
            ▼
第七层：邮件如何形成生产级可靠能力
Response / Retry / Bounce / Outbox / Idempotency / Observability
~~~

## 1. Browser Monitor 的邮件能力首先是业务系统访问外部 Mail Service

### 【当前项目已经存在三个真实邮件业务】

当前邮件不是独立 Demo，而是账号与项目协作流程的一部分。核心实现位于：

~~~text
platform/apps/api/src/auth/mailer.service.ts
~~~

\`MailerService\` 已提供：

~~~ts
async sendVerification(email: string, token: string)
async sendPasswordReset(email: string, token: string)
async sendInvitation(email: string, token: string, projectName: string)
~~~

对应关系：

| 业务行为 | 邮件作用 | 关键凭据 |
| --- | --- | --- |
| 注册账号 | 验证邮箱控制权 | verify-email Token |
| 忘记密码 | 建立密码恢复入口 | reset-password Token |
| 邀请成员 | 把项目邀请交给目标邮箱用户 | invitation Token |

所以邮件在项目中的位置首先是：

~~~text
Business Action
      ↓
Application Service
      ↓
MailerService
      ↓
External Mail System
~~~

项目源码：

- [MailerService](../platform/apps/api/src/auth/mailer.service.ts)
- [AuthService](../platform/apps/api/src/auth/auth.service.ts)
- [ProjectsService](../platform/apps/api/src/projects/projects.service.ts)

### 【当前实际发送者是API进程而不是Worker】

以注册为例：

~~~text
POST /auth/register
        ↓
AuthService.register()
        ↓
PostgreSQL Transaction
        │
        ├── User
        └── Verification Token
        ↓
COMMIT
        ↓
MailerService.sendVerification()
        ↓
Nodemailer
        ↓
SMTP Server
~~~

当前源码中邮件是在 API 完成数据库提交以后直接发送，并没有进入现有 Outbox Worker。后文的 Email Outbox 属于可演进方案，不应描述成当前已实现。

## 2. MailerService、Nodemailer、SMTP与Mailpit属于不同层次

当前 \`MailerService\` 创建 Nodemailer Transport：

~~~ts
this.transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  ...(config.SMTP_USER
    ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
    : {}),
});
~~~

最终调用：

~~~ts
await this.transporter.sendMail({
  from: this.config.SMTP_FROM,
  to,
  subject,
  text,
});
~~~

这几层分别是：

| 概念 | 当前项目中的角色 |
| --- | --- |
| AuthService / ProjectsService | 决定为什么发送 |
| MailerService | 封装邮件基础设施 |
| Nodemailer | Node.js 邮件发送库与 SMTP Client 封装 |
| SMTP | 邮件提交和传输协议 |
| Mailpit | 开发环境 SMTP Server 与邮件查看工具 |
| SMTP_* | SMTP Server 连接配置 |

因此：

~~~text
MailerService
    ≠ SMTP

Nodemailer
    ≠ SMTP Server

Mailpit
    ≠ Nodemailer
~~~

正确关系：

~~~text
Browser Monitor API
        ↓
MailerService
        ↓
Nodemailer
        ↓ SMTP
Mailpit / Production SMTP Provider
~~~

Nodemailer SMTP Transport：
https://nodemailer.com/smtp

## 3. 完整邮件系统由生成、提交、传输、投递和读取共同组成

SMTP 只是邮件系统中的一个环节。

~~~text
Browser Monitor
      │
      │ 构造业务邮件
      ▼
Message Construction
RFC 5322 / MIME
      │
      │ Message Submission
      ▼
MSA / SMTP Provider
      │
      │ SMTP Relay
      ▼
MTA
      │
      │ DNS MX + SMTP
      ▼
Recipient Mail Server
      │
      │ Delivery
      ▼
Mailbox
      │
      │ IMAP / POP3 / Webmail
      ▼
User
~~~

常见角色：

| 缩写 | 英文 | 作用 |
| --- | --- | --- |
| MUA | Mail User Agent | 编写、提交和查看邮件的客户端 |
| MSA | Mail Submission Agent | 接受新邮件提交 |
| MTA | Mail Transfer Agent | 在邮件服务器之间转发邮件 |
| MDA | Mail Delivery Agent | 将邮件写入最终 Mailbox |

RFC 6409 专门区分 Message Submission 与 Message Relay：
https://www.rfc-editor.org/rfc/rfc6409.html

## 4. 邮件内容与邮件运输是两套协议问题

### 【SMTP解决怎么运输，不完整定义邮件长什么样】

一封验证邮件可能表现为：

~~~text
From: Browser Monitor <monitor@example.com>
To: user@example.com
Subject: Verify your Browser Monitor account

Verify your email:
https://monitor.example.com/verify-email?token=xxx
~~~

这里有两个问题：

~~~text
这封邮件本身怎样组织？
        ↓
RFC 5322 / MIME

这封邮件怎样被送出去？
        ↓
SMTP
~~~

所以：

~~~text
RFC 5322
    定义 Internet Message Format

MIME
    扩展 HTML、附件、多媒体和 Multipart

SMTP
    负责提交和传输 Message
~~~

RFC 5322：
https://www.rfc-editor.org/rfc/rfc5322.html

### 【RFC 5322把消息组织成Header Section与Body】

基本结构：

~~~text
Header Fields
     +
Empty Line
     +
Message Body
~~~

常见 Header：

~~~text
From:
To:
Cc:
Date:
Subject:
Message-ID:
Reply-To:
Content-Type:
~~~

因此业务代码中的：

~~~ts
sendMail({ from, to, subject, text })
~~~

必须先形成合法 Message，再通过 SMTP Transport 发送。

### 【MIME把纯文本邮件扩展成真实产品邮件】

MIME（Multipurpose Internet Mail Extensions，多用途互联网邮件扩展）解决：

~~~text
HTML Body
附件
图片
非 ASCII 内容
multipart
内容编码
~~~

如果以后邮件升级为：

~~~text
text/plain
    +
text/html
    +
Logo
    +
PDF Report
~~~

就会涉及：

~~~text
MIME-Version
Content-Type
Content-Disposition
Content-Transfer-Encoding
multipart/alternative
multipart/mixed
Boundary
Base64
~~~

这些通常由 Nodemailer 生成，而不是业务层手工拼接。

RFC 2045：
https://www.rfc-editor.org/rfc/rfc2045.html

## 5. SMTP本质上是运行在TCP之上的命令—响应协议

SMTP（Simple Mail Transfer Protocol，简单邮件传输协议）属于应用层协议。

~~~text
SMTP Client
    │
    │ TCP Connection
    ▼
SMTP Server
~~~

典型会话：

~~~text
S: 220 smtp.example.com ready

C: EHLO monitor.example.com
S: 250 ...

C: STARTTLS
S: 220 Ready to start TLS

        TLS Handshake

C: EHLO monitor.example.com
S: 250 AUTH ...

C: AUTH ...
S: 235 Authentication successful

C: MAIL FROM:<bounce@monitor.example.com>
S: 250 OK

C: RCPT TO:<user@example.com>
S: 250 OK

C: DATA
S: 354 Start mail input

C:
From: Browser Monitor <monitor@example.com>
To: user@example.com
Subject: Verify your account

Verify your email...
.

S: 250 Message accepted

C: QUIT
S: 221 Bye
~~~

所以一行：

~~~ts
await transporter.sendMail(...)
~~~

底层可能经历：

~~~text
DNS
  ↓
TCP Connect
  ↓
SMTP Greeting
  ↓
EHLO
  ↓
TLS / STARTTLS
  ↓
AUTH
  ↓
MAIL FROM
  ↓
RCPT TO
  ↓
DATA
  ↓
SMTP Response
  ↓
Connection Close / Reuse
~~~

SMTP 主规范：
https://www.rfc-editor.org/rfc/rfc5321.html

## 6. EHLO、MAIL FROM、RCPT TO与DATA形成发送状态推进

不要把 SMTP Command 当作孤立词汇记忆。

~~~text
Connection
   ↓
Greeting
   ↓
EHLO
   ↓
Capability Negotiation
   ↓
MAIL FROM
   ↓
建立发件 Envelope
   ↓
RCPT TO
   ↓
增加收件人
   ↓
DATA
   ↓
提交完整 Message
   ↓
Accept / Reject
~~~

EHLO 响应可以声明 STARTTLS、AUTH、SIZE、8BITMIME、PIPELINING 等扩展能力；客户端再决定后续行为。

MAIL FROM 与 RCPT TO 属于 Transport Envelope；DATA 后才传输 RFC 5322 Message。

## 7. SMTP Envelope与用户看到的From/To Header不是同一层

~~~text
SMTP Envelope
────────────────────────────
MAIL FROM:<bounce@example.com>
RCPT TO:<user@example.com>

RFC 5322 Message
────────────────────────────
From: Browser Monitor <notice@example.com>
To: user@example.com
Subject: Verify account
~~~

所以：

~~~text
MAIL FROM
≠
From:

RCPT TO
≠
To:
~~~

Envelope 主要服务于运输、投递和退信；Header 主要描述用户看到的逻辑消息。

Bcc 也可以从这里理解：

~~~text
Envelope:
RCPT TO:<visible@example.com>
RCPT TO:<hidden@example.com>

Message Header:
To: visible@example.com
~~~

这个边界后面会直接连接 Return-Path、Bounce、SPF 与 DMARC。

## 8. Message Submission与服务器之间的SMTP Relay是两个阶段

RFC 6409 将“提交一封新邮件”和“邮件服务器之间转发”拆开：

~~~text
Application / MUA
        ↓
Message Submission
        ↓
MSA
        ↓
SMTP Relay
        ↓
MTA
~~~

典型端口：

| 端口 | 常见职责 | 项目中的位置 |
| --- | --- | --- |
| 25 | MTA ↔ MTA SMTP Relay | 应用通常不直接使用 |
| 587 | Message Submission | 常见生产配置 |
| 465 | Implicit TLS Submission | 常见生产配置 |
| 1025 | Mailpit 开发 SMTP | 当前 Compose 默认 |
| 8025 | Mailpit Web UI | 开发者查看邮件 |

RFC 6409：
https://www.rfc-editor.org/rfc/rfc6409.html

RFC 8314：
https://www.rfc-editor.org/rfc/rfc8314.html

## 9. SMTP_HOST通常指向自己的邮件提供方而不是目标邮箱服务器

假设目标是：

~~~text
user@gmail.com
~~~

生产应用通常不是：

~~~text
Browser Monitor
      ↓
直接连接 Gmail MX
~~~

而是：

~~~text
Browser Monitor
      ↓
SMTP Submission
      ↓
Own Mail Provider
      ↓
Provider Queue / Relay
      ↓
DNS MX
      ↓
Recipient MTA
~~~

因此：

~~~text
SMTP_HOST
    当前应用使用的 SMTP Provider

Recipient Domain
    决定 Provider 后续应把邮件送往哪个邮件系统
~~~

这也解释了为什么切换邮件服务商主要是 Infrastructure Configuration 变化，而不是业务逻辑变化。

## 10. DNS MX负责帮助发送方找到目标域的Mail Exchanger

目标地址：

~~~text
user@example.com
~~~

先提取：

~~~text
example.com
~~~

然后：

~~~text
Recipient Domain
      ↓
DNS MX Query
      ↓
MX Record
      ↓
Mail Exchanger Host
      ↓
Resolve Address
      ↓
SMTP Relay
~~~

因此：

~~~text
DNS MX
    解决“发到哪台邮件服务器”

SMTP
    解决“怎样把邮件交给服务器”
~~~

## 11. TLS与SMTP AUTH解决不同安全问题

当前项目配置中同时存在：

~~~text
SMTP_SECURE
SMTP_USER
SMTP_PASSWORD
~~~

它们不是同一种安全能力。

~~~text
TLS
    保护连接的机密性和完整性

SMTP AUTH
    验证当前 Client 是否有权使用 Submission Server
~~~

SMTP AUTH：
https://www.rfc-editor.org/rfc/rfc4954.html

## 12. STARTTLS与Implicit TLS代表两种建立加密连接的方式

STARTTLS：

~~~text
TCP
 ↓
SMTP Greeting
 ↓
EHLO
 ↓
STARTTLS
 ↓
TLS Handshake
 ↓
EHLO
 ↓
AUTH / MAIL FROM / ...
~~~

常见配置：

~~~text
Port 587
secure: false
~~~

这里的 \`secure: false\` 不等于最终一定明文，它表示连接建立时不立即使用 TLS；服务器支持 STARTTLS 时仍可以升级。

Implicit TLS：

~~~text
TCP Connect
 ↓
TLS Handshake
 ↓
SMTP
~~~

常见配置：

~~~text
Port 465
secure: true
~~~

RFC 8314：
https://www.rfc-editor.org/rfc/rfc8314.html

## 13. Mailpit只承担当前开发环境邮件捕获

Docker Compose 当前定义：

~~~yaml
mailpit:
  image: axllent/mailpit:v1.27
  profiles: ["dev"]
  ports:
    - "8025:8025"
    - "1025:1025"
~~~

开发环境默认值是：

~~~text
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
~~~

所以：

~~~text
API
 ↓ SMTP :1025
Mailpit
 ↓
Capture Message
 ↓ HTTP :8025
Developer Browser
~~~

它主要用于验证：

~~~text
邮件是否发出
收件人是否正确
Subject 是否正确
Token URL 是否正确
正文是否正确
避免开发环境误发真实外部邮件
~~~

Mailpit：
https://mailpit.axllent.org/docs/

## 14. 生产SMTP Provider可以通过配置替换而不修改业务层

当前配置 Schema：

~~~text
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASSWORD
SMTP_FROM
~~~

开发：

~~~text
MailerService
     ↓
mailpit:1025
~~~

生产：

~~~text
MailerService
     ↓
smtp.provider.example:465/587
~~~

而业务代码仍然只是：

~~~ts
await mailer.sendVerification(...)
await mailer.sendPasswordReset(...)
await mailer.sendInvitation(...)
~~~

所以稳定的抽象是：

~~~text
Business Logic
      ↓
Mailer Infrastructure
      ↓
Transport
      ↓
External Provider
~~~

SMTP 只是当前 Transport 选择。未来也可以替换为 SES HTTP API 等 Provider API，而不应该让注册业务直接依赖协议细节。

## 15. SPF、DKIM和DMARC解决Domain Authentication

SMTP Provider 接受了客户端认证，只说明当前客户端能使用它，不代表收件服务器必然信任邮件中的发送域。

### 【SPF声明哪些主机被域名授权发送】

SPF（Sender Policy Framework）通过 DNS Policy 声明允许哪些主机使用某个 Domain 进行邮件发送。

接收方结合：

~~~text
Sending Host
+
MAIL FROM / HELO Domain
+
DNS SPF Policy
~~~

进行判断。

RFC 7208：
https://www.rfc-editor.org/rfc/rfc7208.html

### 【DKIM通过签名把Message与Signing Domain关联】

~~~text
Message
  ↓
Private Key Sign
  ↓
DKIM-Signature
  ↓
Transport
  ↓
Recipient
  ↓
DNS Public Key
  ↓
Verify Signature
~~~

RFC 6376：
https://www.rfc-editor.org/rfc/rfc6376.html

### 【DMARC把RFC5322.From与SPF/DKIM认证结果建立Alignment】

DMARC 关注 Author Domain，并围绕 Alignment、Policy 与 Reporting 建立规则。

截至 2026 年，当前 DMARC 主规范是 RFC 9989，它取代 RFC 7489 与 RFC 9091：

https://www.rfc-editor.org/rfc/rfc9989.html

以后文档应优先引用 RFC 9989。

## 16. TLS、SMTP AUTH与域名认证位于不同安全层

~~~text
Email Security
│
├── Transport Security
│      └── TLS / STARTTLS
│
├── Submission Authentication
│      └── SMTP AUTH
│
└── Domain Authentication
       ├── SPF
       ├── DKIM
       └── DMARC
~~~

分别回答：

~~~text
TLS
    当前连接是否安全？

SMTP AUTH
    当前客户端是否有权使用这台 SMTP Server？

SPF / DKIM / DMARC
    邮件与声明的发送域之间是否具有可信认证关系？
~~~

因此：

~~~text
SMTP AUTH 成功
≠ DMARC 一定通过

TLS 成功
≠ From Domain 一定可信

SPF 通过
≠ DKIM 一定通过

DKIM 通过
≠ DMARC 一定通过
~~~

## 17. SMTP状态码决定发送失败是否值得重试

第一阶段先建立：

~~~text
2xx
    Success

4xx
    Temporary Failure

5xx
    Permanent Failure
~~~

例如：

~~~text
250
Message accepted

421
Service temporarily unavailable

450
Requested action temporarily unavailable

550
Requested action rejected
~~~

工程策略：

~~~text
SMTP Result
   │
   ├── 2xx → accepted
   ├── 4xx → retry
   └── 5xx → failed
~~~

Enhanced Status Codes：
https://www.rfc-editor.org/rfc/rfc3463.html

## 18. sendMail成功不等于用户已经看到邮件

如果：

~~~text
Browser Monitor
      ↓
SMTP Provider
      ↓
250 Accepted
~~~

这里只能说明当前 SMTP Server 已经接受 Message 并承担下一阶段处理责任。

后面仍然可能经历：

~~~text
Provider Queue
     ↓
DNS MX
     ↓
Remote SMTP
     ↓
Recipient Policy
     ↓
Spam Filter
     ↓
Mailbox
~~~

仍然可能发生：

~~~text
Delay
Bounce
Reject
Quarantine
Spam
Delivered
~~~

因此生产邮件状态通常应区分：

~~~text
Requested
   ↓
Submitted
   ↓
Accepted
   ↓
Delivered
   ↓
Opened / Clicked
~~~

其中 Delivered、Bounce、Complaint 等结果通常依赖邮件 Provider Webhook / Event API，不是单靠本次 SMTP 调用就能完整知道。

## 19. 当前同步发送链存在数据库提交与SMTP发送的一致性边界

当前注册流程关键顺序：

~~~text
BEGIN
 ↓
Write User
 ↓
Write Verification Token
 ↓
COMMIT
 ↓
MailerService.sendVerification()
~~~

因此存在：

~~~text
PostgreSQL Transaction
        ↓
结束

SMTP External Call
        ↓
新的失败边界
~~~

例如：

~~~text
Database COMMIT
      ↓
成功

SMTP Send
      ↓
网络故障
      ↓
失败
~~~

结果可能是：

~~~text
Database:
Verification Token 已存在

Mailbox:
用户没有收到邮件
~~~

当前项目通过“未验证邮箱再次注册时轮换旧验证凭据并重新发送”提供业务恢复路径，但这不等于数据库和 SMTP 组成同一个原子事务。

这与 [服务端数据管理源码学习-2.md](./服务端数据管理源码学习-2.md) 中“本地事务不能覆盖外部系统”的知识直接相连。

## 20. 邮件成为关键生产能力后可以演进到Email Outbox

下面是**演进方案，不是当前实现**。

~~~text
HTTP Request
      ↓
Database Transaction
      │
      ├── Business State
      └── Email Outbox
      ↓
COMMIT
      ↓
HTTP Response


Email Outbox
      ↓
Email Worker
      ↓
SMTP Provider
      ↓
Success / Retry / Dead Letter
~~~

收益：

| 当前问题 | Outbox后的能力 |
| --- | --- |
| SMTP响应慢 | 不阻塞主要请求 |
| 临时网络失败 | Retry |
| API进程重启 | Task 仍持久化 |
| 连续失败 | Failed / Dead Letter |
| 邮件积压 | 可独立监控 |
| 吞吐增长 | Worker 可扩容 |

它与 Browser Monitor 已有的遥测 Outbox / Worker 属于相同可靠性思想，但不代表两类任务必须共用同一个数据模型。

## 21. 异步邮件又会引出敏感Token存储取舍

当前同步模式：

~~~text
Create Raw Token
      │
      ├── Hash(Token) → Database
      │
      └── Raw Token → Mailer
~~~

如果改成异步：

~~~text
API
 ↓
Email Outbox
 ↓
Worker
 ↓
Mailer
~~~

Worker 必须在未来拿到构造链接所需的数据。

可能方案：

~~~text
A. Outbox保存Raw Token
   → 简单
   → 扩大敏感凭据存储面

B. 保存加密Token或完整加密Payload
   → 减少明文暴露
   → 引入密钥管理

C. 重新设计一次性凭据领取机制
   → 边界更严格
   → 实现复杂度更高
~~~

所以演进并不是“异步一定更好”，而是：

~~~text
可靠性
   ↕
安全暴露面
   ↕
系统复杂度
~~~

这是一个真实的架构取舍点。

## 22. 邮件读取属于IMAP/POP3另一条链，不是SMTP反向执行

发送完成以后：

~~~text
SMTP
 ↓
Mailbox
~~~

用户访问 Mailbox 进入另一组协议：

~~~text
Mailbox
   ├── IMAP
   ├── POP3
   └── Webmail / Provider API
~~~

所以：

~~~text
SMTP
    Submit / Transfer

IMAP
    Access / Synchronize Mailbox

POP3
    Retrieve Mail
~~~

当前 Browser Monitor 只需要主动发送邮件，不需要读取用户邮箱，因此没有必要为了“邮件系统完整”而接入 IMAP / POP3。

## 23. 当前项目邮件体系最终收敛为七层

~~~text
第一层：Business
Register / Forgot Password / Invitation
        ↓
第二层：Application
AuthService / ProjectsService
        ↓
第三层：Mail Infrastructure
MailerService / Nodemailer
        ↓
第四层：Message
RFC 5322 / MIME
        ↓
第五层：Submission
SMTP / TLS / AUTH / MSA
        ↓
第六层：Internet Transfer
MTA / DNS MX / SMTP Relay / Queue
        ↓
第七层：Delivery & Trust
Mailbox / SPF / DKIM / DMARC / Bounce
~~~

当前源码直接实现到：

~~~text
Business
  ↓
MailerService
  ↓
Nodemailer SMTP Client
  ↓
Configured SMTP Server
~~~

开发环境中的 Mailpit 不会自然代表后续互联网 Relay、SPF/DKIM/DMARC 和真实邮箱 Delivery 已经发生。项目事实与通用邮件体系必须保持这个边界。

## 24. 第一阶段只建立完整链路与概念边界

| 知识 | 当前需要掌握 | 后续再深入 |
| --- | --- | --- |
| SMTP | Client/Server、Submission、Relay、核心命令 | ESMTP Extension |
| RFC 5322 | Header + Body | ABNF Grammar |
| MIME | HTML、附件、Multipart | Encoding / Boundary |
| MSA / MTA | Submission 与 Relay | Routing Internals |
| DNS MX | 找目标 Mail Exchanger | Priority / Fallback |
| Port | 25 / 587 / 465 / 1025 / 8025 | 历史兼容 |
| TLS | STARTTLS / Implicit TLS | MTA-STS / DANE |
| SMTP AUTH | Client Authentication | SASL Mechanism |
| Envelope | MAIL FROM / RCPT TO | Bounce Routing |
| SPF | 授权发送主机 | DNS Lookup 规则 |
| DKIM | Domain Signature | Canonicalization |
| DMARC | Alignment / Policy / Reporting | Reports |
| SMTP Result | 2xx / 4xx / 5xx | DSN / Bounce |
| Reliability | Retry / Queue / Outbox | Idempotency / Backoff |
| IMAP / POP3 | 与 SMTP 的边界 | Protocol State Machine |

完成这一阶段后，应能串起来回答：

~~~text
Browser Monitor为什么需要邮件？

MailerService、Nodemailer、SMTP、Mailpit分别是什么？

一封邮件从sendMail开始经历了什么？

SMTP与RFC 5322 / MIME是什么关系？

SMTP与IMAP是什么关系？

为什么存在25、587、465？

Mailpit的1025与8025分别是什么？

STARTTLS和Implicit TLS有什么区别？

SMTP AUTH与TLS分别解决什么问题？

MAIL FROM与From Header为什么不是同一个概念？

DNS MX在传输中解决什么？

SPF、DKIM、DMARC分别解决什么？

sendMail成功为什么不等于用户收到？

当前同步邮件发送为什么存在跨系统一致性边界？

Email Outbox能解决什么，又会新增什么安全问题？
~~~

## 25. 后续从一次sendMail的真实执行链继续深入

下一阶段最适合沿：

~~~ts
await this.transporter.sendMail(...)
~~~

继续向下拆：

~~~text
Configuration
   ↓
DNS
   ↓
TCP Connection
   ↓
SMTP Greeting
   ↓
EHLO
   ↓
Capability Negotiation
   ↓
STARTTLS / TLS
   ↓
SMTP AUTH
   ↓
MAIL FROM
   ↓
RCPT TO
   ↓
DATA
   ↓
Server Response
   ↓
Connection Reuse / Close
~~~

这样可以把 DNS、TCP、TLS、应用层协议与 Browser Monitor 的真实 SMTP 调用连接起来。

## 26. 参考资料

1. Browser Monitor. [MailerService](../platform/apps/api/src/auth/mailer.service.ts).
2. Browser Monitor. [AuthService](../platform/apps/api/src/auth/auth.service.ts).
3. Browser Monitor. [ProjectsService](../platform/apps/api/src/projects/projects.service.ts).
4. Browser Monitor. [Shared Config](../platform/packages/shared/src/config.ts).
5. Browser Monitor. [Docker Compose](../platform/infra/docker-compose.yml).
6. IETF. RFC 5321 — Simple Mail Transfer Protocol. https://www.rfc-editor.org/rfc/rfc5321.html
7. IETF. RFC 5322 — Internet Message Format. https://www.rfc-editor.org/rfc/rfc5322.html
8. IETF. RFC 2045 — Multipurpose Internet Mail Extensions Part One. https://www.rfc-editor.org/rfc/rfc2045.html
9. IETF. RFC 6409 — Message Submission for Mail. https://www.rfc-editor.org/rfc/rfc6409.html
10. IETF. RFC 8314 — Use of TLS for Email Submission and Access. https://www.rfc-editor.org/rfc/rfc8314.html
11. IETF. RFC 4954 — SMTP Service Extension for Authentication. https://www.rfc-editor.org/rfc/rfc4954.html
12. IETF. RFC 3463 — Enhanced Mail System Status Codes. https://www.rfc-editor.org/rfc/rfc3463.html
13. IETF. RFC 7208 — Sender Policy Framework. https://www.rfc-editor.org/rfc/rfc7208.html
14. IETF. RFC 6376 — DomainKeys Identified Mail Signatures. https://www.rfc-editor.org/rfc/rfc6376.html
15. IETF. RFC 9989 — Domain-Based Message Authentication, Reporting, and Conformance. https://www.rfc-editor.org/rfc/rfc9989.html
16. Nodemailer. SMTP Transport. https://nodemailer.com/smtp
17. Mailpit. Documentation. https://mailpit.axllent.org/docs/
