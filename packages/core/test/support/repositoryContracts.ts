// Behavioural contracts every repository implementation must satisfy. Run against the
// in-memory fakes (so unit tests can trust them) and against SQLite (so production can).
import { beforeEach, describe, expect, it } from 'vitest'
import type { AiUsageRepository, CommunityRepository, PayeeRepository, RunRepository } from '../../src/ports/repositories.js'
import * as f from './fixtures.js'

export type RepoFactory = () => Promise<{
  communities: CommunityRepository
  payees: PayeeRepository
  runs: RunRepository
  aiUsage: AiUsageRepository
}>

export function repositoryContracts(name: string, make: RepoFactory) {
  describe(`${name}: CommunityRepository`, () => {
    let repo: CommunityRepository
    beforeEach(async () => {
      repo = (await make()).communities
    })

    it('returns null for an unknown community', async () => {
      expect(await repo.get(f.GUILD)).toBeNull()
    })

    it('round-trips a community exactly', async () => {
      const c = f.community({
        feeMode: 'fee_budget',
        feeToken: f.FEE_TOKEN,
        approverRoleId: '400000000000000001',
        requireSeparateApprover: true,
        aiProposals: true,
        proposerRoleId: '400000000000000003',
      })
      expect(await repo.insert(c)).toEqual({ ok: true, value: undefined })
      expect(await repo.get(f.GUILD)).toEqual(c)
    })

    it('refuses a second insert for the same guild', async () => {
      await repo.insert(f.community())
      expect(await repo.insert(f.community({ name: 'again' }))).toEqual({ ok: false, error: { code: 'already_exists' } })
    })

    it('updates in place', async () => {
      await repo.insert(f.community())
      await repo.update(f.community({ name: 'Renamed', updatedAt: f.at(5) }))
      expect(await repo.get(f.GUILD)).toMatchObject({ name: 'Renamed', updatedAt: f.at(5) })
    })

    it('upserts bot keys and lists them newest first, per community', async () => {
      await repo.insert(f.community())
      await repo.insert(f.community({ id: f.OTHER_GUILD }))
      const older = f.botKey({ address: '0x4444444444444444444444444444444444444441', createdAt: f.at(1) })
      const newer = f.botKey({
        address: '0x4444444444444444444444444444444444444442',
        createdAt: f.at(2),
        policy: { ...f.botKey().policy, recipients: [f.ADDR.alice], feeToken: f.FEE_TOKEN, feeBudget: 1n },
      })
      const foreign = f.botKey({ address: '0x4444444444444444444444444444444444444443', communityId: f.OTHER_GUILD })
      for (const k of [older, newer, foreign]) await repo.saveBotKey(k)
      await repo.saveBotKey({ ...older, status: 'superseded', sealedSecret: null })
      expect(await repo.listBotKeys(f.GUILD)).toEqual([newer, { ...older, status: 'superseded', sealedSecret: null }])
      expect(await repo.getBotKey(newer.address)).toEqual(newer)
      expect(await repo.getBotKey('0x4444444444444444444444444444444444444449')).toBeNull()
    })

    it('stores setup links by fingerprint, for guilds that are not registered yet too', async () => {
      const link = f.setupLink({ communityId: f.OTHER_GUILD })
      await repo.insertSetupLink(link)
      expect(await repo.getSetupLink(link.tokenHash)).toEqual(link)
      const withFees = f.setupLink({ tokenHash: 'fp_setup_2', settings: { ...link.settings, feeMode: 'fee_budget', feeToken: f.FEE_TOKEN, name: null } })
      await repo.insertSetupLink(withFees)
      expect(await repo.getSetupLink('fp_setup_2')).toEqual(withFees)
      expect(await repo.getSetupLink('fp_unknown')).toBeNull()
    })

    it('hands out copies: mutating a returned object does not change the store', async () => {
      await repo.insert(f.community())
      const got = await repo.get(f.GUILD)
      if (got) got.name = 'mutated'
      expect((await repo.get(f.GUILD))?.name).toBe('Test guild')
    })
  })

  describe(`${name}: PayeeRepository`, () => {
    let repo: PayeeRepository
    beforeEach(async () => {
      const repos = await make()
      await repos.communities.insert(f.community())
      await repos.communities.insert(f.community({ id: f.OTHER_GUILD }))
      repo = repos.payees
    })

    it('upserts by (community, Discord user) and lists per community', async () => {
      expect(await repo.get(f.GUILD, f.ALICE)).toBeNull()
      await repo.upsert(f.payee())
      await repo.upsert(f.payee({ address: f.ADDR.carol, updatedAt: f.at(9) }))
      await repo.upsert(f.payee({ discordUserId: f.BOB, address: f.ADDR.bob }))
      await repo.upsert(f.payee({ communityId: f.OTHER_GUILD }))
      expect(await repo.get(f.GUILD, f.ALICE)).toEqual(f.payee({ address: f.ADDR.carol, updatedAt: f.at(9) }))
      expect((await repo.list(f.GUILD)).map((p) => p.discordUserId).sort()).toEqual([f.ALICE, f.BOB])
    })

    it('consumes a link token exactly once', async () => {
      await repo.insertLinkToken(f.linkToken())
      expect(await repo.getLinkToken('fp_1')).toEqual(f.linkToken())
      expect(await repo.consumeLinkToken('fp_1', f.at(10))).toBe(true)
      expect(await repo.consumeLinkToken('fp_1', f.at(11))).toBe(false)
      expect((await repo.getLinkToken('fp_1'))?.consumedAt).toEqual(f.at(10))
      expect(await repo.consumeLinkToken('fp_unknown', f.at(10))).toBe(false)
      expect(await repo.getLinkToken('fp_unknown')).toBeNull()
    })
  })

  describe(`${name}: RunRepository`, () => {
    let repo: RunRepository
    beforeEach(async () => {
      const repos = await make()
      await repos.communities.insert(f.community())
      await repos.communities.insert(f.community({ id: f.OTHER_GUILD }))
      repo = repos.runs
    })

    const HASH = `0x${'ab'.repeat(32)}` as const

    it('round-trips a run with lines, attempts, failure and bigints exactly', async () => {
      const r = f.advance(
        f.run(),
        { type: 'submit', actor: f.ALICE },
        { type: 'approve', actor: f.TREASURER },
        { type: 'start_attempt', fromBlock: 12_345_678_901n, validBefore: 1_800_000_000 },
        { type: 'record_signed', txHash: HASH, rawTx: '0x76f8aa' },
        { type: 'mark_failed', reason: 'not_landed', detail: 'validBefore passed' },
      )
      await repo.insert(f.run())
      expect(await repo.update({ ...r, version: 1 })).toBe('updated')
      expect(await repo.get(r.id)).toEqual({ ...r, version: 1 })
      expect(await repo.get('run_missing')).toBeNull()
    })

    it('compare-and-sets on version: a stale writer gets conflict and changes nothing', async () => {
      const r0 = f.run()
      await repo.insert(r0)
      const a = f.advance(r0, { type: 'submit', actor: f.ALICE })
      const b = f.advance(r0, { type: 'cancel', actor: f.TREASURER })
      expect(await repo.update(a)).toBe('updated')
      expect(await repo.update(b)).toBe('conflict')
      expect((await repo.get(r0.id))?.status).toBe('pending_approval')
    })

    it('lists per community newest first, with a limit, and by status', async () => {
      await repo.insert(f.run({ id: 'run_a', createdAt: f.at(1) }))
      await repo.insert(f.run({ id: 'run_b', createdAt: f.at(2) }))
      await repo.insert(f.run({ id: 'run_c', createdAt: f.at(3), communityId: f.OTHER_GUILD }))
      const submitted = f.advance(f.run({ id: 'run_a', createdAt: f.at(1) }), { type: 'submit', actor: f.ALICE })
      await repo.update(submitted)
      expect((await repo.listByCommunity(f.GUILD)).map((r) => r.id)).toEqual(['run_b', 'run_a'])
      expect((await repo.listByCommunity(f.GUILD, { limit: 1 })).map((r) => r.id)).toEqual(['run_b'])
      expect((await repo.listByStatus('pending_approval')).map((r) => r.id)).toEqual(['run_a'])
      expect((await repo.listByStatus('draft')).map((r) => r.id).sort()).toEqual(['run_b', 'run_c'])
    })

    it('lists a community\'s paid runs paid at or after a time, newest payment first, with nothing else', async () => {
      const paid = (id: string, paidAt: Date, communityId = f.GUILD) => {
        const r = f.advance(
          f.run({ id, communityId }),
          { type: 'submit', actor: f.ALICE },
          { type: 'approve', actor: f.TREASURER },
          { type: 'start_attempt', fromBlock: 1n, validBefore: 1_800_000_000 },
          { type: 'record_signed', txHash: HASH, rawTx: '0x76f8aa' },
          { type: 'mark_paid', txHash: HASH, blockNumber: 2n },
        )
        return { ...r, paidAt }
      }
      const store = async (r: ReturnType<typeof paid>) => {
        await repo.insert(f.run({ id: r.id, communityId: r.communityId }))
        // Straight to the paid row: the contract is about what is listed, not the state machine.
        expect(await repo.update({ ...r, version: 1 })).toBe('updated')
      }
      await store(paid('run_old', f.at(-1)))
      await store(paid('run_edge', f.at(0)))
      await store(paid('run_new', f.at(60)))
      await store(paid('run_foreign', f.at(30), f.OTHER_GUILD))
      await repo.insert(f.run({ id: 'run_draft' }))
      const failed = f.advance(f.run({ id: 'run_failed' }), { type: 'submit', actor: f.ALICE }, { type: 'approve', actor: f.TREASURER }, { type: 'start_attempt', fromBlock: 1n, validBefore: 1_800_000_000 }, { type: 'mark_failed', reason: 'rejected', detail: 'x' })
      await repo.insert(f.run({ id: 'run_failed' }))
      await repo.update({ ...failed, version: 1 })

      const listed = await repo.listPaid(f.GUILD, { since: f.at(0) })
      expect(listed.map((r) => r.id)).toEqual(['run_new', 'run_edge'])
      expect(listed[0]).toEqual({ ...paid('run_new', f.at(60)), version: 1 })
      expect((await repo.listPaid(f.GUILD, { since: f.at(-3600) })).map((r) => r.id)).toEqual(['run_new', 'run_edge', 'run_old'])
      expect(await repo.listPaid(f.GUILD, { since: f.at(61) })).toEqual([])
    })
  })

  describe(`${name}: AiUsageRepository`, () => {
    let repo: AiUsageRepository
    beforeEach(async () => {
      repo = (await make()).aiUsage
    })

    it('appends with an increasing sequence number and round-trips every field (nulls, bigints, dates) exactly', async () => {
      const a = await repo.append(f.aiUsage())
      const failed = f.aiUsage({
        purpose: 'policy_compile',
        model: 'claude-opus-5-5',
        inputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        outputTokens: null,
        latencyMs: null,
        costMicroUsd: null,
        outcome: 'could_not_propose',
        createdAt: f.at(1),
        proposalId: null,
      })
      const b = await repo.append(failed)
      const compiled = await repo.append(f.aiUsage({ purpose: 'policy_compile', proposalId: null, policyId: 'pol_fixture01', policyVersion: 2, costMicroUsd: 123_456_789_012n, createdAt: f.at(2) }))
      expect(a).toEqual({ ...f.aiUsage(), seq: a.seq })
      expect(b.seq).toBeGreaterThan(a.seq)
      expect(await repo.list(f.GUILD)).toEqual([compiled, { ...failed, seq: b.seq }, a])
    })

    it('lists per community, newest first, by purpose, policy, time and a limit', async () => {
      const older = await repo.append(f.aiUsage({ createdAt: f.at(1) }))
      const criteria = await repo.append(f.aiUsage({ purpose: 'proposal_criteria', createdAt: f.at(2), proposalId: 'prop_2' }))
      const compile = await repo.append(f.aiUsage({ purpose: 'policy_compile', createdAt: f.at(3), proposalId: null, policyId: 'pol_fixture01', policyVersion: 1 }))
      await repo.append(f.aiUsage({ communityId: f.OTHER_GUILD, createdAt: f.at(4) }))
      expect(await repo.list(f.GUILD)).toEqual([compile, criteria, older])
      expect(await repo.list(f.GUILD, { purposes: ['proposal_messages', 'proposal_criteria'] })).toEqual([criteria, older])
      expect(await repo.list(f.GUILD, { policyId: 'pol_fixture01' })).toEqual([compile])
      expect(await repo.list(f.GUILD, { since: f.at(2) })).toEqual([compile, criteria])
      expect(await repo.list(f.GUILD, { limit: 1 })).toEqual([compile])
      expect(await repo.list(f.GUILD, { purposes: [] })).toEqual([])
    })

    it('links a proposal\'s rows to the pay run it became, and nothing else', async () => {
      const mine = await repo.append(f.aiUsage())
      const other = await repo.append(f.aiUsage({ proposalId: 'prop_other', createdAt: f.at(1) }))
      await repo.linkRun('prop_fixture01', 'run_000009')
      expect(await repo.list(f.GUILD)).toEqual([other, { ...mine, runId: 'run_000009' }])
      await repo.linkRun('prop_unknown', 'run_000010')
      expect((await repo.list(f.GUILD)).map((r) => r.runId)).toEqual([null, 'run_000009'])
    })

    it('hands out copies', async () => {
      await repo.append(f.aiUsage())
      const got = (await repo.list(f.GUILD))[0]
      if (got) got.model = 'mutated'
      expect((await repo.list(f.GUILD))[0]?.model).toBe('claude-sonnet-5-5')
    })
  })
}
