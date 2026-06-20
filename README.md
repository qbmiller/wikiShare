# CFShare

CFShare 是一个基于 Cloudflare Workers、Vue 3、D1 和 R2 的私有文档分享与在线阅读系统。它适合用来替代网盘公开链接，把文件上传、权限校验、在线阅读、过期控制和审计日志都收敛到自己的 Cloudflare 账号内。

项目不需要自建服务器，前端静态资源、API、鉴权、文件读取、定时清理都运行在 Cloudflare 上。

## 功能特性

- 账号密码登录。
- 首次部署时初始化管理员账号。
- 管理员用户管理、账号禁用、账号有效期。
- 最多 3 级文件夹。
- 文件夹和文件有效期。
- 文件上传到私有 R2，不暴露公开 R2 URL。
- 支持 PDF、Markdown、图片、PPT/PPTX 文件上传。
- PDF.js 在线阅读，后端支持 HTTP Range。
- Markdown 在线阅读，右侧显示文章结构目录。
- 图片在线预览。
- PPT/PPTX 文件识别和占位预览。
- 支持文件和文件夹生成公开分享链接，必须设置天/小时有效期，默认 1 天。
- 管理员可查看当前有效分享并取消分享。
- 文件夹和文件回收站。
- Cron 定时处理过期内容和回收站清理。
- 审计日志。
- 默认单文件上传限制为 100MB，可通过 `MAX_UPLOAD_BYTES` 调整。

![CFShare 预览](docs/images/preview.png)
## 技术栈

- Vue 3
- Vue Router
- Pinia
- Vite
- Hono
- Cloudflare Workers
- Cloudflare Workers Static Assets
- Cloudflare D1
- Cloudflare R2
- PDF.js
- TypeScript

## 架构

```text
Browser
  |
  | Vue 3 SPA
  v
Cloudflare Workers Static Assets
  |
  | /api/*
  v
Cloudflare Worker + Hono
  |-- 鉴权、会话、用户管理
  |-- 文件夹、文件、回收站、审计日志 API
  |-- 文件上传
  |-- 私有文件读取和 PDF Range 响应
  |-- Cron 过期清理
  |
  |-- D1：业务元数据
  |-- R2：私有文件对象
```

## 本地开发

### 1. 安装依赖

```bash
pnpm install
```

### 2. 应用本地 D1 迁移

```bash
pnpm run db:migrate:local
```

拉取包含新迁移的版本后，也需要重新执行该命令，让本地 D1 创建新增表结构。

### 3. 启动 Worker 开发环境

```bash
pnpm run dev:worker
```

### 4. 启动前端开发环境

另开一个终端：

```bash
pnpm run dev
```

首次访问登录页时，点击“首次部署，初始化管理员”创建第一个管理员账号。

## Cloudflare 部署

### 1. 准备资源

在 Cloudflare 创建：

- D1 数据库：`cfshare-db`
- R2 bucket：`cfshare-pdfs`

然后更新 `wrangler.toml` 中的 `database_id`。

也可以执行：

```bash
pnpm run cf:prepare
```

该命令会通过 Wrangler 创建或复用 D1/R2，并生成 `wrangler.local.toml`。这个文件包含真实 D1 database id，不建议提交到 Git。

### 2. 配置变量

可按需调整 `wrangler.local.toml`：

```toml
MAX_UPLOAD_BYTES = "104857600"
TRASH_RETENTION_DAYS = "30"
TRASH_MAX_BYTES = "21474836480"
```

### 3. 配置 Secret

```bash
npx wrangler secret put SESSION_SECRET --config wrangler.local.toml
```

### 4. 应用远程迁移

```bash
pnpm run db:migrate:remote
```

### 5. 构建并部署

```bash
pnpm run deploy
```

## 常用命令

```bash
pnpm run dev
pnpm run dev:worker
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run deploy
```

## 安全说明

- 文件存储在私有 R2 bucket 中。
- 阅读文件必须经过 Worker 鉴权。
- 系统不提供公开文件直链。
- 只要文件能在浏览器中展示，就无法绝对防止截图、录屏或浏览器侧复制。本项目的目标是提高传播门槛、控制访问权限并保留审计记录。

## 路线图

- 上传文件夹并保留目录层级，适配 Obsidian 等 Markdown 文件夹结构。
- PPT/PPTX 转 PDF 或图片页后在线逐页预览。
- Word、Excel 等更多格式支持。
- 文件全文搜索。
- 更细粒度的分享权限和访问统计。

## 协议

本项目基于 [MIT License](./LICENSE) 开源。
