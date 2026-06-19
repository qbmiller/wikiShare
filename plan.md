# PDF 在线阅读系统规划

## 1. 目标

设计并部署一个依赖 Cloudflare 的私有 PDF 在线阅读系统，用于替代通过网盘直接传播 PDF 的方式。

系统需要支持：

- 用户账号密码登录。
- 用户修改密码。
- 账号有效期。
- 日期文件夹和自定义命名文件夹。
- 文件夹最多嵌套 3 级。
- 文件夹有效期。
- 文件夹或文件到期后进入回收站。
- 回收站按空间和保留时间自动清理。
- PDF 上传和私有存储。
- PDF 在线阅读，不直接暴露公网下载链接。

## 2. 推荐技术栈

前端：

- Vue 3
- Vite
- TypeScript
- Vue Router
- Pinia
- PDF.js
- Naive UI 或 Element Plus

后端：

- Cloudflare Workers
- Hono
- Cloudflare D1
- Cloudflare R2
- Cloudflare Cron Triggers
- Cloudflare Turnstile

部署：

- Cloudflare Workers Static Assets

该系统不需要自建服务器。前端静态资源、API、鉴权、PDF Range 阅读、上传、回收站清理和定时任务都运行在 Cloudflare Workers 上；PDF 文件在 R2；业务数据在 D1。

## 3. 为什么选 Vue 3 + Vite

这是一个登录后的文件管理和 PDF 阅读系统，不是公开 SEO 站点。

推荐 Vue 3 + Vite，而不是 Nuxt：

- 不需要服务端渲染。
- 主体页面都在登录后。
- 业务形态更接近后台管理和文件管理工具。
- Cloudflare Worker 可以同时承载前端静态资源和后端 API。
- 架构更简单，部署更直接。

只有后续需要公开页面、SEO、SSR 或复杂服务端页面渲染时，才考虑 Nuxt。

## 4. 总体架构

```text
浏览器
  |
  | Vue 3 SPA + PDF.js
  |
Cloudflare Worker
  |
  |-- D1：用户、会话、文件夹、文件元数据、回收站状态、审计日志
  |
  |-- R2：私有 PDF 对象存储
  |
  |-- Cron Trigger：过期扫描和回收站清理
```

核心原则：

- R2 bucket 保持私有。
- PDF 文件不暴露为公开 R2 URL。
- 所有 PDF 阅读请求都必须经过 Worker 鉴权。

## 5. 用户系统

### 功能

- 用户名和密码登录。
- 用户自行修改密码。
- 管理员重置密码。
- 账号有效期。
- 禁用账号。
- 角色支持。
- 会话有效期。
- 登录审计日志。

### 用户表

```sql
users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  role text not null,
  expires_at integer,
  disabled_at integer,
  created_at integer not null,
  last_login_at integer
);
```

### 会话表

```sql
sessions (
  id text primary key,
  user_id text not null,
  token_hash text not null,
  expires_at integer not null,
  created_at integer not null
);
```

### 登录规则

每次登录时：

1. 校验用户名和密码。
2. 检查账号是否被禁用。
3. 检查账号是否过期。
4. 创建会话。
5. 使用 HttpOnly Cookie 保存会话 token。

不要把登录 token 存在 localStorage。

## 6. 文件夹系统

### 功能

- 支持日期文件夹，例如 `2026-06-19`。
- 支持自定义文件夹名称。
- 文件夹最多嵌套 3 级。
- 文件夹可设置有效期。
- 过期文件夹进入回收站。
- 回收站中的文件夹可恢复。

### 文件夹表

```sql
folders (
  id text primary key,
  parent_id text,
  name text not null,
  depth integer not null,
  expires_at integer,
  trashed_at integer,
  created_by text not null,
  created_at integer not null
);
```

### 文件夹规则

- 根文件夹 `depth = 1`。
- 最大允许 `depth = 3`。
- API 层必须拒绝超过 3 级的文件夹创建。
- 子文件夹和文件如果没有单独设置有效期，可以继承最近上级文件夹的有效期。
- 文件夹进入回收站后，其下所有子文件夹和文件在普通列表中隐藏。

## 7. PDF 文件存储

### 存储选择

PDF 二进制文件存储在 Cloudflare R2。

