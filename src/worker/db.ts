import { newId, nowSeconds } from './crypto.js'
import type { Env, FileRecord, FolderRecord, SessionUser, UserRecord } from './types.js'

export async function audit(
  env: Env,
  input: {
    userId?: string | null
    action: string
    targetType?: string | null
    targetId?: string | null
    ip?: string | null
    userAgent?: string | null
    detail?: unknown
  },
): Promise<void> {
  await env.DB.prepare(
    `insert into audit_logs(id, user_id, action, target_type, target_id, ip, user_agent, detail, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId(),
      input.userId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.ip ?? null,
      input.userAgent ?? null,
      input.detail == null ? null : JSON.stringify(input.detail),
      nowSeconds(),
    )
    .run()
}

export async function countUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare('select count(*) as count from users').first<{ count: number }>()
  return row?.count ?? 0
}

export async function getUserByUsername(env: Env, username: string): Promise<UserRecord | null> {
  return await env.DB.prepare('select * from users where username = ?').bind(username).first<UserRecord>()
}

export async function getSessionUser(env: Env, tokenHash: string, now = nowSeconds()): Promise<SessionUser | null> {
  return await env.DB.prepare(
    `select u.id, u.username, u.role, u.expires_at
     from sessions s
     join users u on u.id = s.user_id
     where s.token_hash = ?
       and s.expires_at > ?
       and u.disabled_at is null
       and (u.expires_at is null or u.expires_at > ?)`,
  )
    .bind(tokenHash, now, now)
    .first<SessionUser>()
}

export async function getFolder(env: Env, id: string): Promise<FolderRecord | null> {
  return await env.DB.prepare('select * from folders where id = ?').bind(id).first<FolderRecord>()
}

export async function getFile(env: Env, id: string): Promise<FileRecord | null> {
  return await env.DB.prepare('select * from files where id = ?').bind(id).first<FileRecord>()
}

export async function isFolderAvailable(env: Env, folderId: string, now = nowSeconds()): Promise<boolean> {
  let current = await getFolder(env, folderId)
  let guard = 0
  while (current && guard < 4) {
    if (current.trashed_at || isExpired(current.expires_at, now)) {
      return false
    }
    current = current.parent_id ? await getFolder(env, current.parent_id) : null
    guard += 1
  }
  return true
}

export async function getEffectiveFolderExpiration(env: Env, folderId: string): Promise<number | null> {
  let current = await getFolder(env, folderId)
  let guard = 0
  while (current && guard < 4) {
    if (current.expires_at != null) {
      return current.expires_at
    }
    current = current.parent_id ? await getFolder(env, current.parent_id) : null
    guard += 1
  }
  return null
}

export async function isFileReadable(env: Env, file: FileRecord, now = nowSeconds()): Promise<boolean> {
  if (file.deleted_at || file.trashed_at || isExpired(file.expires_at, now)) {
    return false
  }
  return await isFolderAvailable(env, file.folder_id, now)
}

export function filterVisibleFolders(folders: FolderRecord[], now = nowSeconds()): FolderRecord[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))

  return folders.filter((folder) => {
    let current: FolderRecord | undefined = folder
    let guard = 0
    while (current && guard < 4) {
      if (current.trashed_at || isExpired(current.expires_at, now)) {
        return false
      }
      current = current.parent_id ? byId.get(current.parent_id) : undefined
      guard += 1
    }
    return true
  })
}

function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt != null && expiresAt <= now
}
