import { describe, expect, it } from 'vitest'
import { POLICY_RUN_STATUSES, type PolicyRun, type PolicyRunEvent, PolicyRunSchema, movePolicyRun, newPolicyRun, policyKeyHold, runGuards } from './policyRun.js'

const GUILD = '1094309218049937418'
const TREASURER = '300000000000000001'
const T0 = new Date('2026-10-12T18:00:00Z')
const at = (s: number) => new Date(T0.getTime() + s * 1000)

const generating = (): PolicyRun =>
  newPolicyRun({
    id: 'prun_1',
    policyId: 'pol_1',
    policyVersion: 2,
    communityId: GUILD,
    mode: 'autopilot',
    window: { start: at(-7 * 86_400), end: T0 },
    runId: 'run_000001',
    now: T0,
    leaseUntil: at(300),
  })

const ok = (r: { ok: boolean; value?: PolicyRun }) => {
  if (!r.ok || !r.value) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.value
}

describe('PolicyRun: one per policy per period', () => {
  it('starts generating, keyed by the end of its period, holding a lease, its run ID chosen up front', () => {
    const pr = generating()
    expect(PolicyRunSchema.parse(pr)).toEqual(pr)
    expect(pr).toMatchObject({ status: 'generating', periodKey: '2026-10-12T18:00:00.000Z', periodStart: at(-7 * 86_400), periodEnd: T0, runId: 'run_000001', leaseUntil: at(300), rev: 0 })
  })
})

describe('PolicyRun: transitions', () => {
  it('a propose-mode run hands over to the normal approval; an autopilot one waits for its veto window', () => {
    expect(ok(movePolicyRun(generating(), { type: 'proposed', runId: 'run_000001', lines: [], unregistered: [], total: 0n, remaining: null, problems: [] }, at(1)))).toMatchObject({
      status: 'proposed',
      leaseUntil: null,
      rev: 1,
    })
    const scheduled = ok(movePolicyRun(generating(), { type: 'scheduled', runId: 'run_000001', executeAfter: at(86_400), lines: [], unregistered: [], total: 0n, remaining: null, problems: [] }, at(1)))
    expect(scheduled).toMatchObject({ status: 'scheduled', executeAfter: at(86_400) })
  })

  it('is never released before its veto window has passed (the scheduler cannot get this wrong)', () => {
    const scheduled = ok(movePolicyRun(generating(), { type: 'scheduled', runId: 'run_000001', executeAfter: at(86_400), lines: [], unregistered: [], total: 0n, remaining: null, problems: [] }, at(1)))
    expect(movePolicyRun(scheduled, { type: 'lease', until: at(86_400 + 300) }, at(86_399))).toMatchObject({ ok: false, error: { code: 'veto_window_open' } })
    const releasing = ok(movePolicyRun(scheduled, { type: 'lease', until: at(86_400 + 300) }, at(86_400)))
    expect(releasing).toMatchObject({ status: 'releasing', leaseUntil: at(86_400 + 300) })
    expect(ok(movePolicyRun(releasing, { type: 'released', by: TREASURER }, at(86_401)))).toMatchObject({ status: 'released', releasedBy: TREASURER, releasedAt: at(86_401), leaseUntil: null })
  })

  it('a veto counts until the run is released, not after', () => {
    const scheduled = ok(movePolicyRun(generating(), { type: 'scheduled', runId: 'run_000001', executeAfter: at(3600), lines: [], unregistered: [], total: 0n, remaining: null, problems: [] }, at(1)))
    expect(ok(movePolicyRun(scheduled, { type: 'vetoed', by: TREASURER }, at(3700)))).toMatchObject({ status: 'vetoed', vetoedBy: TREASURER, vetoedAt: at(3700) })
    const releasing = ok(movePolicyRun(scheduled, { type: 'lease', until: at(4000) }, at(3600)))
    expect(movePolicyRun(releasing, { type: 'vetoed', by: TREASURER }, at(3601))).toMatchObject({ ok: false, error: { code: 'illegal_transition' } })
  })

  it('a lease can be taken over only once it has run out (a crashed instance, never a live one)', () => {
    const pr = generating()
    expect(movePolicyRun(pr, { type: 'lease', until: at(900) }, at(299))).toMatchObject({ ok: false, error: { code: 'leased' } })
    expect(ok(movePolicyRun(pr, { type: 'lease', until: at(900) }, at(300)))).toMatchObject({ status: 'generating', leaseUntil: at(900), rev: 1 })
  })

  it('a held run says why, with the numbers; finished runs never move again', () => {
    const held = ok(movePolicyRun(generating(), { type: 'held', hold: { code: 'over_budget', total: 70n, limit: 50n }, lines: [], unregistered: [], total: 70n, remaining: 50n, problems: [] }, at(1)))
    expect(held).toMatchObject({ status: 'held', hold: { code: 'over_budget', total: 70n, limit: 50n } })
    const events: PolicyRunEvent[] = [{ type: 'lease', until: at(900) }, { type: 'vetoed', by: TREASURER }, { type: 'released', by: TREASURER }, { type: 'cancelled' }]
    for (const e of events) expect(movePolicyRun(held, e, at(2)).ok).toBe(false)
  })

  it('every (status, event) pair is either a listed transition or refused', () => {
    const allowed: Record<string, string[]> = {
      generating: ['proposed', 'scheduled', 'held', 'empty', 'lease'],
      scheduled: ['lease', 'vetoed', 'held', 'cancelled'],
      releasing: ['lease', 'released', 'held', 'cancelled'],
    }
    const sample = (status: PolicyRun['status']): PolicyRun => ({ ...generating(), status, executeAfter: at(0), leaseUntil: at(0) })
    const events: PolicyRunEvent[] = [
      { type: 'proposed', runId: 'run_000001', lines: [], unregistered: [], total: 0n, remaining: null, problems: [] },
      { type: 'scheduled', runId: 'run_000001', executeAfter: at(10), lines: [], unregistered: [], total: 0n, remaining: null, problems: [] },
      { type: 'held', hold: { code: 'x', total: null, limit: null } },
      { type: 'empty', lines: [], unregistered: [], total: 0n, remaining: null, problems: [] },
      { type: 'lease', until: at(900) },
      { type: 'released', by: TREASURER },
      { type: 'vetoed', by: TREASURER },
      { type: 'cancelled' },
    ]
    for (const status of POLICY_RUN_STATUSES) {
      for (const e of events) expect([status, e.type, movePolicyRun(sample(status), e, at(1)).ok]).toEqual([status, e.type, (allowed[status] ?? []).includes(e.type)])
    }
  })
})

