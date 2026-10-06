import { describe, expect, it } from 'vitest'
import { MAX_LINES_PER_RUN } from '../constants/limits.js'
import { encodeMemo } from './memo.js'
import { RUN_STATUSES, type Run, type RunEvent, type RunStatus, newRun, transition } from './run.js'

const GUILD = '1094309218049937418'
const ALICE = '200000000000000001'
const BOB = '200000000000000002'
const TREASURER = '300000000000000001'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const A1 = '0x1111111111111111111111111111111111111111'
const A2 = '0x2222222222222222222222222222222222222222'
const HASH = `0x${'ab'.repeat(32)}` as const
const RAW = '0x76f8' as const
const t0 = new Date('2026-10-06T12:00:00Z')
const later = (s: number) => new Date(t0.getTime() + s * 1000)

function draft(): Run {
  const r = newRun({
    id: 'run_test0001',
    communityId: GUILD,
    token: TOKEN,
    note: 'October mods',
    createdBy: ALICE,
    lines: [
      { payeeDiscordId: ALICE, address: A1, amount: 1_500_000n },
      { payeeDiscordId: BOB, address: A2, amount: 2_000_000n },
    ],
    now: t0,
  })
  if (!r.ok) throw new Error(r.error.code)
  return r.value
}

/** Applies events in order, failing the test on the first illegal one. */
function apply(run: Run, ...events: RunEvent[]): Run {
  let current = run
  events.forEach((e, i) => {
    const r = transition(current, e, later(i + 1))
    if (!r.ok) throw new Error(`event ${e.type} rejected: ${r.error.code}`)
    current = r.value
  })
  return current
}

const submit: RunEvent = { type: 'submit', actor: ALICE }
const approve: RunEvent = { type: 'approve', actor: TREASURER }
const start: RunEvent = { type: 'start_attempt', fromBlock: 100n, validBefore: 1_800_000_000 }
const signed: RunEvent = { type: 'record_signed', txHash: HASH, rawTx: RAW }
const paid: RunEvent = { type: 'mark_paid', txHash: HASH, blockNumber: 101n }
const failed = (reason: 'rejected' | 'reverted' | 'not_landed' | 'partial_match' | 'transfer_mismatch'): RunEvent => ({
  type: 'mark_failed',
  reason,
  detail: 'test',
})
const cancel: RunEvent = { type: 'cancel', actor: TREASURER }

describe('newRun', () => {
  it('builds a draft with 1-based lines, one memo per line, and an exact total', () => {
    const r = draft()
    expect(r.status).toBe('draft')
    expect(r.version).toBe(0)
    expect(r.total).toBe(3_500_000n)
    expect(r.lines.map((l) => l.line)).toEqual([1, 2])
    expect(r.lines.map((l) => l.memo)).toEqual([encodeMemo('run_test0001', 1), encodeMemo('run_test0001', 2)])
    expect(r.attempts).toEqual([])
  })

  const base = { id: 'run_x', communityId: GUILD, token: TOKEN, note: null, createdBy: ALICE, now: t0 }

  it('rejects a run with no lines', () => {
    expect(newRun({ ...base, lines: [] })).toEqual({ ok: false, error: { code: 'no_lines' } })
  })

  it(`rejects more than ${MAX_LINES_PER_RUN} lines`, () => {
    const lines = Array.from({ length: MAX_LINES_PER_RUN + 1 }, (_, i) => ({
      payeeDiscordId: `2000000000000${String(i).padStart(5, '0')}`,
      address: A1,
      amount: 1n,
    }))
    expect(newRun({ ...base, lines })).toEqual({ ok: false, error: { code: 'too_many_lines' } })
  })

  it('rejects the same payee twice (merge the amounts instead)', () => {
    const lines = [
      { payeeDiscordId: ALICE, address: A1, amount: 1n },
      { payeeDiscordId: ALICE, address: A1, amount: 2n },
    ]
    expect(newRun({ ...base, lines })).toEqual({ ok: false, error: { code: 'duplicate_payee', payeeDiscordId: ALICE } })
  })

  it('rejects non-positive amounts and run IDs that do not fit the memo', () => {
    expect(newRun({ ...base, lines: [{ payeeDiscordId: ALICE, address: A1, amount: 0n }] }).ok).toBe(false)
    expect(newRun({ ...base, id: 'x'.repeat(25), lines: [{ payeeDiscordId: ALICE, address: A1, amount: 1n }] }).ok).toBe(false)
  })
})

