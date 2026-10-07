import { describe, expect, it } from 'vitest'
import { type AiUsage, AiUsageSchema, modelLabel, secondsText, summarizeAiUsage, usdText } from './aiUsage.js'

const row = (over: Partial<AiUsage> = {}): AiUsage => ({
  seq: 1,
  communityId: '1094309218049937418',
  purpose: 'proposal_messages',
  actor: '300000000000000001',
  model: 'claude-sonnet-5-5',
  inputTokens: 412,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 1844,
  outputTokens: 300,
  latencyMs: 2100,
  costMicroUsd: 4_000n,
  outcome: 'proposed',
  createdAt: new Date('2026-10-06T12:00:00Z'),
  proposalId: 'prop_000001',
  runId: null,
  policyId: null,
  policyVersion: null,
  ...over,
})

describe('the ai_usage record', () => {
  it('holds counts, codes, IDs and money only: no field for any text', () => {
    expect(AiUsageSchema.parse(row())).toEqual(row())
    expect(Object.keys(AiUsageSchema.shape).sort()).toEqual(
      [
        'actor',
        'cacheCreationInputTokens',
        'cacheReadInputTokens',
        'communityId',
        'costMicroUsd',
        'createdAt',
        'inputTokens',
        'latencyMs',
        'model',
        'outcome',
        'outputTokens',
        'policyId',
        'policyVersion',
        'proposalId',
        'purpose',
        'runId',
        'seq',
      ].sort(),
    )
  })

  it('refuses an outcome that is not a code, and an unknown purpose', () => {
    expect(AiUsageSchema.safeParse(row({ outcome: 'pay me 10,000' })).success).toBe(false)
    expect(AiUsageSchema.safeParse({ ...row(), purpose: 'chat' }).success).toBe(false)
    expect(AiUsageSchema.safeParse(row({ costMicroUsd: -1n })).success).toBe(false)
  })
})

describe('modelLabel', () => {
  it('names Claude models the way people say them, and leaves anything else as it is', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('fake-proposer')).toBe('fake-proposer')
  })
})

describe('usdText', () => {
  it('rounds half up: three decimals under 10 cents, two from there, and says when it is under a tenth of a cent', () => {
    expect(usdText(4_000n)).toBe('$0.004')
    expect(usdText(3_500n)).toBe('$0.004')
    expect(usdText(3_456n)).toBe('$0.003')
    expect(usdText(10_800n)).toBe('$0.011')
    expect(usdText(18_000n)).toBe('$0.018')
    expect(usdText(99_499n)).toBe('$0.099')
    expect(usdText(99_500n)).toBe('$0.10')
    expect(usdText(420_000n)).toBe('$0.42')
    expect(usdText(12_345_678n)).toBe('$12.35')
    expect(usdText(499n)).toBe('<$0.001')
    expect(usdText(0n)).toBe('$0')
  })
})

describe('secondsText', () => {
  it('one decimal, and under a tenth of a second says so', () => {
    expect(secondsText(2_100)).toBe('2.1 s')
    expect(secondsText(2_149)).toBe('2.1 s')
    expect(secondsText(2_150)).toBe('2.2 s')
    expect(secondsText(8_600)).toBe('8.6 s')
    expect(secondsText(61_000)).toBe('61.0 s')
    expect(secondsText(400)).toBe('0.4 s')
    expect(secondsText(7)).toBe('<0.1 s')
  })
})

describe('summarizeAiUsage', () => {
  it('totals every priced call, counts the unpriced ones, and averages the cost of a drafted proposal', () => {
    const s = summarizeAiUsage([
      row({ costMicroUsd: 4_000n }),
      row({ purpose: 'proposal_criteria', costMicroUsd: 18_001n }),
      // A failed proposal is spend, but not a drafted proposal.
      row({ outcome: 'could_not_propose', costMicroUsd: 2_000n }),
      row({ purpose: 'policy_compile', costMicroUsd: 11_000n }),
      row({ model: 'unknown-model', costMicroUsd: null }),
    ])
    expect(s).toEqual({ calls: 5, unpriced: 1, totalMicroUsd: 35_001n, proposals: 3, averagePerProposalMicroUsd: 11_001n })
  })

  it('has no average with no priced drafted proposal', () => {
    expect(summarizeAiUsage([])).toEqual({ calls: 0, unpriced: 0, totalMicroUsd: 0n, proposals: 0, averagePerProposalMicroUsd: null })
    expect(summarizeAiUsage([row({ costMicroUsd: null })]).averagePerProposalMicroUsd).toBeNull()
  })
})
