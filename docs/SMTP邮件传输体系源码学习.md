# SMTP 邮件传输体系源码学习

> **学习目标**：从 Browser Monitor 当前真实邮件链路出发，把“业务服务、MailerService、Nodemailer、SMTP Server、Mailpit、生产 Mail Provider、收件服务器、Mailbox、客户端读取、发送状态返回”放进同一条生命周期。本文优先解释系统角色和数据流，不先深入 SMTP 命令、MIME 编码等底层细节。
>
> **项目事实边界**：当前 Browser Monitor 已实现 Outbound Email，即注册验证、密码重置和项目邀请通过 Nodemailer SMTP Transport 发送；开发环境使用 Mailpit。项目当前没有实现邮件接收、IMAP 读取、Provider Delivery Webhook，也没有把邮件任务接入现有 Outbox Worker。
>
> **通用知识入口**：脱离项目的完整邮件系统框架维护在 [Full-Stack-AI-NOTES · 邮件传输与邮件系统完整框架](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/邮件传输与邮件系统完整框架.md)。本文只负责把通用框架映射回 Browser Monitor 当前实现和工程取舍。

## 1. Browser Monitor 的邮件链路先区分业务服务器和邮件服务器

当前项目中最容易混淆的是：

~~~text
Browser Monitor API
        ≠
Mail Server
~~~

Browser Monitor API 是业务服务器。它负责：

~~~text
注册用户
密码找回
项目邀请
生成业务Token
构造业务链接
决定给哪个邮箱发什么内容
~~~

真正承担 SMTP Server 角色的是另一个服务。

当前本地开发环境：

~~~text
Browser Monitor API
        ↓ SMTP
      Mailpit
~~~

生产环境则应替换为真实 SMTP Provider：

~~~text
Browser Monitor API
        ↓ SMTP
Production Mail Provider
        ↓
互联网邮件系统
~~~

所以邮件能力不是“API Server 自己变成邮件服务器”，而是：

> **API Server 作为 SMTP Client，连接并调用一个 Mail Server。**

### 【当前项目中的角色映射】

| 系统角色 | Browser Monitor 当前实现 | 职责 |
| --- | --- | --- |
| 业务服务 | API / AuthService / ProjectsService | 决定为什么发邮件 |
| 邮件基础设施适配 | MailerService | 把业务动作转换成发送调用 |
| SMTP Client Library | Nodemailer | 建立 SMTP Transport 并发送消息 |
| 开发 SMTP Server | Mailpit | 接收并保存本地测试邮件 |
| 生产 SMTP Server | 由 SMTP 配置指定，仓库未固定具体厂商 | 接收应用提交并继续投递 |
| 收件服务器 | Gmail / Outlook 等外部系统 | 接收目标域邮件并写入 Mailbox |
| Mail Client | Gmail Web、Outlook 等 | 用户读取 Mailbox |

这张表是后面所有知识的起点。

## 2. 当前三个业务场景共用同一个MailerService发送出口

当前 MailerService 位于：

~~~text
platform/apps/api/src/auth/mailer.service.ts
~~~

它提供三个业务发送方法：

~~~ts
sendVerification(email, token)

sendPasswordReset(email, token)

sendInvitation(email, token, projectName)
~~~

对应：

| 业务场景 | 上游 Service | 邮件目的 |
| --- | --- | --- |
| 注册 | AuthService.register | 验证邮箱 |
| 忘记密码 | AuthService.forgotPassword | 发送密码重置链接 |
| 项目邀请 | ProjectsService.invite | 发送项目邀请链接 |

虽然业务不同，但都收敛到：

~~~text
Business Service
      ↓
MailerService
      ↓
Nodemailer
      ↓
Configured SMTP Server
~~~

因此 MailerService 的价值不是“实现 SMTP 协议”，而是把业务层和邮件传输层隔开。

业务层只关心：

~~~text
发送验证邮件
发送重置邮件
发送邀请邮件
~~~

不需要知道 SMTP Host、Port、认证方式等连接细节。

## 3. 本地开发链路通过Mailpit截断真实互联网邮件传输

Docker Compose 当前启动：

~~~yaml
mailpit:
  image: axllent/mailpit:v1.27
  profiles: ["dev"]
  ports:
    - "8025:8025"
    - "1025:1025"
~~~

API 的默认邮件配置：

~~~text
SMTP_HOST = mailpit
SMTP_PORT = 1025
SMTP_SECURE = false
SMTP_USER = empty
SMTP_PASSWORD = empty
SMTP_FROM = Browser Monitor <monitor@example.test>
~~~

因此一次本地注册验证邮件的完整链路是：

~~~text
Browser
   ↓ HTTP
Browser Monitor API
   ↓
AuthService.register
   ↓
