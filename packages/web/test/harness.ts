// A web app over the real core services on in-memory fakes, with fake passkey sessions and
// a stub client bundle. No network, no browser.
import { createRolepay } from '@rolepay/core'
import {
  FakeActivityReader,
  FakeFundingChain,
  FakePayoutChain,
  FakeRunProposer,
  InProcessLiveFeed,
  ManualClock,
  PlainKeyVault,
  SequentialIds,
  ViemMessageSignatures,
  createMemoryRepositories,
  emptyCriteria,
} from '@rolepay/core/adapters'
import { createWebApp } from '../src/index.js'
import type { LiveStreamOptions } from '../src/live/streams.js'
import { FakePasskeySessions, staticAssets } from '../src/testing/index.js'

export const GUILD = '1094309218049937418'
export const ALICE = '200000000000000001'
export const TREASURER = '300000000000000001'
export const ROLE = '400000000000000001'
export const TOKEN = '0x20c0000000000000000000000000000000000001'
export const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'
export const PASSKEY = '0x7777777777777777777777777777777777777777'
export const OTHER_PASSKEY = '0x8888888888888888888888888888888888888888'
export const DEV_TREASURY = '0x9999999999999999999999999999999999999999'

type Passkey = string | { address: string; proof: 'login' | 'registration'; issuedAt: number }

/** The pages as the mainnet server serves them: no sponsor, no faucet, the mainnet RPC and explorer. */
const MAINNET_WEB = {
  origin: 'https://web.rolepay.app',
  rpId: 'web.rolepay.app',
  network: 'mainnet',
  rpcUrl: 'https://rpc.tempo.xyz',
  sponsorUrl: null,
  explorerUrl: 'https://explore.tempo.xyz',
} as const

/**
 * `discordAppId`: the Discord application, for the home page's install link (absent: no link, as in
 * the other tests). `publicInstall`: ROLEPAY_PUBLIC_INSTALL, by default as the server has it (on testnet only). `demoInviteUrl`:
 * ROLEPAY_DEMO_INVITE_URL, the demo's own Discord server (absent: none). `funding: false`: a server without the funding chain (deposit addresses unavailable).
 */
export function webHarness(opts: { mainnet?: boolean; discordAppId?: string; publicInstall?: boolean; demoInviteUrl?: string; funding?: boolean; live?: LiveStreamOptions } = {}) {
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  // The model (scripted) and Discord (fake) a policy needs to be written; AI stays off per community until a test turns it on.
  const proposer = new FakeRunProposer()
  const activity = new FakeActivityReader()
  const fundingChain = new FakeFundingChain()
  const feed = new InProcessLiveFeed()
  const rolepay = createRolepay({
    live: feed,
    chain,
    repositories: createMemoryRepositories(),
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: opts.mainnet ? 'mainnet' : 'moderato',
    proposer,
    activity,
    ...(opts.funding === false ? {} : { fundingChain }),
    // Real and offline: who signed a wallet claim.
    signatures: new ViemMessageSignatures(),
  })
  const sessions = new FakePasskeySessions()
  const app = createWebApp({
    rolepay,
    clock,
    sessions,
    ...(opts.live ? { live: opts.live } : {}),
    assets: staticAssets({ 'rolepay.js': 'console.log("rolepay");'.repeat(100) }),
    config: {
      origin: 'http://localhost:8787',
      rpId: 'localhost',
      network: 'moderato',
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      explorerUrl: 'https://explore.testnet.tempo.xyz',
      ...(opts.mainnet ? MAINNET_WEB : {}),
      ...(opts.discordAppId ? { discordAppId: opts.discordAppId } : {}),
      publicInstall: opts.publicInstall ?? !opts.mainnet,
      ...(opts.demoInviteUrl ? { demoInviteUrl: opts.demoInviteUrl } : {}),
      botKeyDefaults: { limit: 100_000_000n, periodSeconds: 30 * 86_400, validitySeconds: 30 * 86_400, feeBudget: 1_000_000n },
    },
  })
  /**
   * A request as a browser signed in with the passkey whose account is `address` (or none). A
   * plain address is a session from a passkey login; pass `{ proof: 'registration', issuedAt }`
   * for one minted by a registration.
   */
  const send = (path: string, init: RequestInit & { passkey?: Passkey } = {}) => {
    const headers = new Headers(init.headers)
    if (typeof init.passkey === 'string') headers.set('cookie', sessions.cookieFor(init.passkey))
    else if (init.passkey) headers.set('cookie', sessions.cookieFor(init.passkey.address, init.passkey))
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }
  const post = (path: string, body: unknown = {}, passkey?: Passkey) =>
    send(path, { method: 'POST', body: JSON.stringify(body), ...(passkey ? { passkey } : {}) })
  return { app, rolepay, feed, chain, fundingChain, clock, sessions, send, post, proposer, activity }
}

/**
 * An approved standing policy of the registered community, written through core with the scripted
 * model: "1 AlphaUSD to every Treasurer each Monday", capped at `perRun` (30 by default).
 */
export async function approvedPolicy(h: ReturnType<typeof webHarness>, opts: { perRun?: bigint | null; name?: string } = {}) {
  const who = { guildId: GUILD, actor: TREASURER, actorRoleIds: [ROLE] }
  await h.rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [ROLE] })
  h.activity.roles = [{ id: ROLE, name: 'Treasurer' }]
  h.proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' }, note: 'Treasurers' }, { hasRole: ['R1'] })
  const perRun = opts.perRun === undefined ? 30_000_000n : opts.perRun
  const created = await h.rolepay.policies.create({
    ...who,
    name: opts.name ?? 'Treasurers',
    instruction: '1 AlphaUSD to every Treasurer each Monday',
    schedule: { kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'UTC' },
    caps: { perRun, perPerson: null },
  })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  const approved = await h.rolepay.policies.approve({ ...who, policyId: created.value.id, version: 1 })
  if (!approved.ok) throw new Error(JSON.stringify(approved.error))
  return approved.value
}

export async function registeredCommunity(h: ReturnType<typeof webHarness>, treasuryAddress = PASSKEY, over: Record<string, unknown> = {}) {
  const r = await h.rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE, ...over })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value
}

/** A `/payee link` for `user`, issued as Discord would with their username (`null`: a link from before usernames were kept). */
export async function claimLink(h: ReturnType<typeof webHarness>, user = ALICE, username: string | null = user === ALICE ? 'alice' : null) {
  const link = await h.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: user, discordUsername: username })
  if (!link.ok) throw new Error(link.error.code)
  return link.value.token
}

export async function setupLink(h: ReturnType<typeof webHarness>, settings: Record<string, unknown> = {}) {
  const link = await h.rolepay.communities.issueSetupLink({
    guildId: GUILD,
    discordUserId: TREASURER,
    settings: { name: 'Mods guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE, ...settings },
  })
  if (!link.ok) throw new Error(link.error.code)
  return link.value.token
}

/** The JSON config the server embeds in a page for the client bundle. */
export async function pageConfig(res: Response): Promise<Record<string, unknown>> {
  const html = await res.text()
  const m = html.match(/<script type="application\/json" id="rolepay-config">([^<]*)<\/script>/)
  if (!m?.[1]) throw new Error('no page config')
  return JSON.parse(m[1].replaceAll('\\u003c', '<'))
}
