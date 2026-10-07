// Pay runs signed with a policy's own key: which key signs which run, the pre-flight against that
// key's budget, holds at generation and at release, and never-pay-twice (recovery, retries, leases)
// with a second key on the same treasury. Real services from createRolepay on in-memory fakes.
import { describe, expect, it } from 'vitest'
import { ANA, GUILD, MONDAY, RUI, TOKEN, TREASURER, TREASURY, asTreasurer, policyWorld, usd } from '../../test/support/policyWorld.js'
import { STABLECOIN_DEX_ADDRESS, SWAP_EXACT_AMOUNT_OUT_SIGNATURE, TESTNET_TOKENS, TRANSFER_WITH_MEMO_SIGNATURE } from '../constants/tempo.js'
import type { Run } from '../domain/run.js'

const WEEK = 7 * 86_400
type World = Awaited<ReturnType<typeof policyWorld>>

/** Gives a policy its own key (the dev path: an in-process root signs what the page would), `limit` a week. */
async function ownKey(w: World, policyId: string, limit: number) {
  const p = await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId, limit: usd(limit), periodSeconds: WEEK, expiresAt: w.chain.time + 60 * 86_400 })
  if (!p.ok) throw new Error(JSON.stringify(p.error))
  const a = await w.rolepay.policyKeys.authorize({ guildId: GUILD, policyId, root: w.chain.rootSigner(TREASURY) })
  if (!a.ok) throw new Error(JSON.stringify(a.error))
  return a.value.key.address
}

const keyLeft = async (w: World, accessKey: string) => (await w.chain.keyState({ account: TREASURY, accessKey: accessKey as `0x${string}`, token: TOKEN, feeToken: null })).remaining
const botKey = async (w: World) => (await w.repos.communities.listBotKeys(GUILD)).find((k) => k.status === 'active')?.address as string

/** The help desk policy's next run, made now in propose mode (Ana 12, Rui 2, Big capped at 50: 64). */
async function proposedRun(w: World, policyId: string): Promise<Run> {
  const made = await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId })
  if (!made.ok) throw new Error(JSON.stringify(made.error))
  if (!made.value.run) throw new Error(`no run: ${JSON.stringify(made.value.policyRun.hold)}`)
  const approved = await w.rolepay.payRuns.approve({ guildId: GUILD, runId: made.value.run.id, actor: TREASURER, actorCanApprove: true })
  if (!approved.ok) throw new Error(JSON.stringify(approved.error))
  return approved.value
}

/** A run made by hand (/rolepay new), approved. */
async function manualRun(w: World, amount: number): Promise<Run> {
  const created = await w.rolepay.payRuns.create({ guildId: GUILD, createdBy: TREASURER, lines: [{ discordUserId: ANA, amount: usd(amount) }] })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  await w.rolepay.payRuns.submit({ guildId: GUILD, runId: created.value.id, actor: TREASURER })
  const approved = await w.rolepay.payRuns.approve({ guildId: GUILD, runId: created.value.id, actor: TREASURER, actorCanApprove: true })
  if (!approved.ok) throw new Error(JSON.stringify(approved.error))
  return approved.value
}