describe('PolicyRun: the guards that hold a run whole', () => {
  const caps = { perRun: 100n, perPerson: null }
  it('nothing in the way: no holds', () => {
    expect(runGuards({ lines: 3, total: 60n, caps, remaining: 80n })).toEqual([])
  })

  it('more people than one run holds, over the policy cap, no key, over the key budget: in that order, with the numbers', () => {
    expect(runGuards({ lines: 51, total: 120n, caps, remaining: 90n })).toEqual([
      { code: 'too_many_lines', total: 120n, limit: null },
      { code: 'over_policy_cap', total: 120n, limit: 100n },
      { code: 'over_budget', total: 120n, limit: 90n },
    ])
    expect(runGuards({ lines: 1, total: 5n, caps: { perRun: null, perPerson: null }, remaining: null })).toEqual([{ code: 'no_active_key', total: 5n, limit: null }])
    // Exactly the budget is fine.
    expect(runGuards({ lines: 1, total: 90n, caps, remaining: 90n })).toEqual([])
  })

  it("a policy with its own key is held against that key's budget, in its own words, whatever the bot key has", () => {
    expect(runGuards({ lines: 1, total: 40n, caps, remaining: 30n, key: 'policy' })).toEqual([{ code: 'over_policy_budget', total: 40n, limit: 30n }])
    expect(runGuards({ lines: 1, total: 5n, caps, remaining: null, key: 'policy' })).toEqual([{ code: 'policy_key_inactive', total: 5n, limit: null }])
    expect(runGuards({ lines: 1, total: 30n, caps, remaining: 30n, key: 'policy' })).toEqual([])
    expect(runGuards({ lines: 1, total: 40n, caps, remaining: 30n, key: 'bot' })).toEqual([{ code: 'over_budget', total: 40n, limit: 30n }])
  })

  it('with swaps into preferred stablecoins, the key budget is held against the most the run can take (`spend`), in its own words when only the swaps push it over', () => {
    const none = { perRun: null, perPerson: null }
    expect(runGuards({ lines: 3, total: 64n, spend: 65n, caps: none, remaining: 64n, key: 'policy' })).toEqual([{ code: 'swaps_over_policy_budget', total: 65n, limit: 64n }])
    expect(runGuards({ lines: 3, total: 64n, spend: 65n, caps: none, remaining: 64n })).toEqual([{ code: 'swaps_over_budget', total: 65n, limit: 64n }])
    // Over without the swaps: the usual code, with the total.
    expect(runGuards({ lines: 3, total: 70n, spend: 71n, caps: none, remaining: 64n, key: 'policy' })).toEqual([{ code: 'over_policy_budget', total: 70n, limit: 64n }])
    // Exactly the budget, swaps included, is fine; no `spend` means the total (no swaps).
    expect(runGuards({ lines: 3, total: 63n, spend: 64n, caps: none, remaining: 64n, key: 'policy' })).toEqual([])
    expect(runGuards({ lines: 3, total: 64n, caps: none, remaining: 64n })).toEqual([])
    // The policy's cap per run is about what people receive: the swaps do not count against it.
    expect(runGuards({ lines: 3, total: 100n, spend: 101n, caps: { perRun: 100n, perPerson: null }, remaining: 500n })).toEqual([])
  })
})

describe('policyKeyHold: a pre-flight refusal at release, as the hold it becomes', () => {
  it("the policy key's refusals get the policy key's codes; the bot key's keep theirs", () => {
    expect(policyKeyHold({ code: 'insufficient_limit', remaining: 10n, needed: 40n, periodEnd: null, key: 'policy' }, 40n)).toEqual({ code: 'over_policy_budget', total: 40n, limit: 10n })
    for (const code of ['key_revoked', 'key_not_authorized', 'key_expired', 'key_expires_too_soon'] as const) {
      expect(policyKeyHold({ code, expiry: 1, key: 'policy' } as never, 40n)).toEqual({ code: 'policy_key_inactive', total: 40n, limit: null })
    }
    expect(policyKeyHold({ code: 'fee_budget_exhausted', key: 'policy' }, 40n)).toEqual({ code: 'fee_budget_exhausted', total: 40n, limit: null })
    expect(policyKeyHold({ code: 'insufficient_limit', remaining: 10n, needed: 40n, periodEnd: null }, 40n)).toEqual({ code: 'insufficient_limit', total: 40n, limit: 10n })
    expect(policyKeyHold({ code: 'no_active_key' }, 40n)).toEqual({ code: 'no_active_key', total: 40n, limit: null })
  })
})
