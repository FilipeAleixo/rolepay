// Behavioural contracts every repository implementation must satisfy. Run against the
// in-memory fakes (so unit tests can trust them) and against SQLite (so production can).
import { beforeEach, describe, expect, it } from 'vitest'
import type { CommunityRepository, PayeeRepository, RunRepository } from '../../src/ports/repositories.js'
import * as f from './fixtures.js'

export type RepoFactory = () => Promise<{
  communities: CommunityRepository
  payees: PayeeRepository
  runs: RunRepository
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
      const c = f.community({ feeMode: 'fee_budget', feeToken: f.FEE_TOKEN, approverRoleId: '400000000000000001' })
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
      await repo.saveBotKey({ ...older, status: 'superseded' })
      expect(await repo.listBotKeys(f.GUILD)).toEqual([newer, { ...older, status: 'superseded' }])
      expect(await repo.getBotKey(newer.address)).toEqual(newer)
      expect(await repo.getBotKey('0x4444444444444444444444444444444444444449')).toBeNull()
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
  })
}