describe('transition: the happy path', () => {
  it('draft -> pending_approval -> approved -> executing -> paid', () => {
    const r = apply(draft(), submit, approve, start, signed, paid)
    expect(r.status).toBe('paid')
    expect(r.submittedAt).toEqual(later(1))
    expect(r.approvedBy).toBe(TREASURER)
    expect(r.approvedAt).toEqual(later(2))
    expect(r.attempts).toEqual([
      { number: 1, startedAt: later(3), fromBlock: 100n, txHash: HASH, rawTx: RAW, validBefore: 1_800_000_000 },
    ])
    expect(r.paidTxHash).toBe(HASH)
    expect(r.paidBlock).toBe(101n)
    expect(r.paidAt).toEqual(later(5))
    expect(r.version).toBe(5)
    expect(r.updatedAt).toEqual(later(5))
  })

  it('is pure: the input run is never mutated', () => {
    const d = draft()
    const snapshot = structuredClone(d)
    transition(d, submit, later(1))
    expect(d).toEqual(snapshot)
  })
})

describe('transition: every illegal (status, event) pair is rejected', () => {
  const ALLOWED: Record<RunStatus, RunEvent['type'][]> = {
    draft: ['submit', 'cancel'],
    pending_approval: ['approve', 'cancel'],
    approved: ['start_attempt', 'cancel'],
    executing: ['record_signed', 'mark_paid', 'mark_failed'],
    paid: [],
    // mark_paid: the chain shows the run paid after all (a non-retryable mark_failed is tested below).
    failed: ['start_attempt', 'cancel', 'mark_paid'],
    cancelled: [],
  }
  const reach: Record<RunStatus, () => Run> = {
    draft: () => draft(),
    pending_approval: () => apply(draft(), submit),
    approved: () => apply(draft(), submit, approve),
    executing: () => apply(draft(), submit, approve, start),
    paid: () => apply(draft(), submit, approve, start, signed, paid),
    failed: () => apply(draft(), submit, approve, start, failed('reverted')),
    cancelled: () => apply(draft(), cancel),
  }
  const events: RunEvent[] = [submit, approve, cancel, start, signed, paid, failed('reverted')]

  for (const status of RUN_STATUSES) {
    for (const event of events) {
      const allowed = ALLOWED[status].includes(event.type)
      it(`${status} + ${event.type} -> ${allowed ? 'allowed' : 'illegal_transition'}`, () => {
        const r = transition(reach[status](), event, later(99))
        if (allowed) expect(r.ok).toBe(true)
        else expect(r).toEqual({ ok: false, error: { code: 'illegal_transition', from: status, event: event.type } })
      })
    }
  }
})

describe('transition: execution attempts and retries', () => {
  it('fixes the expiring-nonce deadline when the attempt opens, before anything is signed', () => {
    const r = apply(draft(), submit, approve, start)
    expect(r.attempts).toEqual([
      { number: 1, startedAt: later(3), fromBlock: 100n, validBefore: 1_800_000_000, txHash: null, rawTx: null },
    ])
  })

  it('records the signed tx on the current attempt only once', () => {
    const r = apply(draft(), submit, approve, start, signed)
    expect(transition(r, signed, later(9))).toEqual({ ok: false, error: { code: 'attempt_already_signed' } })
  })

  it('marks failures retryable unless money may have moved', () => {
    const base = apply(draft(), submit, approve, start)
    for (const reason of ['rejected', 'reverted', 'not_landed'] as const) {
      expect(apply(base, failed(reason)).failure).toMatchObject({ reason, retryable: true })
    }
    for (const reason of ['partial_match', 'transfer_mismatch'] as const) {
      expect(apply(base, failed(reason)).failure).toMatchObject({ reason, retryable: false })
    }
  })

  it('a retry opens attempt 2 and clears the failure; history keeps attempt 1', () => {
    const r = apply(draft(), submit, approve, start, signed, failed('not_landed'), { type: 'start_attempt', fromBlock: 200n, validBefore: 1_800_000_300 })
    expect(r.status).toBe('executing')
    expect(r.failure).toBeNull()
    expect(r.attempts.map((a) => [a.number, a.fromBlock, a.validBefore, a.txHash])).toEqual([
      [1, 100n, 1_800_000_000, HASH],
      [2, 200n, 1_800_000_300, null],
    ])
  })

  it('a failed run can be brought up to date with the chain: paid, or a failure where money moved', () => {
    const r = apply(draft(), submit, approve, start, signed, failed('rejected'))
    expect(transition(r, paid, later(9))).toMatchObject({ ok: true, value: { status: 'paid', paidTxHash: HASH, failure: null } })
    expect(transition(r, failed('partial_match'), later(9))).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'partial_match', retryable: false } } })
    // A retryable reason would say nothing new, and would hide what the chain showed.
    expect(transition(r, failed('not_landed'), later(9))).toMatchObject({ ok: false, error: { code: 'illegal_transition' } })
  })

  it('refuses to retry a run whose failure means money may have moved', () => {
    const r = apply(draft(), submit, approve, start, failed('partial_match'))
    expect(transition(r, start, later(9))).toEqual({ ok: false, error: { code: 'not_retryable' } })
  })
})
