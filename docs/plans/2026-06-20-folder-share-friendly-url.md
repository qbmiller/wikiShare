# Folder Share Friendly URL Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix folder share viewing so the left side is a file list and the right side displays the clicked file, and add two-level public URLs like `/share/<uuid>/file_name`.

**Architecture:** Keep the existing opaque share token as the security boundary, but expose a stable UUID `url_id` for shorter public URLs. Store URL IDs on `shares`, resolve public routes by token or `url_id` for backward compatibility, and resolve optional file-name path segments to a file in the shared folder. The public folder view becomes a two-column reader layout with a stable file list on the left and the selected reader on the right.

**Tech Stack:** Vue 3 `<script setup>`, Vue Router, Hono Worker, Cloudflare D1, TypeScript.

---

### Task 1: Add Share URL ID Data Model

**Files:**
- Create: `migrations/0003_share_url_ids.sql`
- Modify: `src/types.ts`
- Modify: `src/worker/types.ts`

**Step 1: Add migration**

Create `migrations/0003_share_url_ids.sql`:

```sql
alter table shares add column url_id text;

create unique index if not exists idx_shares_url_id on shares(url_id)
where url_id is not null;
```

This is compatible with existing local/remote D1 databases. Existing shares keep working through `token`; new shares get `url_id`.

**Step 2: Update frontend share type**

In `src/types.ts`, add `url_id` and keep `public_url`:

```ts
export interface ShareRecord {
  id: string
  token: string
  url_id: string | null
  target_type: 'file' | 'folder'
  target_id: string
  target_name?: string
  expires_at: number
  cancelled_at: number | null
  created_by: string
  created_at: number
  public_url: string
}
```

Also add `url_id` to public metadata:

```ts
export interface PublicShareMetadata {
  token: string
  url_id: string | null
  target_type: 'file' | 'folder'
  target_id: string
  target_name: string
  expires_at: number
}
```

**Step 3: Update Worker share type**

In `src/worker/types.ts`, add:

```ts
url_id: string | null
```

to `ShareRecord`.

**Step 4: Verify**

Run:

```bash
pnpm run typecheck
```

Expected: pass.

---

### Task 2: Generate UUID Share URLs

**Files:**
- Modify: `src/worker/index.ts`
- Test: `scripts/test.mts`

**Step 1: Add URL ID helpers**

In `src/worker/index.ts`, export helper functions for tests:

```ts
export function buildShareUrlId(): string {
  return newId()
}

export function encodeSharePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '-')
}
```

**Step 2: Include URL ID in share creation**

In `/api/shares`, after target validation, keep the existing target validation. The public URL ID is a UUID and does not derive from the file or folder name.

Generate `url_id` and insert it:

```ts
const urlId = buildShareUrlId()
await c.env.DB.prepare(
  `insert into shares(id, token, url_id, target_type, target_id, expires_at, cancelled_at, created_by, created_at)
   values (?, ?, ?, ?, ?, ?, null, ?, ?)`,
)
  .bind(id, token, urlId, targetType, targetId, expiresAt, c.get('user').id, createdAt)
  .run()
```

**Step 3: Return UUID-based public URL**

Update:

```ts
function publicShareUrl(c: Context<{ Bindings: Env; Variables: Variables }>, share: Pick<ShareRecord, 'token' | 'url_id'>): string {
  const url = new URL(c.req.url)
  return `${url.origin}/share/${share.url_id ?? share.token}`
}
```

When creating:

```ts
return c.json({ id, token, urlId, publicUrl: publicShareUrl(c, { token, url_id: urlId }), expiresAt }, 201)
```

When listing:

```ts
public_url: publicShareUrl(c, share)
```

**Step 4: Add tests**

In `scripts/test.mts`, add:

```ts
const urlId = buildShareUrlId()
assert.match(urlId, /^[0-9a-f-]{36}$/)
```

Update import from `src/worker/index.js`.

**Step 5: Verify**

Run:

```bash
pnpm test
pnpm run typecheck
```

Expected: pass.

---

