import type { Clock, KeyValueStore, Rolepay } from '@rolepay/core'
import type { WebConfig } from '../config.js'
import type { LiveStreams } from '../live/streams.js'
import { type CookieNames, cookieNames, readCookie } from './cookies.js'
import { CachedGuildMembers } from './members.js'
import type { AiUsagePort, AuditPort, PayoutsPort, PolicyKeysPort, PolicyPort } from './policyPort.js'
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
  /** The AI spend (policyPort.ts). Absent: the Overview, Audit log and policy pages leave it out. */
  aiUsage?: AiUsagePort
  /** What was paid each week (policyPort.ts). Absent: the Overview leaves that chart out. */
  payouts?: PayoutsPort
  /** Policies' own budgets (policyPort.ts). Absent: a policy's page leaves its budget out. */
  policyKeys?: PolicyKeysPort
  /** Unexpected errors (the page shows a generic message). Never given request data. */
  onError?: (error: unknown) => void
}

/** `live`: the server-sent event streams' limits (absent: the pages do not update live). */
export type DashboardContext = DashboardDeps & { rolepay: Rolepay; clock: Clock; config: WebConfig; testnet: boolean; live?: LiveStreams }

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

/**
 * Dashboard responses use Referrer-Policy `same-origin`, not the site-wide `no-referrer`: under
 * `no-referrer` a browser sends `Origin: null` on a form post, and the same-origin check (CSRF)
 * would refuse the dashboard's own forms. `same-origin` still sends nothing to any other site.
 */
const REFERRER = { 'referrer-policy': 'same-origin' }

export const html = (body: string, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', ...REFERRER })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(body, { status, headers })
}

export const redirect = (location: string, status: 302 | 303, cookies: string[] = []) => {
  const headers = new Headers({ location, ...REFERRER })
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
