# Public Shares Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add expiring public share links for files and folders, viewable without login, with an admin share list and cancel action.

**Architecture:** Store share records in D1 with a random public token, target type, target id, expiration, and cancellation state. Authenticated admins create and cancel shares through `/api/shares`; anonymous users read active shares through `/api/public/shares/:token/*`. Public file viewing reuses the existing reader components through a new public reader route, while public folder sharing exposes a read-only folder/file listing.

**Tech Stack:** Vue 3 `<script setup>`, Vue Router, Hono Worker, Cloudflare D1, Cloudflare R2, TypeScript, existing reader components.

---

### Task 1: Add Share Types and D1 Migration

**Files:**
- Create: `migrations/0002_shares.sql`
- Modify: `src/types.ts`
- Modify: `src/worker/types.ts`

**Step 1: Add the migration**

Create `migrations/0002_shares.sql`:

```sql
create table if not exists shares (
  id text primary key,
  token text not null unique,
  target_type text not null check (target_type in ('file', 'folder')),
  target_id text not null,
  expires_at integer not null,
  cancelled_at integer,
  created_by text not null references users(id),
  created_at integer not null
);

create index if not exists idx_shares_token on shares(token);
create index if not exists idx_shares_target on shares(target_type, target_id);
create index if not exists idx_shares_expires_at on shares(expires_at);
create index if not exists idx_shares_cancelled_at on shares(cancelled_at);
```

**Step 2: Add shared frontend API types**

Add to `src/types.ts`:

```ts
export interface ShareRecord {
  id: string
  token: string
  target_type: 'file' | 'folder'
  target_id: string
  target_name?: string
  expires_at: number
  cancelled_at: number | null
  created_by: string
  created_at: number
  public_url: string
}

export interface PublicShareMetadata {
  token: string
  target_type: 'file' | 'folder'
  target_id: string
  target_name: string
  expires_at: number
}

export interface PublicShareFolder {
  share: PublicShareMetadata
  folder: Folder
  files: SharedFile[]
}
```

**Step 3: Add Worker DB type**

Add to `src/worker/types.ts`:

```ts
export interface ShareRecord {
  id: string
  token: string
  target_type: 'file' | 'folder'
  target_id: string
  expires_at: number
  cancelled_at: number | null
  created_by: string
  created_at: number
}
```

**Step 4: Verify**

Run:

```bash
pnpm run typecheck
```

Expected: TypeScript passes.

**Step 5: Commit**

```bash
git add migrations/0002_shares.sql src/types.ts src/worker/types.ts
git commit -m "feat: add share data model"
```

---

### Task 2: Add Worker Share Helpers and Admin APIs

**Files:**
- Modify: `src/worker/index.ts`
- Test: `scripts/test.mts`

**Step 1: Add helper functions**

In `src/worker/index.ts`, add near existing utility functions:

```ts
function parseShareDuration(value: unknown, unit: unknown): number | null {
  const amount = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }
  if (unit === 'hours') {
    return amount * 60 * 60
  }
  if (unit === 'days') {
    return amount * 24 * 60 * 60
  }
  return null
}

function publicShareUrl(c: Context<{ Bindings: Env; Variables: Variables }>, token: string): string {
  const url = new URL(c.req.url)
  return `${url.origin}/share/${token}`
}
```

Export `parseShareDuration` if adding direct unit tests in `scripts/test.mts`.

**Step 2: Add create share endpoint**

Add authenticated admin endpoint:

