// Opt-in, real chain: a full service-level pay run on Tempo's Moderato TESTNET (chain 42431).
// Run with `pnpm test:chain`. Never mainnet: the test refuses any other chain ID.
//
// Throwaway keys (treasury root, vault master key) are generated into the repo-root .env on
// first run (gitignored) and never printed. The treasury funds itself from the public faucet
// (`tempo_fundAddress`); fees go through the public Moderato sponsor.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AesGcmKeyVault,
  RandomIds,
  SystemClock,
  TempoPayoutChain,
  createTestnetTools,
  openSqliteDatabase,
  rootSignerFromPrivateKey,
} from '../src/adapters/index.js'
import { NETWORKS, type Rolepay, type Run, TESTNET_TOKENS, createRolepay, parseAmount, withDeprecatedEnvNames } from '../src/index.js'
import type { RunRepository } from '../src/ports/repositories.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const ENV_PATH = join(REPO_ROOT, '.env')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
loadEnv({ path: ENV_PATH, quiet: true })

const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)
const fresh = () => privateKeyToAddress(generatePrivateKey()).toLowerCase() as `0x${string}`

/** Reads a throwaway secret from .env (or its deprecated PAYRUN_* name), generating and persisting it on first use. Never printed. */
function envSecret(name: string, make: () => string, valid: RegExp): string {
  const existing = withDeprecatedEnvNames(process.env)[name]
  if (existing && valid.test(existing)) return existing
  const value = make()
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  appendFileSync(ENV_PATH, `${current === '' || current.endsWith('\n') ? '' : '\n'}${name}=${value}\n`, { mode: 0o600 })
  process.env[name] = value
  return value
}

/** Simulates a process crash on one chosen write. */
class CrashingRuns implements RunRepository {
  crashOn: ((next: Run) => boolean) | null = null
  constructor(private readonly inner: RunRepository) {}
  insert = (r: Run) => this.inner.insert(r)
  get = (id: string) => this.inner.get(id)
  listByCommunity = (c: string, o?: { limit?: number }) => this.inner.listByCommunity(c, o)
  listByStatus = (s: Run['status']) => this.inner.listByStatus(s)
  async update(next: Run) {
    if (this.crashOn?.(next)) {
      this.crashOn = null
      throw new Error('simulated crash')
    }
    return this.inner.update(next)
  }
}

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'rolepay.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

