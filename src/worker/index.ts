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
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

interface SupportedFileType {
  kind: string
  extensions: string[]
  mimeTypes: string[]
  contentType: string
  r2Extension: string
  validate: (bytes: ArrayBuffer, mimeType: string) => boolean
}

const SUPPORTED_FILE_TYPES: SupportedFileType[] = [
  {
    kind: 'pdf',
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    contentType: 'application/pdf',
    r2Extension: 'pdf',
    validate: isPdf,
  },
  {
    kind: 'markdown',
    extensions: ['.md', '.markdown'],
    mimeTypes: ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream'],
    contentType: 'text/markdown; charset=utf-8',
    r2Extension: 'md',
    validate: isMarkdown,
  },
  {
    kind: 'image',
    extensions: ['.jpg', '.jpeg'],
    mimeTypes: ['image/jpeg'],
    contentType: 'image/jpeg',
    r2Extension: 'jpg',
    validate: isJpeg,
  },
  {
    kind: 'image',
    extensions: ['.png'],
    mimeTypes: ['image/png'],
    contentType: 'image/png',
    r2Extension: 'png',
    validate: isPng,
  },
  {
    kind: 'image',
    extensions: ['.webp'],
    mimeTypes: ['image/webp'],
    contentType: 'image/webp',
    r2Extension: 'webp',
    validate: isWebp,
  },
  {
    kind: 'image',
    extensions: ['.gif'],
    mimeTypes: ['image/gif'],
    contentType: 'image/gif',
    r2Extension: 'gif',
    validate: isGif,
  },
  {
    kind: 'presentation',
    extensions: ['.ppt'],
    mimeTypes: ['application/vnd.ms-powerpoint', 'application/octet-stream'],
    contentType: 'application/vnd.ms-powerpoint',
    r2Extension: 'ppt',
    validate: isOleCompoundFile,
  },
  {
    kind: 'presentation',
    extensions: ['.pptx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream'],
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    r2Extension: 'pptx',
    validate: isZipPackage,
  },
  {
    kind: 'document',
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'],
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    r2Extension: 'docx',
    validate: isZipPackage,
  },
  {
    kind: 'spreadsheet',
    extensions: ['.xls'],
    mimeTypes: ['application/vnd.ms-excel', 'application/octet-stream'],
    contentType: 'application/vnd.ms-excel',
    r2Extension: 'xls',
    validate: isOleCompoundFile,
  },
  {
    kind: 'spreadsheet',
    extensions: ['.xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'],
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    r2Extension: 'xlsx',
    validate: isZipPackage,
  },
]

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
  const query = c.req.query('q')?.trim() ?? ''
  const page = clampInt(c.req.query('page'), 1, 1, 100000)
  const pageSize = clampInt(c.req.query('pageSize'), 20, 1, 100)
  const offset = (page - 1) * pageSize
  const whereSql = query ? " where username like ? escape '\\'" : ''
  const queryParam = `%${escapeLike(query)}%`
  const countStatement = c.env.DB.prepare(`select count(*) as count from users${whereSql}`)
  const rowsStatement = c.env.DB.prepare(
    `select id, username, role, expires_at, disabled_at, created_at, last_login_at
     from users${whereSql}
     order by created_at desc
     limit ? offset ?`,
  )

  const countResult = query ? await countStatement.bind(queryParam).first<{ count: number }>() : await countStatement.first<{ count: number }>()
  const rowsResult = query
    ? await rowsStatement.bind(queryParam, pageSize, offset).all()
    : await rowsStatement.bind(pageSize, offset).all()

  return c.json({
    items: rowsResult.results,
    total: countResult?.count ?? 0,
    page,
    pageSize,
  })
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
  const now = nowSeconds()
  const folders = await c.env.DB.prepare(
    `select folders.*, count(files.id) as file_count
     from folders
     left join files
       on files.folder_id = folders.id
      and files.trashed_at is null
      and files.deleted_at is null
      and (files.expires_at is null or files.expires_at > ?)
     where folders.trashed_at is null
     group by folders.id
     order by folders.depth, folders.name`,
  )
    .bind(now)
    .all<FolderRecord & { file_count: number }>()
  return c.json(filterVisibleFolders(folders.results, now))
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
  const body = await c.req.json<{ name?: string; expiresAt?: number | null; parentId?: string | null }>()
  const folder = await getFolder(c.env, id)
  if (!folder || folder.trashed_at) {
    return jsonError(c, 404, 'folder_not_found', '文件夹不存在。')
  }

  if ('parentId' in body) {
    const moveResult = await moveFolderTree(c.env, folder, body.parentId ?? null)
    if (moveResult) {
      return jsonError(c, moveResult.status, moveResult.code, moveResult.message)
    }
  }

  await c.env.DB.prepare('update folders set name = coalesce(?, name), expires_at = ? where id = ?')
    .bind(body.name?.trim() || null, 'expiresAt' in body ? body.expiresAt ?? null : folder.expires_at, id)
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
    return jsonError(c, 400, 'invalid_upload', '请选择目标文件夹和文件。')
  }
  const maxUploadBytes = getMaxUploadBytes(c.env)
  if (file.size > maxUploadBytes) {
    return jsonError(c, 413, 'file_too_large', `单个文件不能超过 ${formatBytes(maxUploadBytes)}。`)
  }
  if (!(await isFolderAvailable(c.env, folderId))) {
    return jsonError(c, 404, 'folder_unavailable', '目标文件夹不存在或不可访问。')
  }

  const bytes = await file.arrayBuffer()
  const fileType = detectSupportedFileType(file.name, file.type, bytes)
  if (!fileType) {
    return jsonError(c, 400, 'unsupported_file_type', '只允许上传 PDF、Markdown、图片或 PPT 文件。')
  }

  const id = newId()
  const r2Key = `active/default/${id}.${fileType.r2Extension}`
  const sha256 = await sha256Hex(bytes)
  await c.env.PDF_BUCKET.put(r2Key, bytes, {
    httpMetadata: {
      contentType: fileType.contentType,
    },
    customMetadata: {
      fileId: id,
      uploadedBy: c.get('user').id,
      sha256,
      kind: fileType.kind,
    },
  })
  await c.env.DB.prepare(
    `insert into files(id, folder_id, name, r2_key, size, mime_type, sha256, expires_at, trashed_at, deleted_at, uploaded_by, created_at)
     values (?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)`,
  )
    .bind(id, folderId, file.name || `${id}.${fileType.r2Extension}`, r2Key, bytes.byteLength, fileType.contentType, sha256, c.get('user').id, nowSeconds())
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'file_uploaded', targetType: 'file', targetId: id, detail: { size: bytes.byteLength } })
  return c.json({ id, name: file.name, size: bytes.byteLength }, 201)
})

