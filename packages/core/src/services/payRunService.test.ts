import { beforeEach, describe, expect, it } from 'vitest'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { createMemoryRepositories } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import type { Run } from '../domain/run.js'
import type { RunRepository } from '../ports/repositories.js'
import { CommunityService } from './communityService.js'
import { PayRunService } from './payRunService.js'

const GUILD = '1094309218049937418'
const OTHER_GUILD = '1094309218049937419'
const ALICE = '200000000000000001'
const BOB = '200000000000000002'
const CAROL = '200000000000000003'
const TREASURER = '300000000000000001'
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const ADDR = { alice: '0x1111111111111111111111111111111111111111', bob: '0x2222222222222222222222222222222222222222' } as const

/** Wraps a repository so one chosen write "crashes the process" (throws) after a side effect elsewhere. */
class CrashingRuns implements RunRepository {
  crashOnUpdate: ((next: Run) => boolean) | null = null
  constructor(private readonly inner: RunRepository) {}
  insert = (r: Run) => this.inner.insert(r)
  get = (id: string) => this.inner.get(id)
  listByCommunity = (c: string, o?: { limit?: number }) => this.inner.listByCommunity(c, o)
  listByStatus = (s: Run['status']) => this.inner.listByStatus(s)
  async update(next: Run) {
    if (this.crashOnUpdate?.(next)) {
      this.crashOnUpdate = null
      throw new Error('simulated crash')
    }
    return this.inner.update(next)
  }
}

async function world(opts: { limit?: bigint; fund?: bigint } = {}) {
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const repos = createMemoryRepositories()
  const runs = new CrashingRuns(repos.runs)
  const vault = new PlainKeyVault()
  const ids = new SequentialIds()
  const communitySvc = new CommunityService({ communities: repos.communities, chain, vault, clock, network: 'moderato', ids, setupLinkTtlSeconds: 1800 })
  const makeService = () =>
    new PayRunService({ runs, payees: repos.payees, communities: repos.communities, chain, vault, ids, clock, network: 'moderato' })

  await communitySvc.register({ guildId: GUILD, name: 'Mods', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
  await communitySvc.register({ guildId: OTHER_GUILD, name: 'Other', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
  await communitySvc.provisionBotKey({ guildId: GUILD, limit: opts.limit ?? 10_000_000n, expiresAt: chain.time + 30 * 86_400 })
  const auth = await communitySvc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
  if (!auth.ok) throw new Error(auth.error.code)
  chain.fund(TOKEN, TREASURY, opts.fund ?? 100_000_000n)
  const now = clock.now()
  for (const [id, address] of [
    [ALICE, ADDR.alice],
    [BOB, ADDR.bob],
  ] as const) {
    await repos.payees.upsert({ communityId: GUILD, discordUserId: id, address, registeredAt: now, updatedAt: now })
  }
  return { clock, chain, repos, runs, communitySvc, svc: makeService(), makeService }
}

type World = Awaited<ReturnType<typeof world>>

const LINES = [
  { discordUserId: ALICE, amount: 1_500_000n },
  { discordUserId: BOB, amount: 2_000_000n },
]

async function approvedRun(w: World, lines = LINES): Promise<Run> {
  const created = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: 'October mods', lines })
  if (!created.ok) throw new Error(created.error.code)
  const id = created.value.id
  const s = await w.svc.submit({ guildId: GUILD, runId: id, actor: ALICE })
  if (!s.ok) throw new Error(s.error.code)
  const a = await w.svc.approve({ guildId: GUILD, runId: id, actor: TREASURER, actorCanApprove: true })
  if (!a.ok) throw new Error(a.error.code)
  return a.value
}

const paidTo = (w: World) => [w.chain.balance(TOKEN, ADDR.alice), w.chain.balance(TOKEN, ADDR.bob)]

describe('PayRunService: building and approving runs', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('creates a draft with lines resolved to registered addresses', async () => {
    const r = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: 'October mods', lines: LINES })
    expect(r).toMatchObject({
      ok: true,
      value: { status: 'draft', total: 3_500_000n, token: TOKEN, lines: [{ line: 1, address: ADDR.alice }, { line: 2, address: ADDR.bob }] },
    })
  })

  it('refuses to pay anyone who has not registered first, naming them all', async () => {
    const r = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: [...LINES, { discordUserId: CAROL, amount: 1n }] })
    expect(r).toEqual({ ok: false, error: { code: 'unregistered_payees', discordUserIds: [CAROL] } })
  })

  it('validates input and community', async () => {
    expect(await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: [{ discordUserId: ALICE, amount: 0n }] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(await w.svc.create({ guildId: '1094309218049937499', createdBy: ALICE, note: null, lines: LINES })).toEqual({
      ok: false,
      error: { code: 'community_not_found' },
    })
    expect(await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: [LINES[0]!, LINES[0]!] })).toMatchObject({
      ok: false,
      error: { code: 'duplicate_payee' },
    })
  })

  it('approval needs an actor whose permission the caller asserts', async () => {
    const created = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: LINES })
    if (!created.ok) throw new Error()
    await w.svc.submit({ guildId: GUILD, runId: created.value.id, actor: ALICE })
    expect(await w.svc.approve({ guildId: GUILD, runId: created.value.id, actor: BOB, actorCanApprove: false })).toEqual({
      ok: false,
      error: { code: 'not_permitted' },
    })
    expect(await w.svc.approve({ guildId: GUILD, runId: created.value.id, actor: TREASURER, actorCanApprove: true })).toMatchObject({
      ok: true,
      value: { status: 'approved', approvedBy: TREASURER },
    })
  })

  it('rejects actors that are not Discord user IDs (they are persisted on the run)', async () => {
    const created = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: LINES })
    if (!created.ok) throw new Error()
    expect(await w.svc.submit({ guildId: GUILD, runId: created.value.id, actor: 'someone' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(await w.svc.cancel({ guildId: GUILD, runId: created.value.id, actor: '' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect((await w.repos.runs.get(created.value.id))?.status).toBe('draft')
  })

  it('reports illegal steps with the current status', async () => {
    const created = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: LINES })
    if (!created.ok) throw new Error()
    expect(await w.svc.approve({ guildId: GUILD, runId: created.value.id, actor: TREASURER, actorCanApprove: true })).toEqual({
      ok: false,
      error: { code: 'illegal_state', status: 'draft' },
    })
    expect(await w.svc.execute({ guildId: GUILD, runId: created.value.id })).toEqual({
      ok: false,
      error: { code: 'illegal_state', status: 'draft' },
    })
  })

  it('scopes every run to its guild: another guild cannot see or touch it', async () => {
    const run = await approvedRun(w)
    expect(await w.svc.get({ guildId: OTHER_GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'run_not_found' } })
    expect(await w.svc.execute({ guildId: OTHER_GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'run_not_found' } })
    expect(await w.svc.cancel({ guildId: OTHER_GUILD, runId: run.id, actor: TREASURER })).toEqual({
      ok: false,
      error: { code: 'run_not_found' },
    })
    expect((await w.svc.list({ guildId: OTHER_GUILD })).length).toBe(0)
    expect((await w.svc.list({ guildId: GUILD })).map((r) => r.id)).toEqual([run.id])
  })

  it('cancels an approved run; a cancelled run cannot execute', async () => {
    const run = await approvedRun(w)
    expect(await w.svc.cancel({ guildId: GUILD, runId: run.id, actor: TREASURER })).toMatchObject({ ok: true, value: { status: 'cancelled' } })
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'illegal_state', status: 'cancelled' } })
  })
})

