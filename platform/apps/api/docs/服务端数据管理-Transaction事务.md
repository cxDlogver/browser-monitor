# Transaction（事务）完整知识体系

> 本节在数据库基础、SQL、Schema、Drizzle 之后展开，重点理解事务为什么存在、如何保证数据可靠性，以及在 Browser Monitor 项目中的 pg 与 db 两种实现方式。

## 1. Transaction 解决多个数据库操作的一致性问题

### 【事务产生的原因】

服务端一次业务操作通常不是一条 SQL。

例如创建项目：

```text
创建 projects
+
创建 project_members
+
创建 ingestion_keys
+
创建 allowed_origins
+
记录 audit_logs
```

这些 SQL 共同描述一个业务动作：

```text
创建一个完整 Project
```

如果其中一步失败，不能留下：

```text
Project 已创建
但是 Member 不存在
```

这种状态。

因此需要 Transaction（事务）：

> 将多个数据库操作组织成一个整体，使它们能够一起成功或者一起失败。

---

## 2. Transaction 的执行过程

### 【SQL 执行后是否立即修改数据库】

Transaction 中执行 SQL 后，数据库会产生修改，但 COMMIT（提交）之前，这些修改属于当前事务。

例如：

```sql
BEGIN;

UPDATE projects
SET name='B项目'
WHERE id=1;
```

当前事务看到：

```text
A项目
 ↓
B项目
```

但是其他事务仍然看到旧数据。

执行：

```sql
COMMIT;
```

修改才成为数据库正式状态。

流程：

```text
SQL 执行
    ↓
产生修改
    ↓
属于当前 Transaction
    ↓
COMMIT
    ↓
成为最终数据
```

---

## 3. Transaction 如何保证 Atomicity（原子性）

Atomicity（原子性）：

> 一个业务操作中的多个数据库修改，要么全部成功，要么全部失败。

例如接受项目邀请：

第一步：加入项目成员。

```sql
INSERT INTO project_members(...);
```

第二步：更新邀请状态。

```sql
UPDATE project_invitations
SET accepted_at=now();
```

如果没有事务：

```text
加入成员成功

更新邀请失败
```

数据库会出现：

```text
用户已经加入项目
但是邀请仍然有效
```

使用事务：

```sql
BEGIN;

INSERT project_members;

UPDATE project_invitations;

COMMIT;
```

如果任意一步失败：

```sql
ROLLBACK;
```

之前修改全部撤销。

---

## 4. COMMIT 与 ROLLBACK

### 【COMMIT 确认修改】

```sql
COMMIT;
```

表示：

```text
当前 Transaction 中所有修改正式保存
```

### 【ROLLBACK 撤销修改】

```sql
ROLLBACK;
```

表示：

```text
放弃当前 Transaction 中所有修改
```

Transaction 内部数据库会保存修改过程，因此可以在失败时恢复到事务开始前状态。

---

## 5. 隐式事务与显式事务

### 【隐式事务】

如果没有手动 BEGIN：

```sql
UPDATE projects
SET name='B项目';
```

PostgreSQL 会自动执行：

```text
BEGIN

UPDATE

COMMIT
```

一条 SQL 一个事务。

SQL 执行完成后，事务结束，相关锁自动释放。

---

### 【显式事务】

业务需要多条 SQL 组成整体时：

```sql
BEGIN;

SQL 1;

SQL 2;

SQL 3;

COMMIT;
```

事务生命周期由开发者控制。

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
  throw error;
} finally {
  client.release();
}
```

关键点：

### 【Transaction 必须使用同一个 Client】

错误：

```ts
pool.query('BEGIN');
pool.query(sql1);
pool.query(sql2);
pool.query('COMMIT');
```

因为连接池可能分配不同 Connection（数据库连接）。

正确：

```text
Pool
 ↓
固定 Client
 ↓
BEGIN
 ↓
SQL
 ↓
COMMIT
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

  await tx.insert(projects)

  await tx.insert(projectMembers)

});
```

内部仍然对应：

```text
BEGIN

SQL

COMMIT / ROLLBACK
```

区别：

|方式|特点|
|-|-|
|pg Client|直接控制 SQL、锁、复杂 PostgreSQL 能力|
|Drizzle db|TypeScript 类型安全、适合 CRUD|

---

## 8. Transaction 与 Lock（锁）的关系

Transaction 解决：

```text
一次业务操作不能完成一半
```

Lock 解决：

```text
多个请求同时修改同一条数据
```

二者不同。

---

## 9. FOR UPDATE 行锁

例如接受邀请：

```sql
BEGIN;

SELECT *
FROM project_invitations
WHERE id='invite-001'
FOR UPDATE;

INSERT INTO project_members(...);

UPDATE project_invitations
SET accepted_at=now();

COMMIT;
```

FOR UPDATE 表示：

> 查询这一行，同时锁定这一行，防止其他事务同时修改。

流程：

```text
请求 A
 ↓
SELECT FOR UPDATE
 ↓
锁住 invitation

请求 B
 ↓
SELECT FOR UPDATE
 ↓
等待
```

COMMIT 或 ROLLBACK 后锁自动释放。

---

## 10. Browser Monitor 中 Transaction 使用场景

### 【Create Project】

```text
BEGIN

projects
project_members
ingestion_keys
allowed_origins
audit_logs

COMMIT
```

保证完整创建项目。

---

### 【Ingestion 数据写入】

```text
BEGIN

telemetry_events

outbox_tasks

UPDATE ingestion_keys

COMMIT
```

保证：

```text
事件保存成功
+
后台任务存在
```

---

### 【Worker Dead Letter】

```text
BEGIN

创建失败任务记录

更新 outbox 状态

COMMIT
```

保证失败状态完整记录。

---

## 11. PostgreSQL Transaction 与 Redis 的边界

PostgreSQL：

```text
核心业务数据

telemetry_events
outbox_tasks
```

需要强一致。

因此使用 PostgreSQL Transaction。

Redis：

```text
统计数量
缓存数据
```

属于辅助数据。

例如：

```text
PostgreSQL COMMIT 成功

Redis 更新失败
```

不能 ROLLBACK PostgreSQL。

原因：

Redis 不属于 PostgreSQL Transaction。

系统通常通过：

```text
Outbox
Retry
异步补偿
```

保证最终一致性。

---

## 12. Transaction 完整模型

```text
业务操作
    ↓
判断是否需要事务
    ↓
BEGIN
    ↓
SQL 1
SQL 2
SQL 3
    ↓
成功
    ↓
COMMIT

失败
    ↓
ROLLBACK
```

---

## 13. 核心总结

### Transaction 解决：

1. Atomicity（原子性）

多条 SQL 要么全部成功，要么全部失败。

2. Isolation（隔离性）

控制多个事务同时访问数据时的影响。

3. Durability（持久性）

COMMIT 后数据能够长期保存。

4. Consistency（一致性）

保证数据库从一个合法状态进入另一个合法状态。

最终理解：

> Transaction 不是等 COMMIT 才执行 SQL，而是在 SQL 执行过程中记录修改状态，由 COMMIT 决定是否确认这些修改成为最终数据。pg 方式提供底层控制能力，Drizzle db 方式提供类型安全封装，两者最终都依赖 PostgreSQL 的 Transaction 机制。