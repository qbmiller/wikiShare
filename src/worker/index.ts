import { Hono, type Context, type Next } from 'hono'
import { hashPassword, newId, nowSeconds, randomToken, sha256Hex, verifyPassword } from './crypto.js'
import { audit, countUsers, filterVisibleFolders, getEffectiveFolderExpiration, getFile, getFolder, getSessionUser, getUserByUsername, isFileReadable, isFolderAvailable } from './db.js'
import { clearSessionCookie, getCookie, jsonError, sessionCookie } from './http.js'
import { parseRange } from './range.js'
import type { Env, FileRecord, FolderRecord, R2ObjectBody, ScheduledController, SessionUser, UserRecord } from './types.js'

type Variables = {
  user: SessionUser
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

app.get('/api/health', (c) => c.json({ ok: true, service: 'cfshare' }))

app.post('/api/setup/admin', async (c) => {
  if ((await countUsers(c.env)) > 0) {
    return jsonError(c, 409, 'setup_disabled', '系统已创建用户，初始化入口已关闭。')
  }

  const body = await c.req.json<{ username?: string; password?: string; expiresAt?: number | null }>()
  const username = normalizeUsername(body.username)
  if (!username || !body.password || body.password.length < 8) {
    return jsonError(c, 400, 'invalid_setup', '用户名必填，密码至少 8 位。')
  }

  const id = newId()
  const createdAt = nowSeconds()
  await c.env.DB.prepare(
    `insert into users(id, username, password_hash, role, expires_at, disabled_at, created_at, last_login_at)
     values (?, ?, ?, 'admin', ?, null, ?, null)`,
  )
    .bind(id, username, await hashPassword(body.password), body.expiresAt ?? null, createdAt)
    .run()

  await audit(c.env, {
    userId: id,
    action: 'setup_admin_created',
    targetType: 'user',
    targetId: id,
    ip: c.req.header('CF-Connecting-IP') ?? null,
    userAgent: c.req.header('User-Agent') ?? null,
  })

  return c.json({ id, username, role: 'admin' }, 201)
})

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>()
  const username = normalizeUsername(body.username)
  const user = username ? await getUserByUsername(c.env, username) : null
  const valid = user && body.password ? await verifyPassword(body.password, user.password_hash) : false
  const now = nowSeconds()

  if (!user || !valid || user.disabled_at || (user.expires_at != null && user.expires_at <= now)) {
    await audit(c.env, {
      action: 'login_failed',
      detail: { username },
      ip: c.req.header('CF-Connecting-IP') ?? null,
      userAgent: c.req.header('User-Agent') ?? null,
    })
    return jsonError(c, 401, 'invalid_credentials', '账号或密码错误，或账号不可用。')
  }

  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  await c.env.DB.batch([
    c.env.DB.prepare('update users set last_login_at = ? where id = ?').bind(now, user.id),
    c.env.DB.prepare('insert into sessions(id, user_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)').bind(
      newId(),
      user.id,
      tokenHash,
      now + SESSION_TTL_SECONDS,
      now,
    ),
  ])

  await audit(c.env, {
    userId: user.id,
    action: 'login_success',
    ip: c.req.header('CF-Connecting-IP') ?? null,
    userAgent: c.req.header('User-Agent') ?? null,
  })

  c.header('Set-Cookie', sessionCookie(token, SESSION_TTL_SECONDS))
  return c.json(publicUser(user))
})

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c.req.raw, 'cfshare_session')
  if (token) {
    await c.env.DB.prepare('delete from sessions where token_hash = ?').bind(await sha256Hex(token)).run()
  }
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/auth/login' || c.req.path === '/api/setup/admin') {
    return await next()
  }

  const token = getCookie(c.req.raw, 'cfshare_session')
  const user = token ? await getSessionUser(c.env, await sha256Hex(token)) : null
  if (!user) {
    return jsonError(c, 401, 'unauthorized', '请先登录。')
  }

  c.set('user', user)
  await next()
})

app.get('/api/auth/me', (c) => c.json(c.get('user')))

