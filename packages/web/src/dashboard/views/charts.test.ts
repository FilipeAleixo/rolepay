import type { KeyState, KeyStatusView } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import type { PaidByWeekView, PaidWeekView } from '../policyPort.js'
import { POLICY_KEY_WORDS, atAGlance, budgetBar, keyBudget, paidWeeks, weeksChart } from './charts.js'

const TOKEN = '0x20c0000000000000000000000000000000000001' // AlphaUSD
const EVIL_TOKEN = '<img src=x onerror=alert(1)>"\'&' // tokenLabel keeps its first six and last four characters
const M = 1_000_000n
const NOW = new Date('2026-10-06T12:00:00Z')
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)

/** Visible text, roughly: tags dropped, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const count = (html: string, s: string) => html.split(s).length - 1

function key(over: { state?: Partial<KeyState>; limit?: bigint; periodSeconds?: number | null; token?: string } = {}): KeyStatusView {
  return {
    key: {
      address: '0x4444444444444444444444444444444444444444',
      communityId: '1094309218049937418',
      status: 'active',
      policy: { token: (over.token ?? TOKEN) as `0x${string}`, limit: over.limit ?? 200n * M, periodSeconds: over.periodSeconds === undefined ? 30 * 86_400 : over.periodSeconds, expiresAt: at('2026-12-05T12:00:00Z'), recipients: null, feeToken: null, feeBudget: null },
      createdAt: NOW,
      authorizedAt: NOW,
      revokedAt: null,
    },
    state: { status: 'active', expiry: at('2026-12-05T12:00:00Z'), remaining: 138n * M, periodEnd: at('2026-11-05T12:00:00Z'), chainTime: at('2026-10-06T12:00:00Z'), feeBudgetRemaining: null, ...over.state },
  }
}
const ok = (v: KeyStatusView) => ({ kind: 'ok' as const, value: v })

const MONDAYS = Array.from({ length: 12 }, (_, i) => new Date(Date.parse('2026-07-20T00:00:00Z') + i * 7 * 86_400_000))
function weeks(amounts: ([bigint, bigint] | null)[], token = TOKEN): PaidByWeekView {
  const ws: PaidWeekView[] = MONDAYS.map((start, i) => {
    const [policy, manual] = amounts[i] ?? [0n, 0n]
    return { start, policy, manual, runs: (policy ? 1 : 0) + (manual ? 1 : 0), partial: i === 11 }
  })
  const sum = (k: 'policy' | 'manual') => ws.reduce((a, w) => a + w[k], 0n)
  return { token, weeks: ws, policy: sum('policy'), manual: sum('manual'), total: sum('policy') + sum('manual'), runs: ws.reduce((a, w) => a + w.runs, 0) }
}

describe('budgetBar: the bot key budget as one bar, the limit a hard end line', () => {
  it('is an image with a summary: the spent part against the limit, the rest as the track, the end line', () => {
    const svg = budgetBar({ spent: 62n * M, limit: 200n * M, token: TOKEN })
    expect(svg).toMatch(/^<svg [^>]*role="img"/)
    expect(svg).toContain('aria-label="Bot key budget: 62 of 200 AlphaUSD spent, 138 AlphaUSD left. The chain refuses any payment past the limit."')
    expect(svg).toContain('<svg width="31%"') // the spent part: 62 of 200
    expect(svg).toContain('class="spent"')
    expect(svg).toContain('class="track"')
    expect(svg).toContain('class="limit"')
    expect(svg).not.toMatch(/style=/) // the CSP allows no inline style attributes
  })

  it('spent equal to the limit: the bar is full, no track is left', () => {
    const svg = budgetBar({ spent: 200n * M, limit: 200n * M, token: TOKEN })
    expect(svg).toContain('<svg width="100%"')
    expect(svg).not.toContain('class="track"')
    expect(svg).toContain('200 of 200 AlphaUSD spent, 0 AlphaUSD left')
  })

  it('nothing spent: no spent part, the track runs from the start; a tiny spend stays visible', () => {
    const none = budgetBar({ spent: 0n, limit: 200n * M, token: TOKEN })
    expect(none).not.toContain('class="spent"')
    expect(none).toContain('<rect class="track" x="0"')
    expect(budgetBar({ spent: 1n, limit: 200n * M, token: TOKEN })).toContain('<svg width="0.5%"')
  })

  it('escapes the token symbol', () => {
    const svg = budgetBar({ spent: M, limit: 2n * M, token: EVIL_TOKEN })
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;img ')
  })
})

describe('keyBudget: what the bot may still spend, or why it may spend nothing', () => {
  it('an active key: spent and left in the payout token, the bar, when the period resets and the key expires, and the trust model in plain words', () => {
    const html = keyBudget(ok(key()))
    const t = text(html)
    expect(t).toContain('Bot key budget')
    expect(t).toMatch(/Spent this period 62 AlphaUSD/)
    expect(t).toMatch(/Left 138 AlphaUSD/)
    expect(t).toMatch(/Limit 200 AlphaUSD/)
    expect(t).toContain('Resets 2026-11-05 12:00 UTC · expires 2026-12-05 12:00 UTC')
    expect(t).toMatch(/never spend past (that|the) line/)
    expect(count(html, 'role="img"')).toBe(1)
  })

  it('says what "spent" counts from: since this key was authorised in its first period (a new key starts at 0), else when the period began', () => {
    expect(text(keyBudget(ok(key())))).toContain('Counting since this key was authorised, 2026-10-06 12:00 UTC')
    const later = text(keyBudget(ok(key({ state: { periodEnd: at('2026-12-05T12:00:00Z') } }))))
    expect(later).toContain('This period began 2026-11-05 12:00 UTC')
    expect(later).not.toContain('Counting since')
    expect(text(keyBudget(ok(key({ periodSeconds: null, state: { periodEnd: null } }))))).toContain('Counting since this key was authorised')
  })

  it('spent in full: left is 0 and it says when the bot can pay again', () => {
    const t = text(keyBudget(ok(key({ state: { remaining: 0n } }))))
    expect(t).toMatch(/Left 0 AlphaUSD/)
    expect(t).toContain('Nothing left until the period resets')
  })

  it('large budgets read with thousands grouped: "999,995 AlphaUSD", in the words and in the bar\'s label', () => {
    const big = key({ limit: 1_000_000n * M, state: { remaining: 999_995n * M } })
    const t = text(keyBudget(ok(big)))
    expect(t).toMatch(/Spent this period 5 AlphaUSD/)
    expect(t).toMatch(/Left 999,995 AlphaUSD/)
    expect(t).toMatch(/Limit 1,000,000 AlphaUSD/)
    expect(budgetBar({ spent: 5n * M, limit: 1_000_000n * M, token: TOKEN })).toContain('aria-label="Bot key budget: 5 of 1,000,000 AlphaUSD spent, 999,995 AlphaUSD left.')
  })

  it('a one-time limit: no reset, only the expiry', () => {
    const t = text(keyBudget(ok(key({ periodSeconds: null, state: { periodEnd: null } }))))
    expect(t).toMatch(/^Bot key budget Spent 62 AlphaUSD/)
    expect(t).toContain("One limit for the key's whole life · expires 2026-12-05 12:00 UTC")
  })

  it('a key that expires before the period would reset says so', () => {
    const t = text(keyBudget(ok(key({ state: { expiry: at('2026-10-20T12:00:00Z'), periodEnd: at('2026-11-05T12:00:00Z') } }))))
    expect(t).toMatch(/Expires 2026-10-20 12:00 UTC ?, before the period resets/)
  })

  it('revoked, expired, waiting for authorisation, missing or unreadable: says so plainly and draws no bar', () => {
    const cases: [Parameters<typeof keyBudget>[0], RegExp][] = [
      [ok(key({ state: { status: 'revoked', remaining: 0n } })), /The bot key is revoked: the bot can spend nothing/],
      [ok(key({ state: { status: 'expired', expiry: at('2026-10-01T00:00:00Z') } })), /The bot key expired on 2026-10-01 00:00 UTC ?: the bot can spend nothing/],
      [ok(key({ state: { status: 'not_authorized', remaining: 0n } })), /waits for the treasury's passkey/],
      [{ kind: 'missing' }, /No bot key yet, so the bot can spend nothing/],
      [{ kind: 'unavailable' }, /could not read the bot key from the chain/],
    ]
    for (const [read, words] of cases) {
      const html = keyBudget(read)
      expect(text(html)).toMatch(words)
      expect(html).not.toContain('<svg')
    }
  })
})

describe("keyBudget for a policy's own key: the same picture, in the policy's words", () => {
  /** The text as a person reads it (the words are escaped in the HTML). */
  const said = (html: string) => text(html).replaceAll('&#39;', "'")
  it('names the policy and its key, never the bot, and the bar says whose budget it is', () => {
    const html = keyBudget(ok(key()), POLICY_KEY_WORDS)
    const t = said(html)
    expect(t).toMatch(/^This policy's own budget Spent this period 62 AlphaUSD Left 138 AlphaUSD/)
    expect(html).toContain('aria-label="This policy&#39;s own budget: 62 of 200 AlphaUSD spent, 138 AlphaUSD left.')
    expect(t).toContain('This policy can never spend past that line: the chain enforces it')
    expect(t).not.toMatch(/bot/i)
  })

  it('revoked or expired: the policy pays nothing until it gets a new budget', () => {
    expect(said(keyBudget(ok(key({ state: { status: 'revoked', remaining: 0n } })), POLICY_KEY_WORDS))).toMatch(
      /This policy's key is revoked: this policy can spend nothing\. A treasurer gives it a new budget on the treasury page\./,
    )
    expect(said(keyBudget(ok(key({ state: { status: 'expired', expiry: at('2026-10-01T00:00:00Z') } })), POLICY_KEY_WORDS))).toMatch(
      /This policy's key expired on 2026-10-01 00:00 UTC ?: this policy can spend nothing until a treasurer gives it a new budget on the treasury page/,
    )
    expect(said(keyBudget({ kind: 'unavailable' }, POLICY_KEY_WORDS))).toMatch(/could not read this policy's key from the chain/)
  })
})