describe('which key signs a run', () => {
  it("a policy's runs are signed with its own key; manual runs and other policies' runs with the bot key", async () => {
    const w = await policyWorld({ limit: 1000 })
    const helpDesk = await w.active()
    const other = await w.active({ name: 'Other desk' })
    const own = await ownKey(w, helpDesk.id, 100)
    const bot = await botKey(w)

    const run = await proposedRun(w, helpDesk.id)
    expect(run.total).toBe(usd(64))
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(await keyLeft(w, own)).toBe(usd(36))
    expect(await keyLeft(w, bot)).toBe(usd(1000))

    const manual = await manualRun(w, 5)
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: manual.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    const otherRun = await proposedRun(w, other.id)
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: otherRun.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(await keyLeft(w, bot)).toBe(usd(1000 - 5 - 64))
    expect(await keyLeft(w, own)).toBe(usd(36))
  })

  it("a run over the policy key's budget is refused before anything is signed, named as the policy key's, even with the bot key full", async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await ownKey(w, p.id, 30)
    // The scheduler would hold this at generation; a person who approves it anyway meets the pre-flight.
    const run = await w.rolepay.payRuns.create({ guildId: GUILD, createdBy: TREASURER, lines: [{ discordUserId: ANA, amount: usd(40) }] }, { runId: 'run_policy_over' })
    if (!run.ok) throw new Error('create')
    await w.repos.policyRuns.claim({ ...(await policyRunFor(w, p.id)), runId: 'run_policy_over' })
    await w.rolepay.payRuns.submit({ guildId: GUILD, runId: 'run_policy_over', actor: TREASURER })
    await w.rolepay.payRuns.approve({ guildId: GUILD, runId: 'run_policy_over', actor: TREASURER, actorCanApprove: true })
    const before = w.chain.broadcastCount
    const r = await w.rolepay.payRuns.execute({ guildId: GUILD, runId: 'run_policy_over' })
    expect(r).toEqual({ ok: false, error: { code: 'insufficient_limit', remaining: usd(30), needed: usd(40), periodEnd: expect.any(Number), key: 'policy' } })
    expect(w.chain.broadcastCount).toBe(before)
    expect((await w.rolepay.payRuns.get({ guildId: GUILD, runId: 'run_policy_over' })).ok && (await w.repos.runs.get('run_policy_over'))?.status).toBe('approved')
  })

  it('a revoked policy key stops that policy (key_revoked, the policy key) and never falls back to the bot key; the bot key keeps paying everything else', async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await ownKey(w, p.id, 100)
    const run = await proposedRun(w, p.id)
    expect((await w.rolepay.policyKeys.revoke({ guildId: GUILD, policyId: p.id, root: w.chain.rootSigner(TREASURY), actor: TREASURER })).ok).toBe(true)
    const before = w.chain.broadcastCount
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'key_revoked', key: 'policy' } })
    expect(w.chain.broadcastCount).toBe(before)
    expect(await keyLeft(w, await botKey(w))).toBe(usd(1000))
    const manual = await manualRun(w, 5)
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: manual.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
  })

  it('a policy key whose sealed secret was moved to another policy does not open (bound to its policy)', async () => {
    const w = await policyWorld({ limit: 1000 })
    const a = await w.active()
    const b = await w.active({ name: 'Other desk' })
    const ownA = await ownKey(w, a.id, 100)
    const ownB = await ownKey(w, b.id, 100)
    const keyA = await w.repos.policyKeys.get(ownA)
    const keyB = await w.repos.policyKeys.get(ownB)
    // Someone with the database swaps policy B's sealed secret for policy A's.
    await w.repos.policyKeys.save({ ...(keyB as NonNullable<typeof keyB>), sealedSecret: keyA?.sealedSecret ?? null })
    const run = await proposedRun(w, b.id)
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'unseal_failed' } })
  })
})

describe('never pay twice, with the policy key', () => {
  it('a crash after the signed tx is recorded: the recovery sweep re-broadcasts the same tx (no key needed) and it pays once', async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    const own = await ownKey(w, p.id, 100)
    const run = await proposedRun(w, p.id)
    w.chain.faults.nextBroadcast = 'drop'
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    expect((await w.repos.runs.get(run.id))?.status).toBe('executing')
    const results = await w.rolepay.payRuns.recoverInFlight()
    expect(results).toEqual([{ guildId: GUILD, runId: run.id, status: 'paid' }])
    expect(w.chain.landedTxCount).toBe(1)
    expect(await keyLeft(w, own)).toBe(usd(36))
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('the policy key is revoked after signing: the broadcast is refused, the retry waits out the deadline, checks the memos, then holds at the pre-flight; nothing is paid, nothing by the bot key', async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await ownKey(w, p.id, 100)
    const run = await proposedRun(w, p.id)
    w.chain.faults.nextBroadcast = 'drop'
    await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })
    await w.rolepay.policyKeys.revoke({ guildId: GUILD, policyId: p.id, root: w.chain.rootSigner(TREASURY), actor: TREASURER })
    // Reconcile re-broadcasts the recorded tx: the chain refuses the revoked key's tx.
    expect(await w.rolepay.payRuns.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'rejected', retryable: true } } })
    // A retry right away waits until that tx can no longer land.
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    w.travel(200)
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'key_revoked', key: 'policy' } })
    expect(w.chain.landedTxCount).toBe(0)
    expect(await keyLeft(w, await botKey(w))).toBe(usd(1000))
  })

  it('a bot key run and a policy key run in flight together on one treasury each pay once (expiring nonces, separate leases)', async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await ownKey(w, p.id, 100)
    const policyRun = await proposedRun(w, p.id)
    const manual = await manualRun(w, 5)
    const [a, b] = await Promise.all([w.rolepay.payRuns.execute({ guildId: GUILD, runId: policyRun.id }), w.rolepay.payRuns.execute({ guildId: GUILD, runId: manual.id })])
    expect([a.ok && a.value.status, b.ok && b.value.status]).toEqual(['paid', 'paid'])
    expect(w.chain.landedTxCount).toBe(2)
    expect(w.chain.balance(TOKEN, '0x1111111111111111111111111111111111111111')).toBe(usd(12 + 5))
  })
})

