import type { Policy, PolicyPreview, PolicyRun } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, CAROL, GUILD, MODS_ROLE, T0, TOKEN, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { explainPolicyError } from './errors.js'
import { budgetLine, explainHold, policyBudgetOffer, policyChangedMessage, policyDiscardedMessage, policyListMessage, policyMessage, policyRunNoticeMessage } from './policy.js'

const text = (v: unknown) => JSON.stringify(v)
const ctx = { token: TOKEN, approverRoleId: TREASURER_ROLE }
const HELP = '700000000000000002'

const policy = (over: Partial<Policy> = {}): Policy => ({
  id: 'pol_view01',
  communityId: GUILD,
  name: 'Help desk',
  instruction: 'Every Monday: 1 per answered question in #help, max 50 a week each, for Mods',
  compiled: {
    criteria: {
      hasRole: [MODS_ROLE],
      lacksRole: [],
      joinedBefore: null,
      joinedAfter: null,
      messagesIn: null,
      activeDaysIn: null,
      repliesIn: { channelIds: [HELP], since: T0, until: T0, min: 1 },
      reactedTo: null,
      mentionedIn: null,
      postedIn: null,
      paidInRun: null,
      neverPaid: false,
      exclude: [],
      excludeProposer: false,
    },
    plan: { rule: { kind: 'perUnit', amount: 1_000_000n, per: 'replies', cap: 50_000_000n }, overrides: [], perPersonCap: null },
    note: 'Help desk',
    assumptions: ['"a week" means since the previous run'],
    amountsInInstruction: true,
  },
  schedule: { kind: 'weekly', weekday: 'monday', hour: 18, minute: 0, timezone: 'UTC' },
  caps: { perRun: null, perPerson: null },
  channelId: '700000000000000001',
  status: 'draft',
  version: 2,
  mode: 'propose',
  vetoWindowMinutes: 1440,
  autopilot: null,
  createdBy: TREASURER,
  createdAt: T0,
  updatedAt: T0,
  approvedBy: null,
  approvedAt: null,
  activeSince: null,
  rev: 0,
  ...over,
})

const metrics = (replies: number) => ({ messages: null, activeDays: null, replies })
const preview = (over: Partial<PolicyPreview> = {}): PolicyPreview => ({
  policyId: 'pol_view01',
  version: 2,
  window: { start: T0, end: T0 },
  nextRunAt: new Date('2026-10-12T18:00:00Z'),
  matches: [
    { discordUserId: ALICE, registered: true, metrics: metrics(70), amount: 50_000_000n, capped: true, reasons: [], reasonText: '70 replies', token: TOKEN, swapped: false },
    { discordUserId: CAROL, registered: false, metrics: metrics(4), amount: null, capped: false, reasons: [], reasonText: '4 replies', token: TOKEN, swapped: false },
  ],
  nearMisses: [{ userId: BOB, condition: 'repliesIn', count: 2, min: 3, text: '2 replies (at least 3)' }],
  total: 50_000_000n,
  spend: 50_000_000n,
  remaining: null,
  budgetKey: 'bot',
  problems: ['amount_not_in_instruction', 'over_budget', 'something_new'],
  rule: ['1 per reply.'],
  scans: [],
  ...over,
})

const policyRun = (over: Partial<PolicyRun> = {}): PolicyRun => ({
  id: 'prun_view01',
  policyId: 'pol_view01',
  policyVersion: 2,
  communityId: GUILD,
  periodKey: 'k',
  periodStart: T0,
  periodEnd: T0,
  mode: 'propose',
  status: 'held',
  runId: null,
  executeAfter: null,
  lines: Array.from({ length: 20 }, (_, i) => ({ discordUserId: `2000000000000001${String(i).padStart(2, '0')}`, amount: 1_000_000n, metrics: metrics(1), capped: false })),
  unregistered: [],
  total: 20_000_000n,
  remaining: 5_000_000n,
  problems: [],
  hold: { code: 'over_budget', total: 20_000_000n, limit: 5_000_000n },
  vetoedBy: null,
  vetoedAt: null,
  releasedBy: null,
  releasedAt: null,
  leaseUntil: null,
  createdAt: T0,
  updatedAt: T0,
  rev: 1,
  ...over,
})