describe('weeksChart: paid per week, a policy run apart from a run made by hand', () => {
  it('one week of payouts: one bar, the other weeks empty (never drawn), the summary in the label', () => {
    const svg = weeksChart(weeks([null, null, null, null, null, null, null, [0n, 12n * M]]), 'wide')
    expect(svg).toMatch(/^<svg [^>]*role="img"/)
    expect(svg).toContain('aria-label="Paid per week for the last 12 weeks: 12 AlphaUSD in all, 0 by a policy and 12 by hand. Most in one week: 12 AlphaUSD, the week of Sep 7. This week so far: nothing. 11 of 12 weeks with nothing paid."')
    expect(count(svg, 'class="seg manual')).toBe(1)
    expect(count(svg, 'class="seg policy')).toBe(0)
    expect(count(svg, '<title>')).toBe(12)
    expect(svg).toContain('<title>Week of Sep 7: 12 AlphaUSD, by hand (1 run)</title>')
    expect(svg).toContain('<title>Week of Jul 20: nothing paid</title>')
  })

  it('a full window: twelve bars, a mixed week in two parts with a gap, the current week marked partial, clean scale ticks', () => {
    const full: [bigint, bigint][] = MONDAYS.map((_, i) => [BigInt(i + 1) * 5n * M, i % 3 === 0 ? 2n * M : 0n])
    const svg = weeksChart(weeks(full), 'wide')
    expect(count(svg, 'class="seg policy')).toBe(12)
    expect(count(svg, 'class="seg manual')).toBe(4)
    expect(count(svg, 'class="wk partial"')).toBe(1)
    expect(svg).toMatch(/class="wk partial"[\s\S]*>so far<\/text>[\s\S]*This week/)
    expect(count(svg, '>so far</text>')).toBe(1)
    // The highest week is 60: the scale tops at 100, a gridline at 50, and 0 at the base.
    expect(svg).toMatch(/>100<\/text>/)
    expect(svg).toMatch(/>50<\/text>/)
    expect(svg).toMatch(/>0<\/text>/)
    expect(svg).toContain('<title>Week of Oct 5, so far: 60 AlphaUSD, by a policy (1 run)</title>')
    expect(svg).toContain('<title>Week of Sep 21: 52 AlphaUSD, 50 by a policy and 2 by hand (2 runs)</title>')
    expect(svg).not.toMatch(/style=/)
  })

  it('labels every other week when wide and every third when narrow, always ending with this week', () => {
    const view = weeks([[M, 0n]])
    const labels = (svg: string) => [...svg.matchAll(/<text class="tick" [^>]*>([^<]+)<\/text>/g)].map((m) => m[1])
    expect(labels(weeksChart(view, 'wide'))).toEqual(['Jul 27', 'Aug 10', 'Aug 24', 'Sep 7', 'Sep 21', 'This week'])
    expect(labels(weeksChart(view, 'narrow'))).toEqual(['Aug 3', 'Aug 24', 'Sep 14', 'This week'])
    expect(weeksChart(view, 'narrow')).toContain('class="viz viz-weeks viz-narrow"')
  })

  it('compacts large scale ticks and keeps money exact in the labels', () => {
    const svg = weeksChart(weeks([[12_345_678_901n, 1n]]), 'wide')
    expect(svg).toMatch(/>20K<\/text>/)
    expect(svg).toContain('12,345.678902 AlphaUSD')
  })

  it('escapes the token symbol', () => {
    const svg = weeksChart(weeks([[M, M]], EVIL_TOKEN), 'wide')
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;img ')
  })
})