```ts
app.post('/api/shares', requireAdmin, async (c) => {
  const body = await c.req.json<{ targetType?: 'file' | 'folder'; targetId?: string; duration?: number; unit?: 'days' | 'hours' }>()
  const targetType = body.targetType
  const targetId = body.targetId ?? ''
  const durationSeconds = parseShareDuration(body.duration ?? 1, body.unit ?? 'days')
  if ((targetType !== 'file' && targetType !== 'folder') || !targetId || durationSeconds == null) {
    return jsonError(c, 400, 'invalid_share', '请选择文件或文件夹，并设置有效期。')
  }

  if (targetType === 'file') {
    const file = await getFile(c.env, targetId)
    if (!file || file.deleted_at || file.trashed_at) {
      return jsonError(c, 404, 'target_not_found', '文件不存在或不可分享。')
    }
  } else {
    const folder = await getFolder(c.env, targetId)
    if (!folder || folder.trashed_at) {
      return jsonError(c, 404, 'target_not_found', '文件夹不存在或不可分享。')
    }
  }

  const id = newId()
  const token = randomToken()
  const createdAt = nowSeconds()
  const expiresAt = createdAt + durationSeconds
  await c.env.DB.prepare(
    `insert into shares(id, token, target_type, target_id, expires_at, cancelled_at, created_by, created_at)
     values (?, ?, ?, ?, ?, null, ?, ?)`,
  )
    .bind(id, token, targetType, targetId, expiresAt, c.get('user').id, createdAt)
    .run()

  await audit(c.env, { userId: c.get('user').id, action: 'share_created', targetType, targetId, detail: { shareId: id, expiresAt } })
  return c.json({ id, token, publicUrl: publicShareUrl(c, token), expiresAt }, 201)
})
```

**Step 3: Add list shares endpoint**

Add admin list endpoint:

```ts
app.get('/api/shares', requireAdmin, async (c) => {
  const now = nowSeconds()
  const rows = await c.env.DB.prepare(
    `select shares.*,
            coalesce(files.name, folders.name, shares.target_id) as target_name
     from shares
     left join files on shares.target_type = 'file' and shares.target_id = files.id
     left join folders on shares.target_type = 'folder' and shares.target_id = folders.id
     where shares.cancelled_at is null
       and shares.expires_at > ?
     order by shares.created_at desc`,
  )
    .bind(now)
    .all<ShareRecord & { target_name: string }>()

  return c.json(rows.results.map((share) => ({
    ...share,
    public_url: publicShareUrl(c, share.token),
  })))
})
```

**Step 4: Add cancel endpoint**

Add:

```ts
app.post('/api/shares/:id/cancel', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const share = await c.env.DB.prepare('select * from shares where id = ?').bind(id).first<ShareRecord>()
  if (!share || share.cancelled_at != null) {
    return jsonError(c, 404, 'share_not_found', '分享不存在或已取消。')
  }
  await c.env.DB.prepare('update shares set cancelled_at = ? where id = ?').bind(nowSeconds(), id).run()
  await audit(c.env, { userId: c.get('user').id, action: 'share_cancelled', targetType: share.target_type, targetId: share.target_id, detail: { shareId: id } })
  return c.json({ ok: true })
})
```

**Step 5: Test helper validation**

In `scripts/test.mts`, add:

```ts
assert.equal(parseShareDuration(1, 'days'), 86400)
assert.equal(parseShareDuration(2, 'hours'), 7200)
assert.equal(parseShareDuration(0, 'days'), null)
assert.equal(parseShareDuration(1, 'minutes'), null)
```

Run:

```bash
pnpm test
pnpm run typecheck
```

Expected: both pass.

**Step 6: Commit**

```bash
git add src/worker/index.ts scripts/test.mts
git commit -m "feat: add admin share APIs"
```

---

### Task 3: Add Public Share Worker APIs

**Files:**
- Modify: `src/worker/index.ts`

**Step 1: Allow anonymous public share API paths**

Modify the auth middleware exception in `src/worker/index.ts`:

```ts
if (
  c.req.path === '/api/health'
  || c.req.path === '/api/auth/login'
  || c.req.path === '/api/setup/admin'
  || c.req.path.startsWith('/api/public/shares/')
) {
  return await next()
}
```

**Step 2: Add active share resolver**

Add helper:

```ts
async function getActiveShare(env: Env, token: string): Promise<ShareRecord | null> {
  const now = nowSeconds()
  return await env.DB.prepare(
    `select * from shares
     where token = ?
       and cancelled_at is null
       and expires_at > ?`,
  )
    .bind(token, now)
    .first<ShareRecord>()
}
```

