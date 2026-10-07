import { z } from 'zod'
import { MAX_NOTE_LENGTH, SWAP_SLIPPAGE } from '../constants/limits.js'
import { NETWORKS, type NetworkName, VALID_BEFORE_MARGIN_SECONDS, VALID_BEFORE_SECONDS } from '../constants/tempo.js'
import { type BotKey, type Community, type KeyCheckError, botKeyContext, checkKeyForRun } from '../domain/community.js'
import { runToCsv } from '../domain/csv.js'
import { type SwapCheckError, checkSwapQuotes, checkSwapScope, lineSwapFor, payoutSpendCap, swapLegs } from '../domain/delivery.js'
import { type Address, DiscordIdSchema } from '../domain/ids.js'
import { type PaidByWeek, firstWeekStart, paidByWeek } from '../domain/paidByWeek.js'
import { type PolicyKeyCheckError, policyKeyContext, policyKeyError, policySigner } from '../domain/policy/policyKey.js'
import { type MatchResult, matchTransfers, runTokens } from '../domain/reconcile.js'
import { type Result, err, ok } from '../domain/result.js'
import { type Failure, type NewRunError, type Run, type RunEvent, type RunStatus, currentAttempt, newRun, transition } from '../domain/run.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { KeyVault } from '../ports/keyVault.js'
import type { BroadcastOutcome, FeePayment, PayoutChain } from '../ports/payoutChain.js'
import type { CommunityRepository, PayeeRepository, PolicyKeyRepository, PolicyRunRepository, RunRepository } from '../ports/repositories.js'
import type { AuditTrail } from './auditTrail.js'
import type { RunLeases } from '../ports/runLeases.js'
import { type InvalidInput, invalidInput } from './common.js'

export type PayRunServiceDeps = {
  runs: RunRepository
  payees: PayeeRepository
  communities: CommunityRepository
  /** Read only: which policy made a run (the weekly totals split policy runs from runs made by hand; which key signs it). */
  policyRuns: PolicyRunRepository
  /** Read only: a policy's own access key, which signs that policy's runs instead of the bot key. */
  policyKeys: PolicyKeyRepository
  chain: PayoutChain
  vault: KeyVault
  ids: IdGenerator
  clock: Clock
  network: NetworkName
  /** The audit stream (best effort: a failed write never fails a payment step). */
  audit?: AuditTrail
  /**
   * One worker per run at a time (the Approve job, the recovery sweep, another instance): each
   * execute, reconcile and swept run holds the run's lease. Without leases only the version
   * compare-and-set separates workers, which is enough for money but lets two of them repeat a
   * broadcast and race to record it.
   */
  leases?: RunLeases | null
  /**
   * A line paid in a payee's preferred stablecoin may spend at most its amount plus this many basis
   * points of the payout token (ROLEPAY_SWAP_MAX_SLIPPAGE_BPS, 100 = 1% by default). Fixed on the line
   * when the run is created, so the approver sees it and every attempt signs the same maximum.
   */
  swapMaxSlippageBps?: number
}

/**
 * How long one execute or reconcile may hold a run. Longer than the slowest step: a sync broadcast
 * the public RPC leaves hanging for about a minute, then up to a minute of receipt polling.
 */
const RUN_LEASE_SECONDS = 180

export const CreateRunInputSchema = z.object({
  guildId: DiscordIdSchema,
  createdBy: DiscordIdSchema,
  note: z.string().trim().max(MAX_NOTE_LENGTH).nullable().default(null),
  lines: z.array(z.object({ discordUserId: DiscordIdSchema, amount: z.bigint().positive() })),
})
export type CreateRunInput = z.input<typeof CreateRunInputSchema>

export const PaidByWeekInputSchema = z.object({ guildId: DiscordIdSchema, weeks: z.number().int().min(1).max(52).default(12) })
export type PaidByWeekInput = z.input<typeof PaidByWeekInputSchema>

type RunRef = { guildId: string; runId: string }
type NotFound = { code: 'run_not_found' }
type IllegalState = { code: 'illegal_state'; status: RunStatus }
type Conflict = { code: 'concurrent_update' }
type StepError = NotFound | IllegalState | Conflict

