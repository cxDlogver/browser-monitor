# 账号认证、Session 与 CSRF 源码实战分析

本文只分析 Browser Monitor 当前源码，不把项目实现当成通用标准。通用概念与安全原则统一参考 Full-Stack-AI-NOTES 中的《Web 身份认证、会话控制与访问控制体系》；本文负责解释这些知识在当前仓库里怎样落地、数据怎样流动、PostgreSQL 和 Redis 分别保存什么，以及当前实现有哪些明确边界。

通用知识入口：

- https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/W-Web%E8%BA%AB%E4%BB%BD%E8%AE%A4%E8%AF%81%E4%BC%9A%E8%AF%9D%E6%8E%A7%E5%88%B6%E4%B8%8E%E8%AE%BF%E9%97%AE%E6%8E%A7%E5%88%B6%E4%BD%93%E7%B3%BB.md

主要源码：

- platform/apps/api/src/auth/auth.controller.ts
- platform/apps/api/src/auth/auth.service.ts
- platform/apps/api/src/auth/session.guard.ts
- platform/apps/api/src/auth/csrf.guard.ts
- platform/apps/api/src/auth/mailer.service.ts
- platform/apps/web/src/pages/AuthPage.tsx
- platform/apps/web/src/api/client.ts
- platform/packages/shared/src/crypto.ts
- platform/packages/database/src/schema.ts
- platform/apps/worker/src/outbox-worker.ts

---

## 1. 账号生命周期由注册、邮箱验证、登录、会话使用和凭据失效组成

当前实现不是“注册成功后直接登录”，而是显式经过邮箱验证：

~~~text
注册表单
  ↓
POST /api/v1/auth/register
  ↓
创建或更新未验证 User
  ↓
生成 Verification Token
  ↓
Database 只保存 Token Hash
  ↓
发送验证邮件
  ↓
用户点击 /verify-email?token=...
  ↓
POST /api/v1/auth/verify-email
  ↓
消费 Verification Token
  ↓
users.email_verified_at = now()
  ↓
用户进入登录页
  ↓
POST /api/v1/auth/login
  ↓
校验 Password
  ↓
检查 email_verified_at
  ↓
创建 Session
  ↓
PostgreSQL + Redis
  ↓
Set-Cookie: bm_session
  ↓
后续受保护请求
~~~

这里实际上存在四种不同状态：

| 状态 | 当前项目中的证据 | 表示什么 |
| --- | --- | --- |
| 已注册 | users Row 存在 | 系统已经建立账号记录 |
| 邮箱已验证 | email_verified_at 非空 | 用户已经完成邮箱控制权确认 |
| 已登录 | Browser 持有有效 bm_session，Redis 中存在对应 Session | 当前 Browser 有在线认证状态 |
| 有资源权限 | project_members 等资源关系通过检查 | 当前 User 可以访问具体 Project |

因此：

~~~text
Registered
≠
Email Verified
≠
Authenticated Session
≠
Authorized Resource Access
~~~

---

## 2. 注册阶段先建立 User，再建立一次性邮箱验证凭据

### 【Controller 先校验输入格式】

auth.controller.ts 的注册 Schema：

~~~ts
const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(256),
  displayName: z.string().trim().min(1).max(120),
});
~~~

这一层判断的是：

~~~text
Email 字符串是否合法
Password 长度是否合法
Display Name 格式是否合法
~~~

它并没有证明：

~~~text
邮箱真实存在
用户能够控制这个邮箱
邮箱已经通过验证
~~~

### 【Service 归一化邮箱并计算 Password Hash】

auth.service.ts：

~~~ts
const email = emailInput.trim().toLowerCase();
const passwordHash = await hashPassword(password);
~~~

crypto.ts 当前使用：

~~~text
Password
  ↓
Random 16-byte Salt
  ↓
Node.js scrypt
  ↓
64-byte Derived Key
  ↓
保存：
scrypt + salt + derivedKey
~~~

因此 users.password_hash 保存的不是原始密码。

### 【User 与 Verification Token 在一个数据库事务内建立】

注册主体 SQL：

~~~sql
BEGIN;

INSERT INTO users(
  email,
  password_hash,
  display_name
)
VALUES ($1, $2, $3)
ON CONFLICT (email) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    display_name = EXCLUDED.display_name,
    updated_at = now()