app.post('/api/auth/change-password', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ oldPassword?: string; newPassword?: string }>()
  if (!body.oldPassword || !body.newPassword || body.newPassword.length < 8) {
    return jsonError(c, 400, 'invalid_password', '新密码至少 8 位。')
  }

  const record = await c.env.DB.prepare('select * from users where id = ?').bind(user.id).first<UserRecord>()
  if (!record || !(await verifyPassword(body.oldPassword, record.password_hash))) {
    return jsonError(c, 403, 'password_mismatch', '原密码错误。')
  }

  await c.env.DB.prepare('update users set password_hash = ? where id = ?').bind(await hashPassword(body.newPassword), user.id).run()
  await audit(c.env, { userId: user.id, action: 'password_changed', targetType: 'user', targetId: user.id })
  return c.json({ ok: true })
})

app.get('/api/users', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    'select id, username, role, expires_at, disabled_at, created_at, last_login_at from users order by created_at desc',
  ).all()
  return c.json(rows.results)
})

app.post('/api/users', requireAdmin, async (c) => {
  const body = await c.req.json<{ username?: string; password?: string; role?: 'admin' | 'user'; expiresAt?: number | null }>()
  const username = normalizeUsername(body.username)
  if (!username || !body.password || body.password.length < 8) {
    return jsonError(c, 400, 'invalid_user', '用户名必填，密码至少 8 位。')
  }

  const id = newId()
  await c.env.DB.prepare(
    `insert into users(id, username, password_hash, role, expires_at, disabled_at, created_at, last_login_at)
     values (?, ?, ?, ?, ?, null, ?, null)`,
  )
    .bind(id, username, await hashPassword(body.password), body.role === 'admin' ? 'admin' : 'user', body.expiresAt ?? null, nowSeconds())
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'user_created', targetType: 'user', targetId: id })
  return c.json({ id, username }, 201)
})

app.patch('/api/users/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ role?: 'admin' | 'user'; expiresAt?: number | null; disabled?: boolean }>()
  const existing = await c.env.DB.prepare('select disabled_at from users where id = ?').bind(id).first<{ disabled_at: number | null }>()
  const disabledAt = body.disabled === true ? existing?.disabled_at ?? nowSeconds() : body.disabled === false ? null : existing?.disabled_at ?? null
  await c.env.DB.prepare('update users set role = coalesce(?, role), expires_at = ?, disabled_at = ? where id = ?')
    .bind(body.role ?? null, body.expiresAt ?? null, disabledAt, id)
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'user_updated', targetType: 'user', targetId: id })
  return c.json({ ok: true })
})

app.post('/api/users/:id/reset-password', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ password?: string }>()
  if (!body.password || body.password.length < 8) {
    return jsonError(c, 400, 'invalid_password', '密码至少 8 位。')
  }
  await c.env.DB.prepare('update users set password_hash = ? where id = ?').bind(await hashPassword(body.password), id).run()
  await audit(c.env, { userId: c.get('user').id, action: 'password_reset', targetType: 'user', targetId: id })
  return c.json({ ok: true })
})

app.get('/api/folders/tree', async (c) => {
  const folders = await c.env.DB.prepare(
    `select * from folders
     where trashed_at is null
     order by depth, name`,
  )
    .all<FolderRecord>()
  return c.json(filterVisibleFolders(folders.results, nowSeconds()))
})

app.post('/api/folders', async (c) => {
  const body = await c.req.json<{ parentId?: string | null; name?: string; expiresAt?: number | null }>()
  const name = body.name?.trim()
  if (!name) {
    return jsonError(c, 400, 'invalid_folder', '文件夹名称不能为空。')
  }

  let depth = 1
  if (body.parentId) {
    const parent = await getFolder(c.env, body.parentId)
    if (!parent || parent.trashed_at) {
      return jsonError(c, 404, 'parent_not_found', '上级文件夹不存在。')
    }
    depth = parent.depth + 1
  }

  if (depth > 3) {
    return jsonError(c, 400, 'max_depth_exceeded', '文件夹最多只能嵌套 3 级。')
  }

  const id = newId()
  await c.env.DB.prepare(
    'insert into folders(id, parent_id, name, depth, expires_at, trashed_at, created_by, created_at) values (?, ?, ?, ?, ?, null, ?, ?)',
  )
    .bind(id, body.parentId ?? null, name, depth, body.expiresAt ?? null, c.get('user').id, nowSeconds())
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'folder_created', targetType: 'folder', targetId: id })
  return c.json({ id, name, depth }, 201)
})

