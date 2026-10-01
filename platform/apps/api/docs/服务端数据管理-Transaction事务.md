# Transaction（事务）完整知识体系

> 本节建立在数据库基础、SQL、Schema、Drizzle 之后，重点理解服务端如何保证多步数据操作的可靠性。内容按照“为什么需要事务 → 事务如何执行 → pg 与 Drizzle 如何实现 → 项目源码中的使用场景”的顺序展开。

---

## 1. Transaction 解决多个数据库操作无法保证完整的问题

### 【一次业务操作通常包含多条 SQL】

服务端中的一个业务动作，通常不是一条 SQL 就可以完成。

例如 Browser Monitor 创建项目：

```text
创建 projects 数据

创建 project_members 数据

创建 ingestion_keys 数据

创建 allowed_origins 数据

记录 audit_logs
```

这些数据库变化共同表示：

```text
创建一个完整 Project
```

如果其中一步失败：

```text
projects 创建成功

但是 project_members 创建失败
```

数据库就会留下不完整状态。

因此需要 Transaction（事务）：

> 将多个数据库操作放在同一个执行范围内，使它们作为一个整体成功或者失败。

---

## 2. Transaction 的执行过程

### 【SQL 执行后不是立即成为最终数据】

理解事务最重要的问题：

> SQL 执行以后，数据库数据是否已经改变？

答案：

SQL 会产生修改，但是在 COMMIT（提交）之前，这些修改只属于当前 Transaction。

例如：

```sql
BEGIN;

UPDATE projects
SET name='B项目'
WHERE id=1;
```

当前事务中：

```text
A项目
 ↓
B项目
```

但是其他事务仍然看到提交之前的数据。

执行：

```sql
COMMIT;
```

以后：

```text
B项目
成为数据库正式状态
```

整体流程：

```text
BEGIN
 ↓
执行 SQL
 ↓
产生修改
 ↓
COMMIT
 ↓
修改正式生效
```

如果失败：

```text
ROLLBACK
 ↓
撤销当前 Transaction 的修改
```

---

## 3. Transaction 如何保证 Atomicity（原子性）

Atomicity（原子性）：

> 一个业务操作中的多个数据库修改，要么全部成功，要么全部失败。

例如接受项目邀请：

业务目标：

```text
用户加入项目
```

需要两个修改：

第一步：

```sql
INSERT INTO project_members(...);
```

第二步：

```sql
UPDATE project_invitations
SET accepted_at=now();
```

如果没有事务：

```text
INSERT 成功

UPDATE 失败
```

数据库可能变成：

```text
用户已经成为项目成员

但是邀请仍然显示未接受
```

这就是错误状态。

使用事务：

```sql
BEGIN;

INSERT project_members;

UPDATE project_invitations;

COMMIT;
```

如果 UPDATE 失败：

```sql
ROLLBACK;
```

数据库恢复到事务开始之前的状态。

---

## 4. COMMIT 与 ROLLBACK 的作用

### 【COMMIT 确认修改】

```sql
COMMIT;
```

表示：

```text
当前 Transaction 中的修改正式保存
```

---

### 【ROLLBACK 撤销修改】

```sql
ROLLBACK;
```

表示：

```text
放弃当前 Transaction 中产生的修改
```

数据库内部并不是简单覆盖原数据，而是保存数据修改过程，因此可以在失败时恢复。

PostgreSQL 后续实现会涉及：

- MVCC（Multi-Version Concurrency Control，多版本并发控制）
- WAL（Write Ahead Logging，预写日志）

当前阶段只需要理解：

```text
COMMIT
确认修改

ROLLBACK
撤销修改
```

---

## 5. 隐式事务与显式事务

### 【隐式事务】

如果没有手动 BEGIN：

```sql
UPDATE projects
SET name='B项目';
```

PostgreSQL 会自动处理：

```text
BEGIN
 ↓
UPDATE
 ↓
COMMIT
```

特点：

```text
一条 SQL
对应一个 Transaction
```

SQL 完成后，Transaction 结束，相关锁自动释放。

---

### 【显式事务】

业务需要多条 SQL 组成一个整体：

```sql
BEGIN;

SQL 1;
SQL 2;
SQL 3;

COMMIT;
```

开发者控制 Transaction 生命周期。

---

## 6. PostgreSQL pg 方式实现 Transaction

当前项目底层使用 node-postgres（pg）。

实现方式：

```ts
const client = await pool.connect();

try {
  await client.query('BEGIN');

  await client.query(sql1);
  await client.query(sql2);

  await client.query('COMMIT');

} catch(error) {

  await client.query('ROLLBACK');

} finally {

  client.release();
}
```

---

### 【为什么 Transaction 必须使用同一个 Client】

错误方式：

```ts
pool.query('BEGIN');
pool.query(sql1);
pool.query(sql2);
pool.query('COMMIT');
```

原因：

pool（连接池）可能每次返回不同数据库连接。

Transaction 必须绑定同一个 Connection（数据库连接）。

正确流程：