WHERE users.email_verified_at IS NULL
RETURNING id;
~~~

这段 SQL 带来一个很重要的项目行为。

情况一：

~~~text
Email 不存在
  ↓
创建 User
~~~

情况二：

~~~text
Email 已存在
但 email_verified_at IS NULL
  ↓
允许重新注册
  ↓
更新 Password Hash 和 Display Name
~~~

情况三：

~~~text
Email 已经完成验证
  ↓
WHERE users.email_verified_at IS NULL 不成立
  ↓
RETURNING 没有 User
  ↓
email_already_registered
~~~

所以“未验证账号重新注册”会覆盖旧的密码和显示名，“已经验证的账号”不会被注册接口覆盖。

### 【重新注册未验证账号时旧 Verification Token 会被失效】

源码：

~~~sql
UPDATE account_tokens
SET consumed_at = COALESCE(consumed_at, now())
WHERE user_id = $1
  AND purpose = 'verify-email'
  AND consumed_at IS NULL;
~~~

这样同一个未验证账号不会同时保留多个仍然有效的邮箱验证链接。

随后生成新的验证 Token：

~~~text
createOpaqueToken("bm_verify_")
        ↓
32 Byte Secure Random
        ↓
Base64URL
        ↓
bm_verify_<random>
~~~

数据库只保存：

~~~text
SHA-256(bm_verify_<random>)
~~~

写入：

~~~sql
INSERT INTO account_tokens(
  user_id,
  purpose,
  token_hash,
  expires_at
)
VALUES (
  $1,
  'verify-email',
  $2,
  now() + INTERVAL '24 hours'
);
~~~

最后：

~~~sql
COMMIT;
~~~

事务提交以后才调用 MailerService 发送包含明文 Token 的验证邮件。

### 【注册后的数据库状态模板】

假设 User ID 为 user_001。

users：

~~~text
id                  user_001
email               alice@example.com
password_hash       scrypt$...
display_name        Alice
email_verified_at   NULL
created_at          ...
updated_at          ...
~~~

account_tokens：

~~~text
id           token_001
user_id      user_001
purpose      verify-email
token_hash   SHA256(bm_verify_xxx)
expires_at   now + 24h
consumed_at  NULL
created_at   ...
~~~

Browser / Email 拿到：

~~~text
bm_verify_xxx
~~~

Database 保存：

~~~text
SHA256(bm_verify_xxx)
~~~

---

## 3. 邮箱验证通过一次性 Token 把 User 从未验证转换成已验证

MailerService 生成：

~~~text
PUBLIC_BASE_URL
+
/verify-email
+
?token=bm_verify_xxx
~~~

Web 的 AuthPage 读取 URL 中 Token 后自动发：

~~~text
POST /api/v1/auth/verify-email

{
  token: "bm_verify_xxx"
}
~~~

Service 先 Hash：

~~~text
Submitted Token
      ↓
SHA-256
      ↓
token_hash
~~~

然后在事务中消费：

~~~sql
BEGIN;

UPDATE account_tokens
SET consumed_at = now()
WHERE token_hash = $1
  AND purpose = 'verify-email'
  AND consumed_at IS NULL
  AND expires_at > now()
RETURNING user_id;
~~~

这四个条件共同决定 Token 是否可以使用：

~~~text
Hash 匹配
AND Purpose = verify-email
AND 还没使用
AND 还没过期
~~~

成功以后：

~~~sql
UPDATE users
SET email_verified_at = COALESCE(email_verified_at, now()),
    updated_at = now()
WHERE id = $1;

COMMIT;
~~~

所以邮箱验证最终改变两个核心状态：

~~~text
account_tokens.consumed_at
NULL
  ↓
timestamp
~~~

~~~text
users.email_verified_at
NULL
  ↓
timestamp
~~~

### 【邮箱验证成功不会自动创建登录 Session】

verify-email 接口返回 204。

它不会：

~~~text
INSERT user_sessions
SET Redis Session
Set-Cookie bm_session
~~~

因此当前生命周期是：

~~~text
完成邮箱验证
  ↓
回到登录页
  ↓
重新提交 Email + Password
  ↓