**Step 3: Add public share metadata endpoint**

Add:

```ts
app.get('/api/public/shares/:token', async (c) => {
  const share = await getActiveShare(c.env, c.req.param('token'))
  if (!share) {
    return jsonError(c, 404, 'share_unavailable', '分享不存在或已过期。')
  }

  if (share.target_type === 'file') {
    const file = await getFile(c.env, share.target_id)
    if (!file || file.deleted_at || file.trashed_at) {
      return jsonError(c, 404, 'share_target_unavailable', '分享内容不可访问。')
    }
    return c.json({ share: publicShareMeta(share, file.name), file: publicFile(file) })
  }

  const folder = await getFolder(c.env, share.target_id)
  if (!folder || folder.trashed_at) {
    return jsonError(c, 404, 'share_target_unavailable', '分享内容不可访问。')
  }
  return c.json({ share: publicShareMeta(share, folder.name), folder })
})
```

**Step 4: Add public folder listing endpoint**

For folder shares, list files in the shared folder only. Keep it simple; do not expose nested folder traversal in v1 unless explicitly requested.

```ts
app.get('/api/public/shares/:token/folder', async (c) => {
  const share = await getActiveShare(c.env, c.req.param('token'))
  if (!share || share.target_type !== 'folder') {
    return jsonError(c, 404, 'share_unavailable', '分享不存在或已过期。')
  }
  const folder = await getFolder(c.env, share.target_id)
  if (!folder || folder.trashed_at) {
    return jsonError(c, 404, 'share_target_unavailable', '分享内容不可访问。')
  }
  const now = nowSeconds()
  const files = await c.env.DB.prepare(
    `select * from files
     where folder_id = ?
       and trashed_at is null
       and deleted_at is null
       and (expires_at is null or expires_at > ?)
     order by created_at desc`,
  )
    .bind(folder.id, now)
    .all<FileRecord>()
  return c.json({ share: publicShareMeta(share, folder.name), folder, files: files.results.map(publicFile) })
})
```

**Step 5: Add public file content endpoint**

Add:

```ts
app.get('/api/public/shares/:token/files/:fileId/content', async (c) => {
  const share = await getActiveShare(c.env, c.req.param('token'))
  if (!share) {
    return jsonError(c, 404, 'share_unavailable', '分享不存在或已过期。')
  }

  const fileId = c.req.param('fileId')
  const file = await getFile(c.env, fileId)
  if (!file || file.deleted_at || file.trashed_at) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }
  if (share.target_type === 'file' && share.target_id !== file.id) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }
  if (share.target_type === 'folder' && share.target_id !== file.folder_id) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }

  return streamFile(c, file)
})
```

Refactor existing `/api/files/:id/content` body into a reusable `streamFile(c, file)` helper to avoid duplicate R2/range code.

**Step 6: Add metadata helper**

Add:

```ts
function publicShareMeta(share: ShareRecord, targetName: string) {
  return {
    token: share.token,
    target_type: share.target_type,
    target_id: share.target_id,
    target_name: targetName,
    expires_at: share.expires_at,
  }
}
```

**Step 7: Verify**

Run:

```bash
pnpm run typecheck
pnpm test
```

Expected: both pass.

**Step 8: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add public share APIs"
```

---

### Task 4: Add Admin Share Creation UI

**Files:**
- Modify: `src/views/DashboardView.vue`
- Modify: `src/styles.css`

**Step 1: Add state**

In `DashboardView.vue`, add:

```ts
const shareDuration = ref(1)
const shareUnit = ref<'days' | 'hours'>('days')
const shareMessage = ref('')
```

**Step 2: Add create share method**

Add:

```ts
async function createShare(targetType: 'file' | 'folder', targetId: string) {
  if (shareDuration.value <= 0) {
    error.value = '分享有效期必须大于 0。'
    return
  }
  const result = await api<{ publicUrl: string; expiresAt: number }>('/api/shares', {
    method: 'POST',
    body: JSON.stringify({
      targetType,
      targetId,
      duration: shareDuration.value,
      unit: shareUnit.value,
    }),
  })
  shareMessage.value = `分享链接：${result.publicUrl}`
  await navigator.clipboard?.writeText(result.publicUrl)
}
```

If `navigator.clipboard` fails, still show the URL in `shareMessage`.

**Step 3: Add duration controls**

In the file panel header area near upload controls, add compact controls:

```vue
<div class="share-controls">
  <input v-model.number="shareDuration" type="number" min="1" aria-label="分享有效期" />
  <select v-model="shareUnit" aria-label="分享有效期单位">
    <option value="days">天</option>
    <option value="hours">小时</option>
  </select>