文件元数据、目录结构、权限状态、回收站状态存储在 Cloudflare D1。

不要把 R2 的对象路径当作目录结构的唯一来源。目录树应该以 D1 为准。

### 文件表

```sql
files (
  id text primary key,
  folder_id text not null,
  name text not null,
  r2_key text not null unique,
  size integer not null,
  mime_type text not null,
  sha256 text,
  expires_at integer,
  trashed_at integer,
  deleted_at integer,
  uploaded_by text not null,
  created_at integer not null
);
```

### R2 Key 设计

推荐格式：

```text
active/{tenant_id}/{file_id}.pdf
```

不要把用户可见的文件夹名称直接放进 R2 key。文件夹可以重命名，但对象 key 应该稳定。

## 8. PDF 在线阅读

PDF 不是通过公网链接下载，而是在系统内在线阅读。

### 前端阅读器

使用 PDF.js 集成到 Vue 页面中。

阅读路由示例：

```text
/reader/file/:id
```

阅读器功能：

- 页面渲染。
- 放大和缩小。
- 页码跳转。
- 文本搜索。
- 页面旋转。
- 移动端适配。
- 可选水印层。

### 后端 PDF 内容接口

示例接口：

```text
GET /api/files/:id/content
```

Worker 必须执行：

1. 检查登录会话。
2. 检查账号是否过期。
3. 检查文件是否存在。
4. 检查文件夹或文件是否过期。
5. 检查文件是否在回收站。
6. 检查用户是否有阅读权限。
7. 从 R2 读取 PDF 内容。
8. 返回给 PDF.js。

### Range 请求支持

PDF.js 在线阅读大文件时，需要服务端支持 HTTP Range 请求。

浏览器可能请求：

```http
Range: bytes=0-65535
```

Worker 应返回：

```http
206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-65535/12345678
Content-Type: application/pdf
Cache-Control: private, no-store
```

这样大 PDF 不需要一次性完整加载，首屏打开更快。

### 下载控制

在线阅读权限和原文件下载权限要分开。

建议权限字段：

```text
can_read_online
can_download
```

默认策略：

- 允许在线阅读。
- 不提供原 PDF 下载按钮。

需要明确限制：

只要浏览器能渲染 PDF，就无法做到绝对防复制。用户仍然可能截图、录屏、打印、抓包或从浏览器缓存中分析内容。系统能做的是提高传播门槛，并留下审计记录。

推荐控制：

- 不开放 R2 公网 URL。
- 不生成长期签名 URL。
- 所有阅读请求都绑定登录会话。
- 阅读页面叠加用户、时间、IP 等水印。
- 记录每次打开、阅读和下载行为。
- 增加访问频率限制。
- 可选 IP 或设备校验。

## 9. 上传流程

### 普通上传

中小 PDF：

1. 前端上传文件到 Worker。
2. Worker 检查登录和上传权限。
3. Worker 校验文件类型。
4. Worker 写入 R2。
5. Worker 写入 D1 元数据。

### 大文件上传

大 PDF：

- 使用 multipart upload。
- 记录上传状态。
- 所有分片成功后再完成上传。

### 校验规则

Worker 应检查：

- MIME type 为 `application/pdf`。
- 文件头以 `%PDF` 开始。
- 文件大小不超过配置限制。
- 目标文件夹存在且未进入回收站。
- 上传者账号有效。

## 10. 回收站和过期机制

### 有效期模型

文件夹和文件都可以有 `expires_at`。

最终生效的有效期按以下顺序计算：

1. 文件自身的 `expires_at`，如果设置了。
2. 最近上级文件夹的 `expires_at`，如果设置了。
3. 无有效期限制。

### 过期任务

使用 Cloudflare Cron Trigger。

建议每小时执行一次：

```text
0 * * * *
```

任务内容：

1. 查找已过期文件夹。
2. 设置 `trashed_at`。
3. 查找已过期文件。
4. 设置 `trashed_at`。
5. 写入审计日志。

过期后不要立刻物理删除。

### 回收站清理

回收站清理基于策略。

示例配置：

```text
trash_retention_days = 30
trash_max_bytes = 21474836480
```

清理逻辑：

1. 删除回收站中超过保留天数的文件。
2. 计算回收站总占用空间。
3. 如果超过 `trash_max_bytes`，按 `trashed_at` 从旧到新删除。
4. 删除每个文件时：
   - 删除 R2 对象。
   - 更新 D1 的 `deleted_at`。
   - 写入审计日志。