创建 Session
~~~

---

## 4. 登录时先校验 Password，再检查邮箱是否已经验证

这个顺序必须按源码描述，不能凭经验改写。

Controller 首先只做输入格式校验：

~~~ts
email: z.string().email()
password: z.string().min(1).max(256)
~~~

Service 一次查询：

~~~sql
SELECT
  id,
  email,
  password_hash,
  display_name,
  email_verified_at
FROM users
WHERE email = $1;
~~~

接下来源码顺序是：

~~~text
User 不存在
  ↓
invalid_credentials

User 存在
  ↓
verifyPassword()
  │
  ├── Wrong
  │     ↓
  │   invalid_credentials
  │
  └── Correct
        ↓
检查 email_verified_at
  │
  ├── NULL
  │     ↓
  │   email_not_verified
  │
  └── Verified
        ↓
Create Session
~~~

对应代码逻辑：

~~~ts
if (!row || !verifyPassword(...)) {
  throw invalid_credentials;
}

if (!row.email_verified_at) {
  throw email_not_verified;
}
~~~

所以针对“每次登录是不是先验证邮箱，再验证密码”的答案是：

> 当前实现不是。先做 Email 格式校验，再查 User，然后先校验 Password；只有 Password 正确时才检查 email_verified_at。

这个顺序还有一个安全效果：

~~~text
不知道正确 Password 的请求者
        ↓
只能得到 invalid_credentials
        ↓
不会直接知道账号是不是
“存在但尚未验证邮箱”
~~~

只有已经知道正确 Password 的人，才会得到 email_not_verified。

---

## 5. 登录成功后同时写 PostgreSQL Session Row 和 Redis 在线 Session

### 【先生成三个核心值】

源码逻辑：

~~~text
Session Token
bm_session_<256-bit random>

Token Hash
SHA-256(Session Token)

CSRF Token
bm_csrf_<256-bit random>

Expires At
now + SESSION_TTL_SECONDS
~~~

### 【PostgreSQL 写 user_sessions】

SQL：

~~~sql
INSERT INTO user_sessions(
  user_id,
  token_hash,
  csrf_token,
  expires_at
)
VALUES ($1, $2, $3, $4)
RETURNING id;
~~~

示例：

~~~text
id            7e0d...
user_id       user_001
token_hash    1c65...
csrf_token    bm_csrf_xxx
expires_at    2026-...
last_seen_at  now()
created_at    now()
~~~

数据库不保存原始：

~~~text
bm_session_xxx
~~~

### 【Redis 写请求认证直接需要的 User Context】

源码构造：

~~~text
AuthenticatedUser
{
  id,
  email,
  displayName,
  sessionId,
  csrfToken
}
~~~

Redis：

~~~text
Key:
session:<SHA256(session-token)>

Value:
{
  "id": "user_001",
  "email": "alice@example.com",
  "displayName": "Alice",
  "sessionId": "session-db-id",
  "csrfToken": "bm_csrf_xxx"
}

TTL:
SESSION_TTL_SECONDS
~~~

### 【Browser 得到原始 Session Token】

Controller：

~~~text
Set-Cookie:
bm_session=<raw session token>

HttpOnly = true
Secure   = production
SameSite = Lax
Path     = /
Expires  = session.expiresAt
~~~

最终数据分布：

~~~text
Browser
  ↓
raw bm_session Token


API
  ↓
hashToken(raw token)


Redis
  ↓
session:<tokenHash>
  ↓
AuthenticatedUser


PostgreSQL
  ↓
user_sessions
  ↓
token_hash / csrf_token / expires_at
~~~

---

## 6. 当前 Session Token 是标准 Opaque Session Identifier 思路，但没有固定标准字段结构

Session Token 的生成：

~~~text
"bm_session_"
+
32 Byte Secure Random
+
Base64URL
~~~

它不是 JWT：

~~~text
Header.Payload.Signature
~~~

Token 内也没有编码：

~~~text
userId
role
permission
expiresAt
~~~

因此它属于：

> Opaque Token（不透明令牌）/ Opaque Session Identifier（不透明会话标识符）。

Client 只持有随机 Identifier，真正的用户身份和 Session 语义保存在 Server Side。

OWASP Session Management Cheat Sheet 的核心要求也是：

