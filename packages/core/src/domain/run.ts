import { z } from 'zod'
import { MAX_LINES_PER_RUN, MAX_NOTE_LENGTH } from '../constants/limits.js'
import type { Hex } from './hex.js'
import { AddressSchema, DiscordIdSchema, RunIdSchema, TxHashSchema } from './ids.js'
import { encodeMemo } from './memo.js'
import { sumAmounts } from './money.js'
import { type Result, err, ok } from './result.js'

export const RUN_STATUSES = ['draft', 'pending_approval', 'approved', 'executing', 'paid', 'failed', 'cancelled'] as const
export const RunStatusSchema = z.enum(RUN_STATUSES)
export type RunStatus = z.infer<typeof RunStatusSchema>

/**
 * Why an execution attempt failed. `partial_match` and `transfer_mismatch` mean the
 * chain shows money moving in a way the run did not expect: a human must look, so
 * those are never retried automatically.
 */
export const FAILURE_REASONS = ['rejected', 'reverted', 'not_landed', 'partial_match', 'transfer_mismatch'] as const
export const FailureReasonSchema = z.enum(FAILURE_REASONS)
export type FailureReason = z.infer<typeof FailureReasonSchema>
const NOT_RETRYABLE: ReadonlySet<FailureReason> = new Set(['partial_match', 'transfer_mismatch'])

const HexDataSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).transform((s) => s as Hex)
const MemoSchema = z.string().regex(/^0x[0-9a-f]{64}$/).transform((s) => s as Hex)

export const RunLineSchema = z.object({
  line: z.number().int().min(1),
  payeeDiscordId: DiscordIdSchema,
  address: AddressSchema,
  amount: z.bigint().positive(),
  memo: MemoSchema,
})
export type RunLine = z.infer<typeof RunLineSchema>

/**
 * One try at paying the run. `fromBlock` is the chain head when the attempt opened (the
 * tx cannot land earlier, so memo searches start there). `validBefore` (unix seconds) is
 * the expiring-nonce deadline, fixed BEFORE signing: once chain time passes it, the
 * attempt's tx can never land, which is what makes a re-send provably safe even when
 * the process crashed before recording anything.
 */
export const AttemptSchema = z.object({
  number: z.number().int().min(1),
  startedAt: z.date(),
  fromBlock: z.bigint().nonnegative(),
  txHash: TxHashSchema.nullable(),
  rawTx: HexDataSchema.nullable(),
  validBefore: z.number().int().positive(),
})
export type Attempt = z.infer<typeof AttemptSchema>

export const FailureSchema = z.object({
  reason: FailureReasonSchema,
  detail: z.string(),
  retryable: z.boolean(),
  at: z.date(),
})
export type Failure = z.infer<typeof FailureSchema>

export const RunSchema = z.object({
  id: RunIdSchema,
  communityId: DiscordIdSchema,
  token: AddressSchema,
  note: z.string().max(MAX_NOTE_LENGTH).nullable(),
  status: RunStatusSchema,
  lines: z.array(RunLineSchema).min(1).max(MAX_LINES_PER_RUN),
  total: z.bigint().positive(),
  createdBy: DiscordIdSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  submittedAt: z.date().nullable(),
  approvedBy: DiscordIdSchema.nullable(),
  approvedAt: z.date().nullable(),
  cancelledBy: DiscordIdSchema.nullable(),
  cancelledAt: z.date().nullable(),
  attempts: z.array(AttemptSchema),
  paidTxHash: TxHashSchema.nullable(),
  paidBlock: z.bigint().nonnegative().nullable(),
  paidAt: z.date().nullable(),
  failure: FailureSchema.nullable(),
  /** Incremented on every transition; repositories compare-and-set on it. */
  version: z.number().int().min(0),
})
export type Run = z.infer<typeof RunSchema>

export type NewRunInput = {
  id: string
  communityId: string
  token: string
  note: string | null
  createdBy: string
  lines: { payeeDiscordId: string; address: string; amount: bigint }[]
  now: Date
}

export type NewRunError =
  | { code: 'no_lines' }
  | { code: 'too_many_lines' }
  | { code: 'duplicate_payee'; payeeDiscordId: string }
  | { code: 'invalid_run'; message: string }

