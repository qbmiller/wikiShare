export interface Env {
  DB: D1Database
  PDF_BUCKET: R2Bucket
  ASSETS: Fetcher
  SESSION_SECRET?: string
  MAX_UPLOAD_BYTES?: string
  TRASH_RETENTION_DAYS?: string
  TRASH_MAX_BYTES?: string
}

export interface UserRecord {
  id: string
  username: string
  password_hash: string
  role: 'admin' | 'user'
  expires_at: number | null
  disabled_at: number | null
  created_at: number
  last_login_at: number | null
}

export interface SessionUser {
  id: string
  username: string
  role: 'admin' | 'user'
  expires_at: number | null
}

export interface FolderRecord {
  id: string
  parent_id: string | null
  name: string
  depth: number
  expires_at: number | null
  trashed_at: number | null
  created_by: string
  created_at: number
}

export interface FileRecord {
  id: string
  folder_id: string
  name: string
  r2_key: string
  size: number
  mime_type: string
  sha256: string | null
  expires_at: number | null
  trashed_at: number | null
  deleted_at: number | null
  uploaded_by: string
  created_at: number
}

export interface ShareRecord {
  id: string
  token: string
  url_id: string | null
  target_type: 'file' | 'folder'
  target_id: string
  expires_at: number
  cancelled_at: number | null
  created_by: string
  created_at: number
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
}

export interface D1Result<T = unknown> {
  results: T[]
  success: true
  meta: Record<string, unknown>
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    },
  ): Promise<R2Object>
  delete(key: string | string[]): Promise<void>
}

export interface R2Object {
  key: string
  size: number
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>
}

export interface ScheduledController {
  scheduledTime: number
  cron: string
}