describe('the scheduler and the preview hold a policy against its own key', () => {
  it("generation: a run over the policy key's budget is held whole as over_policy_budget, with the bot key full; no pay run is made", async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await ownKey(w, p.id, 30)
    const preview = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    expect(preview).toMatchObject({ ok: true, value: { total: usd(64), remaining: usd(30), budgetKey: 'policy' } })
    expect(preview.ok && preview.value.problems).toContain('over_policy_budget')
    w.travelTo(MONDAY)
    const { events } = await w.rolepay.scheduler.tick()
    expect(events).toHaveLength(1)
    expect(events[0]?.policyRun).toMatchObject({ status: 'held', hold: { code: 'over_policy_budget', total: usd(64), limit: usd(30) }, runId: null, remaining: usd(30) })
    expect(events[0]?.run).toBeNull()
  })

  it('a policy without its own key is held against the bot key exactly as before', async () => {
    const w = await policyWorld({ limit: 50 })
    const p = await w.active()
    const preview = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    expect(preview).toMatchObject({ ok: true, value: { remaining: usd(50), budgetKey: 'bot' } })
    w.travelTo(MONDAY)
    const { events } = await w.rolepay.scheduler.tick()
    expect(events[0]?.policyRun).toMatchObject({ status: 'held', hold: { code: 'over_budget', total: usd(64), limit: usd(50) } })
  })

  it("a revoked own key holds the policy's next run as policy_key_inactive, whatever the bot key has", async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await ownKey(w, p.id, 100)
    await w.rolepay.policyKeys.revoke({ guildId: GUILD, policyId: p.id, root: w.chain.rootSigner(TREASURY), actor: TREASURER })
    w.travelTo(MONDAY)
    const { events } = await w.rolepay.scheduler.tick()
    expect(events[0]?.policyRun).toMatchObject({ status: 'held', hold: { code: 'policy_key_inactive' }, remaining: null })
  })

  it('autopilot: the release pays with the policy key, never the bot key', async () => {
    const w = await policyWorld({ limit: 1000, minVetoMinutes: 1 })
    const p = await w.active({}, { vetoWindowMinutes: 60 })
    const own = await ownKey(w, p.id, 100)
    const made = await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId: p.id })
    expect(made.ok && made.value.policyRun.status).toBe('scheduled')
    w.travel(3601)
    const released = await w.rolepay.scheduler.tick()
    expect(released.events).toMatchObject([{ kind: 'released', outcome: 'paid' }])
    expect(await keyLeft(w, own)).toBe(usd(36))
    expect(await keyLeft(w, await botKey(w))).toBe(usd(1000))
  })

  it('autopilot: the policy key revoked during the veto window holds the run (policy_key_inactive); nothing is paid', async () => {
    const w = await policyWorld({ limit: 1000, minVetoMinutes: 1 })
    const p = await w.active({}, { vetoWindowMinutes: 60 })
    await ownKey(w, p.id, 100)
    const made = await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId: p.id })
    expect(made.ok && made.value.policyRun.status).toBe('scheduled')
    await w.rolepay.policyKeys.revoke({ guildId: GUILD, policyId: p.id, root: w.chain.rootSigner(TREASURY), actor: TREASURER })
    w.travel(3601)
    const held = await w.rolepay.scheduler.tick()
    expect(held.events).toMatchObject([{ kind: 'held', policyRun: { status: 'held', hold: { code: 'policy_key_inactive' } } }])
    expect(held.events[0]?.run?.status).toBe('approved')
    expect(w.chain.landedTxCount).toBe(0)
    expect(w.chain.balance(TOKEN, '0x2222222222222222222222222222222222222222')).toBe(0n)
    void RUI
  })
})

