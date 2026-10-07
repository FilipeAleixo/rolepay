/**
 * The dashboard's cookies. On https they are Secure and `__Host-` prefixed (the browser then
 * refuses them from any other host or path, and without Secure); on http://localhost neither
 * is possible, so they are plain. Always HttpOnly and SameSite=Lax: Lax so the cookie comes back
 * on the top-level redirect from Discord, never on a cross-site POST.
 */
export type CookieNames = { session: string; state: string; secure: boolean }

export function cookieNames(origin: string): CookieNames {
  const secure = new URL(origin).protocol === 'https:'
  const prefix = secure ? '__Host-' : ''
  return { session: `${prefix}rolepay_session`, state: `${prefix}rolepay_oauth_state`, secure }
}

/** One Set-Cookie value. `maxAge` 0 deletes it. Path is always / (required by __Host-). */
export function setCookie(name: string, value: string, opts: { maxAge: number; secure: boolean }): string {
  return [`${name}=${value}`, 'Path=/', `Max-Age=${opts.maxAge}`, 'HttpOnly', 'SameSite=Lax', ...(opts.secure ? ['Secure'] : [])].join('; ')
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}
