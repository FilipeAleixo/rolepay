// Behavioural contract for ProposalRepository, run against the memory and the SQLite key-value store.
import { beforeEach, describe, expect, it } from 'vitest'
import { ManualClock } from '../../src/adapters/memory/support.js'
import type { ProposalRepository } from '../../src/ports/repositories.js'
import * as f from './fixtures.js'

export function proposalRepositoryContract(name: string, make: (clock: ManualClock) => Promise<ProposalRepository>) {
  describe(`${name}: ProposalRepository`, () => {
    let clock: ManualClock
    let repo: ProposalRepository
    beforeEach(async () => {
      clock = new ManualClock(f.T0)
      repo = await make(clock)
    })

    it('round-trips a proposal exactly: bigints, dates, nested criteria and amount plans', async () => {
      const p = f.proposal()
      await repo.save(p)
      expect(await repo.get(p.id)).toEqual(p)
      expect(await repo.get('prop_unknown')).toBeNull()
    })

    it('overwrites on save', async () => {
      await repo.save(f.proposal())
      await repo.save(f.proposal({ status: 'discarded', closedBy: f.TREASURER }))
      expect((await repo.get('prop_fixture01'))?.status).toBe('discarded')
    })

    it('forgets a proposal once it expires', async () => {
      await repo.save(f.proposal({ expiresAt: f.at(60) }))
      clock.advance(61)
      expect(await repo.get('prop_fixture01')).toBeNull()
    })

    it('claims once (two Create clicks make one run), and a released claim can be taken again', async () => {
      await repo.save(f.proposal())
      expect(await repo.claim('prop_fixture01')).toBe(true)
      expect(await repo.claim('prop_fixture01')).toBe(false)
      await repo.release('prop_fixture01')
      expect(await repo.claim('prop_fixture01')).toBe(true)
    })
  })
}
