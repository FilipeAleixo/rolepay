import { describe, expect, it } from 'vitest'
import * as f from '../../test/support/fixtures.js'
import { GUILD, OTHER_GUILD, policyWorld } from '../../test/support/policyWorld.js'

describe('AiUsageService: what the AI cost a community', () => {
  it('this UTC month so far: the total of every call (a compile too), the unpriced ones, the average cost of a drafted proposal', async () => {
    const w = await policyWorld() // Wednesday 7 October 2026
    const p = await w.draft() // one compile, 10,800 micro-dollars on the fake model
    const add = (over: Parameters<typeof f.aiUsage>[0]) => w.repos.aiUsage.append(f.aiUsage(over))
    await add({ createdAt: new Date('2026-09-30T23:59:59Z'), costMicroUsd: 999_000n }) // last month
    await add({ createdAt: new Date('2026-10-01T00:00:00Z'), costMicroUsd: 4_000n })
    await add({ createdAt: new Date('2026-10-02T00:00:00Z'), purpose: 'proposal_criteria', costMicroUsd: 18_000n })
    await add({ createdAt: new Date('2026-10-03T00:00:00Z'), outcome: 'could_not_propose', proposalId: null, costMicroUsd: 2_000n })
    await add({ createdAt: new Date('2026-10-04T00:00:00Z'), model: 'claude-unpriced-9', costMicroUsd: null })
    await add({ communityId: OTHER_GUILD, costMicroUsd: 50_000n })
    expect(await w.rolepay.aiUsage.month({ guildId: GUILD })).toEqual({
      since: new Date('2026-10-01T00:00:00Z'),
      calls: 5,
      unpriced: 1,
      totalMicroUsd: 34_800n,
      proposals: 3,
      averagePerProposalMicroUsd: 11_000n,
    })
    expect((await w.rolepay.aiUsage.list({ guildId: GUILD, policyId: p.id })).map((u) => [u.purpose, u.policyVersion])).toEqual([['policy_compile', 1]])
  })

  it('lists calls newest first: the proposals only, or all, at most 500 at a time', async () => {
    const w = await policyWorld()
    await w.draft()
    for (let i = 1; i <= 3; i++) await w.repos.aiUsage.append(f.aiUsage({ createdAt: new Date(`2026-10-0${i}T00:00:00Z`), proposalId: `prop_${i}` }))
    const proposals = await w.rolepay.aiUsage.list({ guildId: GUILD, purposes: ['proposal_messages', 'proposal_criteria'], limit: 2 })
    expect(proposals.map((u) => u.proposalId)).toEqual(['prop_3', 'prop_2'])
    expect((await w.rolepay.aiUsage.list({ guildId: GUILD })).map((u) => u.purpose)).toEqual(['policy_compile', 'proposal_messages', 'proposal_messages', 'proposal_messages'])
    expect(await w.rolepay.aiUsage.list({ guildId: OTHER_GUILD })).toEqual([])
    expect(await w.rolepay.aiUsage.list({ guildId: GUILD, limit: 10_000 })).toHaveLength(4)
  })
})
