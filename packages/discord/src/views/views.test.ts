import type { KeyStatusView } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { ADMIN, ALICE, BOB, GUILD, T0, TOKEN, TREASURER, TX, approved, cancelled, executing, failed, paid, pending, run } from '../../test/fixtures.js'
import { ButtonStyle, type Message } from '../api.js'
import { decodeCustomId } from '../components/customId.js'
import { explainError } from './errors.js'
import { count, money, shortAddress, tokenLabel } from './format.js'
import { keyText } from './key.js'
import { receiptDm, runMessage } from './run.js'
import { runSummary, statusMessage } from './status.js'

const ctx = { network: 'moderato' as const }
const buttons = (m: Message) => (m.components ?? []).flatMap((row) => row.components)
const actions = (m: Message) => buttons(m).flatMap((b) => ('custom_id' in b ? [decodeCustomId(b.custom_id)?.action] : []))
const text = (m: Message) => JSON.stringify(m)

describe('format', () => {
  it('names the testnet stablecoins and shortens other addresses', () => {
    expect(tokenLabel('0x20c0000000000000000000000000000000000001')).toBe('AlphaUSD')
    expect(tokenLabel('0x20c0000000000000000000000000000000000000')).toBe('pathUSD')
    expect(tokenLabel('0xabcdef0000000000000000000000000000001234')).toBe('0xabcd…1234')
    expect(shortAddress('0x1111111111111111111111111111111111111111')).toBe('0x1111…1111')
  })

  it('prints money from bigint micro-units without floats', () => {
    expect(money(1_500_000n, '0x20c0000000000000000000000000000000000001')).toBe('1.5 AlphaUSD')
    expect(money(1n, '0x20c0000000000000000000000000000000000001')).toBe('0.000001 AlphaUSD')
  })

  it('counts in the singular for exactly one, the plural otherwise', () => {
    expect(count(1, 'person', 'people')).toBe('1 person')
    expect(count(3, 'person', 'people')).toBe('3 people')
    expect(count(0, 'person', 'people')).toBe('0 people')
  })
})

describe('count strings: never "1 people"', () => {
  const receipts = (sent: number, total: number) => runMessage(paid(), { ...ctx, receipts: { sent, total } }).embeds?.[0]?.fields?.find((f) => f.name === 'Receipts')?.value

  it('the receipts line says one person, or all of many', () => {
    expect(receipts(1, 1)).toBe('Sent by DM to 1 person.')
    expect(receipts(3, 3)).toBe('Sent by DM to all 3 people.')
  })

  it('the receipts line agrees with how many were missed', () => {
    expect(receipts(1, 2)).toBe('Sent by DM to 1 of 2 people (1 does not accept DMs from this server).')
    expect(receipts(1, 3)).toBe('Sent by DM to 1 of 3 people (2 do not accept DMs from this server).')
    expect(receipts(0, 1)).toBe('Sent by DM to 0 of 1 person (1 does not accept DMs from this server).')
  })

  it('a run summary says person for one line and people for more', () => {
    const r = run()
    expect(runSummary({ ...r, lines: r.lines.slice(0, 1) })).toContain(' · 1 person · ')
    expect(runSummary(r)).toContain(' · 2 people · ')
  })

  it("the bot key's period reads per second, per hour, per day, or a plural count", () => {
    const per = (periodSeconds: number) => keyText(keyView(periodSeconds)).match(/ per ([^,]+),/)?.[1]
    expect(per(1)).toBe('second')
    expect(per(90)).toBe('90 seconds')
    expect(per(3_600)).toBe('hour')
    expect(per(7_200)).toBe('2 hours')
    expect(per(86_400)).toBe('day')
    expect(per(2_592_000)).toBe('30 days')
  })

  it('one unregistered payee is not "each of them"', () => {
    expect(explainError({ code: 'unregistered_payees', discordUserIds: [ALICE] })).toBe(`Not registered to be paid yet: <@${ALICE}>. They need to run /payee link first.`)
    expect(explainError({ code: 'unregistered_payees', discordUserIds: [ALICE, BOB] })).toBe(`Not registered to be paid yet: <@${ALICE}>, <@${BOB}>. Each of them runs /payee link first.`)
  })
})