/**
 * Where a run stands after an execute or reconcile call. `pending` = check again after
 * `retryAfter`: reconcile an executing run; call execute again for a failed run that is waiting
 * for its last attempt's deadline before a new one.
 */
export type ExecuteOutcome =
  | { status: 'paid'; run: Run }
  | { status: 'pending'; run: Run; retryAfter: Date | null }
  | { status: 'failed'; run: Run; failure: Failure }

export type ExecuteError =
  | StepError
  | KeyCheckError
  /** The same checks on a policy's own key (`key: 'policy'`): never explained as the bot key's. */
  | PolicyKeyCheckError
  | { code: 'community_not_found' }
  | { code: 'no_active_key' }
  | { code: 'unseal_failed' }
  | { code: 'not_retryable' }
  | ChainShowsPayments
  | SwapCheckError

/** A failed run's memos are on chain: Rolepay records what the chain shows and sends nothing. */
export type ChainShowsPayments = { code: 'chain_shows_payments'; detail: 'all_paid' | 'partial' | 'mismatch' }
/** A failed run's last signed tx could still land until `retryAfter`: nothing can be decided before. */
export type AttemptMayStillLand = { code: 'attempt_may_still_land'; retryAfter: Date }

/**
 * Pay runs: build, approve, execute, reconcile, export.
 *
 * Never-pay-twice rests on three facts: (1) a run moves to `executing` by
 * compare-and-set, so one worker owns an attempt; (2) the signed tx is persisted
 * before it is broadcast, and re-broadcasting it can land it at most once; (3) every
 * attempt has a validBefore deadline, so once chain time passes it with no memo
 * transfers on chain, the attempt provably never paid and a new one is safe.
 */
export class PayRunService {
  constructor(private readonly deps: PayRunServiceDeps) {}

  /**
   * `opts.runId`: for a caller that must know the ID before the run exists (the scheduler records
   * it first, so a crash between the two can never make a second run). Default: a fresh ID.
   */
  async create(
    input: CreateRunInput,
    opts: { runId?: string } = {},
  ): Promise<Result<Run, InvalidInput | NewRunError | { code: 'community_not_found' } | { code: 'unregistered_payees'; discordUserIds: string[] }>> {
    const parsed = CreateRunInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { guildId, createdBy, note, lines } = parsed.data
    const community = await this.deps.communities.get(guildId)
    if (!community) return err({ code: 'community_not_found' })
    const resolved = await Promise.all(lines.map(async (l) => ({ ...l, payee: await this.deps.payees.get(guildId, l.discordUserId) })))
    const missing = [...new Set(resolved.filter((l) => !l.payee).map((l) => l.discordUserId))]
    if (missing.length) return err({ code: 'unregistered_payees', discordUserIds: missing })
    const capBps = this.deps.swapMaxSlippageBps ?? SWAP_SLIPPAGE.defaultBps
    const run = newRun({
      id: opts.runId ?? this.deps.ids.runId(),
      communityId: guildId,
      token: community.payoutToken,
      note: note || null,
      createdBy,
      // Each payee in the stablecoin they prefer, when the community has that on: fixed here, on the line.
      lines: resolved.map((l) => ({
        payeeDiscordId: l.discordUserId,
        address: l.payee?.address ?? '',
        amount: l.amount,
        swap: l.payee ? lineSwapFor(community, l.payee, l.amount, capBps) : null,
      })),
      now: this.deps.clock.now(),
    })
    if (!run.ok) return run
    await this.deps.runs.insert(run.value)
    await this.deps.audit?.run(run.value, 'run.created', createdBy)
    return run
  }

  submit(input: RunRef & { actor: string }) {
    return this.step(input, { type: 'submit', actor: input.actor })
  }

  /**
   * The caller (the Discord layer) asserts whether `actor` holds the approver role. The run's
   * creator may approve it too, unless the community requires a separate approver.
   */
  async approve(
    input: RunRef & { actor: string; actorCanApprove: boolean },
  ): Promise<Result<Run, StepError | InvalidInput | { code: 'not_retryable' } | { code: 'not_permitted' } | { code: 'creator_cannot_approve' }>> {
    if (!input.actorCanApprove) return err({ code: 'not_permitted' })
    const run = await this.get(input)
    if (!run.ok) return run
    const community = await this.deps.communities.get(run.value.communityId)
    if (community?.requireSeparateApprover && run.value.createdBy === input.actor) return err({ code: 'creator_cannot_approve' })
    return this.step(input, { type: 'approve', actor: input.actor })
  }