describe('pay run end to end on Moderato (service level)', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'payrun-chain-'))
  const guildId = snowflake()
  const mods = ['200000000000000101', '200000000000000102', '200000000000000103']
  const addresses = mods.map(() => fresh())
  const root = rootSignerFromPrivateKey(envSecret('ROLEPAY_TEST_ROOT_PRIVATE_KEY', generatePrivateKey, /^0x[0-9a-fA-F]{64}$/) as `0x${string}`)
  const masterKey = envSecret('ROLEPAY_MASTER_KEY', () => generatePrivateKey().slice(2), /^[0-9a-fA-F]{64}$/)
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  let db: Awaited<ReturnType<typeof openSqliteDatabase>>
  let crashingRuns: CrashingRuns
  let rolepay: Rolepay
  let firstRun: Run
  const restart = () =>
    createRolepay({ chain, repositories: db.repositories, vault: new AesGcmKeyVault(masterKey), ids: new RandomIds(), clock: new SystemClock(), network: 'moderato' })

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, TOKEN, usd('100'))
    db = await openSqliteDatabase(join(dbDir, 'payrun.db'))
    crashingRuns = new CrashingRuns(db.repositories.runs)
    rolepay = createRolepay({
      chain,
      repositories: { ...db.repositories, runs: crashingRuns },
      vault: new AesGcmKeyVault(masterKey),
      ids: new RandomIds(),
      clock: new SystemClock(),
      network: 'moderato',
    })
  })

  afterAll(async () => {
    await db?.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('registers the community (guild) with its own treasury account', async () => {
    const r = await rolepay.communities.register({ guildId, name: 'payrun chain test', treasuryAddress: root.address, payoutToken: TOKEN, feeMode: 'sponsor' })
    expect(r.ok).toBe(true)
  })

  it('provisions a bot access key; the chain does not know it yet', async () => {
    const p = await rolepay.communities.provisionBotKey({
      guildId,
      limit: usd('10'),
      periodSeconds: 86_400,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    if (!p.ok) throw new Error(JSON.stringify(p.error))
    const s = await rolepay.communities.keyStatus({ guildId })
    expect(s).toMatchObject({ ok: true, value: { key: { status: 'pending_authorization' }, state: { status: 'not_authorized' } } })
  })

  it('the treasury root authorises it (expiry, 10 USD/day limit, transferWithMemo scope), sponsored', async () => {
    const a = await rolepay.communities.authorizeBotKey({ guildId, root })
    if (!a.ok) throw new Error(JSON.stringify(a.error))
    record({ step: 'authorize', tx: a.value.txHash, url: `${NET.explorerUrl}/tx/${a.value.txHash}` })
    const s = await rolepay.communities.keyStatus({ guildId })
    expect(s).toMatchObject({ ok: true, value: { key: { status: 'active' }, state: { status: 'active', remaining: usd('10') } } })
  })

  it('three payees register through one-time links', async () => {
    for (const [i, user] of mods.entries()) {
      const link = await rolepay.payees.issueLink({ guildId, discordUserId: user })
      if (!link.ok) throw new Error(link.error.code)
      expect((await rolepay.payees.register({ token: link.value.token, address: addresses[i] as string })).ok).toBe(true)
    }
  })

  it('creates, approves and executes a 3-line run in ONE sponsored batched tx; reconciles from memo events', async () => {
    const created = await rolepay.payRuns.create({
      guildId,
      createdBy: mods[0] as string,
      note: 'chain test',
      lines: mods.map((u, i) => ({ discordUserId: u, amount: usd(['1.000001', '2.5', '3.25'][i] as string) })),
    })
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const id = created.value.id
    await rolepay.payRuns.submit({ guildId, runId: id, actor: mods[0] as string })
    await rolepay.payRuns.approve({ guildId, runId: id, actor: '300000000000000101', actorCanApprove: true })
    const started = Date.now()
    const r = await rolepay.payRuns.execute({ guildId, runId: id })
    if (!r.ok) throw new Error(JSON.stringify(r.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    expect(r.value.status).toBe('paid')
    firstRun = r.value.run
    const txHash = firstRun.paidTxHash as `0x${string}`
    record({ step: 'run-1', runId: id, tx: txHash, url: `${NET.explorerUrl}/tx/${txHash}`, latencyMs: Date.now() - started })

    // The signed tx hash recorded before broadcast is the hash that landed.
    expect(firstRun.attempts[0]?.txHash).toBe(txHash)
    for (const [i, a] of addresses.entries()) expect(await testnet.balance(TOKEN, a)).toBe(firstRun.lines[i]?.amount)
    const events = await chain.findMemoTransfers({ token: TOKEN, from: root.address, memos: firstRun.lines.map((l) => l.memo), fromBlock: firstRun.attempts[0]?.fromBlock ?? 0n })
    expect(events.map((e) => e.txHash)).toEqual([txHash, txHash, txHash])
    const s = await rolepay.communities.keyStatus({ guildId })
    expect(s.ok && s.value.state.remaining).toBe(usd('10') - firstRun.total)
  })

  it('executing and reconciling the paid run again never pays twice', async () => {
    const again = await rolepay.payRuns.execute({ guildId, runId: firstRun.id })
    expect(again).toMatchObject({ ok: true, value: { status: 'paid', run: { paidTxHash: firstRun.paidTxHash } } })
    expect(await rolepay.payRuns.reconcile({ guildId, runId: firstRun.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    for (const [i, a] of addresses.entries()) expect(await testnet.balance(TOKEN, a)).toBe(firstRun.lines[i]?.amount)
  })

  it('crash after the tx landed but before it was recorded: a restarted process reconciles it to paid, once', async () => {
    const created = await rolepay.payRuns.create({
      guildId,
      createdBy: mods[0] as string,
      note: 'crash test',
      lines: [
        { discordUserId: mods[0] as string, amount: usd('0.5') },
        { discordUserId: mods[1] as string, amount: usd('0.25') },
      ],
    })
    if (!created.ok) throw new Error(created.error.code)
    const id = created.value.id
    await rolepay.payRuns.submit({ guildId, runId: id, actor: mods[0] as string })
    await rolepay.payRuns.approve({ guildId, runId: id, actor: '300000000000000101', actorCanApprove: true })
    const before = [await testnet.balance(TOKEN, addresses[0] as string), await testnet.balance(TOKEN, addresses[1] as string)]

    crashingRuns.crashOn = (next) => next.status === 'paid'
    await expect(rolepay.payRuns.execute({ guildId, runId: id })).rejects.toThrow('simulated crash')
    expect((await db.repositories.runs.get(id))?.status).toBe('executing')

    const recovered = await restart().payRuns.recoverInFlight()
    expect(recovered).toEqual([{ guildId, runId: id, status: 'paid' }])
    const run = await db.repositories.runs.get(id)
    record({ step: 'crash-recovery', runId: id, tx: run?.paidTxHash, url: `${NET.explorerUrl}/tx/${run?.paidTxHash}` })
    expect(await testnet.balance(TOKEN, addresses[0] as string)).toBe((before[0] as bigint) + usd('0.5'))
    expect(await testnet.balance(TOKEN, addresses[1] as string)).toBe((before[1] as bigint) + usd('0.25'))
  })

  it('a run over the remaining limit is refused before anything is signed', async () => {
    const created = await rolepay.payRuns.create({ guildId, createdBy: mods[0] as string, note: null, lines: [{ discordUserId: mods[2] as string, amount: usd('5') }] })
    if (!created.ok) throw new Error(created.error.code)
    await rolepay.payRuns.submit({ guildId, runId: created.value.id, actor: mods[0] as string })
    await rolepay.payRuns.approve({ guildId, runId: created.value.id, actor: '300000000000000101', actorCanApprove: true })
    expect(await rolepay.payRuns.execute({ guildId, runId: created.value.id })).toMatchObject({ ok: false, error: { code: 'insufficient_limit' } })
    expect((await db.repositories.runs.get(created.value.id))?.status).toBe('approved')
  })

  it('the root revokes the bot key; the chain reports it revoked and runs stop', async () => {
    const r = await rolepay.communities.revokeBotKey({ guildId, root })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    record({ step: 'revoke', tx: r.value.txHash, url: `${NET.explorerUrl}/tx/${r.value.txHash}` })
    expect(await rolepay.communities.keyStatus({ guildId })).toMatchObject({ ok: true, value: { state: { status: 'revoked' } } })
    const created = await rolepay.payRuns.create({ guildId, createdBy: mods[0] as string, note: null, lines: [{ discordUserId: mods[2] as string, amount: usd('0.1') }] })
    if (!created.ok) throw new Error(created.error.code)
    await rolepay.payRuns.submit({ guildId, runId: created.value.id, actor: mods[0] as string })
    await rolepay.payRuns.approve({ guildId, runId: created.value.id, actor: '300000000000000101', actorCanApprove: true })
    expect(await rolepay.payRuns.execute({ guildId, runId: created.value.id })).toEqual({ ok: false, error: { code: 'no_active_key' } })
  })

  it('exports the first run as CSV with the explorer link', async () => {
    const r = await rolepay.payRuns.exportCsv({ guildId, runId: firstRun.id })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.csv).toContain(`${NET.explorerUrl}/tx/${firstRun.paidTxHash}`)
    expect(r.value.csv.split('\r\n')).toHaveLength(5)
  })
})
