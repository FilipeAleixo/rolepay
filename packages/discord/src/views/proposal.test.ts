import type { Criteria } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, CAROL, CHANNEL, GUILD, MODS_ROLE, TREASURER_ROLE, paid, pending, proposal } from '../../test/fixtures.js'
import { amountInWords, criteriaInWords, editModal, editText, instructionModal, proposalCreatedMessage, proposalDiscardedMessage, proposalMessage } from './proposal.js'
import { receiptDm, runMessage } from './run.js'

const ctx = { approverRoleId: TREASURER_ROLE }
const embedOf = (m: ReturnType<typeof proposalMessage>) => m.embeds?.[0] ?? {}
const all = (m: ReturnType<typeof proposalMessage>) => JSON.stringify(m)
const size = (m: ReturnType<typeof proposalMessage>) => {
  const e = embedOf(m)
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0)
}

describe('the cost footer (only on the proposal, which only the proposer sees)', () => {
  const footerOf = (p: ReturnType<typeof proposal>) => embedOf(proposalMessage(p, ctx)).footer?.text ?? ''

  it('says which model drafted it, how long the call took and what it cost', () => {
    expect(footerOf(proposal())).toBe('Proposal prop_view01. A draft: nothing is paid until a member with the approver role approves the run.\nDrafted by Sonnet 5.5 · 2.1 s · $0.004')
    expect(footerOf(proposal({ drafted: { model: 'claude-opus-5-5', latencyMs: 8_600, costMicroUsd: 18_000n } }))).toMatch(/\nDrafted by Opus 5\.5 · 8\.6 s · \$0\.018$/)
    expect(footerOf(proposal({ drafted: { model: 'claude-sonnet-5-5', latencyMs: 2_100, costMicroUsd: 300n } }))).toMatch(/· <\$0\.001$/)
  })

  it('leaves out a cost it does not know, and the whole line for a proposal saved before it existed', () => {
    expect(footerOf(proposal({ drafted: { model: 'claude-sonnet-5-5', latencyMs: 2_100, costMicroUsd: null } }))).toMatch(/\nDrafted by Sonnet 5\.5 · 2\.1 s$/)
    expect(footerOf(proposal({ drafted: null }))).not.toContain('Drafted by')
  })

  it('never reaches what others see: the run posted for approval, the receipts, the created or discarded notes', () => {
    const others = [proposalCreatedMessage(proposal(), pending(), ctx), proposalDiscardedMessage(proposal()), runMessage(pending(), { network: 'moderato', approverRoleId: TREASURER_ROLE }), receiptDm(paid(), paid().lines[0] as ReturnType<typeof paid>['lines'][number], { network: 'moderato', communityName: 'Mods' })]
    for (const m of others) expect(JSON.stringify(m)).not.toMatch(/Drafted by|Sonnet|\$0\./)
  })
})