  /**
   * Cancels a run that has not paid. A failed run is checked against the chain first: if any of
   * its memos are there, the run is brought up to date (paid, or a failure a human must look at)
   * and the cancel is refused, so a paid run never reads "cancelled" and nobody pays it again.
   */
  async cancel(
    input: RunRef & { actor: string },
  ): Promise<
    Result<Run, StepError | InvalidInput | { code: 'not_retryable' } | { code: 'community_not_found' } | ChainShowsPayments | AttemptMayStillLand>
  > {
    const loaded = await this.get(input)
    if (!loaded.ok) return loaded
    if (loaded.value.status === 'failed') {
      const community = await this.deps.communities.get(loaded.value.communityId)
      if (!community) return err({ code: 'community_not_found' })
      const settled = await this.settledFailure(loaded.value, community)
      if (settled.kind === 'may_still_land') return err({ code: 'attempt_may_still_land', retryAfter: settled.retryAfter })
      if (settled.match.kind !== 'none') {
        await this.applyMatch(loaded.value, settled.match)
        return err({ code: 'chain_shows_payments', detail: settled.match.kind })
      }
    }
    return this.step(input, { type: 'cancel', actor: input.actor })
  }

  async get(input: RunRef): Promise<Result<Run, NotFound>> {
    const run = await this.deps.runs.get(input.runId)
    return run && run.communityId === input.guildId ? ok(run) : err({ code: 'run_not_found' })
  }

  list(input: { guildId: string; limit?: number }): Promise<Run[]> {
    return this.deps.runs.listByCommunity(input.guildId, { limit: input.limit ?? 25 })
  }

  /**
   * What paid runs sent in each of the last `weeks` UTC weeks (Monday 00:00 start, the current week
   * last and partial), in the payout token, split into runs a policy made and runs made by hand.
   * For the dashboard's Overview. Reads the community's paid runs in the window and, for each, the
   * policy run that made it (if any).
   */
  async paidByWeek(input: PaidByWeekInput): Promise<Result<PaidByWeek & { token: Address }, InvalidInput | { code: 'community_not_found' }>> {
    const parsed = PaidByWeekInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { guildId, weeks } = parsed.data
    const community = await this.deps.communities.get(guildId)
    if (!community) return err({ code: 'community_not_found' })
    const now = this.deps.clock.now()
    const runs = await this.deps.runs.listPaid(guildId, { since: firstWeekStart(now, weeks) })
    const origins = await Promise.all(runs.map((r) => this.deps.policyRuns.getByRunId(r.id)))
    const policyRunIds = new Set(origins.flatMap((pr) => (pr && pr.communityId === guildId && pr.runId ? [pr.runId] : [])))
    return ok({ token: community.payoutToken, ...paidByWeek(runs, { now, weeks, token: community.payoutToken, policyRunIds }) })
  }

  async exportCsv(input: RunRef): Promise<Result<{ filename: string; csv: string }, NotFound>> {
    const run = await this.get(input)
    if (!run.ok) return run
    const explorer = NETWORKS[this.deps.network].explorerUrl
    return ok({ filename: `rolepay-${run.value.id}.csv`, csv: runToCsv(run.value, { explorerTxUrl: (h) => `${explorer}/tx/${h}` }) })
  }

  /**
   * Pays an approved run (or retries a retryable failed one) as one batched tx.
   * Idempotent: a paid run reports paid; an executing run is reconciled, never re-signed.
   * `concurrent_update` when another worker holds the run right now (or changed it under us):
   * read it again and follow that worker, never send anything of your own meanwhile.
   */
  execute(input: RunRef): Promise<Result<ExecuteOutcome, ExecuteError>> {
    return this.leased(input.runId, () => this.executeHeld(input))
  }