describe('policyMessage', () => {
  it('a draft with a preview: capped amounts, the unregistered, near misses, no key, problems in plain words, the assumptions, Approve and Discard for its version', () => {
    const m = text(policyMessage(policy(), { ...ctx, preview: preview() }))
    expect(m).toContain('Policy draft: Help desk')
    expect(m).toContain(`<@${ALICE}>  50 AlphaUSD (capped)`)
    expect(m).toContain(`<@${CAROL}>. They run`)
    expect(m).toContain(`<@${BOB}>  2 replies (at least 3)`)
    expect(m).toContain('There is no active bot key.')
    expect(m).toContain('cannot be approved')
    expect(m).toContain('held whole, never paid in part')
    expect(m).toContain('something_new')
    expect(m).toContain('The AI assumed')
    expect(m).toContain('policy:approve:pol_view01:2')
    expect(m).toContain('First run after approval')
  })

  it('a preview over the key budget only once its swaps count at their most says so', () => {
    const bot = text(policyMessage(policy(), { ...ctx, preview: preview({ problems: ['swaps_over_budget'], remaining: 50_000_000n }) }))
    expect(bot).toContain('With its swaps into preferred stablecoins counted at their most, more than the bot key has left: the run would be held whole, never paid in part.')
    const own = text(policyMessage(policy(), { ...ctx, preview: preview({ problems: ['swaps_over_policy_budget'], remaining: 50_000_000n, budgetKey: 'policy' }) }))
    expect(own).toContain("With its swaps into preferred stablecoins counted at their most, more than this policy's own key has left: the run would be held whole, never paid in part.")
  })

  it('a daily policy (the testnet demo) says its schedule in plain words, the time with its minute', () => {
    const m = text(policyMessage(policy({ schedule: { kind: 'daily', hour: 18, minute: 0, timezone: 'UTC' } }), { ...ctx, preview: preview({ nextRunAt: new Date('2026-10-07T18:00:00Z') }) }))
    expect(m).toContain('every day at 18:00 (UTC).')
    expect(text(policyListMessage([{ policy: policy({ schedule: { kind: 'daily', hour: 9, minute: 15, timezone: 'Europe/Lisbon' } }), nextRunAt: null, lastRun: null }]))).toContain('every day at 09:15 (Europe/Lisbon)')
  })

  it('without a preview it can say why; active, paused and archived policies have no buttons', () => {
    expect(text(policyMessage(policy(), { ...ctx, previewProblem: 'Rolepay could not read #help.' }))).toContain('Rolepay could not read #help.')
    const active = text(policyMessage(policy({ status: 'active', approvedBy: TREASURER, approvedAt: T0, mode: 'autopilot', autopilot: { enabledBy: TREASURER, enabledAt: T0, approverRoleId: TREASURER_ROLE }, vetoWindowMinutes: 90 }), { ...ctx, nextRunAt: T0 }))
    expect(active).toContain(`Active. Approved by <@${TREASURER}>`)
    expect(active).toContain('pays 90 minutes after it is posted unless vetoed')
    expect(active).not.toContain('policy:approve')
    expect(text(policyMessage(policy({ status: 'paused' }), ctx))).toContain('Paused, version 2')
    expect(text(policyMessage(policy({ status: 'archived' }), ctx))).toContain('Archived. It never runs again.')
    expect(text(policyMessage(policy(), { token: TOKEN, approverRoleId: null }))).toContain('no approver role is set yet')
  })

  it("shows the token each person receives: a payee paid in their preferred stablecoin reads as the run review does", () => {
    const BETA = '0x20c0000000000000000000000000000000000002' as const
    const m = text(
      policyMessage(policy(), {
        ...ctx,
        preview: preview({
          matches: [
            { discordUserId: ALICE, registered: true, metrics: metrics(1), amount: 1_000_000n, capped: false, reasons: [], reasonText: '1 reply', token: BETA, swapped: true },
            { discordUserId: BOB, registered: true, metrics: metrics(2), amount: 2_000_000n, capped: false, reasons: [], reasonText: '2 replies', token: TOKEN, swapped: false },
          ],
        }),
      }),
    )
    expect(m).toContain(`<@${ALICE}>  1 AlphaUSD → 1 BetaUSD (swapped)  ·  1 reply`)
    expect(m).toContain(`<@${BOB}>  2 AlphaUSD  ·  2 replies`)
  })

  it('a long list is cut to fit Discord (1024 characters a field) and says how many more', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ discordUserId: `2000000000000002${String(i).padStart(2, '0')}`, registered: true, metrics: metrics(5), amount: 5_000_000n, capped: false, reasons: [], reasonText: 'has @Mods; 5 replies to other people in #help (at least 1)', token: TOKEN, swapped: false }))
    const m = policyMessage(policy(), { ...ctx, preview: preview({ matches: many, nearMisses: [], problems: [], remaining: 100_000_000n }) })
    const field = m.embeds?.[0]?.fields?.find((f) => f.name === 'Who it applies to right now')
    expect(field?.value.length).toBeLessThanOrEqual(1024)
    expect(field?.value).toMatch(/…and \d+ more$/)
  })
})

