// A web app over the real core services on in-memory fakes, with fake passkey sessions and
// a stub client bundle. No network, no browser.
import { createRolepay } from '@rolepay/core'
import { FakePayoutChain, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import { createWebApp } from '../src/index.js'
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

export function webHarness() {
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const rolepay = createRolepay({
    chain,
    repositories: createMemoryRepositories(),
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato',
  })
  const sessions = new FakePasskeySessions()
  const app = createWebApp({
    rolepay,
    clock,
    sessions,
    assets: staticAssets({ 'payrun.js': 'console.log("payrun");'.repeat(100) }),
    config: {
      origin: 'http://localhost:8787',
      rpId: 'localhost',
      network: 'moderato',
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      explorerUrl: 'https://explore.testnet.tempo.xyz',
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
  return { app, rolepay, chain, clock, sessions, send, post }
}

export async function registeredCommunity(h: ReturnType<typeof webHarness>, treasuryAddress = PASSKEY, over: Record<string, unknown> = {}) {
  const r = await h.rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE, ...over })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value
}

export async function claimLink(h: ReturnType<typeof webHarness>, user = ALICE) {
  const link = await h.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: user })
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
  const m = html.match(/<script type="application\/json" id="payrun-config">([^<]*)<\/script>/)
  if (!m?.[1]) throw new Error('no page config')
  return JSON.parse(m[1].replaceAll('\\u003c', '<'))
}
