import type { Clock, KeyValueStore, Rolepay } from '@rolepay/core'
import type { WebConfig } from '../config.js'
import { type CookieNames, cookieNames, readCookie } from './cookies.js'
import { CachedGuildMembers } from './members.js'
import type { AuditPort, PolicyPort } from './policyPort.js'
import type { DiscordOAuth, GuildMembers } from './ports.js'
import { type DashboardSession, DashboardSessionStore } from './sessions.js'

/** What the server gives the dashboard (apps/server builds it; tests use the fakes). */
export type DashboardDeps = {
  /** Sessions and sign-ins in progress (core's KeyValueStore: the SQLite file in production). */
  kv: KeyValueStore
  /** null when ROLEPAY_DISCORD_CLIENT_SECRET is not set: the dashboard says sign-in is not configured. */
  oauth: DiscordOAuth | null
  /** The bot's view of guild members (roles, display names). Cached briefly here. */
  members: GuildMembers
  /** The policy seam (see policyPort.ts). Absent: the Policies and Audit pages say they are not available. */
  policies?: PolicyPort
  audit?: AuditPort
  /** Unexpected errors (the page shows a generic message). Never given request data. */
  onError?: (error: unknown) => void
}

export type DashboardContext = DashboardDeps & { rolepay: Rolepay; clock: Clock; config: WebConfig; testnet: boolean }

/** Everything the dashboard's routes share: the session store, the cookies, the member cache, responses. */
export type DashboardKit = ReturnType<typeof dashboardKit>

export function dashboardKit(ctx: DashboardContext) {
  const store = new DashboardSessionStore(ctx.kv)
  const names: CookieNames = cookieNames(ctx.config.origin)
  return {
    ...ctx,
    store,
    names,
    members: new CachedGuildMembers(ctx.members, ctx.clock),
    redirectUri: `${ctx.config.origin}/auth/discord/callback`,
    /** The signed-in session this request carries, with its token, or null. */
    async session(req: Request): Promise<{ token: string; session: DashboardSession } | null> {
      const token = readCookie(req, names.session)
      if (!token) return null
      const session = await store.read(token)
      return session ? { token, session } : null
    },
  }
}

export const html = (body: string, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(body, { status, headers })
}

export const redirect = (location: string, status: 302 | 303, cookies: string[] = []) => {
  const headers = new Headers({ location })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(null, { status, headers })
}

/**
 * Where to go after signing in: a dashboard page on this origin, or the dashboard home. Nothing
 * else (no other site, no other page of ours), so the sign-in can never be an open redirect.
 */
export function safeNext(raw: string | undefined, origin: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/dashboard'
  if (!URL.canParse(raw, origin)) return '/dashboard'
  const url = new URL(raw, origin)
  if (url.origin !== origin || !(url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/'))) return '/dashboard'
  return url.pathname + url.search
}