</div>
```

Default must be 1 天.

**Step 4: Add folder share button**

Near selected folder actions, add:

```vue
<button v-if="selectedFolder" class="text-button" type="button" @click="createShare('folder', selectedFolder.id)">分享文件夹</button>
```

**Step 5: Add file share button**

In each file row actions, add:

```vue
<button class="text-button" type="button" @click="createShare('file', file.id)">分享</button>
```

**Step 6: Show share message**

Add below controls:

```vue
<p v-if="shareMessage" class="success-message">{{ shareMessage }}</p>
```

If no success style exists, add one to `src/styles.css` using the existing accent color.

**Step 7: Verify**

Run:

```bash
pnpm run typecheck
```

Expected: pass.

**Step 8: Commit**

```bash
git add src/views/DashboardView.vue src/styles.css
git commit -m "feat: add share creation controls"
```

---

### Task 5: Add Share List Menu and Admin Share List Page

**Files:**
- Create: `src/views/SharesView.vue`
- Modify: `src/router.ts`
- Modify: `src/App.vue`
- Modify: `src/styles.css`

**Step 1: Add route**

In `src/router.ts`:

```ts
import SharesView from './views/SharesView.vue'
```

Add route:

```ts
{ path: '/shares', component: SharesView, meta: { requiresAuth: true, requiresAdmin: true } },
```

**Step 2: Add left menu item**

In `src/App.vue`, import a lucide icon such as `Share2`.

Add admin nav item:

```vue
<RouterLink v-if="auth.user.role === 'admin'" to="/shares" class="nav-item" title="分享">
  <Share2 :size="18" />
  <span class="sidebar-text">分享</span>
</RouterLink>
```

**Step 3: Create `SharesView.vue`**

Implement:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import { formatDate } from '@/date'
import type { ShareRecord } from '@/types'

const shares = ref<ShareRecord[]>([])
const loading = ref(true)
const error = ref('')

onMounted(loadShares)

async function loadShares() {
  loading.value = true
  error.value = ''
  try {
    shares.value = await api<ShareRecord[]>('/api/shares')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '分享列表加载失败'
  } finally {
    loading.value = false
  }
}

async function cancelShare(share: ShareRecord) {
  await api(`/api/shares/${share.id}/cancel`, { method: 'POST' })
  await loadShares()
}

async function copyShare(share: ShareRecord) {
  await navigator.clipboard?.writeText(share.public_url)
}
</script>

<template>
  <section class="page-section">
    <header class="page-header">
      <div>
        <p class="eyebrow">分享</p>
        <h1>当前分享</h1>
      </div>
      <span>{{ shares.length }} 个有效分享</span>
    </header>

    <p v-if="error" class="form-message">{{ error }}</p>
    <p v-if="loading" class="empty-state">正在加载分享...</p>

    <div v-else class="file-table">
      <div class="file-table-head">
        <span>对象</span>
        <span>类型</span>
        <span>过期时间</span>
        <span>操作</span>
      </div>
      <div v-for="share in shares" :key="share.id" class="file-row">
        <span :title="share.target_name">{{ share.target_name }}</span>
        <span>{{ share.target_type === 'file' ? '文件' : '文件夹' }}</span>
        <span>{{ formatDate(share.expires_at) }}</span>
        <div class="row-actions">
          <button class="text-button" type="button" @click="copyShare(share)">复制链接</button>
          <a class="text-button" :href="share.public_url" target="_blank" rel="noreferrer">打开</a>
          <button class="text-button danger-text" type="button" @click="cancelShare(share)">取消分享</button>
        </div>
      </div>
    </div>
  </section>
</template>
```