- Session ID 不应该携带敏感业务语义；
- 应不可预测；
- 自行生成时应使用安全随机数；
- 用户、权限和 Session 内部信息应放在 Server-side Session Store。

当前随机部分为 32 Byte，也就是 256 Bit。

固定前缀：

~~~text
bm_session_
~~~

不提供随机熵，但后面的随机部分仍然是完整 256 Bit。

所以项目当前结构可以概括为：

~~~text
Client Token
= Prefix + 256-bit Random

Server Lookup
= SHA-256(Client Token)

Session State
= Redis JSON
~~~

需要特别强调：

> Session Token 没有像 JWT 一样被规范要求拥有固定字段结构。所谓“标准 Session Token”更准确地说是符合随机性、不可预测性、无业务敏感信息和安全生命周期的 Session Identifier。

---

## 7. 当前 Redis 是在线身份认证的直接判断路径，PostgreSQL 不做 Redis Miss 回源

SessionGuard：

~~~text
Request
  ↓
读取 Cookie bm_session
  ↓
没有 Cookie
  ↓
401 authentication_required
~~~

有 Cookie：

~~~text
bm_session
  ↓
SHA-256
  ↓
Redis GET session:<hash>
  │
  ├── Miss
  │     ↓
  │   401 session_expired
  │
  └── Hit
        ↓
JSON.parse
        ↓
request.auth
        ↓
Continue
~~~

源码中没有：

~~~text
Redis Miss
  ↓
SELECT user_sessions
  ↓
重新写 Redis
~~~

所以你的判断是正确的：

> 当前实现没有 Redis 失效以后读取 PostgreSQL 恢复 Session 的功能。

### 【那 PostgreSQL user_sessions 当前到底有什么用】

第一，创建稳定 Session ID。

~~~text
INSERT user_sessions
RETURNING id
        ↓
AuthenticatedUser.sessionId
~~~

第二，Logout 时和 Redis 一起删除。

~~~text
Redis DEL session:<hash>
+
DELETE FROM user_sessions
WHERE token_hash = ...
~~~

第三，Password Reset 时按 user_id 找到并撤销所有 Session。

~~~sql
DELETE FROM user_sessions
WHERE user_id = $1
RETURNING token_hash;
~~~

然后：

~~~text
token_hash[]
  ↓
Redis DEL
session:<hash1>
session:<hash2>
...
~~~

第四，Worker 会清理过期数据库记录。

~~~sql
DELETE FROM user_sessions
WHERE expires_at < now();
~~~

当前 Housekeeping 每小时触发一次。

### 【因此两个 Store 现在不是典型 Cache + Database Fallback】

更准确的职责是：

~~~text
在线认证
  ↓
Redis


持久 Session Relationship
批量撤销索引
Session DB ID
过期 Row 清理
  ↓
PostgreSQL
~~~

所以不能把它描述成：

~~~text
Redis 只是 Cache
Database 是 Source of Truth
Miss 自动回源
~~~

因为 SessionGuard 的源码不支持这个结论。

### 【两个 Store 不一致时在线结果以 Redis 为准】

情况一：

~~~text
DB Row 仍在
Redis Key 提前丢失
  ↓
401 session_expired
~~~

用户必须重新登录。

情况二：

~~~text
DB Row 被单独删除
Redis Key 仍存在
  ↓
SessionGuard 仍能恢复 request.auth
~~~

只要 Redis TTL 尚未结束，在线请求仍然可能被接受。

因此当前在线认证“事实”以 Redis 状态为直接判断依据。

### 【last_seen_at 当前没有真正参与在线 Session 管理】

Schema 有：

~~~text
last_seen_at
~~~

但当前源码中没有 Request Guard 对它做持续 UPDATE。

因此不能把当前实现说成已经支持：

~~~text
Session 活跃时间
Sliding Expiration
设备活跃管理
~~~

字段目前主要停留在数据模型层。

---

## 8. Session Token 与 CSRF Token 被故意放在两条不同通道

Login Response：

~~~text
Cookie:
bm_session=<session token>

Body:
{
  user: ...,
  csrfToken: "bm_csrf_xxx"
}
~~~

Web Client 把 CSRF Token 写入：