describe('PayRunService: execution', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('pays an approved run in one batched tx, exactly', async () => {
    const run = await approvedRun(w)
    const r = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(r).toMatchObject({ ok: true, value: { status: 'paid', run: { status: 'paid' } } })
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
    expect(w.chain.landedTxCount).toBe(1)
    const key = await w.communitySvc.keyStatus({ guildId: GUILD })
    expect(key.ok && key.value.state.remaining).toBe(6_500_000n)
  })

  it('executing a paid run again is a no-op that reports the same tx (double-click safe)', async () => {
    const run = await approvedRun(w)
    const first = await w.svc.execute({ guildId: GUILD, runId: run.id })
    const second = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(second).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(first.ok && second.ok && second.value.run.paidTxHash).toBe(first.ok && first.value.run.paidTxHash)
    expect(w.chain.broadcastCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('two concurrent executes broadcast once', async () => {
    const run = await approvedRun(w)
    const results = await Promise.all([w.svc.execute({ guildId: GUILD, runId: run.id }), w.svc.execute({ guildId: GUILD, runId: run.id })])
    expect(results.filter((r) => r.ok && r.value.status === 'paid')).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.error.code === 'concurrent_update')).toHaveLength(1)
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('checks the key first: a revoked key fails fast and leaves the run approved', async () => {
    const run = await approvedRun(w)
    await w.communitySvc.revokeBotKey({ guildId: GUILD, root: w.chain.rootSigner(TREASURY) })
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'no_active_key' } })
    expect((await w.svc.get({ guildId: GUILD, runId: run.id })).ok && (await w.repos.runs.get(run.id))?.status).toBe('approved')
    expect(w.chain.broadcastCount).toBe(0)
  })

  it('checks the key first: a key revoked on chain behind our back fails fast as key_revoked', async () => {
    const run = await approvedRun(w)
    const status = await w.communitySvc.keyStatus({ guildId: GUILD })
    if (!status.ok) throw new Error()
    await w.chain.revokeKey({ root: w.chain.rootSigner(TREASURY), accessKey: status.value.key.address })
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'key_revoked' } })
    expect((await w.repos.runs.get(run.id))?.status).toBe('approved')
  })

  it('refuses a run bigger than the remaining limit before signing anything', async () => {
    w = await world({ limit: 3_000_000n })
    const run = await approvedRun(w)
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({
      ok: false,
      error: { code: 'insufficient_limit', remaining: 3_000_000n, needed: 3_500_000n },
    })
    expect(w.chain.broadcastCount).toBe(0)
  })

  it('a definitive chain refusal fails the run (retryable); after a top-up the retry pays once', async () => {
    w = await world({ fund: 1_000_000n })
    const run = await approvedRun(w)
    const r = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(r).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'rejected', retryable: true } } })
    w.chain.fund(TOKEN, TREASURY, 10_000_000n)
    const retry = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(retry).toMatchObject({ ok: true, value: { status: 'paid', run: { attempts: [{ number: 1 }, { number: 2 }] } } })
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('an ambiguous broadcast leaves the run executing; reconcile re-broadcasts the SAME tx and it pays once', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    const r = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(r).toMatchObject({ ok: true, value: { status: 'pending', run: { status: 'executing' } } })
    expect(paidTo(w)).toEqual([0n, 0n])
    const rec = await w.svc.reconcile({ guildId: GUILD, runId: run.id })
    expect(rec).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(rec.ok && rec.value.run.paidTxHash).toBe(rec.ok && rec.value.run.attempts[0]?.txHash)
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('once validBefore has passed with no memos on chain, the attempt is provably dead: fail, then retry pays once', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    w.chain.advance(200)
    w.clock.advance(200)
    expect(await w.svc.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({
      ok: true,
      value: { status: 'failed', failure: { reason: 'not_landed', retryable: true } },
    })
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('never retries a run whose chain record does not match (partial or mismatched payment)', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    // Someone with the treasury key pays line 1 by hand, with the run's memo.
    const status = await w.communitySvc.keyStatus({ guildId: GUILD })
    if (!status.ok) throw new Error()
    const stored = await w.repos.runs.get(run.id)
    const secret = (await w.repos.communities.getBotKey(status.value.key.address))?.sealedSecret.split(':').at(-1) ?? ''
    const manual = await w.chain.signBatch({
      account: TREASURY,
      accessKeySecret: secret,
      token: TOKEN,
      transfers: [{ to: ADDR.alice, amount: 1_500_000n, memo: stored!.lines[0]!.memo }],
      validBefore: w.chain.time + 120,
      fee: { mode: 'sponsor' },
    })
    if (!manual.ok) throw new Error(manual.error.detail)
    await w.chain.broadcast(manual.value.rawTx)
    w.chain.advance(200)
    expect(await w.svc.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({
      ok: true,
      value: { status: 'failed', failure: { reason: 'partial_match', retryable: false } },
    })
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'not_retryable' } })
  })
})

