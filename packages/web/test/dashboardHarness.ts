// The web app with the dashboard, over the real core services on in-memory fakes: a fake Discord
// OAuth provider, a fake bot view of guild members and the in-memory policy port. No network.
import { createRolepay, parseAmount } from '@rolepay/core'
import { FakePayoutChain, ManualClock, MemoryKeyValueStore, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import type { Hono } from 'hono'
import { createWebApp } from '../src/index.js'
import type { DiscordIdentity } from '../src/dashboard/ports.js'
import { FakeDiscordOAuth, FakeGuildMembers, FakePasskeySessions, InMemoryPolicies, staticAssets } from '../src/testing/index.js'

export const GUILD = '1094309218049937418'
export const OTHER_GUILD = '1094309218049937419'
export const ROLE = '400000000000000001'
export const TOKEN = '0x20c0000000000000000000000000000000000001'
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const TREASURER = { id: '300000000000000001', name: 'Tess' }
export const MEMBER = { id: '200000000000000001', name: 'Felix' }
export const OUTSIDER = { id: '200000000000000099', name: 'Mallory' }

export const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}

/** Who signs in, and the servers Discord says they are in (Rolepay's guild and another one). */
export const identity = (user: { id: string; name: string }, guilds = [{ id: GUILD, name: 'Mods guild' }, { id: OTHER_GUILD, name: 'Not on Rolepay' }]): DiscordIdentity => ({
  user,
  guilds,
})

/**
 * A browser: keeps cookies across requests (honouring Max-Age=0), sends Origin on POSTs like a
 * real one, and never follows redirects (tests look at them).
 */
export class TestBrowser {
  readonly cookies = new Map<string, string>()
  readonly setCookies: string[] = []

  constructor(
    private readonly app: Hono,
    private readonly origin: string,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    if (jar) headers.set('cookie', jar)
    if ((init.method ?? 'GET') === 'POST' && !headers.has('origin')) headers.set('origin', this.origin)
    const res = await this.app.request(new URL(path, this.origin).toString(), { ...init, headers })
    for (const sc of res.headers.getSetCookie()) {
      this.setCookies.push(sc)
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim())
      const eq = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, eq)
      if (attrs.some((a) => /^max-age=0$/i.test(a))) this.cookies.delete(name)
      else this.cookies.set(name, (pair ?? '').slice(eq + 1))
    }
    return res
  }

  get(path: string) {
    return this.request(path)
  }

  /** A form POST (application/x-www-form-urlencoded), like the dashboard's own forms send. */
  post(path: string, form: Record<string, string> = {}) {
    return this.request(path, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  }

  /** The CSRF token the dashboard put in this session's forms. */
  async csrf(): Promise<string> {
    const html = await (await this.get('/dashboard')).text()
    const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
    if (!token) throw new Error('no CSRF token on the page')
    return token
  }

  /** POSTs a dashboard form with this session's CSRF token. */
  async act(path: string, form: Record<string, string> = {}) {
    return this.post(path, { csrf: await this.csrf(), ...form })
  }
}

export function dashboardHarness(opts: { oauth?: boolean; origin?: string; policies?: boolean } = {}) {
  const origin = opts.origin ?? 'http://localhost:8787'
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const rolepay = createRolepay({ chain, repositories: createMemoryRepositories({ clock }), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' })
  const kv = new MemoryKeyValueStore(clock)
  const oauth = new FakeDiscordOAuth()
  const members = new FakeGuildMembers()
  const policies = new InMemoryPolicies(clock)
  policies.setApproverRole(GUILD, ROLE)
  const app = createWebApp({
    rolepay,
    clock,
    sessions: new FakePasskeySessions(),
    assets: staticAssets({ 'rolepay.js': '' }),
    config: {
      origin,
      rpId: new URL(origin).hostname,
      network: 'moderato',
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      explorerUrl: 'https://explore.testnet.tempo.xyz',
      botKeyDefaults: { limit: 100_000_000n, periodSeconds: 30 * 86_400, validitySeconds: 30 * 86_400, feeBudget: 1_000_000n },
    },
    dashboard: {
      kv,
      oauth: opts.oauth === false ? null : oauth,
      members,
      ...(opts.policies === false ? {} : { policies, audit: policies }),
    },
  })

  const browser = () => new TestBrowser(app, origin)

  /** Signs a browser in through the real flow: /auth/discord, Discord's consent (fake), the callback. */
  async function signIn(who: DiscordIdentity, b = browser(), next?: string) {
    oauth.signInAs(who)
    const start = await b.get(next ? `/auth/discord?next=${encodeURIComponent(next)}` : '/auth/discord')
    const consent = start.headers.get('location')
    if (start.status !== 302 || !consent) throw new Error(`sign-in did not redirect to Discord: ${start.status}`)
    const back = new URL(consent)
    const callback = await b.get(back.pathname + back.search)
    return { browser: b, callback }
  }

  /** The guild registered with Rolepay, the treasurer and a member in it as the bot sees them. */
  async function community(over: Record<string, unknown> = {}) {
    const r = await rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE, ...over })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    members.set(GUILD, TREASURER.id, [ROLE], 'Tess')
    members.set(GUILD, MEMBER.id, [], 'Felix')
    return r.value
  }

  return { app, origin, rolepay, chain, clock, kv, oauth, members, policies, browser, signIn, community }
}

export type DashboardHarness = ReturnType<typeof dashboardHarness>