~~~text
sessionStorage
browser-monitor-csrf
~~~

后续 Request：

~~~text
Session Token
  ↓
HttpOnly Cookie
  ↓
Browser 自动携带


CSRF Token
  ↓
JavaScript 读取
  ↓
非 GET / HEAD / OPTIONS
  ↓
x-csrf-token Header
~~~

Server：

~~~text
SessionGuard
  ↓
恢复 request.auth.csrfToken
  ↓
CsrfGuard
  ↓
读取 x-csrf-token
  ↓
比较
  │
  ├── Match → Continue
  └── Missing / Mismatch → 403
~~~

这就是当前项目里的 Synchronizer Token Pattern。

---

## 9. Synchronizer Token 为什么通常保护状态修改请求，而不要求普通 GET

CsrfGuard 当前直接放行：

~~~text
GET
HEAD
OPTIONS
~~~

核心原因不是“GET 没有任何安全风险”，而是 HTTP 对 Safe Method 有明确语义。

RFC 9110 对 Safe Method 的定义是：

> Client 不请求，也不期待服务器因为这个方法而改变目标资源状态。

GET、HEAD、OPTIONS、TRACE 被定义为 Safe Method。

所以 CSRF 最典型的攻击目标是：

~~~text
POST
PUT
PATCH
DELETE
~~~

因为攻击者想借当前用户身份执行：

~~~text
修改密码
创建资源
转账
删除数据
修改权限
提交配置
~~~

如果应用写出了：

~~~text
GET /delete-user?id=123
~~~

问题首先是接口违反了 HTTP Safe Method 语义。

RFC 9110 甚至特别说明：如果 Query Parameter 表达的是删除等 Unsafe Action，服务器必须禁止通过 Safe Method 执行，否则爬虫、预取等自动访问也可能触发副作用。

参考：

- RFC 9110 §9.2.1 Safe Methods
- https://www.rfc-editor.org/rfc/rfc9110.html#name-safe-methods

---

## 10. GET 不校验 Synchronizer Token 不代表 GET 绝对不会造成信息泄露

这里要区分两类问题：

~~~text
CSRF
主要关注“借用户身份执行请求”
~~~

和：

~~~text
Cross-origin Read / XS-Leak
关注“攻击者能否得到敏感信息”
~~~

### 【跨站 GET 通常可以被发出，但恶意页面通常不能直接读取 Response Body】

Same-Origin Policy 通常允许：

~~~text
Link Navigation
Form Submission
Image Embedding
Iframe Embedding
~~~

等一部分跨源行为。

但是攻击页面 JavaScript 通常不能直接读取另一个 Origin 的敏感 Response。

例如：

~~~text
evil.example
  ↓
请求 account.example/profile
  ↓
Browser 可能发送 Request
  ↓
account.example 返回私密页面
  ↓
evil.example JavaScript
不能直接读取正文
~~~

MDN 对 Same-Origin Policy 的分类也是：

- Cross-origin writes 通常允许；
- Cross-origin embedding 通常允许；
- Cross-origin reads 通常被限制。

### 【但 Cross-origin Embedding 可能泄露“部分状态信息”】

攻击者读不到正文，不等于完全得不到信息。

例如可能通过：

~~~text
onload / onerror
图片宽高
HTTP Redirect 行为
资源是否存在
Timing
Cache
Iframe 行为
~~~

推断一些用户状态。

这种问题通常归类为：

> XS-Leaks（Cross-Site Leaks，跨站侧信道泄露）。

举例：

~~~text
已登录用户有私密头像
GET /private-avatar
→ image success

没有权限
→ 404
~~~

攻击页面即使不能读图片二进制内容，也可能通过 Image load / error 判断“资源是否存在”。

因此：

> GET 确实可能间接造成信息泄露，但这通常不是 Synchronizer Token 主要解决的经典 CSRF Write 问题，而属于 Cross-origin Read、Embedding 和 XS-Leak 等浏览器隔离问题。

### 【CORS 如果允许恶意 Origin 携带凭据，GET 内容甚至可能被直接读取】

如果服务器错误允许：

~~~text
Access-Control-Allow-Origin:
https://evil.example

Access-Control-Allow-Credentials:
true
~~~