### Task 3: Resolve Public Shares by Token or URL ID

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/types.ts`

**Step 1: Update active share resolver**

Replace `getActiveShare(env, token)` with:

```ts
async function getActiveShare(env: Env, key: string): Promise<ShareRecord | null> {
  const now = nowSeconds()
  return await env.DB.prepare(
    `select * from shares
     where (token = ? or url_id = ?)
       and cancelled_at is null
       and expires_at > ?`,
  )
    .bind(key, key, now)
    .first<ShareRecord>()
}
```

**Step 2: Include URL ID in public metadata**

Update `publicShareMeta`:

```ts
function publicShareMeta(share: ShareRecord, targetName: string) {
  return {
    token: share.token,
    url_id: share.url_id,
    target_type: share.target_type,
    target_id: share.target_id,
    target_name: targetName,
    expires_at: share.expires_at,
  }
}
```

**Step 3: Add folder file lookup endpoint**

Add endpoint:

```ts
app.get('/api/public/shares/:key/files/by-name/:fileName', async (c) => {
  const share = await getActiveShare(c.env, c.req.param('key'))
  if (!share || share.target_type !== 'folder') {
    return jsonError(c, 404, 'share_unavailable', '分享不存在或已过期。')
  }
  const fileName = decodeURIComponent(c.req.param('fileName'))
  const file = await c.env.DB.prepare(
    `select * from files
     where folder_id = ?
       and name = ?
       and trashed_at is null
       and deleted_at is null
     limit 1`,
  )
    .bind(share.target_id, fileName)
    .first<FileRecord>()
  if (!file) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }
  return c.json(publicFile(file))
})
```

This endpoint lets `/share/<uuid>/file_name原样` open the matching file without exposing file IDs in the URL.

**Step 4: Verify**

Run:

```bash
pnpm run typecheck
```

Expected: pass.

---

### Task 4: Add Two-Level Public Route

**Files:**
- Modify: `src/router.ts`
- Modify: `src/views/PublicShareView.vue`

**Step 1: Update router**

Replace the current public share route:

```ts
{ path: '/share/:token', component: PublicShareView },
```

with:

```ts
{ path: '/share/:shareKey/:fileName?', component: PublicShareView },
```

Use `shareKey` instead of `token`; old `/share/<token>` links still match because `fileName` is optional.

**Step 2: Update `PublicShareView.vue` route state**

Rename:

```ts
const token = computed(() => String(route.params.token))
```

to:

```ts
const shareKey = computed(() => String(route.params.shareKey))
const routeFileName = computed(() => {
  const value = route.params.fileName
  return typeof value === 'string' && value ? value : ''
})
```

Use `shareKey` in API URLs.

**Step 3: Load selected file from URL**

In folder share loading:

```ts
if (routeFileName.value) {
  const file = await api<SharedFile>(`/api/public/shares/${shareKey.value}/files/by-name/${encodeURIComponent(routeFileName.value)}`)
  selectedFile.value = file
} else {
  selectedFile.value = folderResult.files[0] ?? null
}
```

**Step 4: Update content URL**

Use:

```ts
return `/api/public/shares/${shareKey.value}/files/${selectedFile.value.id}/content`
```

**Step 5: Update file click behavior**

Inject router:

```ts
const router = useRouter()
```

When selecting a folder file, push readable URL:

```ts
async function selectFile(file: SharedFile) {
  selectedFile.value = file
  await router.push(`/share/${share.value?.url_id ?? shareKey.value}/${encodeSharePathPart(file.name)}`)
}
```

Add local `encodeSharePathPart` or import if moved to shared frontend helper. Keep local:

```ts
function encodeSharePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '-')
}
```

**Step 6: React to route changes**

Because clicking files changes route params in the same component, add:

```ts
watch(() => route.params.fileName, () => {
  if (!loading.value && share.value?.target_type === 'folder') {
    void loadShare()
  }
})
```

Alternatively, only update `selectedFile` from already loaded `files` by matching decoded name. Prefer no extra network when file list is loaded:

```ts
watch(routeFileName, (name) => {
  if (!name || files.value.length === 0) return
  const decoded = decodeURIComponent(name)
  selectedFile.value = files.value.find((file) => file.name === decoded) ?? selectedFile.value
})
```

**Step 7: Verify**

Run:

```bash
pnpm run typecheck
```

Expected: pass.

---

### Task 5: Fix Folder Share Layout

**Files:**
- Modify: `src/views/PublicShareView.vue`
- Modify: `src/styles.css`

**Step 1: Replace folder share template layout**

For folder shares, replace current vertical list + reader with:

```vue
<div v-if="!loading && !error && share?.target_type === 'folder'" class="public-folder-layout">
  <aside class="public-folder-sidebar">
    <h2>{{ share.target_name }}</h2>
    <button
      v-for="file in files"
      :key="file.id"
      class="public-file-list-item"
      :class="{ active: selectedFile?.id === file.id }"
      type="button"
      @click="selectFile(file)"
    >
      <strong>{{ file.name }}</strong>
      <span>{{ formatSize(file.size) }} · {{ formatDate(file.expires_at) }}</span>
    </button>
  </aside>

  <main class="public-folder-reader">
    <component :is="readerComponent" v-if="selectedFile" :file="selectedFile" :content-url="contentUrl" readonly />
    <p v-else class="empty-state">分享中没有可查看文件。</p>
  </main>