describe("a policy's own key and preferred stablecoins (each payee in the stablecoin they chose)", () => {
  const BETA = TESTNET_TOKENS.beta_usd
  const THETA = TESTNET_TOKENS.theta_usd

  /**
   * The help desk policy with preferred stablecoins on and Ana choosing BetaUSD. Its own key is
   * authorised after the switch (with the swap scope), or with `keyFirst` before it (without). The
   * bot key, authorised before the switch, cannot swap: a swap that pays must be the policy key's.
   */
  async function preferring(opts: { keyFirst?: boolean; limit?: number; autopilot?: boolean } = {}) {
    const w = await policyWorld({ limit: 1000, ...(opts.autopilot ? { minVetoMinutes: 1 } : {}) })
    const p = await w.active({}, opts.autopilot ? { vetoWindowMinutes: 60 } : null)
    const first = opts.keyFirst ? await ownKey(w, p.id, opts.limit ?? 100) : null
    expect(await w.rolepay.communities.setPreferredTokens({ guildId: GUILD, enabled: true })).toMatchObject({ ok: true, value: { keyNeedsSwapScope: true } })
    const own = first ?? (await ownKey(w, p.id, opts.limit ?? 100))
    expect(await w.rolepay.payees.setPreferredToken({ guildId: GUILD, discordUserId: ANA, token: BETA })).toMatchObject({ ok: true })
    w.chain.setSwapRoute(TOKEN, BETA, { inPerOutBps: 9_954, liquidity: usd(100_000) })
    return { w, p, own }
  }

  it('provisioned while preferred stablecoins are on, its authorisation carries exactly the bot key scope for them, under the policy limit', async () => {
    const w = await policyWorld({ limit: 1000 })
    const p = await w.active()
    await w.rolepay.communities.setPreferredTokens({ guildId: GUILD, enabled: true })
    const provisioned = await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId: p.id, limit: usd(30), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 })
    if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error))
    expect(provisioned.value.authorization.scopes).toEqual([
      { address: TOKEN, selector: TRANSFER_WITH_MEMO_SIGNATURE },
      { address: STABLECOIN_DEX_ADDRESS, selector: SWAP_EXACT_AMOUNT_OUT_SIGNATURE },
      { address: BETA, selector: TRANSFER_WITH_MEMO_SIGNATURE },
      { address: THETA, selector: TRANSFER_WITH_MEMO_SIGNATURE },
    ])
    expect(provisioned.value.authorization.limits).toEqual([
      { token: TOKEN, limit: usd(30), period: WEEK },
      { token: BETA, limit: usd(30), period: WEEK },
      { token: THETA, limit: usd(30), period: WEEK },
    ])
    const bot = await w.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd(30), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 })
    expect(bot.ok && bot.value.authorization.scopes).toEqual(provisioned.value.authorization.scopes)
  })

  it('a policy run with a swapped line is paid by the policy key alone: the swap input off its payout limit, the delivery off its BetaUSD limit', async () => {
    const { w, p, own } = await preferring()
    const run = await proposedRun(w, p.id)
    expect(run.lines.find((l) => l.payeeDiscordId === ANA)).toMatchObject({ amount: usd(12), swap: { token: BETA, maxIn: usd(12.12) } })
    const quote = await w.chain.quoteSwap({ tokenIn: TOKEN, tokenOut: BETA, amountOut: usd(12) })
    if (quote.kind !== 'quoted') throw new Error('no quote')
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(w.chain.balance(BETA, '0x1111111111111111111111111111111111111111')).toBe(usd(12))
    expect(await keyLeft(w, own)).toBe(usd(100 - 52) - quote.amountIn)
    expect((await w.chain.keyState({ account: TREASURY, accessKey: own as `0x${string}`, token: BETA, feeToken: null })).remaining).toBe(usd(100 - 12))
    expect(await keyLeft(w, await botKey(w))).toBe(usd(1000))
  })

  it("the pre-flight holds it against the policy key's remaining budget with the swap at its maximum input (64 to pay, up to 64.12, 64.1 left): refused as the policy key's, nothing signed", async () => {
    const { w, p } = await preferring()
    const run = await proposedRun(w, p.id)
    expect(run.total).toBe(usd(64))
    // The policy's key is replaced by one with 64.1 a week: enough for the total, not for the swap's maximum.
    const smaller = await ownKey(w, p.id, 64.1)
    const before = w.chain.broadcastCount
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({
      ok: false,
      error: { code: 'insufficient_limit', remaining: usd(64.1), needed: usd(64.12), periodEnd: expect.any(Number), key: 'policy' },
    })
    expect(w.chain.broadcastCount).toBe(before)
    expect(await w.repos.runs.get(run.id)).toMatchObject({ status: 'approved', attempts: [] })
    expect(await keyLeft(w, smaller)).toBe(usd(64.1))
    expect(await keyLeft(w, await botKey(w))).toBe(usd(1000))
  })

  it("generation: a run under the policy key's budget but over it with the swap at its maximum (64 to pay, up to 64.12, 64.1 left) is held whole as swaps_over_policy_budget; no pay run is made", async () => {
    const { w, p } = await preferring({ limit: 64.1 })
    const preview = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    expect(preview).toMatchObject({ ok: true, value: { total: usd(64), spend: usd(64.12), remaining: usd(64.1), budgetKey: 'policy' } })
    expect(preview.ok && preview.value.problems).toContain('swaps_over_policy_budget')
    w.travelTo(MONDAY)
    const { events } = await w.rolepay.scheduler.tick()
    expect(events).toHaveLength(1)
    expect(events[0]?.policyRun).toMatchObject({ status: 'held', hold: { code: 'swaps_over_policy_budget', total: usd(64.12), limit: usd(64.1) }, runId: null, total: usd(64), remaining: usd(64.1) })
    expect(events[0]?.run).toBeNull()
    expect(await w.repos.runs.listByCommunity(GUILD)).toEqual([])
  })

  it('a policy key authorised before the switch cannot swap: the run is held with swap_not_authorized, as the bot key would be, never signed and never handed to the bot key', async () => {
    const { w, p, own } = await preferring({ keyFirst: true })
    const run = await proposedRun(w, p.id)
    expect(await w.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'swap_not_authorized', tokens: [BETA], key: 'policy' } })
    expect(w.chain.broadcastCount).toBe(0)
    expect(await w.repos.runs.get(run.id)).toMatchObject({ status: 'approved', attempts: [] })
    expect(await keyLeft(w, own)).toBe(usd(100))
    expect(await keyLeft(w, await botKey(w))).toBe(usd(1000))
  })

  it('autopilot: the same refusal at the release holds the policy run (swap_not_authorized); nothing is paid', async () => {
    const { w, p } = await preferring({ keyFirst: true, autopilot: true })
    const made = await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId: p.id })
    expect(made.ok && made.value.policyRun.status).toBe('scheduled')
    w.travel(3601)
    const held = await w.rolepay.scheduler.tick()
    expect(held.events).toMatchObject([{ kind: 'held', policyRun: { status: 'held', hold: { code: 'swap_not_authorized' } } }])
    expect(w.chain.broadcastCount).toBe(0)
  })
})

/** A PolicyRun record linking a pay run to the policy (as the scheduler's claim would), for runs made by hand in a test. */
async function policyRunFor(w: World, policyId: string) {
  const { newPolicyRun } = await import('../domain/policy/policyRun.js')
  const now = w.clock.now()
  return newPolicyRun({ id: 'prun_by_hand', policyId, policyVersion: 1, communityId: GUILD, mode: 'propose', window: { start: new Date(now.getTime() - 86_400_000), end: now }, runId: 'run_policy_over', now, leaseUntil: now })
}
