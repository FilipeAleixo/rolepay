import { describe, expect, it } from 'vitest'
import * as f from '../../../test/support/fixtures.js'
import { proposalRepositoryContract } from '../../../test/support/proposalRepositoryContract.js'
import { MemoryKeyValueStore } from '../memory/keyValue.js'
import { ManualClock } from '../memory/support.js'
import { KvProposalRepository } from './proposals.js'

proposalRepositoryContract('memory', async (clock) => new KvProposalRepository(new MemoryKeyValueStore(clock), clock))

describe('KvProposalRepository: records saved before a field existed', () => {
  it('a proposal stored without `drafted` (before the cost footer) still reads, with drafted null', async () => {
    const clock = new ManualClock(f.T0)
    const kv = new MemoryKeyValueStore(clock)
    const repo = new KvProposalRepository(kv, clock)
    await repo.save(f.proposal())
    const { drafted: _, ...older } = (await kv.get<Record<string, unknown>>('proposal:prop_fixture01')) as Record<string, unknown>
    await kv.set('proposal:prop_fixture01', older, { ttl: 3600 })
    expect(await repo.get('prop_fixture01')).toEqual(f.proposal({ drafted: null }))
  })
})