describe('policy list, changes, discards and notices', () => {
  it('lists policies, or says how to write the first', () => {
    expect(text(policyListMessage([]))).toContain('No policies yet')
    const m = text(policyListMessage([{ policy: policy({ status: 'active' }), nextRunAt: T0, lastRun: null }, { policy: policy({ id: 'pol_two', name: 'Monthly' }), nextRunAt: null, lastRun: null }]))
    expect(m).toContain('pol_view01')
    expect(m).toContain('next run <t:')
    expect(m).toContain('Monthly')
  })

  it('says each governance change publicly, and what a discard brought back', () => {
    expect(text(policyChangedMessage(policy({ status: 'paused' }), 'paused', TREASURER, ctx))).toContain('paused by')
    expect(text(policyChangedMessage(policy(), 'resumed', TREASURER, ctx))).toContain('Periods it missed are not run')
    expect(text(policyChangedMessage(policy({ mode: 'propose' }), 'mode', TREASURER, ctx))).toContain('back to propose')
    expect(text(policyChangedMessage(policy({ mode: 'autopilot', vetoWindowMinutes: 60 }), 'mode', TREASURER, { token: TOKEN, approverRoleId: null }))).toContain('1 hour after it is posted unless an approver vetoes it')
    expect(text(policyDiscardedMessage(policy({ status: 'paused', version: 1 }), TREASURER))).toContain('Version 1 is back, paused.')
    expect(text(policyDiscardedMessage(policy({ status: 'archived' }), TREASURER))).not.toContain('is back')
  })

  it('a held run says why with the numbers and who would have been paid; an empty period is one line', () => {
    const held = text(policyRunNoticeMessage(policy(), policyRun(), ctx))
    expect(held).toContain('Held: Help desk')
    expect(held).toContain('more than the bot key has left (5 AlphaUSD)')
    expect(held).toContain('Would have paid 20 AlphaUSD to 20 people')
    expect(held).toContain('…and 5 more')
    expect(text(policyRunNoticeMessage(policy(), policyRun({ status: 'empty', hold: null, lines: [], total: 0n }), ctx))).toContain('nobody matched')
  })
})

describe("a policy's own budget in words", () => {
  const key = { address: '0x6666666666666666666666666666666666666666' as const, communityId: '1094309218049937418', policyId: 'pol_view01', status: 'active' as const, policy: { token: TOKEN, limit: 30_000_000n, periodSeconds: 604_800, expiresAt: 1_800_000_000, recipients: null, feeToken: null, feeBudget: null }, createdAt: T0, authorizedAt: T0, revokedAt: null }
  const state = { status: 'active' as const, expiry: 1_800_000_000, remaining: 20_000_000n, periodEnd: 1_760_000_000, chainTime: 1_759_000_000, feeBudgetRemaining: null }
  it('its own key, from the chain: what is left this period, chain-enforced, when it resets and expires', () => {
    expect(budgetLine({ policyId: 'pol_view01', signs: 'own', key, state }, TOKEN)).toBe(
      'Own budget: 20 of 30 AlphaUSD left this period (chain-enforced). Resets <t:1760000000:R>, expires <t:1800000000:R>.',
    )
    expect(budgetLine({ policyId: 'pol_view01', signs: 'own', key: { ...key, policy: { ...key.policy, periodSeconds: null } }, state: { ...state, periodEnd: null } }, TOKEN)).toBe(
      'Own budget: 20 of 30 AlphaUSD left in total (chain-enforced). Expires <t:1800000000:R>.',
    )
    expect(budgetLine({ policyId: 'pol_view01', signs: 'own', key, state: { ...state, status: 'expired' } }, TOKEN)).toContain('its key has expired, so it pays nothing')
    expect(budgetLine({ policyId: 'pol_view01', signs: 'own', key, state: { ...state, status: 'not_authorized' } }, TOKEN)).toContain('cannot pay right now')
  })

  it("shared (the bot key's budget, a key of its own perhaps waiting), or stopped (its key revoked)", () => {
    expect(budgetLine({ policyId: 'pol_view01', signs: 'bot', key: null, state: null }, TOKEN)).toBe("Shared: it pays from the bot key's budget, with manual runs, AI-proposed runs and other policies.")
    expect(budgetLine({ policyId: 'pol_view01', signs: 'bot', key: { ...key, status: 'pending_authorization' }, state }, TOKEN)).toContain('A key of its own waits for the treasury passkey.')
    expect(budgetLine({ policyId: 'pol_view01', signs: 'retired', key: { ...key, status: 'revoked' }, state: null }, TOKEN)).toContain('It never falls back to the bot key.')
  })

  it('the offer after approval is private and carries only the link', () => {
    const offer = policyBudgetOffer(policy({ status: 'active', name: 'Judges *bold*' }), { url: 'https://rolepay.test/setup/t/policies/pol_view01', expiresAt: new Date(T0.getTime() + 1_800_000) })
    expect(offer.flags).toBe(64)
    expect(offer.content).toContain('Give **Judges \\*bold\\*** its own budget?')
    expect(offer.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: 'Give this policy its own budget', url: 'https://rolepay.test/setup/t/policies/pol_view01' }] }])
  })
})

