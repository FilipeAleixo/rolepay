// A whole server on in-memory adapters and a fake Discord, driven through real HTTP requests
// (Hono's app.request), with Discord-style Ed25519 signatures.
import { randomBytes } from 'node:crypto'
import { TESTNET_TOKENS, createRolepay, parseAmount } from '@rolepay/core'
import { type KeyValueStore, type Rolepay } from '@rolepay/core'
import { FakeFundingChain, FakePayoutChain, FakeRunProposer, ManualClock, MemoryKeyValueStore, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import { RestActivityReader } from '@rolepay/discord'
import { FakeDiscordRest, createTestSigner } from '@rolepay/discord/testing'
import { FakePasskeySessions, staticAssets } from '@rolepay/web/testing'
import { parseServerConfig } from '../src/config.js'
import { type ServerDeps, composeServer } from '../src/compose.js'
import { aiUsagePortFromCore, auditPortFromCore, payoutsPortFromCore, policyPortFromCore } from '../src/policySeam.js'

export const GUILD = '1094309218049937418'
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const TOKEN = TESTNET_TOKENS.alpha_usd
export const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}

type SharedState = { rolepay: Rolepay; chain: FakePayoutChain; fundingChain: FakeFundingChain; clock: ManualClock; kv: KeyValueStore; rest: FakeDiscordRest; proposer: FakeRunProposer }

/**
 * `from`: start a second server over the first one's database and chain, as a restarted
 * process would (a fresh Discord connection and queue). `sleep`: replace the job's waits.
 * `devShortcuts: false`: the production default (no `treasury:` or `new_key` in Discord).
 * `demoControls: true`: `/rolepay policy run_now` and one-minute veto windows (off by default, as in production).
 * `policySeam: true`: the dashboard's Policies and Audit pages and the AI spend over core's services, as main.ts wires them.
 * `env`: more settings, as the environment would give them.
 */
export async function testServer(
  opts: {
    from?: SharedState
    sleep?: (ms: number) => Promise<void>
    devShortcuts?: boolean
    demoControls?: boolean
    policySeam?: boolean
    env?: Record<string, string>
    dashboard?: ServerDeps['web']['dashboard']
  } = {},
) {
  const signer = await createTestSigner()
  const config = parseServerConfig({
    ROLEPAY_MASTER_KEY: randomBytes(32).toString('hex'),
    // These tests run on testnet with the dev path on, unless a test asks for the production default.
    ROLEPAY_DEV_SHORTCUTS: String(opts.devShortcuts ?? true),
    ROLEPAY_DEMO_CONTROLS: String(opts.demoControls ?? false),
    DISCORD_APP_ID: '500000000000000001',
    DISCORD_PUBLIC_KEY: signer.publicKeyHex,
    DISCORD_BOT_TOKEN: 'test-bot-token',
    PUBLIC_URL: 'https://rolepay.test',
    ...opts.env,
  })
  const clock = opts.from?.clock ?? new ManualClock(new Date())
  const chain = opts.from?.chain ?? new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  if (!opts.from) chain.fund(TOKEN, TREASURY, usd('1000'))
  // Deposit addresses: an in-memory registry and transfer log (the fake masterId is a salt's last 4 bytes).
  const fundingChain = opts.from?.fundingChain ?? new FakeFundingChain()
  const logs: { event: string; fields?: Record<string, unknown> }[] = []
  // A restarted process gets a fresh Discord connection; the AI proposals read through it.
  const rest = new FakeDiscordRest()
  const proposer = opts.from?.proposer ?? new FakeRunProposer()
  const activity = new RestActivityReader(rest)
  const rolepay =
    opts.from?.rolepay ??
    createRolepay({
      chain,
      repositories: createMemoryRepositories({ clock }),
      vault: new PlainKeyVault(),
      ids: new SequentialIds(),
      clock,
      network: 'moderato',
      proposer,
      activity,
      proposalLog: (entry) => logs.push({ event: 'proposal', fields: entry }),
      minVetoMinutes: config.policies.minVetoMinutes,
      demoControls: config.core.demoControls,
      fundingChain,
    })
  const kv = opts.from?.kv ?? new MemoryKeyValueStore(clock)
  const sessions = new FakePasskeySessions()
  const seam = opts.policySeam ? { policies: policyPortFromCore(rolepay, { names: activity }), audit: auditPortFromCore(rolepay), aiUsage: aiUsagePortFromCore(rolepay), payouts: payoutsPortFromCore(rolepay) } : {}
  const dashboard = opts.dashboard || opts.policySeam ? { ...seam, ...opts.dashboard } : undefined
  const server = composeServer({
    web: { sessions, assets: staticAssets({ 'rolepay.js': '' }), ...(dashboard ? { dashboard } : {}) },
    config,
    rolepay,
    rest,
    clock,
    kv,
    sleep:
      opts.sleep ??
      (async (ms) => {
        clock.advance(ms / 1000)
        chain.advance(Math.ceil(ms / 1000))
      }),
    log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
  })

  /** POSTs a signed interaction, like Discord does. */
  async function interact(interaction: unknown, sign = true) {
    const body = JSON.stringify(interaction)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-signature-timestamp': timestamp }
    if (sign) headers['x-signature-ed25519'] = await signer.sign(timestamp + body)
    return server.app.request('/discord/interactions', { method: 'POST', headers, body })
  }

  /** A browser POST to a page endpoint, signed in with the passkey whose account is `address`. */
  const browserPost = (path: string, address: string, body: unknown = {}) =>
    server.app.request(path, {
      method: 'POST',
      headers: { cookie: sessions.cookieFor(address), 'content-type': 'application/json', origin: 'https://rolepay.test' },
      body: JSON.stringify(body),
    })

  /** Discord's signature over `text` (the timestamp, then the body). */
  const sign = (text: string) => signer.sign(text)

  return { ...server, config, clock, chain, fundingChain, rolepay, kv, rest, proposer, logs, interact, browserPost, sign }
}