  private async executeHeld(input: RunRef): Promise<Result<ExecuteOutcome, ExecuteError>> {
    const loaded = await this.get(input)
    if (!loaded.ok) return loaded
    const run = loaded.value
    if (run.status === 'paid') return ok({ status: 'paid', run })
    if (run.status === 'executing') return this.reconcileRun(run)
    if (run.status !== 'approved' && run.status !== 'failed') return err({ code: 'illegal_state', status: run.status })
    if (run.status === 'failed' && !run.failure?.retryable) return err({ code: 'not_retryable' })

    const community = await this.deps.communities.get(run.communityId)
    if (!community) return err({ code: 'community_not_found' })

    if (run.status === 'failed') {
      // Before any new attempt: wait until the last one can no longer land (so "never pay twice"
      // does not depend on how a node's error text was read), then, if the chain shows ANY of this
      // run's memos, stop and record what it shows (all: paid; some or wrong ones: a human looks).
      const settled = await this.settledFailure(run, community)
      if (settled.kind === 'may_still_land') return ok({ status: 'pending', run, retryAfter: settled.retryAfter })
      const seen = settled.match
      if (seen.kind !== 'none') {
        const recorded = await this.applyMatch(run, seen)
        if (seen.kind === 'all_paid' && recorded.ok) return recorded
        return err({ code: 'chain_shows_payments', detail: seen.kind })
      }
    }

    // Which key signs, decided per attempt, after the checks above: a policy's own key for that
    // policy's runs, the bot key for every other run. Nothing below depends on which one it is.
    const signer = await this.signingKey(run, community)
    if (!signer.ok) return signer
    const { key, vaultContext, scope } = signer.value

    // Independent reads, so at the same time: the key's state on chain and the head the attempt opens at.
    const [state, head] = await Promise.all([
      this.deps.chain.keyState({
        account: community.treasuryAddress,
        accessKey: key.address,
        token: run.token,
        feeToken: key.policy.feeToken,
      }),
      this.deps.chain.head(),
    ])
    // A swapped line counts at its maximum input: the most the run can take from the payout limit.
    // Both checks are on the key that signs this attempt (a policy's own key or the bot key).
    const check = checkKeyForRun(state, { total: payoutSpendCap(run.lines), needsFeeBudget: community.feeMode === 'fee_budget' })
    if (!check.ok) return scope === 'policy' ? err(policyKeyError(check.error)) : check
    const swaps = await this.swapPreflight(run, community, key)
    if (!swaps.ok) return swaps
    if (!key.sealedSecret) return err({ code: 'unseal_failed' })
    const secret = await this.deps.vault.open(key.sealedSecret, vaultContext)
    if (!secret.ok) return secret

    const validBefore = Math.floor(this.deps.clock.now().getTime() / 1000) + VALID_BEFORE_SECONDS
    const started = await this.save(run, { type: 'start_attempt', fromBlock: head.number, validBefore })
    if (!started.ok) return started

    const signed = await this.deps.chain.signBatch({
      account: community.treasuryAddress,
      accessKeySecret: secret.value,
      token: run.token,
      transfers: run.lines.map((l) => ({ to: l.address, amount: l.amount, memo: l.memo, ...(l.swap ? { swap: l.swap } : {}) })),
      validBefore,
      fee: feePayment(community, key),
    })
    if (!signed.ok) return this.conclude(started.value, { type: 'mark_failed', reason: 'rejected', detail: `${signed.error.reason}: ${signed.error.detail}` })

    // Persist BEFORE broadcasting: after a crash we know exactly which tx to look for.
    const recorded = await this.save(started.value, { type: 'record_signed', txHash: signed.value.txHash, rawTx: signed.value.rawTx })
    if (!recorded.ok) return recorded
    return this.settle(recorded.value, await this.deps.chain.broadcast(signed.value.rawTx), community)
  }

  /** Brings an executing run up to date with the chain. Never signs anything new. `concurrent_update` as for execute. */
  reconcile(input: RunRef): Promise<Result<ExecuteOutcome, ExecuteError>> {
    return this.leased(input.runId, async (): Promise<Result<ExecuteOutcome, ExecuteError>> => {
      const loaded = await this.get(input)
      if (!loaded.ok) return loaded
      const run = loaded.value
      if (run.status === 'paid') return ok({ status: 'paid', run })
      if (run.status === 'failed' && run.failure) return ok({ status: 'failed', run, failure: run.failure })
      if (run.status !== 'executing') return err({ code: 'illegal_state', status: run.status })
      return this.reconcileRun(run)
    })
  }