同时 Cookie 又能被发送，那么跨源 Fetch 可能直接读取敏感 GET Response。

这是：

~~~text
CORS / Credential Boundary 配置错误
~~~

不能通过“GET 本身不要求 CSRF Token”来解释或修复。

### 【敏感 GET 更应该治理 Cross-origin Read，而不是简单给所有 GET 加 CSRF Token】

常见方向包括：

~~~text
严格 CORS
SameSite Cookie
Cross-Origin-Resource-Policy
CSP frame-ancestors
X-Frame-Options
正确 Content-Type
X-Content-Type-Options: nosniff
Fetch Metadata
减少可区分的敏感 Side Channel
~~~

另外 OWASP 明确提醒不要把 CSRF Token 放在 GET URL / Query 中，因为 URL 很容易进入：

~~~text
Browser History
Server Log
Proxy Log
Referer
Network Diagnostic Tool
~~~

参考：

- OWASP CSRF Prevention Cheat Sheet
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- MDN Same-Origin Policy
- https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy

---

## 11. 一次完整受保护请求可以直接从源码按三层安全检查阅读

### 【读取请求】

~~~text
GET /api/v1/projects
      ↓
Cookie bm_session
      ↓
SessionGuard
      ↓
Redis session:<tokenHash>
      ↓
恢复 request.auth
      ↓
Project Membership / Role
      ↓
Business Query
~~~

### 【写请求】

~~~text
POST / PUT / DELETE ...
      ↓
Cookie bm_session
+
x-csrf-token
      ↓
SessionGuard
      ↓
恢复 Current User
      ↓
CsrfGuard
      ↓
验证当前 Session 的 CSRF Token
      ↓
Project Membership / Role
      ↓
Business Mutation
~~~

所以实际不是一个笼统的“权限校验”，而是：

~~~text
Authentication
  ↓
Request Authenticity
  ↓
Resource Authorization
~~~

三层连续检查。

---

## 12. Logout 与 Password Reset 展示了 Session Revocation 的实际实现

### 【Logout 撤销当前 Session】

请求需要先通过：

~~~text
SessionGuard
+
CsrfGuard
~~~

然后：

~~~text
bm_session
  ↓
SHA-256
  ↓
Redis DEL session:<hash>
+
DELETE user_sessions WHERE token_hash = ...
  ↓
clearCookie bm_session
~~~

所以 Logout 不只是删除 Browser Cookie，也会删除 Server-side Session。

### 【Password Reset 撤销当前 User 的全部 Session】

Reset Token 验证成功以后：

~~~text
UPDATE users.password_hash
      ↓
Consume Reset Tokens
      ↓
DELETE FROM user_sessions
WHERE user_id = ...
RETURNING token_hash[]
      ↓
COMMIT
      ↓
Redis DEL session:<hash>...
~~~

因此用户修改密码后，旧 Session 会被全部撤销。

这一点把：

~~~text
Credential Change
        ↓
Session Revocation
~~~

真正连接起来。

---

## 13. 当前 Redis + PostgreSQL 双存储仍有值得继续优化的可靠性问题

### 【Redis Miss 是否应该 Database Fallback 是一个语义问题，不只是性能问题】

当前选择：

~~~text
Redis Miss
  ↓
Session Expired
~~~

优点：

~~~text
请求路径简单
撤销即时
不会把已经删除的 Redis Session 自动复活
~~~

代价：

~~~text
Redis Flush / 数据丢失
  ↓
所有在线用户重新登录
~~~

如果以后改成：

~~~text
Redis Miss
  ↓
SELECT user_sessions
  ↓
恢复 Redis
~~~

就必须解决：

~~~text
这个 DB Row 是真实有效 Session
还是 Redis 被主动删除后的已撤销 Session？

expires_at 是否有效？

User 是否已禁用？

怎样区分 Logout 和 Redis 数据丢失？

恢复以后 CSRF Token 是否继续有效？
~~~

所以 Database Fallback 会改变 Revocation 语义，不能只当成普通 Cache Aside。

### 【Login 当前存在 PostgreSQL 与 Redis 双写窗口】

顺序：

~~~text
INSERT user_sessions
      ↓
Redis SET
~~~

两步不是一个跨系统 Transaction。

如果：