describe('PayRunService: crash recovery (a crash mid-run never pays twice)', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('tx landed but the process died before recording it: recovery finds it and marks paid', async () => {
    const run = await approvedRun(w)
    w.runs.crashOnUpdate = (next) => next.status === 'paid'
    await expect(w.svc.execute({ guildId: GUILD, runId: run.id })).rejects.toThrow('simulated crash')
    expect((await w.repos.runs.get(run.id))?.status).toBe('executing')
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])

    const restarted = w.makeService()
    const recovered = await restarted.recoverInFlight()
    expect(recovered).toEqual([{ guildId: GUILD, runId: run.id, status: 'paid' }])
    expect(await restarted.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('response lost after landing (no crash): reconcile finds the memos and marks paid', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect(await w.svc.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('died after signing but before recording the signed tx: nothing was broadcast; after validBefore it retries once', async () => {
    const run = await approvedRun(w)
    w.runs.crashOnUpdate = (next) => next.status === 'executing' && next.attempts.at(-1)?.txHash != null
    await expect(w.svc.execute({ guildId: GUILD, runId: run.id })).rejects.toThrow('simulated crash')
    expect(w.chain.broadcastCount).toBe(0)

    const restarted = w.makeService()
    expect(await restarted.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    w.chain.advance(200)
    w.clock.advance(200)
    expect(await restarted.recoverInFlight()).toEqual([{ guildId: GUILD, runId: run.id, status: 'failed' }])
    expect(await restarted.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })
})

describe('PayRunService: export', () => {
  it('exports a run as CSV with explorer links on the configured network', async () => {
    const w = await world()
    const run = await approvedRun(w)
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    const r = await w.svc.exportCsv({ guildId: GUILD, runId: run.id })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.filename).toBe(`payrun-${run.id}.csv`)
    expect(r.value.csv).toContain('https://explore.testnet.tempo.xyz/tx/0x')
    expect(r.value.csv.split('\r\n')).toHaveLength(4)
    expect(await w.svc.exportCsv({ guildId: OTHER_GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'run_not_found' } })
  })
})