app.post('/api/files/markdown', requireAdmin, async (c) => {
  const body = await c.req.json<{ folderId?: string; name?: string; content?: string }>()
  const folderId = body.folderId ?? ''
  if (!folderId || !(await isFolderAvailable(c.env, folderId))) {
    return jsonError(c, 404, 'folder_unavailable', '目标文件夹不存在或不可访问。')
  }

  const name = normalizeMarkdownFileName(body.name)
  if (!name) {
    return jsonError(c, 400, 'invalid_file_name', 'Markdown 文件名不能为空。')
  }

  const content = body.content ?? ''
  const bytes = encodeUtf8(content)
  if (bytes.byteLength > getMaxUploadBytes(c.env)) {
    return jsonError(c, 413, 'file_too_large', `单个文件不能超过 ${formatBytes(getMaxUploadBytes(c.env))}。`)
  }

  const id = newId()
  const r2Key = `active/default/${id}.md`
  const sha256 = await sha256Hex(bytes)
  await c.env.PDF_BUCKET.put(r2Key, bytes, {
    httpMetadata: {
      contentType: 'text/markdown; charset=utf-8',
    },
    customMetadata: {
      fileId: id,
      uploadedBy: c.get('user').id,
      sha256,
      kind: 'markdown',
    },
  })
  await c.env.DB.prepare(
    `insert into files(id, folder_id, name, r2_key, size, mime_type, sha256, expires_at, trashed_at, deleted_at, uploaded_by, created_at)
     values (?, ?, ?, ?, ?, 'text/markdown; charset=utf-8', ?, null, null, null, ?, ?)`,
  )
    .bind(id, folderId, name, r2Key, bytes.byteLength, sha256, c.get('user').id, nowSeconds())
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'markdown_created', targetType: 'file', targetId: id, detail: { size: bytes.byteLength } })
  return c.json({ id, name, size: bytes.byteLength }, 201)
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