## 11. 审计日志

需要记录安全敏感操作：

- 登录成功和失败。
- 登出。
- 修改密码。
- 创建、修改、禁用用户。
- 创建、修改、删除、回收、恢复文件夹。
- 上传文件。
- 打开和阅读文件。
- 下载文件。
- 回收、恢复、删除文件。
- 定时任务触发的过期处理。

建议表：

```sql
audit_logs (
  id text primary key,
  user_id text,
  action text not null,
  target_type text,
  target_id text,
  ip text,
  user_agent text,
  detail text,
  created_at integer not null
);
```

## 12. API 草案

认证：

```text
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/change-password
GET  /api/auth/me
```

用户：

```text
GET    /api/users
POST   /api/users
PATCH  /api/users/:id
POST   /api/users/:id/reset-password
POST   /api/users/:id/disable
```

文件夹：

```text
GET    /api/folders/tree
POST   /api/folders
PATCH  /api/folders/:id
POST   /api/folders/:id/trash
POST   /api/folders/:id/restore
```

文件：

```text
GET    /api/folders/:id/files
POST   /api/files/upload
GET    /api/files/:id/metadata
GET    /api/files/:id/content
POST   /api/files/:id/trash
POST   /api/files/:id/restore
DELETE /api/files/:id
```

回收站：

```text
GET    /api/trash
POST   /api/trash/cleanup
```

审计：

```text
GET    /api/audit-logs
```

## 13. 部署计划

### 第一步：创建 Cloudflare 资源

创建：

- R2 bucket：`cfshare-pdfs`
- D1 database：`cfshare-db`
- Worker project：`cfshare`
- 自定义域名

### 第二步：配置 Worker Bindings

`wrangler.toml` 示例：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cfshare-db"

[[r2_buckets]]
binding = "PDF_BUCKET"
bucket_name = "cfshare-pdfs"
```

配置 secrets：

```text
SESSION_SECRET
TURNSTILE_SECRET_KEY
```

### 第三步：数据库迁移

创建迁移文件：

- users
- sessions
- folders
- files
- audit_logs
- settings

### 第四步：Worker API

实现：

- Auth middleware。
- Session Cookie 处理。
- 权限检查。
- 文件夹 API。
- 上传 API。
- 支持 Range 的 PDF 内容接口。
- 回收站 API。
- Cron scheduled handler。

### 第五步：Vue App

实现页面：

- 登录。
- 文件浏览。
- 文件夹管理。
- PDF 阅读器。
- 回收站。
- 用户管理。
- 系统设置。
- 审计日志。

### 第六步：部署

构建前端：

```bash
npm run build
```

部署到 Cloudflare：

```bash
npx wrangler deploy
```

## 14. MVP 范围

第一版应包含：

- 管理员登录。
- 用户创建。
- 账号有效期。
- 最多 3 级文件夹树。
- PDF 上传。
- 基于 PDF.js 的在线阅读。
- R2 私有存储。
- 文件夹和文件过期。
- 回收站。
- Cron 自动清理。

后续再做：

- 精细到文件夹的 ACL。
- 设备绑定。
- IP 白名单。
- 高级水印。
- 分片上传。
- 全部 PDF 的全文搜索。
- 多租户隔离。

## 15. 关键风险

### 在线阅读不是绝对 DRM

只要用户能在浏览器里看到 PDF，就仍然可能截图、打印、录屏或抓取渲染内容。

缓解方案：

- 水印。
- 禁用直接下载。
- 审计每次阅读。
- 访问频率限制。
- 会话过期。
- 对高风险文件可选将 PDF 页面渲染为图片流。

### Worker 限制

超大 PDF 和高并发访问需要重点处理流式读取和 Range 请求。

缓解方案：

- 早期就实现 Range 支持。
- 避免把完整 PDF 一次性读入内存。
- 设置文件大小限制。
- 使用真实大 PDF 样本压测。

### 回收站一致性

R2 删除和 D1 状态更新可能出现部分失败。

缓解方案：

- 删除任务设计为幂等。
- 保留 `deleted_at`。
- 失败任务可重试。
- 记录清理审计日志。