/** A bot key waiting for the treasury, whose text spells out its policy. */
function keyView(periodSeconds: number): KeyStatusView {
  const policy = { token: TOKEN, limit: 100_000_000n, periodSeconds, expiresAt: 1_900_000_000, recipients: null, feeToken: null, feeBudget: null }
  return {
    key: { address: '0x5555555555555555555555555555555555555555', communityId: GUILD, status: 'pending_authorization', policy, createdAt: T0, authorizedAt: null, revokedAt: null },
    state: { status: 'not_authorized', expiry: 0, remaining: 0n, periodEnd: null, chainTime: 1_800_000_000, feeBudgetRemaining: null },
  }
}

describe('runMessage', () => {
  it('a run awaiting approval lists every line and the total, with Approve and Cancel', () => {
    const m = runMessage(pending(), ctx)
    const t = text(m)
    expect(t).toContain(`<@${ALICE}>`)
    expect(t).toContain('1.5 AlphaUSD')
    expect(t).toContain(`<@${BOB}>`)
    expect(t).toContain('25 AlphaUSD')
    expect(t).toContain('26.5 AlphaUSD') // total
    expect(t).toContain('October mods')
    expect(actions(m)).toEqual(['approve', 'cancel'])
    expect(buttons(m).map((b) => b.style)).toEqual([ButtonStyle.Success, ButtonStyle.Danger])
  })

  it('never pings anyone it mentions', () => {
    for (const r of [pending(), paid(), failed()]) expect(runMessage(r, ctx).allowed_mentions).toEqual({ parse: [] })
  })

  it('an approved or executing run shows who approved it and that it is paying, with no buttons', () => {
    for (const r of [approved(), executing()]) {
      const m = runMessage(r, ctx)
      expect(text(m)).toContain(`<@${TREASURER}>`)
      expect(text(m)).toMatch(/Paying/)
      expect(buttons(m)).toEqual([])
    }
  })

  it('a paid run links the transaction on the explorer', () => {
    const m = runMessage(paid(), ctx)
    expect(text(m)).toContain(`https://explore.testnet.tempo.xyz/tx/${TX}`)
    expect(actions(m)).toEqual([])
    expect(buttons(m).some((b) => b.style === ButtonStyle.Link)).toBe(true)
  })

  it('a retryable failure explains itself and offers Retry', () => {
    const m = runMessage(failed('rejected'), ctx)
    expect(text(m)).toMatch(/refused/i)
    expect(actions(m)).toEqual(['retry', 'cancel'])
  })

  it('no failure claims "nothing was paid": each says what was checked, and that Retry checks the chain first', () => {
    for (const reason of ['rejected', 'reverted', 'not_landed'] as const) {
      const r = failed(reason as 'rejected')
      const m = runMessage({ ...r, failure: r.failure && { ...r.failure, reason } }, ctx)
      expect(text(m)).not.toMatch(/nothing was paid/i)
      expect(text(m)).toMatch(/checks the chain/i)
    }
  })

  it('a failed run shows the problem too (for example, the chain shows its payments), and a run where money moved offers no buttons', () => {
    const problem = explainError({ code: 'chain_shows_payments', detail: 'partial' })
    const m = runMessage(failed('partial_match'), { ...ctx, problem })
    expect(text(m)).toContain('The chain already shows payments from this run')
    expect(actions(m)).toEqual([])
  })

  it("a refused transaction shows only the reason code in public; the node's own error text appears only where details are asked for (L2)", () => {
    const r = failed('rejected')
    const withNodeText = { ...r, failure: r.failure && { ...r.failure, detail: 'insufficient_balance: HTTP request failed. URL: https://rpc.example/key-abc <html>' } }
    const pub = text(runMessage(withNodeText, ctx))
    expect(pub).toContain('insufficient_balance')
    expect(pub).not.toContain('rpc.example')
    expect(pub).not.toContain('HTTP request failed')
    expect(text(runMessage(withNodeText, { ...ctx, showDetail: true }))).toContain('HTTP request failed')
  })

  it('a failure where money may have moved offers no Retry and says a human must look', () => {
    const m = runMessage(failed('partial_match'), ctx)
    expect(text(m)).toMatch(/do not retry/i)
    expect(actions(m)).toEqual([])
  })

  it('a cancelled run says who cancelled it', () => {
    const m = runMessage(cancelled(), ctx)
    expect(text(m)).toContain(`<@${ADMIN}>`)
    expect(text(m)).toMatch(/Cancelled/)
    expect(buttons(m)).toEqual([])
  })

  it('an approved run that could not start shows the problem and offers Retry', () => {
    const m = runMessage(approved(), { ...ctx, problem: 'The bot key was revoked.' })
    expect(text(m)).toContain('The bot key was revoked.')
    expect(text(m)).not.toMatch(/Paying/)
    expect(actions(m)).toEqual(['retry', 'cancel'])
  })

  it('a retry in progress shows as paying, with no buttons, even while the run still reads failed', () => {
    const m = runMessage(failed('rejected'), { ...ctx, paying: true })
    expect(text(m)).toMatch(/Paying/)
    expect(buttons(m)).toEqual([])
  })

  it('a paid run reports how many receipts went out by DM', () => {
    expect(text(runMessage(paid(), { ...ctx, receipts: 'sending' }))).toMatch(/Sending receipts/)
    expect(text(runMessage(paid(), { ...ctx, receipts: { sent: 1, total: 2 } }))).toMatch(/1 of 2 people.*1 does not accept DMs/)
    expect(text(runMessage(paid(), { ...ctx, receipts: { sent: 2, total: 2 } }))).toMatch(/to all 2 people/)
  })

  it('a run still confirming on chain says Rolepay keeps checking', () => {
    expect(text(runMessage(executing(), { ...ctx, stillConfirming: true }))).toMatch(/keeps checking/)
  })

  it('a run without a note still renders', () => {
    expect(() => runMessage(run({ note: null }), ctx)).not.toThrow()
  })
})