export function newRun(input: NewRunInput): Result<Run, NewRunError> {
  if (input.lines.length === 0) return err({ code: 'no_lines' })
  if (input.lines.length > MAX_LINES_PER_RUN) return err({ code: 'too_many_lines' })
  const seen = new Set<string>()
  for (const l of input.lines) {
    if (seen.has(l.payeeDiscordId)) return err({ code: 'duplicate_payee', payeeDiscordId: l.payeeDiscordId })
    seen.add(l.payeeDiscordId)
  }
  if (!RunIdSchema.safeParse(input.id).success) return err({ code: 'invalid_run', message: 'run ID does not fit the memo' })
  const candidate = {
    id: input.id,
    communityId: input.communityId,
    token: input.token,
    note: input.note,
    status: 'draft',
    lines: input.lines.map((l, i) => ({ ...l, line: i + 1, memo: encodeMemo(input.id, i + 1) })),
    total: sumAmounts(input.lines.map((l) => l.amount)),
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    attempts: [],
    paidTxHash: null,
    paidBlock: null,
    paidAt: null,
    failure: null,
    version: 0,
  }
  const parsed = RunSchema.safeParse(candidate)
  if (!parsed.success) return err({ code: 'invalid_run', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
  return ok(parsed.data)
}

export type RunEvent =
  | { type: 'submit'; actor: string }
  | { type: 'approve'; actor: string }
  | { type: 'cancel'; actor: string }
  | { type: 'start_attempt'; fromBlock: bigint; validBefore: number }
  | { type: 'record_signed'; txHash: Hex; rawTx: Hex }
  | { type: 'mark_paid'; txHash: Hex; blockNumber: bigint }
  | { type: 'mark_failed'; reason: FailureReason; detail: string }

export type TransitionError =
  | { code: 'illegal_transition'; from: RunStatus; event: RunEvent['type'] }
  | { code: 'not_retryable' }
  | { code: 'attempt_already_signed' }

const CANCELLABLE: ReadonlySet<RunStatus> = new Set(['draft', 'pending_approval', 'approved', 'failed'])

/**
 * The run state machine. Pure: returns a new run (version + 1) or says why not.
 *
 *   draft -submit-> pending_approval -approve-> approved -start_attempt-> executing
 *   executing -record_signed-> executing (once per attempt)
 *   executing -mark_paid-> paid | -mark_failed-> failed -start_attempt-> executing (if retryable)
 *   failed -mark_paid-> paid | -mark_failed (partial_match, transfer_mismatch)-> failed
 *     (the chain shows the run's memos after all: record what it shows)
 *   draft | pending_approval | approved | failed -cancel-> cancelled
 */
export function transition(run: Run, event: RunEvent, now: Date): Result<Run, TransitionError> {
  const illegal = () => err({ code: 'illegal_transition' as const, from: run.status, event: event.type })
  const next = (changes: Partial<Run>) => ok({ ...run, ...changes, updatedAt: now, version: run.version + 1 })

  switch (event.type) {
    case 'submit':
      return run.status === 'draft' ? next({ status: 'pending_approval', submittedAt: now }) : illegal()
    case 'approve':
      return run.status === 'pending_approval'
        ? next({ status: 'approved', approvedBy: event.actor, approvedAt: now })
        : illegal()
    case 'cancel':
      return CANCELLABLE.has(run.status)
        ? next({ status: 'cancelled', cancelledBy: event.actor, cancelledAt: now })
        : illegal()
    case 'start_attempt': {
      if (run.status !== 'approved' && run.status !== 'failed') return illegal()
      if (run.status === 'failed' && !run.failure?.retryable) return err({ code: 'not_retryable' })
      const attempt: Attempt = {
        number: run.attempts.length + 1,
        startedAt: now,
        fromBlock: event.fromBlock,
        validBefore: event.validBefore,
        txHash: null,
        rawTx: null,
      }
      return next({ status: 'executing', failure: null, attempts: [...run.attempts, attempt] })
    }
    case 'record_signed': {
      if (run.status !== 'executing') return illegal()
      const current = run.attempts.at(-1)
      if (!current || current.txHash !== null) return err({ code: 'attempt_already_signed' })
      const signed: Attempt = { ...current, txHash: event.txHash, rawTx: event.rawTx }
      return next({ attempts: [...run.attempts.slice(0, -1), signed] })
    }
    case 'mark_paid':
      return run.status === 'executing' || run.status === 'failed'
        ? next({ status: 'paid', paidTxHash: event.txHash, paidBlock: event.blockNumber, paidAt: now, failure: null })
        : illegal()
    case 'mark_failed':
      return run.status === 'executing' || (run.status === 'failed' && NOT_RETRYABLE.has(event.reason))
        ? next({
            status: 'failed',
            failure: { reason: event.reason, detail: event.detail, retryable: !NOT_RETRYABLE.has(event.reason), at: now },
          })
        : illegal()
  }
}

/** The attempt currently in flight (or last tried), if any. */
export function currentAttempt(run: Run): Attempt | undefined {
  return run.attempts.at(-1)
}