</div>
```

For file shares, keep:

```vue
<component v-else-if="selectedFile && !error" ... />
```

This satisfies: “左侧是文件列表，点击某一个展示那个文件”.

**Step 2: Add CSS**

In `src/styles.css`, add:

```css
.public-folder-layout {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
  gap: 18px;
  padding: 0 30px 30px;
}

.public-folder-sidebar {
  position: sticky;
  top: 92px;
  display: grid;
  align-self: start;
  max-height: calc(100vh - 120px);
  gap: 8px;
  overflow: auto;
  border: 1px solid var(--docs-border);
  border-radius: 8px;
  padding: 14px;
  background: var(--docs-surface);
}

.public-folder-sidebar h2 {
  margin-bottom: 6px;
}

.public-file-list-item {
  display: grid;
  gap: 4px;
  width: 100%;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 10px;
  background: transparent;
  color: var(--docs-text);
  text-align: left;
}

.public-file-list-item:hover,
.public-file-list-item.active {
  border-color: var(--docs-accent);
  background: var(--docs-accent-soft);
}

.public-file-list-item strong,
.public-file-list-item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.public-file-list-item span {
  color: var(--docs-muted);
  font-size: 12px;
}

.public-folder-reader {
  min-width: 0;
}
```

Add mobile override:

```css
@media (max-width: 760px) {
  .public-folder-layout {
    grid-template-columns: 1fr;
    padding: 0 18px 18px;
  }

  .public-folder-sidebar {
    position: static;
    max-height: 280px;
  }
}
```

**Step 3: Verify**

Run:

```bash
pnpm run typecheck
pnpm run build
```

Expected: pass.

---

### Task 6: Update Share Link Display and Docs

**Files:**
- Modify: `src/views/DashboardView.vue`
- Modify: `src/views/SharesView.vue`
- Modify: `README.md`

**Step 1: Confirm created links use URL IDs**

No UI change should be needed if `/api/shares` returns `publicUrl` using `url_id`. Verify the popup displays `/share/<uuid>`.

**Step 2: Confirm share list uses URL IDs**

No UI change should be needed if `/api/shares` returns `public_url` using `url_id`.

**Step 3: Update README**

Add note:

```md
- 文件夹分享链接使用两级路径：`/share/<uuid>/文件名`，复制文件夹链接后也可在页面左侧点击文件切换阅读。
```

**Step 4: Final verification**

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Expected: all pass.

Manual checks:

- Old `/share/<token>` link still opens.
- New folder share URL looks like `/share/550e8400-e29b-41d4-a716-446655440000`.
- Clicking a file changes URL to `/share/550e8400-e29b-41d4-a716-446655440000/original-file-name.pdf`.
- Refreshing that two-level URL opens the same file.
- Left side remains a file list; right side changes reader content.

---

## Notes

- The folder/file URL is not the security boundary. The UUID `url_id` is stable and shorter than the token, while the existing token remains supported for compatibility.
- File names are URL-encoded. Slash characters are replaced to avoid accidental nested routes.
- Existing shares without `url_id` remain valid through token URLs, but share list will display token URLs for them until regenerated.
