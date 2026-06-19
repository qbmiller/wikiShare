export function jsonError(_context: unknown, status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) {
    return null
  }

  for (const item of header.split(';')) {
    const [rawKey, ...rawValue] = item.trim().split('=')
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='))
    }
  }
  return null
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `cfshare_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}

export function clearSessionCookie(): string {
  return 'cfshare_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
}