**Step 4: Verify**

Run:

```bash
pnpm run typecheck
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/views/SharesView.vue src/router.ts src/App.vue src/styles.css
git commit -m "feat: add share management page"
```

---

### Task 6: Add Public Share Views

**Files:**
- Create: `src/views/PublicShareView.vue`
- Modify: `src/router.ts`
- Modify: `src/components/readers/MarkdownReader.vue`

**Step 1: Add public route**

In `src/router.ts`:

```ts
import PublicShareView from './views/PublicShareView.vue'
```

Add route without `requiresAuth`:

```ts
{ path: '/share/:token', component: PublicShareView },
```

**Step 2: Create public share view**

Create `src/views/PublicShareView.vue` that:
- Reads `token` from route.
- Calls `/api/public/shares/:token`.
- If target is a file, renders the same reader component as `ReaderView.vue` with content URL `/api/public/shares/:token/files/:fileId/content`.
- If target is a folder, calls `/api/public/shares/:token/folder` and renders a read-only list of files. Clicking a file sets `selectedFile` and renders the reader below or navigates to `?file=<id>`.
- Shows expiration time using `formatDate`.
- Does not show admin edit controls.

Use the same `readerComponent` MIME routing from `ReaderView.vue`. Keep it local for now; extract later only if duplication becomes painful.

**Step 3: Disable Markdown editing for anonymous shares**

Modify `src/components/readers/MarkdownReader.vue` props:

```ts
const props = withDefaults(defineProps<{
  file: SharedFile
  contentUrl: string
  readonly?: boolean
}>(), {
  readonly: false,
})
```

Update:

```ts
const isAdmin = computed(() => !props.readonly && auth.user?.role === 'admin')
const editing = ref(route.query.edit === '1' && isAdmin.value)
```

In `PublicShareView.vue`, pass `readonly`.

**Step 4: Verify anonymous routing**

Run:

```bash
pnpm run typecheck
```

Manual check after implementation:

```bash
pnpm run dev:worker
pnpm run dev
```

Open a public share URL in a private browser window. Expected: no redirect to `/login`; content loads.

**Step 5: Commit**

```bash
git add src/views/PublicShareView.vue src/router.ts src/components/readers/MarkdownReader.vue
git commit -m "feat: add public share viewing"
```

---

### Task 7: Update Documentation and Final Verification

**Files:**
- Modify: `README.md`

**Step 1: Update feature list**

Add:

```md
- 支持文件和文件夹生成公开分享链接，必须设置天/小时有效期，默认 1 天。
- 管理员可查看当前有效分享并取消分享。
```

**Step 2: Add migration note**

In local development section, mention:

```bash
pnpm run db:migrate:local
```

must be rerun after pulling this feature.

**Step 3: Full verification**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Expected: all pass.

**Step 4: Manual acceptance checklist**

Verify:

- Admin can create a file share with default `1 天`.
- Admin can create a folder share with `小时`.
- Public file share opens without login.
- Public folder share opens without login and lists files.
- Expired share returns “分享不存在或已过期”.
- Cancelled share disappears from `/shares`.
- Cancelled public URL no longer works.
- Ordinary authenticated user cannot call `/api/shares`.

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document public sharing"
```

---

## Notes and Decisions

- Share expiration is mandatory. UI defaults to `1 天`; API rejects non-positive or unknown units.
- Public shares are bearer links. Anyone with the URL can read until expiry or cancellation.
- Public folder sharing initially exposes direct files in that folder. If recursive folder sharing is needed, add it as a follow-up with explicit UI for nested folders.
- Public reading does not bypass trash/deleted state. If the target is trashed or deleted, the share becomes unavailable.
- Public sharing is read-only. Markdown editing remains admin-only and disabled for anonymous share routes.
