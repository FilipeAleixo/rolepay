import { beforeEach, describe, expect, it } from 'vitest'
import { KvRunLeases } from '../adapters/kv/runLeases.js'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { MemoryKeyValueStore } from '../adapters/memory/keyValue.js'
import { createMemoryRepositories } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import type { Run } from '../domain/run.js'
import type { RunRepository } from '../ports/repositories.js'
import type { RunLeases } from '../ports/runLeases.js'
import * as f from '../../test/support/fixtures.js'
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
  listPaid = (c: string, o: { since: Date }) => this.inner.listPaid(c, o)
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
  const makeService = (leases: RunLeases | null = null) =>
    new PayRunService({ runs, payees: repos.payees, communities: repos.communities, policyRuns: repos.policyRuns, policyKeys: repos.policyKeys, chain, vault, ids, clock, network: 'moderato', leases })

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
    await repos.payees.upsert({ communityId: GUILD, discordUserId: id, address, preferredToken: null, registeredAt: now, updatedAt: now })
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

/**
 * Holds the next broadcast until `open()`: a payment in flight, so another worker can be run in the
 * middle of it. `reached` resolves once the broadcast has started. Any other broadcast meanwhile
 * waits at the same gate.
 */
function holdBroadcast(chain: FakePayoutChain) {
  const real = chain.broadcast.bind(chain)
  let open = () => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let entered = () => {}
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  chain.broadcast = async (rawTx) => {
    entered()
    await gate
    return real(rawTx)
  }
  return { reached, open }
}

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

  it('the creator may approve their own run by default; with requireSeparateApprover another approver must', async () => {
    const w = await world()
    const own = async () => {
      const created = await w.svc.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines: LINES })
      if (!created.ok) throw new Error(created.error.code)
      await w.svc.submit({ guildId: GUILD, runId: created.value.id, actor: TREASURER })
      return created.value.id
    }
    const first = await own()
    expect(await w.svc.approve({ guildId: GUILD, runId: first, actor: TREASURER, actorCanApprove: true })).toMatchObject({ ok: true, value: { status: 'approved' } })

    await w.communitySvc.register({ guildId: '1094309218049937420', name: null, treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
    const c = await w.repos.communities.get(GUILD)
    if (!c) throw new Error('no community')
    await w.repos.communities.update({ ...c, requireSeparateApprover: true })
    const second = await own()
    expect(await w.svc.approve({ guildId: GUILD, runId: second, actor: TREASURER, actorCanApprove: true })).toEqual({ ok: false, error: { code: 'creator_cannot_approve' } })
    expect(await w.svc.get({ guildId: GUILD, runId: second })).toMatchObject({ ok: true, value: { status: 'pending_approval' } })
    expect(await w.svc.approve({ guildId: GUILD, runId: second, actor: CAROL, actorCanApprove: true })).toMatchObject({ ok: true, value: { status: 'approved' } })
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

  it('reads the key state and the chain head at the same time (one round trip to the node, not two)', async () => {
    const run = await approvedRun(w)
    const keyState = w.chain.keyState.bind(w.chain)
    const head = w.chain.head.bind(w.chain)
    let inFlight = 0
    let peak = 0
    const slowRead = async <T>(read: () => Promise<T>): Promise<T> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return read()
    }
    w.chain.keyState = (input) => slowRead(() => keyState(input))
    w.chain.head = () => slowRead(() => head())
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(peak).toBe(2)
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

  it('a definitive chain refusal fails the run (retryable); after a top-up and the old deadline, the retry pays once', async () => {
    w = await world({ fund: 1_000_000n })
    const run = await approvedRun(w)
    const r = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(r).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'rejected', retryable: true } } })
    w.chain.fund(TOKEN, TREASURY, 10_000_000n)
    w.chain.advance(200)
    w.clock.advance(200)
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
    const secret = (await w.repos.communities.getBotKey(status.value.key.address))?.sealedSecret?.split(':').at(-1) ?? ''
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

describe('PayRunService: telling the truth about failed and unsure runs', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })
  const pastDeadline = () => {
    w.chain.advance(200)
    w.clock.advance(200)
  }
  /** Line 1 of the run paid by hand with the run's memo (someone holding the key, or a stray tx). */
  async function payLineOneByHand(runId: string) {
    const status = await w.communitySvc.keyStatus({ guildId: GUILD })
    if (!status.ok) throw new Error()
    const stored = await w.repos.runs.get(runId)
    const secret = (await w.repos.communities.getBotKey(status.value.key.address))?.sealedSecret?.split(':').at(-1) ?? ''
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
  }

  it('reconcile reads the head before the memo search: a tx landing between the two reads is never called not_landed', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    const attempt = (await w.repos.runs.get(run.id))?.attempts[0]
    if (!attempt?.rawTx) throw new Error('no signed tx')
    w.chain.advance(attempt.validBefore - 5 - w.chain.time) // just before the deadline
    // The tx lands while the memo search is in flight, and the next read of the head is a slow one, well past the deadline.
    const search = w.chain.findMemoTransfers.bind(w.chain)
    let raced = false
    w.chain.findMemoTransfers = async (input) => {
      const found = await search(input)
      if (!raced) {
        raced = true
        await w.chain.broadcast(attempt.rawTx as `0x${string}`)
        w.chain.advance(30)
      }
      return found
    }
    const r = await w.svc.reconcile({ guildId: GUILD, runId: run.id })
    expect(r).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('a retry of a failed run whose payments are all on chain records it paid and sends nothing new', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'rejected' } } })
    await w.chain.mine() // the "rejected" tx lands after all
    pastDeadline()
    const broadcasts = w.chain.broadcastCount
    const retry = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(retry).toMatchObject({ ok: true, value: { status: 'paid', run: { status: 'paid', failure: null } } })
    expect(w.chain.broadcastCount).toBe(broadcasts)
    expect(w.chain.landedTxCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('a retry that finds some of the run on chain refuses (chain_shows_payments), sends nothing, and the run can no longer be retried or cancelled', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    pastDeadline()
    expect(await w.svc.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'not_landed', retryable: true } } })
    await payLineOneByHand(run.id)
    pastDeadline()
    const broadcasts = w.chain.broadcastCount
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'chain_shows_payments', detail: 'partial' } })
    expect(w.chain.broadcastCount).toBe(broadcasts)
    expect(await w.repos.runs.get(run.id)).toMatchObject({ status: 'failed', failure: { reason: 'partial_match', retryable: false } })
    expect(await w.svc.cancel({ guildId: GUILD, runId: run.id, actor: TREASURER })).toEqual({ ok: false, error: { code: 'chain_shows_payments', detail: 'partial' } })
    expect((await w.repos.runs.get(run.id))?.status).toBe('failed')
    expect(paidTo(w)).toEqual([1_500_000n, 0n])
  })

  it('cancelling a failed run whose payments are on chain is refused, and the run is recorded paid', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    await w.chain.mine()
    pastDeadline()
    expect(await w.svc.cancel({ guildId: GUILD, runId: run.id, actor: TREASURER })).toEqual({ ok: false, error: { code: 'chain_shows_payments', detail: 'all_paid' } })
    expect(await w.repos.runs.get(run.id)).toMatchObject({ status: 'paid', cancelledBy: null })
  })

  it('a failed run with nothing on chain can still be cancelled', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    pastDeadline()
    await w.svc.reconcile({ guildId: GUILD, runId: run.id })
    expect(await w.svc.cancel({ guildId: GUILD, runId: run.id, actor: TREASURER })).toMatchObject({ ok: true, value: { status: 'cancelled' } })
  })
})