app.put('/api/files/:id/content', requireAdmin, async (c) => {
  const id = c.req.param('id') ?? ''
  const file = await getFile(c.env, id)
  if (!file || file.deleted_at || file.trashed_at) {
    return jsonError(c, 404, 'file_not_found', '文件不存在。')
  }
  if (!file.mime_type.startsWith('text/markdown')) {
    return jsonError(c, 400, 'unsupported_file_type', '当前只支持编辑 Markdown 文件。')
  }

  const body = await c.req.json<{ content?: string }>()
  const content = body.content ?? ''
  const bytes = encodeUtf8(content)
  if (bytes.byteLength > getMaxUploadBytes(c.env)) {
    return jsonError(c, 413, 'file_too_large', `单个文件不能超过 ${formatBytes(getMaxUploadBytes(c.env))}。`)
  }

  const sha256 = await sha256Hex(bytes)
  await c.env.PDF_BUCKET.put(file.r2_key, bytes, {
    httpMetadata: {
      contentType: 'text/markdown; charset=utf-8',
    },
    customMetadata: {
      fileId: file.id,
      uploadedBy: file.uploaded_by,
      sha256,
      kind: 'markdown',
    },
  })
  await c.env.DB.prepare('update files set size = ?, sha256 = ?, mime_type = ? where id = ?')
    .bind(bytes.byteLength, sha256, 'text/markdown; charset=utf-8', id)
    .run()
  await audit(c.env, { userId: c.get('user').id, action: 'markdown_updated', targetType: 'file', targetId: id, detail: { size: bytes.byteLength } })
  return c.json({ ok: true, size: bytes.byteLength, sha256 })
})

app.get('/api/files/:id/content', async (c) => {
  const file = await getReadableFile(c.env, c.req.param('id'))
  if (!file) {
    return jsonError(c, 404, 'file_unavailable', '文件不存在或不可访问。')
  }

  const head = await c.env.PDF_BUCKET.head(file.r2_key)
  if (!head) {
    return jsonError(c, 404, 'object_missing', '文件对象不存在。')
  }

  const contentType = normalizeStoredContentType(file.mime_type)
  const range = parseRange(c.req.header('Range') ?? null, head.size)
  const dispositionType = c.req.query('download') === '1' ? 'attachment' : 'inline'
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': contentDisposition(dispositionType, file.name),
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
    return jsonError(c, 404, 'object_missing', '文件对象不存在。')
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
  const allFolders = await c.env.DB.prepare('select * from folders').all<FolderRecord>()
  const folders = await c.env.DB.prepare('select * from folders where trashed_at is not null order by trashed_at desc').all<FolderRecord>()
  const files = await c.env.DB.prepare('select * from files where trashed_at is not null and deleted_at is null order by trashed_at desc').all<FileRecord>()
  const folderPathMap = buildFolderPathMap(allFolders.results)

  return c.json({
    folders: folders.results.map((folder) => ({
      ...folder,
      path: folderPathMap.get(folder.id) ?? folder.name,
    })),
    files: files.results.map((file) => ({
      ...file,
      path: joinPath(folderPathMap.get(file.folder_id), file.name),
    })),
  })
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

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(parsed, min), max)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
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

function buildFolderPathMap(folders: FolderRecord[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const paths = new Map<string, string>()

  const resolve = (folder: FolderRecord, visiting = new Set<string>()): string => {
    const existing = paths.get(folder.id)
    if (existing) {
      return existing
    }
    if (visiting.has(folder.id)) {
      return folder.name
    }

    visiting.add(folder.id)
    const parent = folder.parent_id ? byId.get(folder.parent_id) : null
    const path = parent ? joinPath(resolve(parent, visiting), folder.name) : folder.name
    visiting.delete(folder.id)
    paths.set(folder.id, path)
    return path
  }

  for (const folder of folders) {
    resolve(folder)
  }

  return paths
}

function joinPath(parentPath: string | undefined, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name
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

function isMarkdown(bytes: ArrayBuffer): boolean {
  const sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, Math.min(bytes.byteLength, 4096)))
  return !sample.includes('\u0000')
}

function isJpeg(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes.slice(0, 3))
  return view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff
}

function isPng(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes.slice(0, 8))
  return view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47 && view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a
}