describe('explainHold and explainPolicyError: every code in plain words', () => {
  it('holds', () => {
    const say = (code: string, autopilotBy: string | null = null) => explainHold({ code, total: 20_000_000n, limit: 5_000_000n }, { token: TOKEN, autopilotBy })
    expect(say('insufficient_limit')).toContain('press Retry')
    expect(say('over_policy_cap')).toContain("over this policy's cap of 5 AlphaUSD")
    expect(say('too_many_lines')).toContain('at most 50')
    expect(say('no_active_key')).toContain('no active bot key')
    for (const c of ['key_revoked', 'key_expired', 'key_expires_too_soon', 'key_not_authorized']) expect(say(c)).toContain('cannot pay any more')
    expect(say('policy_not_active')).toContain('paused or changed')
    expect(say('autopilot_off')).toContain('switched off')
    expect(say('policy_changed')).toContain('edited')
    expect(say('approver_changed', TREASURER)).toContain(`<@${TREASURER}> no longer holds the approver role`)
    expect(say('approver_changed')).toContain('The treasurer who switched autopilot on')
    expect(say('creator_cannot_approve')).toContain('separate approver')
    expect(say('cannot_read')).toContain('could not read')
    expect(say('over_policy_budget')).toBe(
      "The run would pay 20 AlphaUSD, more than this policy's own key has left (5 AlphaUSD). Held whole: nothing was paid, and the chain would refuse it anyway. A treasurer raises this policy's budget on the treasury page (`/rolepay policy show`), or it waits for the key's next period.",
    )
    expect(say('policy_key_inactive')).toContain('never falls back to the bot key')
    // Within the budget, but not once the swaps into preferred stablecoins count at their most: `total` is that most.
    expect(say('swaps_over_budget')).toBe(
      "With its swaps into the stablecoins people prefer counted at their most, the run could take 20 AlphaUSD from the bot key, which has 5 AlphaUSD left. Held whole: nothing was paid. Raise the key's limit on the setup page, or wait for its next period.",
    )
    expect(say('swaps_over_policy_budget')).toBe(
      "With its swaps into the stablecoins people prefer counted at their most, the run could take 20 AlphaUSD from this policy's own key, which has 5 AlphaUSD left. Held whole: nothing was paid. A treasurer raises this policy's budget on the treasury page (`/rolepay policy show`), or it waits for the key's next period.",
    )
    expect(say('mystery')).toBe('Held (mystery). Nothing was paid.')
    expect(explainHold({ code: 'over_budget', total: null, limit: null }, { token: TOKEN })).toContain('?')
  })

  it('errors', () => {
    const community = { approverRoleId: TREASURER_ROLE, proposerRoleId: null }
    const cases: [Record<string, unknown> & { code: string }, string][] = [
      [{ code: 'policy_not_found' }, '/rolepay policy list'],
      [{ code: 'policy_run_not_found' }, 'does not exist'],
      [{ code: 'not_permitted' }, `<@&${TREASURER_ROLE}>`],
      [{ code: 'policy_not_draft', status: 'active' }, 'is active'],
      [{ code: 'version_mismatch', version: 3 }, 'version 3'],
      [{ code: 'policy_blocked', problems: [] }, 'cannot be approved'],
      [{ code: 'creator_cannot_approve' }, 'separate approver'],
      [{ code: 'invalid_veto_window', min: 60, max: 10_080 }, 'between 60 minutes and 168 hours'],
      [{ code: 'policy_not_approved' }, 'Approve the policy first'],
      [{ code: 'policy_archived' }, 'archived'],
      [{ code: 'policy_not_active', status: 'paused' }, 'it is paused'],
      [{ code: 'policy_not_paused', status: 'active' }, 'not paused'],
      [{ code: 'not_scheduled', status: 'vetoed' }, 'already vetoed'],
      [{ code: 'not_scheduled', status: 'released' }, 'already released'],
      [{ code: 'too_late', status: 'pending_approval' }, 'already pending approval'],
      [{ code: 'already_run' }, 'already been made'],
      [{ code: 'discord_not_configured' }, 'cannot read Discord activity'],
      [{ code: 'ai_disabled' }, 'AI proposals are off'],
      [{ code: 'schedule_not_allowed', kind: 'daily' }, 'A daily schedule is a demo control (ROLEPAY_DEMO_CONTROLS=true on Moderato)'],
    ]
    for (const [error, says] of cases) expect([error.code, explainPolicyError(error, { community })]).toEqual([error.code, expect.stringContaining(says)])
    expect(explainPolicyError({ code: 'not_permitted' })).toContain('the approver role')
  })
})