describe('PayRunService: a new attempt waits until the last one can no longer land', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('a retry right after a broadcast "rejected" (misread while the tx sat in a mempool) waits, so the old and a new tx never both land', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'rejected' } } })
    const prior = (await w.repos.runs.get(run.id))?.attempts[0]
    if (!prior) throw new Error('no attempt')

    const early = await w.svc.execute({ guildId: GUILD, runId: run.id })
    expect(early).toEqual({ ok: true, value: { status: 'pending', run: expect.objectContaining({ status: 'failed' }), retryAfter: new Date((prior.validBefore + 10) * 1000) } })
    expect(w.chain.broadcastCount).toBe(1)
    expect((await w.repos.runs.get(run.id))?.attempts).toHaveLength(1)

    await w.chain.mine() // the old tx lands inside its window
    w.chain.advance(prior.validBefore + 11 - w.chain.time)
    w.clock.advance(200)
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('the wait is by chain time: exactly at the deadline plus margin it still waits, one second later it goes', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    const prior = (await w.repos.runs.get(run.id))?.attempts[0]
    if (!prior) throw new Error('no attempt')
    w.clock.advance(3600) // the server clock alone does not count
    w.chain.advance(prior.validBefore + 10 - w.chain.time)
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    w.chain.advance(1)
    expect(await w.svc.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid', run: { attempts: [{ number: 1 }, { number: 2 }] } } })
    await w.chain.mine() // the old tx is past its deadline: it can never land now
    expect(w.chain.landedTxCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('cancelling a failed run also waits until its last tx can no longer land, then checks the chain', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    const prior = (await w.repos.runs.get(run.id))?.attempts[0]
    if (!prior) throw new Error('no attempt')
    expect(await w.svc.cancel({ guildId: GUILD, runId: run.id, actor: TREASURER })).toEqual({
      ok: false,
      error: { code: 'attempt_may_still_land', retryAfter: new Date((prior.validBefore + 10) * 1000) },
    })
    await w.chain.mine()
    w.chain.advance(200)
    expect(await w.svc.cancel({ guildId: GUILD, runId: run.id, actor: TREASURER })).toMatchObject({ ok: false, error: { code: 'chain_shows_payments' } })
    expect((await w.repos.runs.get(run.id))?.status).toBe('paid')
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

  it('one run whose reconcile throws (an RPC refusing an old log range, say) does not stop the sweep for the others', async () => {
    const stuck = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'drop'
    await w.svc.execute({ guildId: GUILD, runId: stuck.id })
    w.clock.advance(1)
    const fine = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    await w.svc.execute({ guildId: GUILD, runId: fine.id })
    const lookup = w.chain.lookupTx.bind(w.chain)
    const stuckHash = (await w.repos.runs.get(stuck.id))?.attempts[0]?.txHash
    w.chain.lookupTx = async (hash) => {
      if (hash === stuckHash) throw new Error('HTTP request failed. URL: https://rpc.example/key-abc123 details: range too large')
      return lookup(hash)
    }
    const results = await w.svc.recoverInFlight()
    expect(results).toContainEqual({ guildId: GUILD, runId: fine.id, status: 'paid' })
    expect(results).toContainEqual({ guildId: GUILD, runId: stuck.id, status: 'error', error: 'unexpected', detail: 'HTTP request failed. URL: <url> details: range too large' })
    expect((await w.repos.runs.get(stuck.id))?.status).toBe('executing')
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

describe('PayRunService: one worker per run (the Approve job, the recovery sweep, another instance)', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })
  const ref = (run: Run) => ({ guildId: GUILD, runId: run.id })
  /** Two server instances over the same database and chain, each with its own leases. */
  const instances = () => {
    const kv = new MemoryKeyValueStore(w.clock)
    return { a: w.makeService(new KvRunLeases(kv, { instance: 'machine-a' })), b: w.makeService(new KvRunLeases(kv, { instance: 'machine-b' })) }
  }

  it('the sweep of another instance leaves alone a run whose payment is in flight: one broadcast, no conflict', async () => {
    const { a, b } = instances()
    const run = await approvedRun(w)
    const hold = holdBroadcast(w.chain)
    const paying = a.execute(ref(run))
    await hold.reached
    expect((await w.repos.runs.get(run.id))?.status).toBe('executing')

    expect(await b.recoverInFlight()).toEqual([])

    hold.open()
    expect(await paying).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.broadcastCount).toBe(1)
    expect(w.chain.landedTxCount).toBe(1)
    expect(await b.recoverInFlight()).toEqual([])
  })

  it('a second worker asking to execute or reconcile a run another holds is told concurrent_update at once and sends nothing', async () => {
    const { a, b } = instances()
    const run = await approvedRun(w)
    const hold = holdBroadcast(w.chain)
    const paying = a.execute(ref(run))
    await hold.reached

    expect(await b.execute(ref(run))).toEqual({ ok: false, error: { code: 'concurrent_update' } })
    expect(await b.reconcile(ref(run))).toEqual({ ok: false, error: { code: 'concurrent_update' } })

    hold.open()
    await paying
    expect(w.chain.broadcastCount).toBe(1)
    expect(paidTo(w)).toEqual([1_500_000n, 2_000_000n])
  })

  it('a worker gives the run back when its step ends, also when the step throws', async () => {
    const { a, b } = instances()
    const run = await approvedRun(w)
    w.runs.crashOnUpdate = (next) => next.status === 'paid'
    await expect(a.execute(ref(run))).rejects.toThrow('simulated crash')
    expect(await b.recoverInFlight()).toEqual([{ guildId: GUILD, runId: run.id, status: 'paid' }])
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('the sweep skips a run its caller has a job for in this process, even between the job steps', async () => {
    const run = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    expect(await w.svc.execute(ref(run))).toMatchObject({ ok: true, value: { status: 'pending' } })

    expect(await w.svc.recoverInFlight({ skip: (r) => r.runId === run.id })).toEqual([])
    expect((await w.repos.runs.get(run.id))?.status).toBe('executing')

    expect(await w.svc.recoverInFlight()).toEqual([{ guildId: GUILD, runId: run.id, status: 'paid' }])
  })

  it('the sweep reads each run again before reconciling it: one another worker finished after the listing is left alone', async () => {
    const first = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    await w.svc.execute(ref(first))
    w.clock.advance(1)
    const second = await approvedRun(w)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    await w.svc.execute(ref(second))

    // While the sweep works on the first run it listed, another worker (the run's own job) settles the other one.
    const lookup = w.chain.lookupTx.bind(w.chain)
    let other: Run | null = null
    let settling = false
    const sweptLookups: string[] = []
    w.chain.lookupTx = async (hash) => {
      if (!settling) sweptLookups.push(hash)
      if (other === null) {
        other = hash === (await w.repos.runs.get(first.id))?.attempts[0]?.txHash ? second : first
        settling = true
        expect(await w.svc.reconcile(ref(other))).toMatchObject({ ok: true, value: { status: 'paid' } })
        settling = false
      }
      return lookup(hash)
    }
    const results = await w.makeService().recoverInFlight()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'paid' })
    expect(results.map((r) => r.runId)).not.toContain((other as Run | null)?.id)
    // The settled run was not even looked up on chain: the sweep read it first and left it.
    expect(sweptLookups).toHaveLength(1)
    expect(w.chain.landedTxCount).toBe(2)
  })
})

describe('PayRunService: what was paid each week (the dashboard)', () => {
  async function paidRun(w: World, lines = LINES): Promise<Run> {
    const run = await approvedRun(w, lines)
    const r = await w.svc.execute({ guildId: GUILD, runId: run.id })
    if (!r.ok || r.value.status !== 'paid') throw new Error('the run did not pay')
    return r.value.run
  }

  it('sums paid runs per UTC week by when they were paid, split into runs a policy made and runs made by hand, and nothing else', async () => {
    const w = await world({ limit: 100_000_000n })
    const byHand = await paidRun(w) // Tuesday 2026-10-06: the week of Monday 2026-10-05
    w.clock.advance(7 * 86_400)
    const byPolicy = await paidRun(w, [{ discordUserId: ALICE, amount: 62_000_000n }]) // the week of 2026-10-12, the current one
    await w.repos.policyRuns.claim(f.policyRun({ runId: byPolicy.id }))
    await approvedRun(w) // approved, never paid
    const waiting = await w.svc.create({ guildId: GUILD, createdBy: ALICE, note: null, lines: LINES })
    if (!waiting.ok) throw new Error(waiting.error.code)
    // A policy run of another community that names one of these runs does not make it a policy's.
    await w.repos.policyRuns.claim(f.policyRun({ id: 'prun_foreign', policyId: 'pol_other', communityId: OTHER_GUILD, periodKey: 'other', runId: byHand.id }))

    const r = await w.svc.paidByWeek({ guildId: GUILD })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.token).toBe(TOKEN)
    expect(r.value.weeks).toHaveLength(12)
    expect(r.value.since).toEqual(new Date('2026-07-27T00:00:00Z'))
    expect(r.value.weeks.slice(10)).toEqual([
      { start: new Date('2026-10-05T00:00:00Z'), policy: 0n, manual: 3_500_000n, runs: 1, partial: false },
      { start: new Date('2026-10-12T00:00:00Z'), policy: 62_000_000n, manual: 0n, runs: 1, partial: true },
    ])
    expect(r.value.weeks.slice(0, 10).every((week) => week.runs === 0)).toBe(true)
    expect(r.value).toMatchObject({ total: 65_500_000n, policy: 62_000_000n, manual: 3_500_000n, runs: 2 })
  })

  it('takes the number of weeks (1 to 52), and refuses an unknown community or a bad value', async () => {
    const w = await world()
    await paidRun(w)
    const four = await w.svc.paidByWeek({ guildId: GUILD, weeks: 4 })
    expect(four.ok && four.value.weeks.map((week) => week.manual)).toEqual([0n, 0n, 0n, 3_500_000n])
    const other = await w.svc.paidByWeek({ guildId: OTHER_GUILD })
    expect(other.ok && other.value.total).toBe(0n)
    expect(await w.svc.paidByWeek({ guildId: '1094309218049937499' })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect(await w.svc.paidByWeek({ guildId: GUILD, weeks: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await w.svc.paidByWeek({ guildId: GUILD, weeks: 53 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })
})

describe('PayRunService: export', () => {
  it('exports a run as CSV with explorer links on the configured network', async () => {
    const w = await world()
    const run = await approvedRun(w)
    await w.svc.execute({ guildId: GUILD, runId: run.id })
    const r = await w.svc.exportCsv({ guildId: GUILD, runId: run.id })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.filename).toBe(`rolepay-${run.id}.csv`)
    expect(r.value.csv).toContain('https://explore.testnet.tempo.xyz/tx/0x')
    expect(r.value.csv.split('\r\n')).toHaveLength(4)
    expect(await w.svc.exportCsv({ guildId: OTHER_GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'run_not_found' } })
  })
})
