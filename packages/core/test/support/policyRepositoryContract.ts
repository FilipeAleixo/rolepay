// Behavioural contracts for the policy repositories and the audit log. Run against the in-memory
// fakes and against SQLite, so unit tests on fakes can be trusted.
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuditLog, CommunityRepository, PolicyRepository, PolicyRunRepository } from '../../src/ports/repositories.js'
import * as f from './fixtures.js'

export type PolicyRepoFactory = () => Promise<{ communities: CommunityRepository; policies: PolicyRepository; policyRuns: PolicyRunRepository; audit: AuditLog }>

export function policyRepositoryContract(name: string, make: PolicyRepoFactory) {
  describe(`${name}: PolicyRepository`, () => {
    let repo: PolicyRepository
    beforeEach(async () => {
      const r = await make()
      await r.communities.insert(f.community())
      await r.communities.insert(f.community({ id: f.OTHER_GUILD }))
      repo = r.policies
    })

    it('round-trips a policy and its first version exactly', async () => {
      const p = f.policy({ autopilot: { enabledBy: f.TREASURER, enabledAt: f.at(90), approverRoleId: '400000000000000001' }, mode: 'autopilot' })
      await repo.insert(p, f.policyVersion(p))
      expect(await repo.get(p.id)).toEqual(p)
      expect(await repo.listVersions(p.id)).toEqual([f.policyVersion(p)])
      expect(await repo.getVersion(p.id, 1)).toEqual(f.policyVersion(p))
      expect(await repo.get('pol_unknown')).toBeNull()
      expect(await repo.getVersion(p.id, 2)).toBeNull()
    })

    it('refuses a second insert with the same ID', async () => {
      await repo.insert(f.policy(), f.policyVersion())
      await expect(repo.insert(f.policy(), f.policyVersion())).rejects.toThrow()
    })

    it('updates by compare-and-set on rev, adding or replacing a version in the same write', async () => {
      const p = f.policy()
      await repo.insert(p, f.policyVersion(p))
      const v2 = f.policy({ version: 2, status: 'draft', instruction: 'Every Monday: 2 per answer', approvedBy: null, approvedAt: null, rev: 1, updatedAt: f.at(120) })
      expect(await repo.update(v2, f.policyVersion(v2, { authoredAt: f.at(120) }))).toBe('updated')
      expect(await repo.update({ ...v2, name: 'stale' })).toBe('conflict')
      expect(await repo.get(p.id)).toEqual(v2)
      expect((await repo.listVersions(p.id)).map((v) => [v.version, v.approvedBy])).toEqual([
        [1, f.TREASURER],
        [2, null],
      ])
      // Approving version 2 rewrites its row.
      const approved = { ...v2, status: 'active' as const, approvedBy: f.TREASURER, approvedAt: f.at(200), rev: 2 }
      expect(await repo.update(approved, f.policyVersion(approved, { authoredAt: f.at(120) }))).toBe('updated')
      expect(await repo.getVersion(p.id, 2)).toMatchObject({ approvedBy: f.TREASURER, approvedAt: f.at(200), authoredAt: f.at(120) })
      expect(await repo.update(f.policy({ id: 'pol_missing', rev: 1 }))).toBe('conflict')
    })

    it('lists per community, newest first, and active policies across communities for the scheduler', async () => {
      const a = f.policy({ id: 'pol_a', createdAt: f.at(1) })
      const b = f.policy({ id: 'pol_b', createdAt: f.at(2), status: 'paused' })
      const c = f.policy({ id: 'pol_c', communityId: f.OTHER_GUILD })
      for (const p of [a, b, c]) await repo.insert(p, f.policyVersion(p))
      expect((await repo.listByCommunity(f.GUILD)).map((p) => p.id)).toEqual(['pol_b', 'pol_a'])
      expect((await repo.listByStatus('active')).map((p) => p.id).sort()).toEqual(['pol_a', 'pol_c'])
    })

    it('hands out copies', async () => {
      await repo.insert(f.policy(), f.policyVersion())
      const got = await repo.get('pol_fixture01')
      if (got) got.name = 'mutated'
      expect((await repo.get('pol_fixture01'))?.name).toBe('Help desk')
    })
  })

  describe(`${name}: PolicyRunRepository`, () => {
    let repo: PolicyRunRepository
    beforeEach(async () => {
      const r = await make()
      await r.communities.insert(f.community())
      await r.communities.insert(f.community({ id: f.OTHER_GUILD }))
      await r.policies.insert(f.policy(), f.policyVersion())
      const other = f.policy({ id: 'pol_other', communityId: f.OTHER_GUILD })
      await r.policies.insert(other, f.policyVersion(other))
      repo = r.policyRuns
    })

    it('claims a period once: a second claim for the same policy and period, under any ID, is refused', async () => {
      const pr = f.policyRun({ status: 'generating', rev: 0, leaseUntil: f.at(300) })
      expect(await repo.claim(pr)).toBe(true)
      expect(await repo.claim({ ...pr, id: 'prun_other', runId: 'run_other' })).toBe(false)
      expect(await repo.claim({ ...pr, id: 'prun_next', periodKey: 'next', runId: 'run_next' })).toBe(true)
      expect(await repo.get(pr.id)).toEqual(pr)
    })

    it('finds a run by its pay run and by its period, and round-trips every field', async () => {
      const pr = f.policyRun({ hold: { code: 'over_budget', total: 70n, limit: 50n }, vetoedBy: f.TREASURER, vetoedAt: f.at(5), releasedBy: f.TREASURER, releasedAt: f.at(6), remaining: null })
      await repo.claim(pr)
      expect(await repo.getByRunId('run_fixture01')).toEqual(pr)
      expect(await repo.getByPeriod('pol_fixture01', pr.periodKey)).toEqual(pr)
      expect(await repo.getByRunId('run_unknown')).toBeNull()
      expect(await repo.get('prun_unknown')).toBeNull()
    })

    it('updates by compare-and-set on rev', async () => {
      const pr = f.policyRun()
      await repo.claim(pr)
      const next = { ...pr, status: 'vetoed' as const, vetoedBy: f.TREASURER, vetoedAt: f.at(9), rev: pr.rev + 1 }
      expect(await repo.update(next)).toBe('updated')
      expect(await repo.update({ ...next, status: 'releasing' })).toBe('conflict')
      expect(await repo.get(pr.id)).toEqual(next)
    })

    it('lists per community (newest period first, by policy and status) and by status across communities', async () => {
      const older = f.policyRun({ id: 'prun_1', periodKey: 'k1', periodEnd: f.at(1), runId: 'run_1', status: 'proposed' })
      const newer = f.policyRun({ id: 'prun_2', periodKey: 'k2', periodEnd: f.at(2), runId: 'run_2' })
      const foreign = f.policyRun({ id: 'prun_3', policyId: 'pol_other', communityId: f.OTHER_GUILD, runId: 'run_3' })
      for (const pr of [older, newer, foreign]) await repo.claim(pr)
      expect((await repo.list(f.GUILD)).map((r) => r.id)).toEqual(['prun_2', 'prun_1'])
      expect((await repo.list(f.GUILD, { policyId: 'pol_fixture01', statuses: ['proposed'] })).map((r) => r.id)).toEqual(['prun_1'])
      expect((await repo.list(f.GUILD, { limit: 1 })).map((r) => r.id)).toEqual(['prun_2'])
      expect((await repo.listByStatus(['scheduled', 'generating'])).map((r) => r.id).sort()).toEqual(['prun_2', 'prun_3'])
    })
  })

  describe(`${name}: AuditLog`, () => {
    let log: AuditLog
    beforeEach(async () => {
      log = (await make()).audit
    })

    it('appends with an increasing sequence number and returns the stored event', async () => {
      const a = await log.append(f.auditEvent())
      const b = await log.append(f.auditEvent({ type: 'policy.approved', at: f.at(1) }))
      expect(a).toEqual({ ...f.auditEvent(), seq: a.seq })
      expect(b.seq).toBeGreaterThan(a.seq)
    })

    it('queries newest first, per community, with every filter and a cursor', async () => {
      const e = async (over: Parameters<typeof f.auditEvent>[0]) => log.append(f.auditEvent(over))
      const created = await e({ at: f.at(1) })
      const approved = await e({ type: 'policy.approved', at: f.at(2), actor: f.BOB })
      const generated = await e({ type: 'policy_run.generated', at: f.at(3), actor: null, policyRunId: 'prun_1', runId: 'run_1', details: { total: '20', lines: 2, autopilot: true } })
      const paid = await e({ type: 'run.paid', at: f.at(4), actor: null, policyId: null, policyVersion: null, runId: 'run_9' })
      await e({ communityId: f.OTHER_GUILD, at: f.at(5) })
      const q = (over: Record<string, unknown> = {}) =>
        log.query({ guildId: f.GUILD, types: [], actor: null, policyId: null, runId: null, since: null, until: null, before: null, limit: 100, ...over })
      expect(await q()).toEqual([paid, generated, approved, created])
      expect(await q({ types: ['policy.approved', 'run.paid'] })).toEqual([paid, approved])
      expect(await q({ actor: f.BOB })).toEqual([approved])
      expect(await q({ policyId: 'pol_fixture01' })).toEqual([generated, approved, created])
      expect(await q({ runId: 'run_1' })).toEqual([generated])
      expect(await q({ since: f.at(2), until: f.at(3) })).toEqual([generated, approved])
      expect(await q({ before: generated.seq, limit: 1 })).toEqual([approved])
    })
  })
}