~~~text
Database Insert 成功
Redis SET 失败
~~~

结果可能是：

~~~text
Login 返回失败
但 Database 留下一条 Session Row
~~~

这条 Row 不会形成可用在线 Session，但会存在到主动删除或过期清理。

### 【Logout 也不是跨 PostgreSQL 和 Redis 的原子事务】

当前使用 Promise.all 同时删除。

任何分布式双写设计都要继续考虑：

~~~text
部分失败
Retry
Idempotency
Cleanup
Compensation
~~~

因此“Redis 快 + PostgreSQL 持久”只是第一层解释，不是完整可靠性设计。

---


### 【两个 Store 都写 Session，不意味着必须建立 Session Outbox】

判断是否需要 Outbox，先确定哪个系统决定当前 Credential 是否有效。当前实现登录与鉴权的真实路径为：

~~~text
AuthService.login()
  ↓ 验证密码和邮箱
  ↓ 生成随机 Session Token / tokenHash / csrfToken / expiresAt
  ↓ INSERT user_sessions ... RETURNING id
  ↓ Redis SET session:<tokenHash> userContext EX SESSION_TTL_SECONDS
  ↓ 返回 Token，Controller 设置 Cookie

SessionGuard.canActivate()
  ↓ Cookie bm_session → tokenHash
  ↓ Redis GET session:<tokenHash>
     ├─ 命中 → request.auth = JSON.parse(redisValue)，允许通过该 Session 检查
     └─ 未命中 → 401 session_expired
~~~

源码：[auth.service.ts](../platform/apps/api/src/auth/auth.service.ts)、[session.guard.ts](../platform/apps/api/src/auth/session.guard.ts)。**这里 Redis 是在线认证的直接决定依据，并不是 Redis Miss 后自动从 PostgreSQL user_sessions 回源的标准 Cache-Aside。** PostgreSQL 保存持久会话记录，用于 Session ID、Password Reset 批量撤销、按账户查找和清理等。因此两份 Store 有不同实际职责。

登录时先写 PostgreSQL 再写 Redis，没有跨存储共同 Transaction。如果 PostgreSQL 插入成功但 Redis SET 失败，登录请求会抛错，Token 尚未正常返回给客户端，可能留下一条不能用于当前在线授权的孤立记录。这主要是可用性、补偿和清理问题；不必默认增加 SessionCreated Outbox 让登录在不确定的时刻才生效。可以评估失败补偿删除、孤立行周期清理和监控告警。

| 登录/使用故障 | PostgreSQL | Redis | 真实影响 |
| --- | --- | --- | --- |
| DB INSERT 失败 | 无新 Session | 无新 Key | 登录请求失败 |
| DB INSERT 成功、Redis SET 失败 | 新行存在 | 没有对应 Key | 登录失败，孤立 DB 记录待清理 |
| Redis 写入成功、HTTP 响应丢失 | 新行存在 | 在线 Key 存在 | 客户端可能没拿到 Token，应考虑重试造成多个 Session |
| Redis Key 提前消失 | 行可能还在 | 无 Key | 当前 Guard 仍返回 401 |
| DB Session 被删，Redis Key 仍存在 | 无行 | Key 尚有效 | 当前 Guard 可能继续接受旧 Token |

### 【Logout 和 Password Reset 的双写失败需要按即时安全撤销分析】

当前 Logout：

~~~ts
await Promise.all([
  this.redis.del("session:" + tokenHash),
  this.database.pool.query(
    "DELETE FROM user_sessions WHERE token_hash = $1", [tokenHash],
  ),
]);
~~~

Promise.all 只是在同一个 JavaScript 层等待两个操作，**不构成 Redis + PostgreSQL 原子事务，也不能回滚已经成功的一方**。如果 PostgreSQL DELETE 已成功、Redis DEL 失败，旧 Token 在 Redis TTL 结束前仍可能通过只查询 Redis 的 SessionGuard；反过来若 Redis 已删除、DB 删除失败，在线请求被拒绝，但 DB 会话记录留下了待清理状态。

Password Reset 更需要注意：源码先在 PostgreSQL 的一个事务里重置密码、DELETE 对应用户全部 user_sessions，COMMIT 以后才批量 Redis DEL 这些 Session Key。若 Redis 删除失败，旧 Key 仍可能存在并通过在线认证。这不是前端 Cookie 删除问题，而是服务端撤销语义问题。

