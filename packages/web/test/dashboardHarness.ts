// The web app with the dashboard, over the real core services on in-memory fakes: a fake Discord
// OAuth provider, a fake bot view of guild members and the in-memory policy port (or, for the page
// contract, another policy backend: core's own services through the server's adapters). No network.
import { type ActivityReader, type RunProposer, createRolepay, parseAmount } from '@rolepay/core'
import { FakeFundingChain, FakePayoutChain, InProcessLiveFeed, ManualClock, MemoryKeyValueStore, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import type { Hono } from 'hono'
import { createWebApp } from '../src/index.js'
import type { LiveStreamOptions } from '../src/live/streams.js'
import type { AuditPort, PolicyActor, PolicyPort } from '../src/dashboard/policyPort.js'
import type { DiscordIdentity } from '../src/dashboard/ports.js'
import { FakeDiscordOAuth, FakeGuildMembers, FakePasskeySessions, InMemoryAiUsage, InMemoryPayouts, InMemoryPolicies, InMemoryPolicyKeys, staticAssets } from '../src/testing/index.js'

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

/** A dashboard action as the policy port received it, with the actor the dashboard read from Discord. */
export type PortCall = { method: string; guildId: string; policyId?: string; actor: PolicyActor }

/** Wraps a policy port so every action is recorded (reads are not), whatever implements it. */
export function recording(port: PolicyPort, calls: PortCall[]): PolicyPort {
  const record = (method: string, input: { guildId: string; policyId?: string; actor: PolicyActor }) =>
    calls.push({ method, guildId: input.guildId, ...(input.policyId ? { policyId: input.policyId } : {}), actor: input.actor })
  return {
    ...(port.dailySchedules === undefined ? {} : { dailySchedules: port.dailySchedules }),
    list: (i) => port.list(i),
    get: (i) => port.get(i),
    preview: (i) => port.preview(i),
    versions: (i) => port.versions(i),
    upcoming: (i) => port.upcoming(i),
    runOrigins: (i) => port.runOrigins(i),
    create: (i) => (record('create', i), port.create(i)),
    edit: (i) => (record('edit', i), port.edit(i)),
    approve: (i) => (record('approve', i), port.approve(i)),
    discard: (i) => (record('discard', i), port.discard(i)),
    pause: (i) => (record('pause', i), port.pause(i)),
    resume: (i) => (record('resume', i), port.resume(i)),
    archive: (i) => (record('archive', i), port.archive(i)),
    setMode: (i) => (record('setMode', i), port.setMode(i)),
    veto: (i) => (record('veto', i), port.veto(i)),
  }
}

/**
 * Where the Policies and Audit pages get their data in a harness: `core` adds what the backend
 * needs to core's services (the model and Discord activity), `attach` builds the ports once the
 * services exist. The default is `InMemoryPolicies`.
 */
export type PolicyBackendSetup<B extends { policies: PolicyPort; audit: AuditPort }> = {
  core?: { proposer?: RunProposer; activity?: ActivityReader; minVetoMinutes?: number }
  attach(h: HarnessBase): B
}

export function dashboardHarness<B extends { policies: PolicyPort; audit: AuditPort } = { policies: PolicyPort; audit: AuditPort }>(
  opts: { live?: LiveStreamOptions; oauth?: boolean; origin?: string; policies?: boolean; aiUsage?: boolean; payouts?: boolean; policyKeys?: boolean; backend?: (clock: ManualClock) => PolicyBackendSetup<B> } = {},
) {
  const origin = opts.origin ?? 'http://localhost:8787'
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const setup = opts.backend?.(clock)
  // Deposit addresses: an in-memory registry and transfer log (the fake masterId is a salt's last 4 bytes).
  const fundingChain = new FakeFundingChain()
  // Every audit event to the live pages, as in production.
  const feed = new InProcessLiveFeed()
  const rolepay = createRolepay({
    live: feed,
    chain,
    repositories: createMemoryRepositories({ clock }),
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato',
    fundingChain,
    ...(setup?.core ?? {}),
  })
  const kv = new MemoryKeyValueStore(clock)
  const oauth = new FakeDiscordOAuth()
  const members = new FakeGuildMembers()
  const policies = new InMemoryPolicies(clock)
  policies.setApproverRole(GUILD, ROLE)
  const aiUsage = new InMemoryAiUsage(clock)
  const payouts = new InMemoryPayouts(clock, TOKEN)
  const policyKeys = new InMemoryPolicyKeys()
  const errors: unknown[] = []
  const calls: PortCall[] = []
  const base: HarnessBase = { rolepay, clock, chain, members, community, payee, activeKey, run }
  const backend = setup?.attach(base) ?? null
  const ports = backend ? { policies: recording(backend.policies, calls), audit: backend.audit } : { policies, audit: policies }
  const sessions = new FakePasskeySessions()
  const app = createWebApp({
    rolepay,
    clock,
    sessions,
    ...(opts.live ? { live: opts.live } : {}),
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
      ...(opts.policies === false ? {} : ports),
      ...(opts.aiUsage === false ? {} : { aiUsage }),
      ...(opts.payouts === false ? {} : { payouts }),
      ...(opts.policyKeys === false ? {} : { policyKeys }),
      onError: (e) => errors.push(e),
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

  /** A registered payee (their passkey address), as /payee link and the claim page would make one. */
  async function payee(userId: string, address: string) {
    const link = await rolepay.payees.issueLink({ guildId: GUILD, discordUserId: userId })
    if (!link.ok) throw new Error(link.error.code)
    const r = await rolepay.payees.register({ token: link.value.token, address })
    if (!r.ok) throw new Error(r.error.code)
  }

  /** An active bot key authorised by the treasury (the fake chain's root signer), and a funded treasury. */
  async function activeKey(limit = usd('100')) {
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + 60 * 86_400
    const p = await rolepay.communities.provisionBotKey({ guildId: GUILD, limit, periodSeconds: 30 * 86_400, expiresAt })
    if (!p.ok) throw new Error(p.error.code)
    const a = await rolepay.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    if (!a.ok) throw new Error(a.error.code)
    chain.fund(TOKEN, TREASURY, usd('1000'))
    return a.value.key
  }

  /** A run made by `by` (default the treasurer), submitted; approved by the treasurer and paid unless asked not to. */
  async function run(lines: [string, string][], opts: { note?: string; by?: string; approve?: boolean; pay?: boolean } = {}) {
    const created = await rolepay.payRuns.create({
      guildId: GUILD,
      createdBy: opts.by ?? TREASURER.id,
      note: opts.note ?? null,
      lines: lines.map(([discordUserId, amount]) => ({ discordUserId, amount: usd(amount) })),
    })
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const runId = created.value.id
    await rolepay.payRuns.submit({ guildId: GUILD, runId, actor: opts.by ?? TREASURER.id })
    if (opts.approve !== false) await rolepay.payRuns.approve({ guildId: GUILD, runId, actor: TREASURER.id, actorCanApprove: true })
    if (opts.approve !== false && opts.pay !== false) {
      const paid = await rolepay.payRuns.execute({ guildId: GUILD, runId })
      if (!paid.ok || paid.value.status !== 'paid') throw new Error(`run ${runId} did not pay: ${JSON.stringify(paid, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))}`)
    }
    const r = await rolepay.payRuns.get({ guildId: GUILD, runId })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }

  /** The treasury registered as a virtual-address master (as the setup page does), recorded by Rolepay. */
  async function depositAddresses(masterId = '58e21090') {
    const { txHash } = fundingChain.register(TREASURY, `0x${'00'.repeat(28)}${masterId}`)
    const r = await rolepay.funding.confirmMaster({ guildId: GUILD, masterId: `0x${masterId}`, txHash })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }

  /** A funding source made by the treasurer. */
  async function fundingSource(name: string) {
    const r = await rolepay.funding.createSource({ guildId: GUILD, actor: TREASURER.id, actorRoleIds: [ROLE], name })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }

  /** Someone sends `amount` to a deposit address, and the watcher sees it. */
  async function deposit(to: string, amount: string, opts: { token?: string; from?: string } = {}) {
    const sent = fundingChain.transfer({ token: (opts.token ?? TOKEN) as `0x${string}`, from: (opts.from ?? '0x5555555555555555555555555555555555555555') as `0x${string}`, to: to as `0x${string}`, amount: usd(amount) })
    await rolepay.funding.scan()
    return sent
  }

  return { app, origin, rolepay, feed, sessions, chain, fundingChain, clock, kv, oauth, members, policies, aiUsage, payouts, policyKeys, backend, calls, errors, browser, signIn, community, payee, activeKey, run, depositAddresses, fundingSource, deposit }
}

/** What a policy backend may use to set itself up: core's services, the clock, the chain, the bot's member view, the helpers. */
export type HarnessBase = {
  rolepay: ReturnType<typeof createRolepay>
  clock: ManualClock
  chain: FakePayoutChain
  members: FakeGuildMembers
  community(over?: Record<string, unknown>): Promise<unknown>
  payee(userId: string, address: string): Promise<void>
  activeKey(limit?: bigint): Promise<unknown>
  run(lines: [string, string][], opts?: { note?: string; by?: string; approve?: boolean; pay?: boolean }): Promise<{ id: string }>
}

export type DashboardHarness = ReturnType<typeof dashboardHarness>
