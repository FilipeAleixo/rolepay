// A policy as the policy services will describe one: the Monday rule from the spec.
import type { PolicyPreview } from '../src/dashboard/policyPort.js'
import { GUILD, type DashboardHarness, usd } from './dashboardHarness.js'

export const ALICE = { id: '200000000000000011', address: '0x1111111111111111111111111111111111111111' }
export const BOB = { id: '200000000000000012', address: '0x2222222222222222222222222222222222222222' }
export const CAROL = { id: '200000000000000013' }

export const MONDAY_RULE = 'Every Monday: 1 USDC per answered question in #help, max 50 a week each.'

export const preview = (over: Partial<PolicyPreview> = {}): PolicyPreview => ({
  asOf: new Date('2026-10-06T12:00:00Z'),
  window: { since: new Date('2026-09-28T18:00:00Z'), until: new Date('2026-10-05T18:00:00Z') },
  matches: [
    { userId: ALICE.id, metrics: { replies: 12, activeDays: 4 }, reasons: ['12 replies in #help (at least 1)'], amount: usd('12'), registered: true },
    { userId: BOB.id, metrics: { replies: 60 }, reasons: ['60 replies in #help (at least 1)', 'capped at 50'], amount: usd('50'), registered: true },
    { userId: CAROL.id, metrics: { replies: 3 }, reasons: ['3 replies in #help (at least 1)'], amount: usd('3'), registered: false },
  ],
  nearMisses: [{ userId: '200000000000000014', metrics: { replies: 0, messages: 9 }, missing: 'no replies in #help this week' }],
  nextRunAt: new Date('2026-10-12T18:00:00Z'),
  total: usd('62'),
  remainingBudget: usd('87.5'),
  held: null,
  ...over,
})

/** The Monday rule, active at version 2 (version 1 superseded), with Alice and Bob named by the bot. */
export function mondayPolicy(h: DashboardHarness, over: Parameters<DashboardHarness['policies']['seed']>[1] = { name: 'Weekly helpers', instruction: MONDAY_RULE }) {
  h.members.set(GUILD, ALICE.id, [], 'Alice')
  h.members.set(GUILD, BOB.id, [], 'Bob')
  const id = h.policies.seed(
    GUILD,
    {
      ruleInWords: 'Pays 1 AlphaUSD per reply in #help since the last run, at most 50 each.',
      filter: { repliesIn: { channels: ['#help'], min: 1 }, amount: { kind: 'perUnit', unit: 'replies', each: '1', cap: '50' } },
      nextRunAt: new Date('2026-10-12T18:00:00Z'),
      matchesNow: 3,
      version: 1,
      approvedBy: '300000000000000001',
      approvedAt: new Date('2026-10-01T09:00:00Z'),
      createdBy: '300000000000000001',
      ...over,
    },
    preview(),
  )
  return id
}