  /**
   * The recovery sweep: reconcile every run a crash may have left in `executing`. Each run is on its
   * own: one that throws (an RPC outage, a log range the node refuses) is reported as an error
   * and the sweep carries on, so one bad run cannot stall every run after it.
   *
   * A run some worker is handling is not the sweep's: it skips the runs `skip` names (the caller's
   * own jobs, in flight or waiting between steps) and the runs another worker holds the lease of,
   * and it reads each run again once it holds it, so a run settled since the listing is left alone.
   * Skipped runs are not in the results: whoever handles them reports them.
   */
  async recoverInFlight(opts: { skip?: (ref: RunRef) => boolean } = {}): Promise<RecoveryResult[]> {
    const results: RecoveryResult[] = []
    for (const listed of await this.deps.runs.listByStatus('executing')) {
      const ref = { guildId: listed.communityId, runId: listed.id }
      if (opts.skip?.(ref)) continue
      try {
        const r = await this.leased(ref.runId, async () => {
          const run = await this.deps.runs.get(ref.runId)
          return run?.status === 'executing' ? this.reconcileRun(run) : null
        })
        if (r === null || (!r.ok && r.error.code === 'concurrent_update')) continue
        results.push(r.ok ? { ...ref, status: r.value.status } : { ...ref, status: 'error', error: r.error.code })
      } catch (e) {
        results.push({ ...ref, status: 'error', error: 'unexpected', detail: redactUrls(e instanceof Error ? e.message : String(e)) })
      }
    }
    return results
  }

  // ---- internals -------------------------------------------------------------

