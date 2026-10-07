import { describe, expect, it } from 'vitest'
import { POLICY_RUN_STATUSES, type PolicyRun, type PolicyRunEvent, PolicyRunSchema, movePolicyRun, newPolicyRun } from './policyRun.js'

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