function isWebp(bytes: ArrayBuffer): boolean {
  const header = new TextDecoder().decode(bytes.slice(0, 12))
  return header.startsWith('RIFF') && header.endsWith('WEBP')
}

function isGif(bytes: ArrayBuffer): boolean {
  const header = new TextDecoder().decode(bytes.slice(0, 6))
  return header === 'GIF87a' || header === 'GIF89a'
}

function isOleCompoundFile(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes.slice(0, 8))
  return view[0] === 0xd0 && view[1] === 0xcf && view[2] === 0x11 && view[3] === 0xe0 && view[4] === 0xa1 && view[5] === 0xb1 && view[6] === 0x1a && view[7] === 0xe1
}

function isZipPackage(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes.slice(0, 4))
  return view[0] === 0x50 && view[1] === 0x4b && (view[2] === 0x03 || view[2] === 0x05 || view[2] === 0x07) && (view[3] === 0x04 || view[3] === 0x06 || view[3] === 0x08)
}

function detectSupportedFileType(name: string, mimeType: string, bytes: ArrayBuffer) {
  const lowerName = name.toLowerCase()
  return SUPPORTED_FILE_TYPES.find((fileType) => {
    const extensionMatched = fileType.extensions.some((extension) => lowerName.endsWith(extension))
    const mimeMatched = !mimeType || fileType.mimeTypes.includes(mimeType)
    return extensionMatched && mimeMatched && fileType.validate(bytes, mimeType)
  }) ?? null
}

function normalizeStoredContentType(mimeType: string): string {
  if (mimeType.startsWith('text/markdown')) {
    return 'text/markdown; charset=utf-8'
  }
  return mimeType || 'application/octet-stream'
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const fallbackName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  return `${type}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

function normalizeMarkdownFileName(name: string | undefined): string {
  const trimmed = name?.trim().replace(/[\\/:*?"<>|]/g, '-') ?? ''
  if (!trimmed) {
    return ''
  }
  return /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`
}

function encodeUtf8(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function getMaxUploadBytes(env: Pick<Env, 'MAX_UPLOAD_BYTES'>): number {
  const configured = Number.parseInt(env.MAX_UPLOAD_BYTES ?? '', 10)
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_UPLOAD_BYTES
  }
  return configured
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.ceil(size / 1024)}KB`
  }
  return `${Math.ceil(size / 1024 / 1024)}MB`
}

async function moveFolderTree(
  env: Env,
  folder: FolderRecord,
  parentId: string | null,
): Promise<{ status: 400 | 404; code: string; message: string } | null> {
  if (folder.parent_id === parentId) {
    return null
  }

  const folders = await env.DB.prepare('select * from folders where trashed_at is null').all<FolderRecord>()
  const byId = new Map(folders.results.map((item) => [item.id, item]))
  const parent = parentId ? byId.get(parentId) : null

  if (parentId && !parent) {
    return { status: 404, code: 'parent_not_found', message: '上级文件夹不存在。' }
  }

  const subtreeIds = new Set<string>([folder.id])
  let changed = true
  while (changed) {
    changed = false
    for (const item of folders.results) {
      if (item.parent_id && subtreeIds.has(item.parent_id) && !subtreeIds.has(item.id)) {
        subtreeIds.add(item.id)
        changed = true
      }
    }
  }

  if (parentId && subtreeIds.has(parentId)) {
    return { status: 400, code: 'invalid_parent', message: '不能移动到自己或下级文件夹中。' }
  }

  const targetDepth = parent ? parent.depth + 1 : 1
  const depthDelta = targetDepth - folder.depth
  const maxDepth = Math.max(...folders.results.filter((item) => subtreeIds.has(item.id)).map((item) => item.depth + depthDelta))
  if (maxDepth > 3) {
    return { status: 400, code: 'max_depth_exceeded', message: '文件夹最多只能嵌套 3 级。' }
  }

  await env.DB.batch(
    folders.results
      .filter((item) => subtreeIds.has(item.id))
      .map((item) => {
        if (item.id === folder.id) {
          return env.DB.prepare('update folders set parent_id = ?, depth = ? where id = ?').bind(parentId, item.depth + depthDelta, item.id)
        }
        return env.DB.prepare('update folders set depth = ? where id = ?').bind(item.depth + depthDelta, item.id)
      }),
  )

  return null
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