**Outbox 能保证将来继续重试 Redis DEL，却不能保证 Logout 当前立即生效。** 其因果链是：

~~~text
DB 已成功撤销会话
    ↓
Outbox 提交成功
    ↓
后台等待或重试 Redis DEL
    ↓
Redis DEL 真正成功前，旧 Session Key 仍可能可用
~~~

因此不能把“最终一致的事件通知”误用成“即时认证撤销”。架构完善应优先解决五个问题：

1. **在线权威在哪？** 继续以 Redis 为授权依据时，撤销要在这个边界明确生效；如切换为 DB 权威，则必须确保 Redis 命中不能绕过已撤销状态的校验。
2. **撤销成功如何定义？** 不应在旧 Token 仍可能通过核心认证检查时无条件声称服务器已完成撤销。对已经进入业务逻辑的并发请求，需要另行规定是否中止。
3. **存储故障时如何拒绝？** Redis 故障不应让敏感请求按默认允许执行；需要有明确 Fail-closed 与降级策略。
4. **哪些补偿是异步的？** 孤立 DB 记录清理、审计事件和跨服务通知可由后台修复；是否允许延迟失效取决于安全要求，而不是是否采用队列。
5. **Redis Miss 后回源是否安全？** 如果 PostgreSQL 还保留未标记撤销的旧行，盲目从 DB 重建 Redis 可能让旧 Session 复活；回源必须按权威过期与撤销规则检查。

当前项目没有实现以上全部补救路径，本文讨论的是**源码中的风险窗口和可演进设计**，不能当作已上线功能。与监控数据链路对照：Raw Event + Outbox 同事务后可返回 HTTP 202，让后台稍后投影；对即时 Session Revocation 则不能直接用同样的“稍后处理”承诺替代安全边界。

关联：[通用会话与访问控制](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/W-Web%E8%BA%AB%E4%BB%BD%E8%AE%A4%E8%AF%81%E4%BC%9A%E8%AF%9D%E6%8E%A7%E5%88%B6%E4%B8%8E%E8%AE%BF%E9%97%AE%E6%8E%A7%E5%88%B6%E4%BD%93%E7%B3%BB.md)、[Redis 一致性](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-Redis完整知识体系.md)、[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[AWS Outbox Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)。


## 14. 源码结论

当前项目认证生命周期可以压缩成：

~~~text
注册
→ Password scrypt Hash
→ User 入库
→ Verification Token Hash 入库
→ 邮箱一次性 Token 验证

登录
→ 查 User
→ 先验证 Password
→ 再检查 email_verified_at
→ 创建 Opaque Session Token
→ 创建 CSRF Token
→ user_sessions 写 PostgreSQL
→ AuthenticatedUser 写 Redis
→ raw Session Token 写 HttpOnly Cookie

在线认证
→ Cookie Token Hash
→ Redis Session Lookup
→ Redis Miss 直接 401
→ 不做 PostgreSQL Fallback

写请求
→ SessionGuard
→ CsrfGuard
→ Resource Authorization

密码重置
→ 更新 Password Hash
→ 撤销全部 PostgreSQL Session
→ 删除全部 Redis Session
~~~

需要特别保留的几个事实：

1. 当前 Session Token 是 256-bit 随机 Opaque Identifier，不是 JWT，也不存在固定标准字段结构。
2. 登录顺序是 Password 正确以后才检查 Email Verified，不是反过来。
3. Redis 是当前在线认证的直接状态来源；PostgreSQL 不是 Redis Miss Fallback。
4. PostgreSQL user_sessions 目前主要承担 Session ID、持久关系、Logout / Password Reset 批量撤销和过期清理。
5. last_seen_at 当前没有形成真正的请求活跃追踪。
6. Synchronizer Token 主要保护 Unsafe / State-changing Request；GET 依赖 Safe Method 语义。
7. GET 仍可能通过 XS-Leak、错误 CORS 或可嵌入敏感资源泄漏信息，因此“不校验 CSRF Token”不等于“完全不存在跨站读风险”。

这些结论以当前仓库源码为准，后续代码变化时应重新核对实现。