describe('run notes are shown as text, never as Discord markdown (L6)', () => {
  const phishing = '[Claim your bonus](https://evil.example/claim) **now** <@&123> `x` ||spoiler||'
  const escaped = (t: string) => {
    // No unescaped markdown left: every formatting character has a backslash before it.
    expect(t).not.toMatch(/(?<!\\)\[Claim/)
    expect(t).not.toMatch(/(?<!\\)\]\(/)
    expect(t).not.toMatch(/(?<!\\)\*\*now/)
    expect(t).not.toMatch(/(?<!\\)<@&/)
    expect(t).not.toMatch(/https:\/\//)
  }
  const r = run({ note: phishing })
  it('on the run message, in the receipt DM, and in the status list', () => {
    escaped(runMessage(r, ctx).embeds?.[0]?.description ?? '')
    escaped(receiptDm(r, r.lines[0] as (typeof r.lines)[number], { ...ctx, communityName: 'Test guild' }).embeds?.[0]?.description ?? '')
    const community = { id: GUILD, name: 'g', network: 'moderato', treasuryAddress: TOKEN, payoutToken: TOKEN, feeMode: 'sponsor', feeToken: null, approverRoleId: null, requireSeparateApprover: false, aiProposals: false, proposerRoleId: null, preferredTokens: false, createdAt: T0, updatedAt: T0 } as const
    const recent = statusMessage({ community, runs: [r], key: null }).embeds?.[0]?.fields?.find((f) => f.name === 'Recent runs')?.value ?? ''
    expect(recent).toContain('Claim your bonus')
    escaped(recent)
  })

  it('autocomplete choices are plain text, so the summary there stays unescaped', () => {
    expect(runSummary(r)).toContain(phishing)
  })
})

describe('a line paid in the payee\'s preferred stablecoin', () => {
  const BETA = '0x20c0000000000000000000000000000000000002'
  const swapped = <R extends ReturnType<typeof pending>>(r: R): R => ({ ...r, lines: r.lines.map((l) => (l.line === 1 ? { ...l, swap: { token: BETA as `0x${string}`, maxIn: 1_515_000n } } : l)) })

  it('the review embed shows "5 AlphaUSD -> 5 BetaUSD (swapped)" on that line and says what the swaps may cost at most', () => {
    const m = runMessage(swapped(pending()), ctx)
    const description = m.embeds?.[0]?.description ?? ''
    expect(description).toContain(`<@${ALICE}>  1.5 AlphaUSD → 1.5 BetaUSD (swapped)`)
    expect(description).toContain(`<@${BOB}>  25 AlphaUSD  ·`)
    const swaps = m.embeds?.[0]?.fields?.find((f) => f.name === 'Swaps')?.value
    expect(swaps).toContain('1 line is paid in another stablecoin')
    expect(swaps).toContain('at most 1.515 AlphaUSD')
    expect(runMessage(pending(), ctx).embeds?.[0]?.fields?.find((f) => f.name === 'Swaps')).toBeUndefined()
  })

  it('the receipt DM says what they received: the stablecoin they chose, swapped from the payout token', () => {
    const r = swapped(paid())
    const dm = receiptDm(r, r.lines[0] as (typeof r.lines)[number], { network: 'moderato', communityName: 'Mods' })
    expect(dm.embeds?.[0]?.title).toBe('You were paid 1.5 BetaUSD')
    expect(text(dm)).toContain('swapped from AlphaUSD')
    const plain = receiptDm(r, r.lines[1] as (typeof r.lines)[number], { network: 'moderato', communityName: 'Mods' })
    expect(plain.embeds?.[0]?.title).toBe('You were paid 25 AlphaUSD')
    expect(text(plain)).not.toContain('swapped')
  })

  it('the pre-flight holds explain themselves, saying nothing was signed', () => {
    expect(explainError({ code: 'swap_no_route', token: BETA })).toMatch(/BetaUSD.*Nothing was signed/)
    expect(explainError({ code: 'swap_over_cap', token: BETA, quoted: 5_100_000n, max: 5_050_000n }, { token: TOKEN })).toContain('5.1 AlphaUSD, more than the 5.05 AlphaUSD')
    expect(explainError({ code: 'swap_limit_low', token: BETA, remaining: 1_000_000n, needed: 2_000_000n })).toContain('1 BetaUSD')
    expect(explainError({ code: 'swap_not_authorized', tokens: [BETA] })).toMatch(/new key/)
  })
})

describe('receiptDm', () => {
  it('tells the payee what they were paid, why, and links the transaction', () => {
    const r = paid()
    const m = receiptDm(r, r.lines[1] as (typeof r.lines)[number], { ...ctx, communityName: 'Test guild' })
    const t = text(m)
    expect(t).toContain('25 AlphaUSD')
    expect(t).toContain('October mods')
    expect(t).toContain('Test guild')
    expect(t).toContain(`https://explore.testnet.tempo.xyz/tx/${TX}`)
  })

  it('links the payee to their account page, where they see the balance and send it on (when the server has one)', () => {
    const r = paid()
    const line = r.lines[1] as (typeof r.lines)[number]
    const m = receiptDm(r, line, { ...ctx, communityName: 'Test guild', accountUrl: 'https://app.rolepay.app/account' })
    const buttons = (m.components ?? []).flatMap((row) => (row as { components: { label: string; url?: string }[] }).components)
    expect(buttons.map((b) => [b.label, b.url])).toEqual([
      ['View transaction', `https://explore.testnet.tempo.xyz/tx/${TX}`],
      ['Your account', 'https://app.rolepay.app/account'],
    ])
    expect(text(m)).toMatch(/sign in with your passkey/)
    const without = receiptDm(r, line, { ...ctx, communityName: 'Test guild' })
    expect(text(without)).not.toContain('/account')
  })
})

describe('explainError', () => {
  it('turns core error codes into plain English', () => {
    expect(explainError({ code: 'community_not_found' })).toMatch(/\/rolepay setup/)
    expect(explainError({ code: 'unregistered_payees', discordUserIds: [ALICE, BOB] })).toContain(`<@${ALICE}>, <@${BOB}>`)
    expect(explainError({ code: 'unregistered_payees', discordUserIds: [ALICE] })).toMatch(/\/payee link/)
    expect(explainError({ code: 'insufficient_limit', remaining: 2_000_000n, needed: 26_500_000n, periodEnd: 1_800_000_000 }, { token: '0x20c0000000000000000000000000000000000001' })).toBe(
      'This run needs 26.5 AlphaUSD but the bot key has 2 AlphaUSD left this period (it resets <t:1800000000:R>).',
    )
    expect(explainError({ code: 'key_revoked' })).toMatch(/revoked/)
    expect(explainError({ code: 'invalid_input', issues: ['amount: too small'] })).toContain('amount: too small')
  })

  it('never fails on an unknown code', () => {
    expect(explainError({ code: 'brand_new_code' })).toMatch(/brand_new_code/)
  })
})