  /**
   * The key that signs this run's next attempt. A run a policy made (its PolicyRun links it) is
   * signed with that policy's own key once the treasury has authorised one, and never with the bot
   * key after that: a revoked own key stops the policy (`key_revoked`, the policy key). Every other
   * run, and a policy with no key of its own, is signed with the community's active bot key.
   */
  private async signingKey(
    run: Run,
    community: Community,
  ): Promise<Result<{ key: BotKey; vaultContext: string; scope: 'bot' | 'policy' }, { code: 'no_active_key' } | PolicyKeyCheckError>> {
    const origin = await this.deps.policyRuns.getByRunId(run.id)
    if (origin && origin.communityId === community.id) {
      const keys = (await this.deps.policyKeys.listByPolicy(origin.policyId)).filter((k) => k.communityId === community.id)
      const signer = policySigner(keys)
      if (signer.kind === 'retired') return err(policyKeyError({ code: 'key_revoked' }))
      if (signer.kind === 'own') return ok({ key: signer.key, vaultContext: policyKeyContext(community.id, signer.key.policyId, signer.key.address), scope: 'policy' })
    }
    const key = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status === 'active')
    if (!key) return err({ code: 'no_active_key' })
    return ok({ key, vaultContext: botKeyContext(community.id, key.address), scope: 'bot' })
  }

  /**
   * Runs one step on a run while holding its lease, and gives the lease back after, also when the
   * step throws. Another worker holding the run: `concurrent_update`, and the step does not run.
   */
  private async leased<T>(runId: string, step: () => Promise<T>): Promise<T | Result<never, Conflict>> {
    const leases = this.deps.leases
    if (!leases) return step()
    if (!(await leases.acquire(runId, RUN_LEASE_SECONDS))) return err({ code: 'concurrent_update' })
    try {
      return await step()
    } finally {
      await leases.release(runId)
    }
  }

  private async reconcileRun(run: Run): Promise<Result<ExecuteOutcome, ExecuteError>> {
    const community = await this.deps.communities.get(run.communityId)
    if (!community) return err({ code: 'community_not_found' })
    const attempt = currentAttempt(run)

    if (attempt?.txHash) {
      const tx = await this.deps.chain.lookupTx(attempt.txHash)
      if (tx.kind === 'confirmed') return this.settle(run, { ...tx, txHash: attempt.txHash }, community)
      if (tx.kind === 'reverted') return this.settle(run, { kind: 'reverted', txHash: attempt.txHash, blockNumber: tx.blockNumber }, community)
    }

    // The head FIRST, and the memo search bounded by it: "nothing on chain up to block N" and
    // "block N is past the deadline" then describe the same moment. Searching first and reading
    // the head after would let a tx land in between and be called not_landed.
    const head = await this.deps.chain.head()
    const match = await this.matchOnChain(run, community, head.number)
    if (match.kind !== 'none') return this.applyMatch(run, match)

    if (!attempt || head.timestamp > attempt.validBefore + VALID_BEFORE_MARGIN_SECONDS) {
      return this.conclude(run, { type: 'mark_failed', reason: 'not_landed', detail: 'validBefore passed with no memo transfers on chain' })
    }
    if (attempt.rawTx) return this.settle(run, await this.deps.chain.broadcast(attempt.rawTx), community)
    return ok({ status: 'pending', run, retryAfter: deadline(attempt.validBefore) })
  }

  /**
   * For a failed run: whether its last attempt's tx could still land (chain time not yet past its
   * validBefore plus the margin), or else what the chain shows for the run up to a head that is
   * past that deadline, so nothing from any earlier attempt can appear after the answer.
   */
  private async settledFailure(
    run: Run,
    community: Community,
  ): Promise<{ kind: 'may_still_land'; retryAfter: Date } | { kind: 'settled'; match: MatchResult }> {
    const head = await this.deps.chain.head()
    const last = currentAttempt(run)
    if (last && head.timestamp <= last.validBefore + VALID_BEFORE_MARGIN_SECONDS) return { kind: 'may_still_land', retryAfter: deadline(last.validBefore) }
    return { kind: 'settled', match: await this.matchOnChain(run, community, head.number) }
  }

  /**
   * The run's memo transfers from its first attempt up to `toBlock` (a head the caller read), in every
   * token its lines are delivered in (the payout token, and any preferred stablecoin a line swaps into).
   */
  private async matchOnChain(run: Run, community: Community, toBlock: bigint): Promise<MatchResult> {
    const fromBlock = run.attempts[0]?.fromBlock ?? 0n
    const memos = run.lines.map((l) => l.memo)
    const found = await Promise.all(
      runTokens(run).map((token) => this.deps.chain.findMemoTransfers({ token, from: community.treasuryAddress, memos, fromBlock, toBlock })),
    )
    return matchTransfers(run, community.treasuryAddress, found.flat())
  }

  /**
   * Before signing a run with lines in preferred stablecoins: the key must have been authorised to
   * deliver them, the DEX must quote each swap within its maximum (read only), and the key's limit in
   * each preferred token must cover what the run delivers in it. Any problem holds the run whole with
   * the reason; nothing is signed. The chain enforces each swap's maximum anyway (the batch reverts).
   */
  private async swapPreflight(run: Run, community: Community, key: BotKey): Promise<Result<void, SwapCheckError>> {
    const legs = swapLegs(run.lines)
    if (legs.length === 0) return ok(undefined)
    const scope = checkSwapScope(legs, key.policy.swapTokens)
    if (!scope.ok) return scope
    const [quotes, remaining] = await Promise.all([
      Promise.all(legs.map((l) => this.deps.chain.quoteSwap({ tokenIn: run.token, tokenOut: l.token, amountOut: l.amountOut }))),
      Promise.all(
        legs.map(async (l) => (await this.deps.chain.keyState({ account: community.treasuryAddress, accessKey: key.address, token: l.token, feeToken: null })).remaining),
      ),
    ])
    return checkSwapQuotes(legs, quotes, remaining)
  }

  private applyMatch(run: Run, match: Exclude<MatchResult, { kind: 'none' }>) {
    switch (match.kind) {
      case 'all_paid':
        return this.conclude(run, { type: 'mark_paid', txHash: match.txHash, blockNumber: match.blockNumber })
      case 'partial':
        return this.conclude(run, {
          type: 'mark_failed',
          reason: 'partial_match',
          detail: `paid lines ${match.paidLines.join(',')}; missing ${match.missingLines.join(',')}`,
        })
      case 'mismatch':
        return this.conclude(run, { type: 'mark_failed', reason: 'transfer_mismatch', detail: match.detail })
    }
  }

  private settle(run: Run, outcome: BroadcastOutcome, community: Community): Promise<Result<ExecuteOutcome, ExecuteError>> {
    switch (outcome.kind) {
      case 'confirmed': {
        const match = matchTransfers(run, community.treasuryAddress, outcome.transfers)
        if (match.kind === 'none') return this.conclude(run, { type: 'mark_failed', reason: 'transfer_mismatch', detail: 'confirmed tx carries none of the run memos' })
        return this.applyMatch(run, match)
      }
      case 'reverted':
        return this.conclude(run, { type: 'mark_failed', reason: 'reverted', detail: `tx ${outcome.txHash} reverted` })
      case 'rejected':
        return this.conclude(run, { type: 'mark_failed', reason: 'rejected', detail: `${outcome.reason}: ${outcome.detail}` })
      case 'unknown': {
        const validBefore = currentAttempt(run)?.validBefore
        return Promise.resolve(ok({ status: 'pending' as const, run, retryAfter: validBefore ? deadline(validBefore) : null }))
      }
    }
  }

  private async conclude(run: Run, event: RunEvent): Promise<Result<ExecuteOutcome, ExecuteError>> {
    const saved = await this.save(run, event)
    if (!saved.ok) return saved
    const r = saved.value
    if (r.status === 'paid') return ok({ status: 'paid', run: r })
    if (r.status === 'failed' && r.failure) return ok({ status: 'failed', run: r, failure: r.failure })
    return ok({ status: 'pending', run: r, retryAfter: null })
  }

  private async step(ref: RunRef, event: RunEvent & { actor: string }): Promise<Result<Run, StepError | InvalidInput | { code: 'not_retryable' }>> {
    const actor = DiscordIdSchema.safeParse(event.actor)
    if (!actor.success) return invalidInput(actor.error)
    const run = await this.get(ref)
    if (!run.ok) return run
    return this.save(run.value, event)
  }

  private async save(run: Run, event: RunEvent): Promise<Result<Run, StepError | { code: 'not_retryable' }>> {
    const next = transition(run, event, this.deps.clock.now())
    if (!next.ok) return next.error.code === 'not_retryable' ? err({ code: 'not_retryable' }) : err({ code: 'illegal_state', status: run.status })
    if ((await this.deps.runs.update(next.value)) === 'conflict') return err({ code: 'concurrent_update' })
    await this.audited(next.value, event)
    return next
  }

  /** Each step a person (or Rolepay) would want in the governance report; signing details stay out. */
  private async audited(run: Run, event: RunEvent) {
    const audit = this.deps.audit
    if (!audit) return
    switch (event.type) {
      case 'submit':
        return audit.run(run, 'run.submitted', event.actor)
      case 'approve':
        return audit.run(run, 'run.approved', event.actor)
      case 'cancel':
        return audit.run(run, 'run.cancelled', event.actor)
      case 'start_attempt':
        return audit.run(run, 'run.executing', null, { attempt: run.attempts.length })
      case 'mark_paid':
        return audit.run(run, 'run.paid', null, { txHash: event.txHash })
      case 'mark_failed':
        return audit.run(run, 'run.failed', null, { reason: event.reason, retryable: run.failure?.retryable ?? false })
      case 'record_signed':
        return
    }
  }
}

/** One run the recovery sweep looked at; the guild is there so callers can report it. `detail` is for logs only. */
export type RecoveryResult = { guildId: string; runId: string; status: ExecuteOutcome['status'] | 'error'; error?: string; detail?: string }

/** RPC errors carry their request URL, which may hold an API key: never pass one on. */
const redactUrls = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)

function feePayment(community: Community, key: BotKey): FeePayment {
  return community.feeMode === 'fee_budget' && key.policy.feeToken ? { mode: 'fee_budget', feeToken: key.policy.feeToken } : { mode: 'sponsor' }
}

const deadline = (validBefore: number) => new Date((validBefore + VALID_BEFORE_MARGIN_SECONDS) * 1000)
