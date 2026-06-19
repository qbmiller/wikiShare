import type { ApiError } from './types'

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  })

  if (!response.ok) {
    let message = `请求失败：${response.status}`
    try {
      const data = (await response.json()) as ApiError
      message = data.error?.message ?? message
    } catch {
      // ignore non-json errors
    }
    throw new Error(message)
  }

  return (await response.json()) as T
}