app.patch('/api/folders/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; expiresAt?: number | null }>()
  await c.env.DB.prepare('update folders set name = coalesce(?, name), expires_at = ? where id = ?')
    .bind(body.name?.trim() || null, body.expiresAt ?? null, id)
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'folder_updated', targetType: 'folder', targetId: id })
  return c.json({ ok: true })
})

app.post('/api/folders/:id/trash', async (c) => {
  const id = c.req.param('id')
  await trashFolderTree(c.env, id)
  await audit(c.env, { userId: c.get('user').id, action: 'folder_trashed', targetType: 'folder', targetId: id })
  return c.json({ ok: true })
})

app.post('/api/folders/:id/restore', async (c) => {
  const id = c.req.param('id')
  await restoreFolderTree(c.env, id)
  await audit(c.env, { userId: c.get('user').id, action: 'folder_restored', targetType: 'folder', targetId: id })
  return c.json({ ok: true })
})

app.get('/api/folders/:id/files', async (c) => {
  const folderId = c.req.param('id')
  if (!(await isFolderAvailable(c.env, folderId))) {
    return jsonError(c, 404, 'folder_unavailable', '文件夹不存在或不可访问。')
  }

  const now = nowSeconds()
  const inheritedExpiration = await getEffectiveFolderExpiration(c.env, folderId)
  if (inheritedExpiration != null && inheritedExpiration <= now) {
    return jsonError(c, 404, 'folder_expired', '文件夹已过期。')
  }
  const files = await c.env.DB.prepare(
    `select * from files
     where folder_id = ?
       and trashed_at is null
       and deleted_at is null
       and (expires_at is null or expires_at > ?)
     order by created_at desc`,
  )
    .bind(folderId, now)
    .all()
  return c.json(files.results)
})

app.post('/api/files/upload', async (c) => {
  const form = await c.req.parseBody()
  const folderId = String(form.folderId ?? '')
  const file = form.file
  if (!folderId || !(file instanceof File)) {
    return jsonError(c, 400, 'invalid_upload', '请选择目标文件夹和 PDF 文件。')
  }
  if (!(await isFolderAvailable(c.env, folderId))) {
    return jsonError(c, 404, 'folder_unavailable', '目标文件夹不存在或不可访问。')
  }

  const bytes = await file.arrayBuffer()
  if (!isPdf(bytes, file.type)) {
    return jsonError(c, 400, 'invalid_pdf', '只允许上传 PDF 文件。')
  }

  const id = newId()
  const r2Key = `active/default/${id}.pdf`
  const sha256 = await sha256Hex(bytes)
  await c.env.PDF_BUCKET.put(r2Key, bytes, {
    httpMetadata: {
      contentType: 'application/pdf',
    },
    customMetadata: {
      fileId: id,
      uploadedBy: c.get('user').id,
      sha256,
    },
  })
  await c.env.DB.prepare(
    `insert into files(id, folder_id, name, r2_key, size, mime_type, sha256, expires_at, trashed_at, deleted_at, uploaded_by, created_at)
     values (?, ?, ?, ?, ?, 'application/pdf', ?, null, null, null, ?, ?)`,
  )
    .bind(id, folderId, file.name || `${id}.pdf`, r2Key, bytes.byteLength, sha256, c.get('user').id, nowSeconds())
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'file_uploaded', targetType: 'file', targetId: id, detail: { size: bytes.byteLength } })
  return c.json({ id, name: file.name, size: bytes.byteLength }, 201)
})

app.get('/api/files/:id/metadata', async (c) => {
  const file = await getReadableFile(c.env, c.req.param('id'))
  if (!file) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }
  return c.json(publicFile(file))
})

app.patch('/api/files/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; expiresAt?: number | null }>()
  const file = await getFile(c.env, id)
  if (!file || file.deleted_at) {
    return jsonError(c, 404, 'file_not_found', '文件不存在。')
  }

  await c.env.DB.prepare('update files set name = coalesce(?, name), expires_at = ? where id = ?')
    .bind(body.name?.trim() || null, body.expiresAt ?? null, id)
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'file_updated', targetType: 'file', targetId: id })
  return c.json({ ok: true })
})