```text
Pool
 ↓
获取固定 Client
 ↓
BEGIN
 ↓
执行 SQL
 ↓
COMMIT
 ↓
释放 Client
```

---

## 7. Drizzle db 方式实现 Transaction

项目已经通过：

```ts
drizzle(pool,{schema})
```

创建 db。

Drizzle 提供：

```ts
await db.transaction(async(tx)=>{

  await tx.insert(projects);

  await tx.insert(projectMembers);

});
```

内部仍然对应：

```text
BEGIN
 ↓
SQL
 ↓
COMMIT / ROLLBACK
```

两种方式：

|方式|特点|
|-|-|
|pg Client|直接控制 SQL、锁、PostgreSQL 特性|
|Drizzle db|类型安全，适合常规 CRUD（增删改查）|

---

## 8. Transaction 与 Lock（锁）的区别

两个概念解决不同问题：

### Transaction

解决：

```text
一次业务操作不能只完成一部分
```

例如：

```text
创建项目

需要同时创建多个关联数据
```

---

### Lock（锁）

解决：

```text
多个请求同时修改同一份数据
```

例如：

```text
两个请求同时接受同一个邀请
```

---

## 9. FOR UPDATE 行锁解决并发修改问题

例如接受邀请：

数据库：

```text
project_invitations

id
invite-001

accepted_at
NULL
```

表示邀请还没有被接受。

两个请求同时处理：

请求 A：

```sql
SELECT *
FROM project_invitations
WHERE id='invite-001'
FOR UPDATE;
```

数据库：

```text
锁住 invite-001 这一行
```

请求 B 同时执行：

```sql
SELECT *
FROM project_invitations
WHERE id='invite-001'
FOR UPDATE;
```

数据库发现：

```text
invite-001 已经被 A 锁住
```

因此 B 等待。

A 完成：

```sql
UPDATE project_invitations
SET accepted_at=now();

COMMIT;
```

释放锁。

B 继续执行时，可以看到最新状态。

---

### 【FOR UPDATE 锁什么时候释放】

锁属于 Transaction，不属于 SQL。

因此：

```text
COMMIT
或者
ROLLBACK

 ↓

释放锁
```

隐式事务：

```text
SQL执行
 ↓
自动COMMIT
 ↓
释放锁
```

显式事务：

```text
SQL执行完成
 ↓
锁继续存在
 ↓
COMMIT/ROLLBACK
 ↓
释放锁
```

---

## 10. Browser Monitor 项目中的 Transaction 使用

### 【Create Project】

流程：

```text
BEGIN

创建 projects

创建 project_members

创建 ingestion_keys

创建 allowed_origins

记录 audit_logs

COMMIT
```

目的：

保证一个 Project 的相关数据完整创建。

---

### 【Ingestion 数据写入】

流程：

```text
BEGIN

写入 telemetry_events

创建 outbox_tasks

更新 ingestion_keys

COMMIT
```

原因：

必须保证：

```text
事件数据存在

并且后台任务存在
```

否则会出现：

```text
事件保存成功
但是没有任务继续处理
```

---

### 【Worker Dead Letter】

流程：

```text
BEGIN

创建失败任务记录

更新 outbox 状态

COMMIT
```

保证失败状态完整保存。

---

## 11. PostgreSQL Transaction 与 Redis 的边界

PostgreSQL 保存：

```text
telemetry_events
outbox_tasks
```

这些属于核心业务事实。

需要：

```text
PostgreSQL Transaction
```

保证可靠。

Redis 保存：

```text
统计数量
缓存结果
```

属于辅助数据。

例如：

```text
PostgreSQL COMMIT 成功

Redis 更新失败
```

不能：

```text
ROLLBACK PostgreSQL
```

原因：

Redis 不属于 PostgreSQL Transaction。

系统通常通过：

```text
异步任务
重试机制
最终一致性
```

处理辅助数据失败。

---

## 12. Transaction 完整执行模型

```text
业务操作
    ↓
判断是否需要事务
    ↓
BEGIN
    ↓
执行 SQL
    ↓
成功
    ↓
COMMIT

失败
    ↓
ROLLBACK
```

---

## 13. Transaction 核心总结

Transaction 主要解决四个问题：

### Atomicity（原子性）

多个数据库操作：

```text
全部成功
或者
全部失败
```

### Consistency（一致性）

数据库从一个合法状态进入另一个合法状态。

依赖：

```text
Transaction
Constraint
业务规则
```

### Isolation（隔离性）

多个请求同时操作数据时，控制相互影响。

常配合：

```sql
FOR UPDATE
```

### Durability（持久性）

COMMIT 后，数据可以长期保存。

---

最终理解：

> Transaction 不是等 COMMIT 才执行 SQL，而是在 SQL 执行过程中记录修改状态，由 COMMIT 决定这些修改是否成为最终数据。pg 方式提供数据库底层控制能力，Drizzle db 方式提供更高层的类型安全封装，两者最终都依赖 PostgreSQL Transaction 机制。