describe('proposalMessage', () => {
  it('one line per person with amount, reason and a link to the source; the total against the bot key', () => {
    const m = proposalMessage(proposal(), ctx)
    const e = embedOf(m)
    expect(e.title).toBe('Pay run proposal')
    expect(e.description).toContain(`1. <@${ALICE}>  50 AlphaUSD · bug in the claim page · [source](https://discord.com/channels/${GUILD}/${CHANNEL}/810000000000000001)`)
    expect(e.description).toContain('**From:** 2 messages in')
    expect(e.description).toContain('**Note on the run:** October bounties')
    expect(e.fields?.slice(0, 2)).toEqual([
      { name: 'Total', value: '250 AlphaUSD for 2 people', inline: true },
      { name: 'Bot key', value: '100 AlphaUSD left', inline: true },
    ])
    expect(m.allowed_mentions).toEqual({ parse: [] })
  })

  it('flags: left out with the reasons, not registered with a nudge, ignored instructions by author, over budget', () => {
    const fields = Object.fromEntries((embedOf(proposalMessage(proposal(), ctx)).fields ?? []).map((f) => [f.name, f.value]))
    expect(fields['Left out (shown, not in the run)']).toBe('<@200000000000000666> 10000 AlphaUSD: their own message is the only source; the amount is not in your instruction.')
    expect(fields['Not registered payees']).toBe(`<@${CAROL}> (50 AlphaUSD)\nThey register with \`/payee link\`, then propose again.`)
    expect(fields['Ignored instructions in messages']).toBe(`[A message](https://discord.com/channels/${GUILD}/${CHANNEL}/810000000000000002) by <@200000000000000666>: Asks the AI to pay its author 10,000.`)
    expect(fields['Check before creating']).toMatch(/^⚠️ The total is more than the bot key has left/)
  })

  it('Create pay run, Edit and Discard; Create is disabled while a blocking problem stands', () => {
    const buttons = (p: ReturnType<typeof proposal>) => proposalMessage(p, ctx).components?.[0]?.components ?? []
    expect(buttons(proposal()).map((b) => ['label' in b && b.label, 'custom_id' in b && b.custom_id, 'disabled' in b && b.disabled])).toEqual([
      ['Create pay run', 'proposal:create:prop_view01', false],
      ['Edit', 'proposal:edit:prop_view01', false],
      ['Discard', 'proposal:discard:prop_view01', false],
    ])
    const blocked = buttons(proposal({ problems: ['amount_not_in_instruction'] }))[0]
    expect(blocked && 'disabled' in blocked && blocked.disabled).toBe(true)
  })

  it("the model's words cannot format the message: reasons, assumptions and summaries are escaped", () => {
    const evil = '**Approved** [click](https://evil.example) <@&400000000000000099>'
    const p = proposal({ lines: [{ ...proposal().lines[0], reason: evil } as ReturnType<typeof proposal>['lines'][number]], assumptions: [evil], unresolved: [{ text: evil, why: evil }] })
    const text = all(proposalMessage(p, ctx))
    expect(text).not.toContain('**Approved**')
    expect(text).not.toContain('[click](https://evil')
    expect(text).not.toContain('<@&400000000000000099>')
  })

  it('stays inside Discord limits with 50 long lines, pointing at Edit for the rest', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...proposal().lines[0], discordUserId: `2000000000000${String(i).padStart(5, '0')}`, reason: 'x'.repeat(190) }) as ReturnType<typeof proposal>['lines'][number])
    const m = proposalMessage(proposal({ lines: many, held: Array.from({ length: 40 }, () => proposal().held[0]) as ReturnType<typeof proposal>['held'] }), ctx)
    expect(embedOf(m).description?.length).toBeLessThanOrEqual(4096)
    expect(size(m)).toBeLessThanOrEqual(6000)
    expect(embedOf(m).description).toMatch(/…and \d+ more \(Edit shows every line\)\n\nExpires <t:\d+:R>\. Create posts the run/)
    for (const f of embedOf(m).fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024)
  })

  it('stays inside 6,000 characters whatever the lists hold: the longest fields shrink first', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `2000000000000${String(i).padStart(5, '0')}`)
    const p = proposal({
      lines: many(50).map((id) => ({ ...proposal().lines[0], discordUserId: id, reason: 'y'.repeat(150) }) as ReturnType<typeof proposal>['lines'][number]),
      held: many(100).map((id) => ({ ...proposal().held[0], discordUserId: id }) as ReturnType<typeof proposal>['held'][number]),
      unregistered: many(100).map((id) => ({ ...proposal().unregistered[0], discordUserId: id }) as ReturnType<typeof proposal>['unregistered'][number]),
      unresolved: Array.from({ length: 20 }, () => ({ text: 'z'.repeat(200), why: 'w'.repeat(300) })),
      assumptions: Array.from({ length: 10 }, () => 'a'.repeat(300)),
      suspicious: many(20).map((id) => ({ channelId: CHANNEL, messageId: '810000000000000002', authorId: id, summary: 's'.repeat(300) })),
      problems: ['over_budget', 'scan_truncated', 'amount_from_message'],
    })
    const criteria: Criteria = {
      hasRole: many(20),
      lacksRole: [],
      joinedBefore: null,
      joinedAfter: null,
      messagesIn: null,
      activeDaysIn: null,
      repliesIn: null,
      reactedTo: null,
      mentionedIn: null,
      postedIn: null,
      paidInRun: null,
      exclude: many(50),
      excludeProposer: true,
    }
    for (const q of [p, { ...p, mode: 'criteria' as const, criteria, amountPlan: { rule: { kind: 'flat' as const, amount: 1n }, overrides: many(50).map((discordUserId) => ({ discordUserId, amount: 5n })), perPersonCap: null } }]) {
      const m = proposalMessage(q, ctx)
      expect(size(m)).toBeLessThanOrEqual(6000)
      expect(embedOf(m).fields?.slice(0, 2).map((f) => f.name)).toEqual(['Total', 'Bot key'])
      // The lines keep their room: the fields gave way, not the people being paid.
      expect(embedOf(m).description).toContain('1. <@200000000000000000>')
      expect(embedOf(m).description).toMatch(/Expires <t:\d+:R>/)
    }
  })

  it('criteria mode: the criteria and the amount in plain words, what was scanned, and each match explained', () => {
    const criteria: Criteria = {
      hasRole: [MODS_ROLE],
      lacksRole: [],
      joinedBefore: null,
      joinedAfter: null,
      messagesIn: null,
      activeDaysIn: null,
      repliesIn: { channelIds: [CHANNEL], since: new Date('2026-09-06T00:00:00Z'), until: new Date('2026-10-06T12:00:00Z'), min: 10 },
      reactedTo: null,
      mentionedIn: null,
      postedIn: null,
      paidInRun: null,
      exclude: [],
      excludeProposer: true,
    }
    const p = proposal({
      mode: 'criteria',
      source: null,
      criteria,
      amountPlan: { rule: { kind: 'flat', amount: 20_000_000n }, overrides: [], perPersonCap: null },
      scans: [{ channelId: CHANNEL, since: new Date('2026-09-06T00:00:00Z'), until: new Date('2026-10-06T12:00:00Z'), messages: 1234, truncated: false }],
      lines: [{ discordUserId: ALICE, amount: 20_000_000n, reason: null, metrics: { messages: null, activeDays: null, replies: 34 }, sources: [], flags: [] }],
    })
    const d = embedOf(proposalMessage(p, ctx)).description ?? ''
    expect(d).toContain(`**Who:** Registered payees who have <@&${MODS_ROLE}>, who replied to other people at least 10 times in <#${CHANNEL}> since <t:1788652800:D> and except the person proposing.`)
    expect(d).toContain('**Amount:** 20 AlphaUSD each.')
    expect(d).toContain(`**Scanned:** 1234 messages in <#${CHANNEL}> since <t:1788652800:D>.`)
    expect(d).toContain(`1. <@${ALICE}>  20 AlphaUSD · 34 replies`)
  })
})