创建User + Verification Token
   ↓
MailerService.sendVerification
   ↓
Nodemailer
   ↓ SMTP :1025
Mailpit
   ↓
本地保存测试邮件
   ↓ HTTP :8025
Developer Browser
~~~

这里没有：

~~~text
DNS MX
Gmail SMTP Server
真实互联网投递
用户真实Mailbox
~~~

因为 Mailpit 已经把邮件截住。

### 【1025和8025属于两个不同接口】

~~~text
API → Mailpit
使用 SMTP :1025

Developer Browser → Mailpit
使用 HTTP :8025
~~~

因此：

- 1025 是应用提交测试邮件的 SMTP 端口；
- 8025 是开发者查看邮件的 Web UI 端口。

这也解释了为什么可以：

~~~text
应用通过SMTP发送
        ↓
开发者通过浏览器HTTP查看
~~~

两条连接服务于不同角色。

## 4. 当前MailerService通过配置建立到SMTP Server的发送通道

核心代码是：

~~~ts
this.transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: SMTP_USER存在时使用用户名和密码
});
~~~

最终发送：

~~~ts
await this.transporter.sendMail({
  from,
  to,
  subject,
  text
});
~~~

这里可以把配置理解成四个问题：

| 配置 | 解决的问题 |
| --- | --- |
| SMTP_HOST | 我要连接哪台邮件服务器 |
| SMTP_PORT | 通过哪个端口连接 |
| SMTP_SECURE | 连接建立时采用怎样的 TLS 模式 |
| SMTP_USER / SMTP_PASSWORD | 当前应用是否有权使用该发送服务器 |
| SMTP_FROM | 当前邮件声明的发送方 |

所以项目中的配置关系是：

~~~text
Browser Monitor API
      ↓
读取SMTP配置
      ↓
Nodemailer Transport
      ↓
目标SMTP Server
~~~

不是：

~~~text
配置所有Gmail / Outlook / QQ邮箱服务器
~~~

Browser Monitor 只需要知道自己的第一跳邮件服务。

### 【当前项目只实现SMTP接入，没有实现Provider HTTPS API】

通用邮件服务可以使用：

~~~text
SMTP
或
HTTPS API
~~~

但是当前 Browser Monitor 源码明确使用 Nodemailer SMTP Transport，因此当前事实是：

~~~text
Browser Monitor
      ↓ SMTP
Configured SMTP Server
~~~

如果未来切换 Amazon SES API、SendGrid API 等 HTTPS Provider API，需要新增或替换 Mail Transport 实现，不能把它描述成当前已经存在的能力。

## 5. 生产环境完整邮件链路在第一跳之后由Mail Provider继续完成

当前仓库只直接控制到：

~~~text
Browser Monitor
      ↓
Configured SMTP Server
~~~

如果把 SMTP_HOST 指向真实 Provider，则完整生产链可以理解成：

~~~text
Browser Monitor API
        ↓
MailerService
        ↓
Nodemailer
        ↓ SMTP Submission
Production Mail Provider
        ↓
Provider Queue
        ↓
读取收件地址
        ↓
example@gmail.com
        ↓
提取 gmail.com
        ↓
DNS MX
        ↓
Gmail Mail Server
        ↓ SMTP Relay
接收和投递检查
        ↓
Gmail Mailbox
        ↓
Gmail Web / App
        ↓
User
~~~

这里要建立责任边界：

~~~text
Browser Monitor直接负责
────────────────────
业务触发
邮件内容
SMTP第一跳连接配置
调用结果处理


Mail Provider和收件系统负责
────────────────────
发送队列
目标域路由
DNS MX
跨服务器SMTP Relay
收件策略
Mailbox投递
~~~

这也是为什么普通业务服务不需要自己运行完整的互联网邮件 MTA。

## 6. 邮件发送结果必须区分调用结果和最终投递结果

当前 MailerService 的 private send 方法：

~~~ts
private async send(...): Promise<void> {
  await this.transporter.sendMail(...);
}
~~~

这里有一个很重要的项目事实：

> **MailerService 当前把 Nodemailer sendMail 的详细返回值丢弃，只向上层暴露 Promise 成功或抛错。**

所以 AuthService / ProjectsService 当前能够直接判断的只有：

~~~text
await成功
    ↓
当前SMTP调用没有抛出错误

await失败
    ↓
当前发送调用发生错误
~~~

不能由此直接判断：

~~~text
用户已经收到
邮件进入Inbox
用户已经打开
~~~

### 【完整状态链应该按阶段理解】

~~~text
Requested
    ↓
Submitted
    ↓
Accepted by Sending Server
    ↓
Queued
    ↓
Accepted by Recipient Server
    ↓
Delivered / Bounced
    ↓
Opened
~~~

