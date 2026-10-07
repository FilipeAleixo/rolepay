// Opt-in, real chain: one autopilot payout of a standing policy on Tempo's Moderato TESTNET (chain
// 42431). Run with `pnpm test:chain`. Never mainnet: the test refuses any other chain ID.
//
// The rule is compiled once by the deterministic fake model and Discord is a fake; everything
// else is production: SQLite, the AES vault, the Tempo chain through the public sponsor, the
// system clock. The policy's next run is made now (the dev shortcut), waits out a one-minute veto
// window in real time, and is paid by the scheduler in one batched transaction within the key's
// on-chain limit. Reuses the throwaway treasury root key the other chain tests keep in .env.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AesGcmKeyVault,
  FakeActivityReader,
  FakeRunProposer,
  RandomIds,
  SystemClock,
  TempoPayoutChain,
  createTestnetTools,
  emptyCriteria,
  openSqliteDatabase,
  rootSignerFromPrivateKey,
} from '../src/adapters/index.js'
import { NETWORKS, type Rolepay, TESTNET_TOKENS, createRolepay, parseAmount, withDeprecatedEnvNames } from '../src/index.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const ENV_PATH = join(REPO_ROOT, '.env')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
loadEnv({ path: ENV_PATH, quiet: true })

const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const APPROVER = '400000000000000101'
const MODS = '400000000000000102'
const TREASURER = '300000000000000101'
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)
const fresh = () => privateKeyToAddress(generatePrivateKey()).toLowerCase() as `0x${string}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Reads a throwaway secret from .env, generating and persisting it on first use. Never printed. */
function envSecret(name: string, make: () => string, valid: RegExp): string {
  const existing = withDeprecatedEnvNames(process.env)[name]
  if (existing && valid.test(existing)) return existing
  const value = make()
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  appendFileSync(ENV_PATH, `${current === '' || current.endsWith('\n') ? '' : '\n'}${name}=${value}\n`, { mode: 0o600 })
  process.env[name] = value
  return value
}

describe('a standing policy on autopilot pays on Moderato after its veto window (service level)', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'rolepay-policy-chain-'))
  const guildId = snowflake()
  const mods = ['200000000000000201', '200000000000000202']
  const addresses = mods.map(() => fresh())
  const root = rootSignerFromPrivateKey(envSecret('ROLEPAY_TEST_ROOT_PRIVATE_KEY', generatePrivateKey, /^0x[0-9a-fA-F]{64}$/) as `0x${string}`)
  const masterKey = envSecret('ROLEPAY_MASTER_KEY', () => generatePrivateKey().slice(2), /^[0-9a-fA-F]{64}$/)
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const activity = new FakeActivityReader()
  const proposer = new FakeRunProposer()
  let db: Awaited<ReturnType<typeof openSqliteDatabase>>
  let rolepay: Rolepay

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, TOKEN, usd('10'))
    db = await openSqliteDatabase(join(dbDir, 'rolepay.db'))
    rolepay = createRolepay({ chain, repositories: db.repositories, vault: new AesGcmKeyVault(masterKey), ids: new RandomIds(), clock: new SystemClock(), network: 'moderato', proposer, activity, minVetoMinutes: 1 })
    activity.roles = [{ id: MODS, name: 'Mods' }]
    for (const m of mods) activity.setMember(m, { roleIds: [MODS], joinedAt: null })
    activity.setMember(TREASURER, { roleIds: [APPROVER], joinedAt: null })
    proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '0.01', per: '', cap: '', total: '', splitBy: '' }, note: 'Chain policy' }, { hasRole: ['R1'] })
  })

  afterAll(async () => {
    await db?.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('write once, approve, autopilot with a one-minute veto window; after it, one sponsored batch pays both Mods', async () => {
    const who = { guildId, actor: TREASURER, actorRoleIds: [APPROVER] }
    expect((await rolepay.communities.register({ guildId, name: 'Rolepay policy chain test', treasuryAddress: root.address, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: APPROVER })).ok).toBe(true)
    await rolepay.communities.setAiProposals({ guildId, enabled: true, actorRoleIds: [APPROVER] })
    const key = await rolepay.communities.provisionBotKey({ guildId, limit: usd('1'), periodSeconds: 86_400, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
    if (!key.ok) throw new Error(JSON.stringify(key.error))
    const auth = await rolepay.communities.authorizeBotKey({ guildId, root })
    if (!auth.ok) throw new Error(JSON.stringify(auth.error))
    for (const [i, user] of mods.entries()) {
      const link = await rolepay.payees.issueLink({ guildId, discordUserId: user })
      if (!link.ok) throw new Error(link.error.code)
      expect((await rolepay.payees.register({ token: link.value.token, address: addresses[i] as string })).ok).toBe(true)
    }

    const created = await rolepay.policies.create({ ...who, name: 'Chain policy', instruction: '0.01 to every Mod each Monday', schedule: { kind: 'weekly', weekday: 'monday', hour: 18 } })
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect((await rolepay.policies.approve({ ...who, policyId: created.value.id, version: 1 })).ok).toBe(true)
    expect((await rolepay.policies.setMode({ ...who, policyId: created.value.id, mode: 'autopilot', vetoWindowMinutes: 1 })).ok).toBe(true)

    const made = await rolepay.scheduler.runNow({ ...who, policyId: created.value.id })
    if (!made.ok) throw new Error(JSON.stringify(made.error))
    expect(made.value.policyRun).toMatchObject({ status: 'scheduled', total: usd('0.02') })
    expect((await rolepay.scheduler.tick()).events).toEqual([]) // inside the window: nothing is released

    await sleep(62_000)
    const started = Date.now()
    const { events, errors } = await rolepay.scheduler.tick()
    expect(errors).toEqual([])
    expect(events.map((e) => e.kind)).toEqual(['released'])
    let run = events[0]?.run
    // A slow receipt is reconciled like any other run (the recovery sweep would do the same).
    for (let i = 0; run && run.status === 'executing' && i < 12; i++) {
      await sleep(5000)
      const r = await rolepay.payRuns.reconcile({ guildId, runId: run.id })
      if (r.ok) run = r.value.run
    }
    expect(run).toMatchObject({ status: 'paid', approvedBy: TREASURER })
    const tx = run?.paidTxHash as string
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(join(RESULTS_DIR, 'policy.chain.json'), JSON.stringify({ at: new Date().toISOString(), policyId: created.value.id, runId: run?.id, tx, url: `${NET.explorerUrl}/tx/${tx}`, latencyMs: Date.now() - started }, null, 2))
    for (const a of addresses) expect(await testnet.balance(TOKEN, a)).toBe(usd('0.01'))
    const left = await rolepay.communities.keyStatus({ guildId })
    expect(left.ok && left.value.state.remaining).toBe(usd('0.98'))
    const audit = await rolepay.audit.list({ guildId, policyId: created.value.id })
    expect(audit.ok && audit.value.events.map((e) => e.type)).toContain('policy_run.released')
    await rolepay.communities.revokeBotKey({ guildId, root })
  })
})
