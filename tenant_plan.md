# 多租户改造计划

## 背景

当前系统是全局角色模型：`admin` 可以查看和管理所有文件、文件夹、用户、回收站、审计日志和设置。后续如果要支持多个管理员分别管理自己的文件范围，需要引入租户边界，避免不同管理员之间互相看到数据。

核心边界建议使用 `tenant_id`。所有用户、文件夹、文件、审计日志都归属到一个租户；接口查询和详情访问都必须校验当前登录用户的 `tenant_id`。

## 目标角色

- `super_admin`：平台管理员，可管理所有租户和全局配置。
- `tenant_admin`：租户管理员，只能管理自己租户内的文件、用户、回收站和审计日志。
- `user`：普通用户，只能阅读自己租户内可见文件。

第一阶段可以先不做完整平台管理页面，只把现有 `admin` 收敛成租户管理员模型。

## 数据库改造

新增租户表：

```sql
create table if not exists tenants (
  id text primary key,
  name text not null,
  status text not null default 'active',
  created_at integer not null
);
```

需要增加 `tenant_id` 的表：

- `users.tenant_id`
- `folders.tenant_id`
- `files.tenant_id`
- `audit_logs.tenant_id`

可选后续增强：

- `settings.tenant_id`：如果回收站保留天数、容量限制等配置需要每个租户独立管理，再把设置改成租户级。

迁移策略：

- 创建默认租户，例如 `default`。
- 将现有 `users`、`folders`、`files`、`audit_logs` 全部写入默认租户。
- 给 `tenant_id` 建索引，常用查询建议使用 `(tenant_id, ...)` 组合索引。

## 登录态改造

当前 session 用户信息需要扩展租户字段。

目标结构：

```ts
interface SessionUser {
  id: string
  username: string
  role: 'super_admin' | 'tenant_admin' | 'user'
  tenant_id: string
  expires_at: number | null
}
```

后端 `getSessionUser` 查询 session 时，需要从 `users` 带出 `tenant_id` 和新角色。

## 接口权限边界

重点原则：不能只在列表接口过滤，详情接口也必须校验 `tenant_id`。否则用户只要知道文件 id 或文件夹 id，仍可能越权访问其它租户的数据。

需要加租户过滤或租户校验的接口范围：

- 文件夹树：`/api/folders/tree`
- 文件夹创建
- 文件夹更新
- 文件夹移动
- 文件夹回收
- 文件夹恢复
- 文件列表：`/api/folders/:id/files`
- 文件上传
- Markdown 创建
- 文件 metadata
- 文件 content
- 文件更新
- 文件内容更新
- 文件回收
- 文件恢复
- 回收站
- 审计日志
- 用户管理

所有按 id 查询的 helper 也要考虑租户边界，例如：

- `getFolder`
- `getFile`
- `getReadableFile`
- `isFolderAvailable`
- `getEffectiveFolderExpiration`
- `moveFolderTree`
- `trashFolderTree`
- `restoreFolderTree`

建议新增租户感知版本：

```ts
getFolderForTenant(env, folderId, tenantId)
getFileForTenant(env, fileId, tenantId)
assertFolderInTenant(env, folderId, tenantId)
assertFileInTenant(env, fileId, tenantId)
```

`super_admin` 如需跨租户查看，应走显式平台管理接口，不建议让普通业务接口默认绕过租户过滤。

## R2 路径隔离

当前新文件路径类似：

```text
active/default/{fileId}.ext
```

多租户后建议新上传文件使用：

```text
active/{tenantId}/{fileId}.ext
```

旧文件无需立即搬迁，因为数据库已经保存了 `r2_key`，可以继续按旧路径读取。新上传文件按租户路径写入即可。

## 前端改造

第一阶段前端改动尽量小：

- 用户管理页只管理当前租户用户。
- 租户管理员创建用户时不显示租户选择。
- 普通租户管理员不能创建 `super_admin`。
- 导航和页面结构可以先保持不变。

第二阶段再增加：

- 租户管理页面。
- 平台管理员租户切换。
- 用户页租户筛选。
- 租户级容量和配置展示。

## 分阶段落地

### 第一阶段：最小可用多租户

1. 新增 `tenants` 表和默认租户迁移。
2. 给 `users`、`folders`、`files`、`audit_logs` 增加 `tenant_id`。
3. 登录态带出 `tenant_id`。
4. 后端文件、文件夹、回收站、审计、用户接口全部加租户过滤。
5. 新上传 R2 key 改成 `active/{tenantId}/{fileId}.ext`。
6. 用户管理限制在当前租户。
7. 增加跨租户越权测试。

### 第二阶段：平台管理

1. 增加 `super_admin` 角色。
2. 增加租户管理页面。
3. 平台管理员可创建、禁用、查看租户。
4. 平台管理员用户页支持按租户筛选。

### 第三阶段：租户级配置

1. 回收站保留时间改成租户级。
2. 回收站容量限制改成租户级。
3. 增加租户存储用量统计。
4. 增加租户级审计统计。

## 验证重点

- 租户 A 管理员不能看到租户 B 的文件夹树。
- 租户 A 管理员不能通过租户 B 的文件 id 读取 metadata。
- 租户 A 管理员不能通过租户 B 的文件 id 读取 content。
- 租户 A 管理员不能移动、回收、恢复租户 B 的文件夹。
- 租户 A 管理员不能回收、恢复、更新租户 B 的文件。
- 租户 A 管理员只能管理租户 A 的用户。
- 回收站只显示当前租户的数据。
- 审计日志只显示当前租户的数据。
- 新上传文件的 R2 key 带当前 `tenant_id`。
