# CFShare 部署到 Cloudflare

## 1. 确认 Wrangler 登录状态

```bash
cd /Users/miller/Documents/cfShare
npx wrangler whoami
```

如果未登录：

```bash
npx wrangler login
```

过程中 Wrangler 可能提示安装 Cloudflare skill，按提示处理即可。

## 2. 准备 Cloudflare 资源

项目需要两个 Cloudflare 资源：

- D1 数据库：`cfshare-db`
- R2 Bucket：`cfshare-pdfs`

查看或创建 D1：

```bash
npx wrangler d1 list --json
npx wrangler d1 create cfshare-db
```

创建 R2 Bucket：

```bash
npx wrangler r2 bucket create cfshare-pdfs
```

如果资源已存在，可以直接复用。

## 3. 生成本地部署配置

```bash
cp wrangler.toml wrangler.local.toml
```

把 `wrangler.local.toml` 中的 D1 配置改成真实 database id：

```toml
database_id = "真实的-d1-database-id"
```

检查配置：

```bash
grep -n "database_id\|bucket_name" wrangler.local.toml
```

`wrangler.local.toml` 包含真实 Cloudflare 资源 id，不要提交到 Git。

## 4. 配置 SESSION_SECRET

生成随机密钥：

```bash
openssl rand -hex 32
```

写入 Cloudflare Worker Secret：

```bash
npx wrangler secret put SESSION_SECRET --config wrangler.local.toml
```

按终端提示粘贴刚才生成的随机字符串。

## 5. 应用远程 D1 迁移. 改动sql后也要执行

```bash
pnpm run db:migrate:remote
```

如提示确认，输入 `y`。

## 6. 构建并部署

```bash
pnpm run deploy
```

部署成功后访问：

```text
https://cfshare.xxxx.workers.dev
```

## 7. 初始化管理员

首次访问登录页时，点击“首次部署，初始化管理员”，填写管理员用户名和密码。
## 8. 页面绑定自己的二级域名等
