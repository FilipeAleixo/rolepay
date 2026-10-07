// Opt-in, real chain: the full Discord flow through the signed HTTP endpoint on Tempo's
// Moderato TESTNET, with production adapters (SQLite, AES vault, Tempo chain) and only the
// Discord REST faked. Run with `pnpm test:chain`. Refuses any chain but Moderato.
//
// Reuses the throwaway keys core's chain test keeps in the gitignored .env
// (PAYRUN_TEST_ROOT_PRIVATE_KEY, PAYRUN_MASTER_KEY); never prints them.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NETWORKS, TESTNET_TOKENS, createPayrun, parseAmount } from '@rolepay/core'
import { createTestnetTools, openPayrunAdapters, rootSignerFromPrivateKey } from '@rolepay/core/adapters'
import { FakeDiscordRest, buttonClick, createTestSigner, slashCommand } from '@rolepay/discord/testing'
import { FakePasskeySessions, staticAssets } from '@rolepay/web/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeServer } from '../src/compose.js'
import { parseServerConfig } from '../src/config.js'
import { REPO_ROOT, loadEnvironment } from '../src/env.js'

const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)
const fresh = () => `0x${randomBytes(20).toString('hex')}`
const text = (v: unknown) => JSON.stringify(v ?? null)

describe('Discord flow through HTTP on Moderato (fake Discord REST, real chain)', () => {
  const env = loadEnvironment()
  const rootKey = env.PAYRUN_TEST_ROOT_PRIVATE_KEY
  const dbDir = mkdtempSync(join(tmpdir(), 'payrun-server-chain-'))
  const guildId = snowflake()
  const scope = { guildId, channelId: '700000000000000001' }
  const admin = { userId: '300000000000000202', manageGuild: true }
  const treasurerRole = '400000000000000201'
  /** The dev path is for a treasurer: Manage Server and the approver role. */
  const treasurerAdmin = { ...admin, roles: [treasurerRole] }
  const treasurer = { userId: '300000000000000201', roles: [treasurerRole] }
  const payees = ['200000000000000201', '200000000000000202']
  const addresses = payees.map(fresh)
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  let close: () => Promise<void>
  let server: ReturnType<typeof composeServer>
  let rest: FakeDiscordRest
  let interact: (i: unknown) => Promise<Response>
  const sessions = new FakePasskeySessions()

  beforeAll(async () => {
    if (!rootKey || !env.PAYRUN_MASTER_KEY) throw new Error('Run `pnpm --filter @rolepay/core test:chain` (or `pnpm dev:treasury`) first: it creates the throwaway testnet keys in .env')
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    const root = rootSignerFromPrivateKey(rootKey as `0x${string}`)
    await testnet.ensureFunded(root.address, TOKEN, usd('100'))

    const signer = await createTestSigner()
    const config = parseServerConfig({
      ...env,
      PAYRUN_NETWORK: 'moderato',
      PAYRUN_DB_PATH: join(dbDir, 'payrun.db'),
      DISCORD_APP_ID: '500000000000000001',
      DISCORD_PUBLIC_KEY: signer.publicKeyHex,
      DISCORD_BOT_TOKEN: 'fake-bot-token',
      PUBLIC_URL: 'https://payrun.test',
      PAYRUN_BOT_KEY_LIMIT: '10',
      PAYRUN_DEV_SHORTCUTS: 'true',
    })
    const opened = await openPayrunAdapters(config.core)
    close = opened.close
    rest = new FakeDiscordRest()
    server = composeServer({ config, payrun: createPayrun(opened.deps), rest, clock: opened.deps.clock, kv: opened.kv, web: { sessions, assets: staticAssets({}) }, log: () => {} })
    interact = async (interaction) => {
      const body = JSON.stringify(interaction)
      const timestamp = String(Math.floor(Date.now() / 1000))
      return server.app.request('/discord/interactions', {
        method: 'POST',
        headers: { 'x-signature-ed25519': await signer.sign(timestamp + body), 'x-signature-timestamp': timestamp },
        body,
      })
    }

    // Setup over HTTP, then the dev path authorises the key with the in-process root.
    await interact(slashCommand(scope, 'payrun', 'setup', { treasury: root.address, approver_role: treasurerRole }, treasurerAdmin, 'tok-setup'))
    await server.drain()
    expect(text(rest.lastEdit('tok-setup'))).toMatch(/Waiting for the treasury to authorise/)
    const payrun = createPayrun(opened.deps)
    const authorized = await payrun.communities.authorizeBotKey({ guildId, root })
    if (!authorized.ok) throw new Error(JSON.stringify(authorized.error))
  })

  afterAll(async () => {
    await close?.()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('links, a run, Approve, one sponsored batch on chain, receipts', async () => {
    for (const [i, user] of payees.entries()) {
      const res = (await (await interact(slashCommand(scope, 'payee', 'link', {}, { userId: user }))).json()) as { data: { content: string } }
      const path = /https:\/\/payrun\.test(\/claim\/\S+)/.exec(res.data.content)?.[1] as string
      // The claim page registers the passkey session's account (fake sessions here; the browser e2e uses real passkeys).
      const claimed = await server.app.request(path, {
        method: 'POST',
        headers: { cookie: sessions.cookieFor(addresses[i] as string), 'content-type': 'application/json' },
        body: '{}',
      })
      expect(claimed.status).toBe(200)
    }

    await interact(slashCommand(scope, 'payrun', 'new', { amount: '0.01', users: `<@${payees[0]}> <@${payees[1]}>=0.02`, note: 'server chain test' }, admin, 'tok-new'))
    await server.drain()
    const runId = /payrun:approve:([^"]+)"/.exec(text(rest.lastEdit('tok-new')))?.[1] as string
    expect(runId).toBeDefined()

    const started = Date.now()
    const approved = (await (await interact(buttonClick(scope, `payrun:approve:${runId}`, treasurer, 'tok-approve'))).json()) as { type: number }
    expect(approved.type).toBe(7)
    await server.drain()

    const final = text(rest.lastEdit('tok-approve'))
    expect(final).toMatch(/"title":"Paid"/)
    const txHash = /explore\.testnet\.tempo\.xyz\/tx\/(0x[0-9a-f]{64})/.exec(final)?.[1]
    expect(txHash).toBeDefined()
    expect(await testnet.balance(TOKEN, addresses[0] as string)).toBe(usd('0.01'))
    expect(await testnet.balance(TOKEN, addresses[1] as string)).toBe(usd('0.02'))
    expect(rest.dms.map((d) => d.userId)).toEqual(payees)

    mkdirSync(join(REPO_ROOT, '.chain-results'), { recursive: true })
    writeFileSync(
      join(REPO_ROOT, '.chain-results', 'server.chain.json'),
      JSON.stringify({ at: new Date().toISOString(), runId, tx: txHash, url: `${NET.explorerUrl}/tx/${txHash}`, approveToPaidMs: Date.now() - started }, null, 2),
    )
  })
})
