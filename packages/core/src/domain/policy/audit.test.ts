import { describe, expect, it } from 'vitest'
import { type AuditEvent, AuditEventSchema, AuditQuerySchema, auditToCsv } from './audit.js'

const GUILD = '1094309218049937418'
const TREASURER = '300000000000000001'
const T0 = new Date('2026-10-12T18:00:00Z')

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  seq: 1,
  communityId: GUILD,
  at: T0,
  type: 'policy.approved',
  actor: TREASURER,
  policyId: 'pol_1',
  policyVersion: 2,
  policyRunId: null,
  runId: null,
  details: { mode: 'propose' },
  ...over,
})

describe('audit events', () => {
  it('carry who, when, the policy and version, the run, and details that are numbers, codes and IDs, never text', () => {
    expect(AuditEventSchema.parse(event())).toEqual(event())
    // Rolepay itself (the scheduler) acts with no actor.
    expect(AuditEventSchema.parse(event({ actor: null, type: 'policy_run.released' })).actor).toBeNull()
    expect(AuditEventSchema.safeParse(event({ type: 'policy.renamed' as AuditEvent['type'] })).success).toBe(false)
    // A details value is short: a code, an amount, an ID. A long string (someone's words) is refused.
    expect(AuditEventSchema.safeParse(event({ details: { note: 'x'.repeat(200) } })).success).toBe(false)
  })

  it('queries default to the newest 100, and refuse more than 500 at once', () => {
    expect(AuditQuerySchema.parse({ guildId: GUILD })).toEqual({ guildId: GUILD, types: [], actor: null, policyId: null, runId: null, since: null, until: null, before: null, limit: 100 })
    expect(AuditQuerySchema.safeParse({ guildId: GUILD, limit: 501 }).success).toBe(false)
  })

  it('exports to CSV, one row per event, oldest first, formulas defused', () => {
    const csv = auditToCsv([
      event({ seq: 2, type: 'policy_run.vetoed', policyRunId: 'prun_1', runId: 'run_000001', details: { total: '20', why: '=cmd()' }, at: new Date(T0.getTime() + 60_000) }),
      event(),
    ])
    expect(csv.split('\r\n')).toEqual([
      'seq,at,type,actor,policy_id,policy_version,policy_run_id,run_id,details',
      `1,2026-10-12T18:00:00.000Z,policy.approved,${TREASURER},pol_1,2,,,"{""mode"":""propose""}"`,
      `2,2026-10-12T18:01:00.000Z,policy_run.vetoed,${TREASURER},pol_1,2,prun_1,run_000001,"{""total"":""20"",""why"":""=cmd()""}"`,
      '',
    ])
    expect(auditToCsv([event({ details: { x: '=1+1' }, actor: null })]).split('\r\n')[1]).toContain(',rolepay,')
  })
})
