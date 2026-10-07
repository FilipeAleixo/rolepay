// A whole server on in-memory adapters and a fake Discord, driven through real HTTP requests
// (Hono's app.request), with Discord-style Ed25519 signatures.
import { randomBytes } from 'node:crypto'
import { TESTNET_TOKENS, createPayrun, parseAmount } from '@rolepay/core'
import { type KeyValueStore, type Payrun } from '@rolepay/core'
import { FakePayoutChain, FakeRunProposer, ManualClock, MemoryKeyValueStore, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import { RestActivityReader } from '@rolepay/discord'
import { FakeDiscordRest, createTestSigner } from '@rolepay/discord/testing'
import { FakePasskeySessions, staticAssets } from '@rolepay/web/testing'
import { parseServerConfig } from '../src/config.js'
import { composeServer } from '../src/compose.js'

export const GUILD = '1094309218049937418'
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const TOKEN = TESTNET_TOKENS.alpha_usd
export const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}

type SharedState = { payrun: Payrun; chain: FakePayoutChain; clock: ManualClock; kv: KeyValueStore; rest: FakeDiscordRest; proposer: FakeRunProposer }

/**
 * `from`: start a second server over the first one's database and chain, as a restarted
 * process would (a fresh Discord connection and queue). `sleep`: replace the job's waits.
 * `devShortcuts: false`: the production default (no `treasury:` or `new_key` in Discord).
 */
export async function testServer(opts: { from?: SharedState; sleep?: (ms: number) => Promise<void>; devShortcuts?: boolean } = {}) {
  const signer = await createTestSigner()
  const config = parseServerConfig({
    PAYRUN_MASTER_KEY: randomBytes(32).toString('hex'),
    // These tests run on testnet with the dev path on, unless a test asks for the production default.
    PAYRUN_DEV_SHORTCUTS: String(opts.devShortcuts ?? true),
    DISCORD_APP_ID: '500000000000000001',
    DISCORD_PUBLIC_KEY: signer.publicKeyHex,
    DISCORD_BOT_TOKEN: 'test-bot-token',
    PUBLIC_URL: 'https://payrun.test',
  })
  const clock = opts.from?.clock ?? new ManualClock(new Date())
  const chain = opts.from?.chain ?? new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  if (!opts.from) chain.fund(TOKEN, TREASURY, usd('1000'))
  const logs: { event: string; fields?: Record<string, unknown> }[] = []
  // A restarted process gets a fresh Discord connection; the AI proposals read through it.
  const rest = new FakeDiscordRest()
  const proposer = opts.from?.proposer ?? new FakeRunProposer()
  const payrun =
    opts.from?.payrun ??
    createPayrun({
      chain,
      repositories: createMemoryRepositories({ clock }),
      vault: new PlainKeyVault(),
      ids: new SequentialIds(),
      clock,
      network: 'moderato',
      proposer,
      activity: new RestActivityReader(rest),
      proposalLog: (entry) => logs.push({ event: 'proposal', fields: entry }),
    })
  const kv = opts.from?.kv ?? new MemoryKeyValueStore(clock)
  const sessions = new FakePasskeySessions()
  const server = composeServer({
    web: { sessions, assets: staticAssets({ 'payrun.js': '' }) },
    config,
    payrun,
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
      headers: { cookie: sessions.cookieFor(address), 'content-type': 'application/json', origin: 'https://payrun.test' },
      body: JSON.stringify(body),
    })

  return { ...server, config, clock, chain, payrun, kv, rest, proposer, logs, interact, browserPost }
}