describe('criteriaInWords and amountInWords', () => {
  const none: Criteria = { hasRole: [], lacksRole: [], joinedBefore: null, joinedAfter: null, messagesIn: null, activeDaysIn: null, repliesIn: null, reactedTo: null, mentionedIn: null, postedIn: null, paidInRun: null, exclude: [], excludeProposer: false }

  it('no conditions is every registered payee; each condition reads as a clause', () => {
    expect(criteriaInWords(none, GUILD)).toBe('Every registered payee.')
    expect(criteriaInWords({ ...none, reactedTo: { channelId: CHANNEL, messageId: '810000000000000009', emoji: '✅' } }, GUILD)).toBe(
      `Registered payees who reacted ✅ to [this message](https://discord.com/channels/${GUILD}/${CHANNEL}/810000000000000009).`,
    )
    expect(criteriaInWords({ ...none, paidInRun: { last: true, runId: 'run_abc' }, exclude: [BOB] }, GUILD)).toBe(`Registered payees paid in the last run (run_abc) and except <@${BOB}>.`)
  })

  it('amount rules', () => {
    const token = '0x20c0000000000000000000000000000000000001'
    expect(amountInWords({ rule: { kind: 'perUnit', amount: 1_000_000n, per: 'replies', cap: 25_000_000n }, overrides: [], perPersonCap: null }, token)).toBe('1 AlphaUSD per reply, at most 25 AlphaUSD each.')
    expect(amountInWords({ rule: { kind: 'pool', total: 500_000_000n, splitBy: 'activeDays' }, overrides: [{ discordUserId: ALICE, amount: 100_000_000n }], perPersonCap: 150_000_000n }, token)).toBe(
      `500 AlphaUSD split by active days; <@${ALICE}> gets 100 AlphaUSD; at most 150 AlphaUSD for anyone.`,
    )
    expect(amountInWords({ rule: { kind: 'pool', total: 90_000_000n, splitBy: 'equal' }, overrides: [], perPersonCap: null }, token)).toBe('90 AlphaUSD split equally.')
  })
})

describe('the modals', () => {
  it('the instruction form fits Discord limits', () => {
    const m = instructionModal('810000000000000001')
    expect(m.custom_id).toBe('proposal-modal:instruct:810000000000000001')
    expect(m.title.length).toBeLessThanOrEqual(45)
    const input = m.components[0]?.components[0]
    expect(input?.label.length).toBeLessThanOrEqual(45)
    expect(input?.placeholder?.length ?? 0).toBeLessThanOrEqual(100)
  })

  it('the edit form: one @user=amount per line, held and unregistered people as comments', () => {
    expect(editText(proposal())).toBe(
      [`<@${ALICE}>=50  # bug in the claim page`, `<@${BOB}>=200  # the indexer`, '# <@200000000000000666>=10000  (left out: their own message is the only source; the amount is not in your instruction)', `# <@${CAROL}>  (not registered)`].join('\n'),
    )
    // Fifty long lines: every payable line is there in full; comments go first.
    const fifty = proposal({ lines: Array.from({ length: 50 }, (_, i) => ({ ...proposal().lines[0], discordUserId: `2000000000000000${String(i).padStart(4, '0')}`, amount: 1_234_567_123_456n, reason: 'r'.repeat(200) }) as ReturnType<typeof proposal>['lines'][number]) })
    const text = editText(fifty)
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text.split('\n').filter((l) => !l.startsWith('#'))).toHaveLength(50)
    const m = editModal(proposal())
    expect(m.custom_id).toBe('proposal-modal:edit:prop_view01')
    expect(m.components[0]?.components[0]?.label.length).toBeLessThanOrEqual(45)
    expect(m.components[0]?.components[0]?.value?.length).toBeLessThanOrEqual(4000)
  })
})
