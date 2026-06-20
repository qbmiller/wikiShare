export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  expires_at: number | null
  disabled_at?: number | null
  created_at?: number
  last_login_at?: number | null
}

export interface PaginatedUsers {
  items: User[]
  total: number
  page: number
  pageSize: number
}

export interface Folder {
  id: string
  parent_id: string | null
  name: string
  depth: number
  expires_at: number | null
  trashed_at?: number | null
  created_at: number
  path?: string
  file_count?: number
}

export interface SharedFile {
  id: string
  folder_id: string
  name: string
  size: number
  mime_type: string
  sha256: string | null
  expires_at: number | null
  trashed_at?: number | null
  created_at: number
  path?: string
}

export interface PaginatedFiles {
  items: SharedFile[]
  total: number
  page: number
  pageSize: number
}

export type PdfFile = SharedFile

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

export interface PublicShareFile {
  share: PublicShareMetadata
  file: SharedFile
}

export interface PublicShareFolder {
  share: PublicShareMetadata
  folder: Folder
  files: SharedFile[]
}

export interface ApiError {
  error?: {
    code: string
    message: string
  }
}

export interface AuditLog {
  id: string
  user_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  ip: string | null
  user_agent: string | null
  detail: string | null
  created_at: number
}
