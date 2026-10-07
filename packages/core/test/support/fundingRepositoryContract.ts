// Behavioural contract for the funding repository (virtual-address masters, funding sources,
// deposits). Run against the in-memory fake and against SQLite, so unit tests on fakes can be trusted.
import { beforeEach, describe, expect, it } from 'vitest'
import type { CommunityRepository, FundingRepository } from '../../src/ports/repositories.js'
import * as f from './fixtures.js'

export type FundingRepoFactory = () => Promise<{ communities: CommunityRepository; funding: FundingRepository }>

export function fundingRepositoryContract(name: string, make: FundingRepoFactory) {
  describe(`${name}: FundingRepository`, () => {
    let repo: FundingRepository
    beforeEach(async () => {
      const r = await make()
      await r.communities.insert(f.community())
      await r.communities.insert(f.community({ id: f.OTHER_GUILD }))
      repo = r.funding
    })

    it('stores one master per community, exactly, and lists them all', async () => {
      expect(await repo.getMaster(f.GUILD)).toBeNull()
      expect(await repo.insertMaster(f.depositMaster())).toBe(true)
      expect(await repo.insertMaster(f.depositMaster({ masterId: '0x01020304' }))).toBe(false)
      expect(await repo.getMaster(f.GUILD)).toEqual(f.depositMaster())
      const other = f.depositMaster({ communityId: f.OTHER_GUILD, masterId: '0x0a0b0c0d', txHash: null, scannedTo: 2_000_000_000_000n })
      await repo.insertMaster(other)
      expect((await repo.listMasters()).sort((a, b) => a.communityId.localeCompare(b.communityId))).toEqual([f.depositMaster(), other])
    })

    it('moves the scan cursor forward only', async () => {
      await repo.insertMaster(f.depositMaster())
      await repo.advanceScan(f.GUILD, 1500n)
      await repo.advanceScan(f.GUILD, 1200n)
      expect((await repo.getMaster(f.GUILD))?.scannedTo).toBe(1500n)
      await repo.advanceScan(f.OTHER_GUILD, 9n)
      expect(await repo.getMaster(f.OTHER_GUILD)).toBeNull()
    })

    it('stores sources exactly, oldest first per community, one per user tag', async () => {
      const one = f.fundingSource(1)
      const two = f.fundingSource(2, { name: 'Judges pool' })
      expect(await repo.insertSource(two)).toBe('inserted')
      expect(await repo.insertSource(one)).toBe('inserted')
      await repo.insertSource(f.fundingSource(1, { id: 'fsrc_other', communityId: f.OTHER_GUILD }))
      expect(await repo.insertSource(f.fundingSource(2, { id: 'fsrc_again' }))).toBe('tag_taken')
      expect(await repo.getSource(one.id)).toEqual(one)
      expect(await repo.getSource('fsrc_unknown')).toBeNull()
      expect(await repo.listSources(f.GUILD)).toEqual([one, two])
    })

    it('stores each deposit once by transaction and log index, and lists newest first', async () => {
      const first = f.deposit()
      const later = f.deposit({ txHash: `0x${'d2'.repeat(32)}`, blockNumber: 1002n, sourceId: 'fsrc_fixture2', amount: 1n, blockTime: f.at(70) })
      const sameTxNext = f.deposit({ logIndex: 3, token: f.FEE_TOKEN, from: '0x0000000000000000000000000000000000000000' })
      expect(await repo.insertDeposit(first)).toBe(true)
      expect(await repo.insertDeposit({ ...first, amount: 999n })).toBe(false)
      expect(await repo.insertDeposit(later)).toBe(true)
      expect(await repo.insertDeposit(sameTxNext)).toBe(true)
      expect(await repo.listDeposits(f.GUILD)).toEqual([later, sameTxNext, first])
      expect(await repo.listDeposits(f.GUILD, { sourceId: 'fsrc_fixture1' })).toEqual([sameTxNext, first])
      expect(await repo.listDeposits(f.GUILD, { since: f.at(65) })).toEqual([later])
      expect(await repo.listDeposits(f.GUILD, { limit: 1 })).toEqual([later])
      expect(await repo.listDeposits(f.OTHER_GUILD)).toEqual([])
    })

    it('keeps amounts beyond 2^53 exact', async () => {
      const big = f.deposit({ amount: 123_456_789_012_345_678_901n })
      await repo.insertDeposit(big)
      expect(await repo.listDeposits(f.GUILD)).toEqual([big])
    })
  })
}