describe('paidWeeks: the chart, its legend, the 12-week total and the numbers', () => {
  it('no payouts at all: a calm empty state, no chart', () => {
    const html = paidWeeks(weeks([]))
    expect(text(html)).toContain('Nothing paid in the last 12 weeks.')
    expect(html).not.toContain('<svg')
  })

  it('with payouts: the total, a legend in words, a wide and a narrow chart, and every value in a table', () => {
    const html = paidWeeks(weeks([null, [50n * M, 12n * M], null, null, null, null, null, null, null, null, [0n, 3n * M], [62n * M, 0n]]))
    const t = text(html)
    expect(t).toMatch(/Last 12 weeks 127 AlphaUSD/)
    expect(t).toContain('Made by a policy')
    expect(t).toContain('Made by hand')
    expect(count(html, 'role="img"')).toBe(2)
    expect(html).toContain('<summary>Show the numbers</summary>')
    expect(count(html, '<tr>')).toBe(1 + 12 + 1) // the head, a row per week, the total
    expect(t).toContain('2026-07-27 50 AlphaUSD 12 AlphaUSD 62 AlphaUSD 2')
    expect(t).toContain('2026-10-05 so far 62 AlphaUSD 0 AlphaUSD 62 AlphaUSD 1')
    expect(html).toContain('<span class="muted">0 AlphaUSD</span>')
    expect(t).toContain('12 weeks 112 AlphaUSD 15 AlphaUSD 127 AlphaUSD 4')
  })

  it('escapes the token symbol everywhere', () => {
    const html = paidWeeks(weeks([[M, M]], EVIL_TOKEN))
    expect(html).not.toContain('<img')
    expect(count(html, '&lt;img ')).toBeGreaterThan(5)
  })
})

describe('atAGlance: one panel, the budget and the weeks', () => {
  it('holds both parts, or the budget alone when the weekly payouts are not wired', () => {
    const both = atAGlance({ key: ok(key()), payouts: weeks([[M, 0n]]) })
    expect(both).toMatch(/^<section class="card glance" aria-labelledby="glance">/)
    expect(text(both)).toMatch(/^At a glance Bot key budget .* Paid per week/)
    expect(count(both, 'role="img"')).toBe(3) // the budget bar, the wide and the narrow weekly chart
    expect(text(atAGlance({ key: ok(key()), payouts: null }))).not.toContain('Paid per week')
  })
})
