export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  expires_at: number | null
  disabled_at?: number | null
  created_at?: number
  last_login_at?: number | null
}

export interface Folder {
  id: string
  parent_id: string | null
  name: string
  depth: number
  expires_at: number | null
  trashed_at?: number | null
  created_at: number
}

export interface PdfFile {
  id: string
  folder_id: string
  name: string
  size: number
  mime_type: string
  sha256: string | null
  expires_at: number | null
  trashed_at?: number | null
  created_at: number
}

export interface ApiError {
  error?: {
    code: string
    message: string
  }
}