Browser Monitor 当前主要覆盖：

~~~text
Requested
    ↓
Submitted
    ↓
当前SMTP调用结果
~~~

后面的 Delivered / Bounced 等最终状态，当前仓库没有 Provider Webhook 或 Delivery Event 接入。

### 【SMTP同步结果和Provider异步结果是两类不同返回】

同步：

~~~text
Browser Monitor
      ↓ SMTP
Mail Provider
      ↓
Success / Error
~~~

异步：

~~~text
Mail Provider
      ↓
继续向目标域投递
      ↓
最终成功 / 退信 / 拒绝
      ↓
Webhook / Event
      ↓
Browser Monitor
~~~

当前只实现第一条。

如果以后产品需要“查看邮件是否真正投递”，需要补第二条状态回传链，而不是只修改 sendMail 的返回判断。

## 7. 邮件读取和用户回复不属于当前Browser Monitor邮件能力

当前项目实现的是：

~~~text
Outbound Email
Browser Monitor → User
~~~

没有实现：

~~~text
Inbound Email
User → Browser Monitor
~~~

### 【用户读取邮件不是Browser Monitor把邮件主动推到客户端】

真实生产环境中：

~~~text
Browser Monitor
      ↓
Mail Provider
      ↓
Recipient Mail Server
      ↓
Mailbox
~~~

到这里发送链已经结束。

用户读取时通常是：

~~~text
Mail Client
      ↓
访问 / 同步
      ↓
Recipient Mail Server
      ↓
Mailbox
      ↓
返回邮件内容
~~~

也就是说：

> 收件服务器保存邮件，客户端再读取或同步；Browser Monitor 不参与这一段。

如果用户使用 Gmail Web：

~~~text
Browser
    ↓ HTTPS
Gmail Web Application
    ↓
Gmail Mailbox
~~~

如果使用通用桌面客户端，则可能通过 IMAP 同步服务器 Mailbox。

### 【用户Reply不是SMTP Response】

SMTP Response：

~~~text
Browser Monitor
      ↓
Mail Server
      ↓
发送调用结果
~~~

User Reply：

~~~text
User
  ↓
写一封新的邮件
  ↓
用户自己的Mail Server
  ↓
原发送域的收件服务器
  ↓
目标Mailbox
~~~

它是一封新的反向邮件。

当前 Browser Monitor 没有 Inbox、IMAP Client 或 Inbound Webhook，因此即使 SMTP_FROM 使用一个可回复地址，也不代表 Browser Monitor API 会自动收到并处理回复。

## 8. 当前同步邮件发送存在数据库状态和外部SMTP之间的一致性边界

注册流程当前是：

~~~text
BEGIN
  ↓
写入User
  ↓
写入Verification Token Hash
  ↓
COMMIT
  ↓
MailerService.sendVerification
  ↓
SMTP
~~~

这意味着数据库事务结束之后，才调用外部 SMTP Server。

如果：

~~~text
Database COMMIT
      ↓
成功

SMTP Send
      ↓
失败
~~~

就可能出现：

~~~text
数据库
    已存在有效验证Token

邮件
    没有成功发送
~~~

当前注册逻辑存在一个业务恢复机制：

~~~text
未验证账号重新注册
      ↓
旧验证凭据失效
      ↓
生成新的Verification Token
      ↓
再次发送
~~~

但是它仍然不等于“数据库和邮件发送已经组成一个原子事务”。

### 【Email Outbox属于后续可靠性演进而不是当前实现】

可以演进成：

~~~text
Database Transaction
      │
      ├── Business State
      └── Email Task
      ↓
COMMIT
      ↓
Email Worker
      ↓
SMTP Provider
      ↓
Retry / Failed
~~~

这样能改善：

- SMTP 临时故障；
- API 请求等待外部邮件服务；
- Worker 重试；
- 邮件积压监控；
- Failed / Dead Letter 管理。

但当前 Browser Monitor 的 Outbox / Worker 用于遥测任务，不用于邮件发送。

所以答辩时必须说：

~~~text
现有实现：
API同步调用SMTP

可演进方案：
Email Outbox + Worker
~~~

不能把二者混为一谈。

### 【异步发送还会带来Token安全问题】

当前注册验证逻辑：

~~~text
Raw Token
   │
   ├── Hash(Token) → Database
   └── Raw Token → Mailer
~~~

数据库只保存 Token Hash。

如果改成：

~~~text
API
 ↓
Email Outbox
 ↓
Worker
 ↓
Mailer
~~~

Worker 需要未来仍能生成包含 Raw Token 的验证链接。

于是需要重新设计：

~~~text
Raw Token如何安全进入异步任务？
是否加密存储？
邮件Payload是否包含敏感凭据？
任务完成后何时删除？
~~~