app.get('/api/files/:id/content', async (c) => {
  const file = await getReadableFile(c.env, c.req.param('id'))
  if (!file) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }

  const head = await c.env.PDF_BUCKET.head(file.r2_key)
  if (!head) {
    return jsonError(c, 404, 'object_missing', 'PDF 对象不存在。')
  }

  const range = parseRange(c.req.header('Range') ?? null, head.size)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/pdf',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
  })

  let object: R2ObjectBody | null
  let status = 200
  if (range) {
    object = await c.env.PDF_BUCKET.get(file.r2_key, { range: { offset: range.offset, length: range.length } })
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${head.size}`)
    headers.set('Content-Length', String(range.length))
    status = 206
  } else {
    object = await c.env.PDF_BUCKET.get(file.r2_key)
    headers.set('Content-Length', String(head.size))
  }

  if (!object?.body) {
    return jsonError(c, 404, 'object_missing', 'PDF 对象不存在。')
  }

  await audit(c.env, { userId: c.get('user').id, action: 'file_read', targetType: 'file', targetId: file.id })
  return new Response(object.body, { status, headers })
})

app.post('/api/files/:id/trash', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('update files set trashed_at = ? where id = ? and deleted_at is null').bind(nowSeconds(), id).run()
  await audit(c.env, { userId: c.get('user').id, action: 'file_trashed', targetType: 'file', targetId: id })
  return c.json({ ok: true })
})

app.post('/api/files/:id/restore', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('update files set trashed_at = null where id = ? and deleted_at is null').bind(id).run()
  await audit(c.env, { userId: c.get('user').id, action: 'file_restored', targetType: 'file', targetId: id })
  return c.json({ ok: true })
})

app.delete('/api/files/:id', requireAdmin, async (c) => {
  const id = c.req.param('id') ?? ''
  const file = await getFile(c.env, id)
  if (!file) {
    return jsonError(c, 404, 'file_not_found', '文件不存在。')
  }
  await c.env.PDF_BUCKET.delete(file.r2_key)
  await c.env.DB.prepare('update files set deleted_at = ? where id = ?').bind(nowSeconds(), id).run()
  await audit(c.env, { userId: c.get('user').id, action: 'file_deleted', targetType: 'file', targetId: id })
  return c.json({ ok: true })
})

app.get('/api/trash', async (c) => {
  const folders = await c.env.DB.prepare('select * from folders where trashed_at is not null order by trashed_at desc').all()
  const files = await c.env.DB.prepare('select * from files where trashed_at is not null and deleted_at is null order by trashed_at desc').all()
  return c.json({ folders: folders.results, files: files.results })
})

app.post('/api/trash/cleanup', requireAdmin, async (c) => {
  const result = await cleanupTrash(c.env)
  await audit(c.env, { userId: c.get('user').id, action: 'trash_cleanup_requested', detail: result })
  return c.json(result)
})

app.get('/api/audit-logs', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare('select * from audit_logs order by created_at desc limit 300').all()
  return c.json(rows.results)
})

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw))

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await expireContent(env)
    await cleanupTrash(env)
  },
}

async function requireAdmin(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  if (c.get('user').role !== 'admin') {
    return jsonError(c, 403, 'forbidden', '需要管理员权限。')
  }
  await next()
}

function normalizeUsername(username: string | undefined): string {
  return username?.trim().toLowerCase() ?? ''
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    expires_at: user.expires_at,
    disabled_at: user.disabled_at,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
  }
}

function publicFile(file: FileRecord) {
  return {
    id: file.id,
    folder_id: file.folder_id,
    name: file.name,
    size: file.size,
    mime_type: file.mime_type,
    sha256: file.sha256,
    expires_at: file.expires_at,
    created_at: file.created_at,
  }
}

async function getReadableFile(env: Env, id: string): Promise<FileRecord | null> {
  const file = await getFile(env, id)
  if (!file || !(await isFileReadable(env, file))) {
    return null
  }
  return file
}

function isPdf(bytes: ArrayBuffer, mimeType: string): boolean {
  const header = new TextDecoder().decode(bytes.slice(0, 5))
  return header === '%PDF-' && (!mimeType || mimeType === 'application/pdf')
}

export async function trashFolderTree(env: Env, folderId: string, at = nowSeconds()): Promise<void> {
  await env.DB.prepare('update folders set trashed_at = ? where id = ?').bind(at, folderId).run()
  await env.DB.prepare(
    `update folders set trashed_at = ?
     where parent_id = ?
        or parent_id in (select id from folders where parent_id = ?)`,
  )
    .bind(at, folderId, folderId)
    .run()
  await env.DB.prepare(
    `update files set trashed_at = ?
     where deleted_at is null
       and (
         folder_id = ?
         or folder_id in (select id from folders where parent_id = ?)
         or folder_id in (select id from folders where parent_id in (select id from folders where parent_id = ?))
       )`,
  )
    .bind(at, folderId, folderId, folderId)
    .run()
}

export async function restoreFolderTree(env: Env, folderId: string): Promise<void> {
  await env.DB.prepare('update folders set trashed_at = null where id = ?').bind(folderId).run()
  await env.DB.prepare(
    `update folders set trashed_at = null
     where parent_id = ?
        or parent_id in (select id from folders where parent_id = ?)`,
  )
    .bind(folderId, folderId)
    .run()
  await env.DB.prepare(
    `update files set trashed_at = null
     where deleted_at is null
       and (
         folder_id = ?
         or folder_id in (select id from folders where parent_id = ?)
         or folder_id in (select id from folders where parent_id in (select id from folders where parent_id = ?))
       )`,
  )
    .bind(folderId, folderId, folderId)
    .run()
}

async function expireContent(env: Env): Promise<void> {
  const now = nowSeconds()
  const expiredFolders = await env.DB.prepare('select id from folders where trashed_at is null and expires_at is not null and expires_at <= ?')
    .bind(now)
    .all<{ id: string }>()
  for (const folder of expiredFolders.results) {
    await trashFolderTree(env, folder.id)
    await audit(env, { action: 'folder_expired', targetType: 'folder', targetId: folder.id })
  }

  const expiredFiles = await env.DB.prepare(
    'select id from files where deleted_at is null and trashed_at is null and expires_at is not null and expires_at <= ?',
  )
    .bind(now)
    .all<{ id: string }>()
  for (const file of expiredFiles.results) {
    await env.DB.prepare('update files set trashed_at = ? where id = ?').bind(now, file.id).run()
    await audit(env, { action: 'file_expired', targetType: 'file', targetId: file.id })
  }
}

async function cleanupTrash(env: Env): Promise<{ deleted: number; freedBytes: number }> {
  const now = nowSeconds()
  const retentionDays = Number.parseInt(env.TRASH_RETENTION_DAYS ?? '30', 10)
  const maxBytes = Number.parseInt(env.TRASH_MAX_BYTES ?? '21474836480', 10)
  const cutoff = now - retentionDays * 24 * 60 * 60
  const deleted = new Set<string>()
  let freedBytes = 0

  const oldFiles = await env.DB.prepare(
    'select * from files where deleted_at is null and trashed_at is not null and trashed_at <= ? order by trashed_at asc',
  )
    .bind(cutoff)
    .all<FileRecord>()

  for (const file of oldFiles.results) {
    freedBytes += await deleteFileObject(env, file)
    deleted.add(file.id)
  }

  const sizeRow = await env.DB.prepare(
    'select coalesce(sum(size), 0) as total from files where deleted_at is null and trashed_at is not null',
  ).first<{ total: number }>()
  let total = sizeRow?.total ?? 0

  if (total > maxBytes) {
    const overflowFiles = await env.DB.prepare(
      'select * from files where deleted_at is null and trashed_at is not null order by trashed_at asc',
    ).all<FileRecord>()
    for (const file of overflowFiles.results) {
      if (total <= maxBytes) {
        break
      }
      if (deleted.has(file.id)) {
        continue
      }
      freedBytes += await deleteFileObject(env, file)
      total -= file.size
      deleted.add(file.id)
    }
  }

  return { deleted: deleted.size, freedBytes }
}

async function deleteFileObject(env: Env, file: FileRecord): Promise<number> {
  await env.PDF_BUCKET.delete(file.r2_key)
  await env.DB.prepare('update files set deleted_at = ? where id = ?').bind(nowSeconds(), file.id).run()
  await audit(env, { action: 'file_deleted_by_cleanup', targetType: 'file', targetId: file.id, detail: { size: file.size } })
  return file.size
}
