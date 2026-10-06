import { z } from 'zod'
import { MAX_NOTE_LENGTH } from '../constants/limits.js'
import { NETWORKS, type NetworkName, VALID_BEFORE_MARGIN_SECONDS, VALID_BEFORE_SECONDS } from '../constants/tempo.js'
import { type BotKey, type Community, type KeyCheckError, botKeyContext, checkKeyForRun } from '../domain/community.js'
import { runToCsv } from '../domain/csv.js'
import { DiscordIdSchema } from '../domain/ids.js'
import { type MatchResult, matchTransfers } from '../domain/reconcile.js'
import { type Result, err, ok } from '../domain/result.js'
import { type Failure, type NewRunError, type Run, type RunEvent, type RunStatus, currentAttempt, newRun, transition } from '../domain/run.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { KeyVault } from '../ports/keyVault.js'
import type { BroadcastOutcome, FeePayment, PayoutChain } from '../ports/payoutChain.js'
import type { CommunityRepository, PayeeRepository, RunRepository } from '../ports/repositories.js'
import { type InvalidInput, invalidInput } from './common.js'

export type PayRunServiceDeps = {
  runs: RunRepository
  payees: PayeeRepository
  communities: CommunityRepository
  chain: PayoutChain
  vault: KeyVault
  ids: IdGenerator
  clock: Clock
  network: NetworkName
}

export const CreateRunInputSchema = z.object({
  guildId: DiscordIdSchema,
  createdBy: DiscordIdSchema,
  note: z.string().trim().max(MAX_NOTE_LENGTH).nullable().default(null),
  lines: z.array(z.object({ discordUserId: DiscordIdSchema, amount: z.bigint().positive() })),
})
export type CreateRunInput = z.input<typeof CreateRunInputSchema>

type RunRef = { guildId: string; runId: string }
type NotFound = { code: 'run_not_found' }
type IllegalState = { code: 'illegal_state'; status: RunStatus }
type Conflict = { code: 'concurrent_update' }
type StepError = NotFound | IllegalState | Conflict

/** Where a run stands after an execute or reconcile call. `pending` = check again after `retryAfter`. */
export type ExecuteOutcome =
  | { status: 'paid'; run: Run }
  | { status: 'pending'; run: Run; retryAfter: Date | null }
  | { status: 'failed'; run: Run; failure: Failure }