因此 Email Outbox 是可靠性提升，同时也增加新的敏感数据治理问题。

## 9. 当前项目的完整邮件知识框架收敛到一条主链

不要再按 SMTP、Mailpit、DNS、IMAP 等词平铺学习，而只保留下面这张图：

~~~text
                          Browser Monitor邮件链
                                  │
                              业务触发
                                  ↓
                     AuthService / ProjectsService
                                  ↓
                             MailerService
                                  ↓
                             Nodemailer
                                  ↓
                         SMTP第一跳提交
                                  ↓
               ┌──────────────────┴──────────────────┐
               ↓                                     ↓
            本地开发                               生产环境
            Mailpit                         Production Mail Provider
               │                                     │
        Web UI :8025                             Provider Queue
                                                     ↓
                                                  DNS MX
                                                     ↓
                                             Recipient Mail Server
                                                     ↓
                                                  Mailbox
                                                     ↓
                                                Mail Client
                                                     ↓
                                                   User
~~~

然后把其他知识挂在这条链上：

| 分支 | 当前项目位置 |
| --- | --- |
| 本地邮件测试 | Mailpit 1025 / 8025 |
| SMTP连接 | Nodemailer + SMTP_* |
| 业务邮件 | Verification / Reset / Invitation |
| 发送结果 | sendMail Promise 成功 / 抛错 |
| 最终投递状态 | 当前未实现 |
| Provider Webhook | 当前未实现 |
| 邮件读取 | 当前不负责 |
| 用户回复处理 | 当前未实现 |
| Email Outbox | 可演进方案 |
| SPF / DKIM / DMARC | 生产发送域治理，仓库当前无完整配置事实 |

这样每个新知识点都能先回答：

> **它处在当前邮件生命周期的哪一段，解决什么问题？**

## 10. 项目答辩可以沿完整链路回答

### 【项目为什么需要Mailpit】

结论：

> Browser Monitor API 是业务服务器而不是邮件服务器。本地开发通过 SMTP 把邮件交给 Mailpit，Mailpit 作为本地 SMTP Server 截获测试邮件，再通过 8025 Web UI 供开发者查看，从而避免开发过程真实向互联网邮箱发信。

### 【SMTP_HOST配置的是什么】

结论：

> SMTP_HOST 配置的是 Browser Monitor 第一跳要连接的 SMTP Server，而不是最终收件人的 Gmail / Outlook Server。开发环境指向 Mailpit；生产环境应指向真实 Mail Provider。

### 【sendMail成功是否代表用户收到】

结论：

> 不代表。当前项目只能确认本次 Nodemailer SMTP 调用是否成功返回，后续 Provider Queue、目标服务器接收、Spam Policy、Mailbox 投递都不在当前同步调用结果中；项目也还没有接入 Delivery Webhook。

### 【邮件是怎样被用户读取的】

结论：

> Browser Monitor 负责把邮件交给发送系统，最终邮件存储在收件方 Mailbox。用户的 Mail Client 再通过 Webmail HTTPS、IMAP 或 Provider 自有同步机制读取 Mailbox；不是 Browser Monitor 直接把邮件推到用户客户端。

### 【当前邮件链最大的工程边界】

结论：

> 数据库业务状态先提交，随后才同步调用外部 SMTP，因此存在数据库成功而邮件发送失败的跨系统一致性窗口。可以通过业务重发恢复，进一步也可以设计 Email Outbox + Worker，但这会重新引出 Raw Token 在异步任务中的安全存储问题。

## 11. 相关源码与资料

### 【项目源码】

- platform/apps/api/src/auth/mailer.service.ts：Nodemailer SMTP Transport 与三类邮件构造。
- platform/apps/api/src/auth/auth.service.ts：注册、验证 Token、密码重置与邮件调用顺序。
- platform/apps/api/src/projects/projects.service.ts：项目邀请与邮件调用。
- platform/packages/shared/src/config.ts：SMTP_HOST、SMTP_PORT、SMTP_SECURE、SMTP_USER、SMTP_PASSWORD、SMTP_FROM。
- platform/infra/docker-compose.yml：Mailpit 以及开发环境默认 SMTP 配置。

### 【通用资料】

1. IETF. RFC 5321 — Simple Mail Transfer Protocol. https://www.rfc-editor.org/rfc/rfc5321.html
2. IETF. RFC 6409 — Message Submission for Mail. https://www.rfc-editor.org/rfc/rfc6409.html
3. IETF. RFC 9051 — Internet Message Access Protocol (IMAP) Version 4rev2. https://www.rfc-editor.org/rfc/rfc9051.html
4. Nodemailer. SMTP Transport. https://nodemailer.com/smtp
5. Mailpit. Configuration. https://mailpit.axllent.org/docs/configuration/