export type ExecuteError =
  | StepError
  | KeyCheckError
  | { code: 'community_not_found' }
  | { code: 'no_active_key' }
  | { code: 'unseal_failed' }
  | { code: 'not_retryable' }
  | { code: 'chain_shows_payments'; detail: string }

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

  async create(
    input: CreateRunInput,
  ): Promise<Result<Run, InvalidInput | NewRunError | { code: 'community_not_found' } | { code: 'unregistered_payees'; discordUserIds: string[] }>> {
    const parsed = CreateRunInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { guildId, createdBy, note, lines } = parsed.data
    const community = await this.deps.communities.get(guildId)
    if (!community) return err({ code: 'community_not_found' })
    const resolved = await Promise.all(lines.map(async (l) => ({ ...l, payee: await this.deps.payees.get(guildId, l.discordUserId) })))
    const missing = [...new Set(resolved.filter((l) => !l.payee).map((l) => l.discordUserId))]
    if (missing.length) return err({ code: 'unregistered_payees', discordUserIds: missing })
    const run = newRun({
      id: this.deps.ids.runId(),
      communityId: guildId,
      token: community.payoutToken,
      note: note || null,
      createdBy,
      lines: resolved.map((l) => ({ payeeDiscordId: l.discordUserId, address: l.payee?.address ?? '', amount: l.amount })),
      now: this.deps.clock.now(),
    })
    if (!run.ok) return run
    await this.deps.runs.insert(run.value)
    return run
  }

  submit(input: RunRef & { actor: string }) {
    return this.step(input, { type: 'submit', actor: input.actor })
  }

  /** The caller (the Discord layer) asserts whether `actor` holds the approver role. */
  async approve(
    input: RunRef & { actor: string; actorCanApprove: boolean },
  ): Promise<Result<Run, StepError | InvalidInput | { code: 'not_retryable' } | { code: 'not_permitted' }>> {
    if (!input.actorCanApprove) return err({ code: 'not_permitted' })
    return this.step(input, { type: 'approve', actor: input.actor })
  }

  cancel(input: RunRef & { actor: string }) {
    return this.step(input, { type: 'cancel', actor: input.actor })
  }

  async get(input: RunRef): Promise<Result<Run, NotFound>> {
    const run = await this.deps.runs.get(input.runId)
    return run && run.communityId === input.guildId ? ok(run) : err({ code: 'run_not_found' })
  }

  list(input: { guildId: string; limit?: number }): Promise<Run[]> {
    return this.deps.runs.listByCommunity(input.guildId, { limit: input.limit ?? 25 })
  }

  async exportCsv(input: RunRef): Promise<Result<{ filename: string; csv: string }, NotFound>> {
    const run = await this.get(input)
    if (!run.ok) return run
    const explorer = NETWORKS[this.deps.network].explorerUrl
    return ok({ filename: `payrun-${run.value.id}.csv`, csv: runToCsv(run.value, { explorerTxUrl: (h) => `${explorer}/tx/${h}` }) })
  }

  /**
   * Pays an approved run (or retries a retryable failed one) as one batched tx.
   * Idempotent: a paid run reports paid; an executing run is reconciled, never re-signed.
   */
  async execute(input: RunRef): Promise<Result<ExecuteOutcome, ExecuteError>> {
    const loaded = await this.get(input)
    if (!loaded.ok) return loaded
    const run = loaded.value
    if (run.status === 'paid') return ok({ status: 'paid', run })
    if (run.status === 'executing') return this.reconcileRun(run)
    if (run.status !== 'approved' && run.status !== 'failed') return err({ code: 'illegal_state', status: run.status })
    if (run.status === 'failed' && !run.failure?.retryable) return err({ code: 'not_retryable' })

    const community = await this.deps.communities.get(run.communityId)
    if (!community) return err({ code: 'community_not_found' })
    const key = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status === 'active')
    if (!key) return err({ code: 'no_active_key' })

    if (run.status === 'failed') {
      // Belt and braces before any re-send: if the chain shows ANY of this run's memos, stop.
      const seen = await this.matchOnChain(run, community)
      if (seen.kind !== 'none') return err({ code: 'chain_shows_payments', detail: seen.kind })
    }

    const state = await this.deps.chain.keyState({
      account: community.treasuryAddress,
      accessKey: key.address,
      token: run.token,
      feeToken: key.policy.feeToken,
    })
    const check = checkKeyForRun(state, { total: run.total, needsFeeBudget: community.feeMode === 'fee_budget' })
    if (!check.ok) return check
    const secret = await this.deps.vault.open(key.sealedSecret, botKeyContext(community.id, key.address))
    if (!secret.ok) return secret

    const head = await this.deps.chain.head()
    const validBefore = Math.floor(this.deps.clock.now().getTime() / 1000) + VALID_BEFORE_SECONDS
    const started = await this.save(run, { type: 'start_attempt', fromBlock: head.number, validBefore })
    if (!started.ok) return started

    const signed = await this.deps.chain.signBatch({
      account: community.treasuryAddress,
      accessKeySecret: secret.value,
      token: run.token,
      transfers: run.lines.map((l) => ({ to: l.address, amount: l.amount, memo: l.memo })),
      validBefore,
      fee: feePayment(community, key),
    })
    if (!signed.ok) return this.conclude(started.value, { type: 'mark_failed', reason: 'rejected', detail: `${signed.error.reason}: ${signed.error.detail}` })

    // Persist BEFORE broadcasting: after a crash we know exactly which tx to look for.
    const recorded = await this.save(started.value, { type: 'record_signed', txHash: signed.value.txHash, rawTx: signed.value.rawTx })
    if (!recorded.ok) return recorded
    return this.settle(recorded.value, await this.deps.chain.broadcast(signed.value.rawTx), community)
  }

  /** Brings an executing run up to date with the chain. Never signs anything new. */
  async reconcile(input: RunRef): Promise<Result<ExecuteOutcome, ExecuteError>> {
    const loaded = await this.get(input)
    if (!loaded.ok) return loaded
    const run = loaded.value
    if (run.status === 'paid') return ok({ status: 'paid', run })
    if (run.status === 'failed' && run.failure) return ok({ status: 'failed', run, failure: run.failure })
    if (run.status !== 'executing') return err({ code: 'illegal_state', status: run.status })
    return this.reconcileRun(run)
  }

  /** Startup sweep: reconcile every run a crash may have left in `executing`. */
  async recoverInFlight(): Promise<RecoveryResult[]> {
    const results: RecoveryResult[] = []
    for (const run of await this.deps.runs.listByStatus('executing')) {
      const ref = { guildId: run.communityId, runId: run.id }
      const r = await this.reconcileRun(run)
      results.push(r.ok ? { ...ref, status: r.value.status } : { ...ref, status: 'error', error: r.error.code })
    }
    return results
  }

  // ---- internals -------------------------------------------------------------

  private async reconcileRun(run: Run): Promise<Result<ExecuteOutcome, ExecuteError>> {
    const community = await this.deps.communities.get(run.communityId)
    if (!community) return err({ code: 'community_not_found' })
    const attempt = currentAttempt(run)

    if (attempt?.txHash) {
      const tx = await this.deps.chain.lookupTx(attempt.txHash)
      if (tx.kind === 'confirmed') return this.settle(run, { ...tx, txHash: attempt.txHash }, community)
      if (tx.kind === 'reverted') return this.settle(run, { kind: 'reverted', txHash: attempt.txHash, blockNumber: tx.blockNumber }, community)
    }

    const match = await this.matchOnChain(run, community)
    if (match.kind !== 'none') return this.applyMatch(run, match)

    const head = await this.deps.chain.head()
    if (!attempt || head.timestamp > attempt.validBefore + VALID_BEFORE_MARGIN_SECONDS) {
      return this.conclude(run, { type: 'mark_failed', reason: 'not_landed', detail: 'validBefore passed with no memo transfers on chain' })
    }
    if (attempt.rawTx) return this.settle(run, await this.deps.chain.broadcast(attempt.rawTx), community)
    return ok({ status: 'pending', run, retryAfter: deadline(attempt.validBefore) })
  }

  private async matchOnChain(run: Run, community: Community): Promise<MatchResult> {
    const fromBlock = run.attempts[0]?.fromBlock ?? 0n
    const transfers = await this.deps.chain.findMemoTransfers({
      token: run.token,
      from: community.treasuryAddress,
      memos: run.lines.map((l) => l.memo),
      fromBlock,
    })
    return matchTransfers(run, community.treasuryAddress, transfers)
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
    return next
  }
}

/** One run the recovery sweep looked at; the guild is there so callers can report it. */
export type RecoveryResult = { guildId: string; runId: string; status: ExecuteOutcome['status'] | 'error'; error?: string }

function feePayment(community: Community, key: BotKey): FeePayment {
  return community.feeMode === 'fee_budget' && key.policy.feeToken ? { mode: 'fee_budget', feeToken: key.policy.feeToken } : { mode: 'sponsor' }
}

const deadline = (validBefore: number) => new Date((validBefore + VALID_BEFORE_MARGIN_SECONDS) * 1000)
