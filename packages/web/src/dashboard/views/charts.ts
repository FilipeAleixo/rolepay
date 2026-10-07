import { type KeyStatusView, displayAmount } from '@rolepay/core'
import type { PaidByWeekView, PaidWeekView } from '../policyPort.js'
import { day, esc, money, row, table, tokenLabel, when } from './format.js'
import type { ChainRead } from './overview.js'

/**
 * The Overview's "At a glance" panel: the bot key's budget as one bar with the limit as a hard end
 * line, and what was paid each week. Pure builders of inline SVG, no script and no chart library:
 * the look comes from DASHBOARD_STYLE (classes) and SVG attributes, never a style attribute (the
 * CSP allows the one stylesheet only). Each picture is an image with a summary in its label, and
 * every value is also in words or in a table, so nothing depends on colour or on hovering.
 *
 * Money is bigint micro-units throughout; only the drawing (bar lengths in px and %) is a number.
 * Every string from data (the token symbol) is escaped.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const weekLabel = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
/** A drawing coordinate, to two decimals. */
const px = (n: number) => Math.round(n * 100) / 100
/** Money for reading, thousands grouped ("999,995"). */
const amount = (m: bigint) => displayAmount(m)

const part = (body: string) => `<div class="glance-part">${body}</div>`
const notice = (tone: '' | 'warn' | 'bad', body: string) => `<p class="notice${tone ? ` ${tone}` : ''}">${body}</p>`
const figure = (label: string, value: bigint, token: string, end = false) =>
  `<p class="figure${end ? ' end' : ''}"><span class="label">${label}</span> <span class="value">${amount(value)} <span class="unit">${esc(tokenLabel(token))}</span></span></p>`

// ---- the bot key's budget --------------------------------------------------------------------

const BAR = { height: 32, y: 10, thickness: 12 }

/**
 * The budget as one bar: the part spent this period in gold, the rest as a faint track, and the
 * limit as a solid line at the end, which is the trust model in one picture (the bot cannot spend
 * past it; the chain refuses it). Widths are percentages, so it fills any width without scaling.
 */
export function budgetBar(b: { spent: bigint; limit: bigint; token: string }): string {
  const symbol = tokenLabel(b.token)
  const spent = b.spent < 0n ? 0n : b.spent > b.limit ? b.limit : b.spent
  const left = b.limit - spent
  // Hundredths of a percent, from the bigints; a spend too small to see is drawn at half a percent.
  const exact = b.limit > 0n ? Number((spent * 10_000n) / b.limit) / 100 : 0
  const pct = spent > 0n && exact < 0.5 ? 0.5 : exact
  const { height, y, thickness } = BAR
  const label = `Bot key budget: ${amount(spent)} of ${amount(b.limit)} ${symbol} spent, ${amount(left)} ${symbol} left. The chain refuses any payment past the limit.`
  // The spent part: rounded at its end, square where it starts; a 2px gap before the track.
  const spentPart = spent > 0n ? `<svg width="${pct}%" height="${height}"><rect class="spent" y="${y}" width="100%" height="${thickness}" rx="3"/><rect class="spent" y="${y}" width="4" height="${thickness}"/></svg>` : ''
  const track =
    left === 0n
      ? ''
      : spent > 0n
        ? `<svg x="${pct}%" width="${px(100 - pct)}%" height="${height}"><rect class="track" x="2" y="${y}" width="100%" height="${thickness}"/></svg>`
        : `<rect class="track" x="0" y="${y}" width="100%" height="${thickness}"/>`
  const limit = `<svg x="100%" width="2" height="${height}" overflow="visible"><rect class="limit" x="-2" y="1" width="2" height="${height - 2}"/></svg>`
  return `<svg class="viz viz-budget" role="img" aria-label="${esc(label)}" width="100%" height="${height}">${track}${spentPart}${limit}</svg>`
}

/** What the bot may still spend this period, drawn; or, when it may spend nothing, why, in words and with no bar. */
export function keyBudget(read: ChainRead<KeyStatusView>): string {
  const head = '<h3>Bot key budget</h3>'
  if (read.kind === 'unavailable') return part(`${head}<p class="muted">Rolepay could not read the bot key from the chain just now, so its budget is not drawn. Reload in a moment.</p>`)
  if (read.kind === 'missing') return part(`${head}${notice('', 'No bot key yet, so the bot can spend nothing. A treasurer authorises one on the setup page: <code>/rolepay setup</code> in Discord.')}`)
  const { key, state } = read.value
  const expires = new Date((state.expiry || key.policy.expiresAt) * 1000)
  if (state.status === 'revoked') return part(`${head}${notice('bad', 'The bot key is revoked: the bot can spend nothing. A treasurer authorises a new key on the setup page.')}`)
  if (state.status === 'expired') return part(`${head}${notice('bad', `The bot key expired on ${when(expires)}: the bot can spend nothing until a treasurer authorises a new key on the setup page.`)}`)
  if (state.status === 'not_authorized') return part(`${head}${notice('warn', "The bot key waits for the treasury's passkey to authorise it. Until then the bot can spend nothing.")}`)

  const { limit, token, periodSeconds } = key.policy
  const left = state.remaining > limit ? limit : state.remaining
  const spent = limit - left
  const periodic = periodSeconds !== null
  const resets = state.periodEnd ? new Date(state.periodEnd * 1000) : null
  // Each clause stays on one line on a phone.
  const clause = (words: string) => `<span class="nowrap">${words}</span>`
  const timing = !periodic
    ? `One limit for the key's whole life · ${clause(`expires ${when(expires)}`)}`
    : resets && resets < expires
      ? `${clause(`Resets ${when(resets)}`)} · ${clause(`expires ${when(expires)}`)}`
      : `${clause(`Expires ${when(expires)}`)}, before the period resets`
  const empty =
    left === 0n ? `<p class="quiet">${periodic ? 'Nothing left until the period resets: a run waits until then.' : 'Nothing left: a treasurer authorises a new key on the setup page.'}</p>` : ''
  return part(
    `${head}<div class="figures">${figure(periodic ? 'Spent this period' : 'Spent', spent, token)}${figure('Left', left, token, true)}</div>` +
      `${budgetBar({ spent, limit, token })}<p class="budget-limit"><span class="label">Limit</span> ${money(limit, token)}</p>` +
      `<p class="quiet">${timing}</p>${empty}<p class="caption">The bot can never spend past that line: the chain enforces it, whatever Rolepay's own code does.</p>`,
  )
}

// ---- paid per week ---------------------------------------------------------------------------

/**
 * Two drawings of the same chart, one shown at a time by a media query: wide (every other week
 * labelled) and narrow (every third, thinner bars). Slots are percentages of the width, so bars
 * keep their thickness in px and text keeps its size at any width (no viewBox scaling).
 */
const LAYOUTS = {
  wide: { gutter: 7, bar: 20, plot: 128, every: 2 },
  narrow: { gutter: 13, bar: 12, plot: 112, every: 3 },
} as const
const TOP = 16
const TICK_BAND = 24
const GAP = 2

/** The smallest of 1, 2, 2.5, 5 or 10 times a power of ten (in micro-units) at or above the peak. */
function niceCeiling(peak: bigint): bigint {
  if (peak <= 0n) return 1_000_000n
  let p = 1n
  while (p * 10n <= peak) p *= 10n
  for (const c of [p, 2n * p, (5n * p) / 2n, 5n * p]) if (c >= peak) return c
  return 10n * p
}

/** A scale tick: "250", "12.5K", "2M" (whole tokens; large ones compact). */
function compact(v: bigint): string {
  if (v >= 10_000_000_000_000n) return `${displayAmount(v / 1_000_000n)}M`
  if (v >= 10_000_000_000n) return `${displayAmount(v / 1_000n)}K`
  return displayAmount(v)
}

const runsWord = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`

/** The tooltip and the words for one week (raw text: escaped where it is written). */
function weekWords(w: PaidWeekView, symbol: string): string {
  const when = `Week of ${weekLabel(w.start)}${w.partial ? ', so far' : ''}`
  if (w.runs === 0) return `${when}: nothing paid`
  const total = `${amount(w.policy + w.manual)} ${symbol}`
  const split = w.policy > 0n && w.manual > 0n ? `${amount(w.policy)} by a policy and ${amount(w.manual)} by hand` : w.policy > 0n ? 'by a policy' : 'by hand'
  return `${when}: ${total}, ${split} (${runsWord(w.runs)})`
}

/** A bar segment from `top` to `bottom`, `half` either side of 0, rounded at the top by `r`. */
function segmentPath(half: number, top: number, bottom: number, r: number): string {
  const t = px(top)
  const b = px(bottom)
  if (r <= 0) return `M${-half} ${b}V${t}H${half}V${b}Z`
  return `M${-half} ${b}V${px(top + r)}A${r} ${r} 0 0 1 ${px(-half + r)} ${t}H${px(half - r)}A${r} ${r} 0 0 1 ${half} ${px(top + r)}V${b}Z`
}

/** Where a week's bar ends at the top (its whole height), for the label above it. */
function barTop(w: PaidWeekView, height: (v: bigint) => number, base: number): number {
  const hp = w.policy > 0n ? Math.max(2, height(w.policy)) : 0
  const hm = w.manual > 0n ? Math.max(2, height(w.manual)) : 0
  if (!hm) return base - hp
  return Math.min(base - hp - hm, (hp ? base - hp - GAP : base) - 2)
}

/** A policy's runs at the base, runs made by hand above them, a 2px gap between (carved from the upper part, so the total height stays true). */
function segments(w: PaidWeekView, height: (v: bigint) => number, base: number, half: number): string {
  const parts: { cls: 'policy' | 'manual'; top: number; bottom: number }[] = []
  const hp = w.policy > 0n ? Math.max(2, height(w.policy)) : 0
  const hm = w.manual > 0n ? Math.max(2, height(w.manual)) : 0
  if (hp) parts.push({ cls: 'policy', top: base - hp, bottom: base })
  if (hm) {
    const bottom = hp ? base - hp - GAP : base
    parts.push({ cls: 'manual', top: Math.min(base - hp - hm, bottom - 2), bottom })
  }
  return parts
    .map((s, i) => `<path class="seg ${s.cls}" d="${segmentPath(half, s.top, s.bottom, i === parts.length - 1 ? Math.min(4, s.bottom - s.top, half) : 0)}"/>`)
    .join('')
}

/** The chart's summary, for its label. */
function weeksSummary(view: PaidByWeekView, symbol: string): string {
  const n = view.weeks.length
  const peak = view.weeks.reduce<PaidWeekView | null>((best, w) => (!best || w.policy + w.manual > best.policy + best.manual ? w : best), null)
  const current = view.weeks.at(-1)
  const now = current && current.runs > 0 ? `${amount(current.policy + current.manual)} ${symbol}` : 'nothing'
  const empty = view.weeks.filter((w) => w.runs === 0).length
  const most = peak && peak.runs > 0 ? ` Most in one week: ${amount(peak.policy + peak.manual)} ${symbol}, the week of ${weekLabel(peak.start)}.` : ''
  return `Paid per week for the last ${n} weeks: ${amount(view.total)} ${symbol} in all, ${amount(view.policy)} by a policy and ${amount(view.manual)} by hand.${most} This week so far: ${now}. ${empty} of ${n} weeks with nothing paid.`
}

/** The weekly bars, a policy's runs apart from runs made by hand, the current week marked as partial. */
export function weeksChart(view: PaidByWeekView, layout: keyof typeof LAYOUTS): string {
  const L = LAYOUTS[layout]
  const symbol = tokenLabel(view.token)
  const n = view.weeks.length
  const peak = view.weeks.reduce((m, w) => (w.policy + w.manual > m ? w.policy + w.manual : m), 0n)
  const top = niceCeiling(peak)
  const base = TOP + L.plot
  const svgHeight = base + TICK_BAND
  const height = (v: bigint) => Number((v * BigInt(L.plot * 100)) / top) / 100
  const yOf = (v: bigint) => px(base - height(v))
  const scale = [top, ...(top % 2n === 0n ? [top / 2n] : []), 0n]
  const grid = scale
    .map((v) => {
      const y = yOf(v) + 0.5
      return `<line class="${v === 0n ? 'base' : 'grid'}" x1="${L.gutter}%" x2="100%" y1="${y}" y2="${y}"/><text class="axis" x="${L.gutter}%" dx="-8" y="${px(yOf(v) + 3.5)}" text-anchor="end">${compact(v)}</text>`
    })
    .join('')
  const slot = 100 / n
  const weeks = view.weeks
    .map((w, i) => {
      const labelled = (n - 1 - i) % L.every === 0
      const bars = segments(w, height, base, L.bar / 2)
      // The week in progress says so on the bar itself (and under it, "This week").
      const soFar = w.partial && w.runs > 0 ? `<text class="sofar" x="50%" y="${px(barTop(w, height, base) - 6)}" text-anchor="middle">so far</text>` : ''
      return (
        `<svg class="wk${w.partial ? ' partial' : ''}" x="${px(i * slot)}%" width="${px(slot)}%" height="${svgHeight}" overflow="visible"><title>${esc(weekWords(w, symbol))}</title>` +
        `<rect class="hit" width="100%" height="${base}"/>${bars ? `<svg x="50%" overflow="visible">${bars}</svg>` : ''}${soFar}` +
        `${labelled ? `<text class="tick" x="50%" y="${base + 17}" text-anchor="middle">${w.partial ? 'This week' : weekLabel(w.start)}</text>` : ''}</svg>`
      )
    })
    .join('')
  return (
    `<svg class="viz viz-weeks viz-${layout}" role="img" aria-label="${esc(weeksSummary(view, symbol))}" width="100%" height="${svgHeight}">` +
    `${grid}<svg x="${L.gutter}%" width="${100 - L.gutter}%" height="${svgHeight}" overflow="visible">${weeks}</svg></svg>`
  )
}

/** Every value of the chart, exactly, oldest week first, with the totals. */
function numbers(view: PaidByWeekView): string {
  const t = view.token
  const numeric = [1, 2, 3, 4]
  // A zero is quieter than an amount, so the weeks with payouts stand out.
  const cell = (m: bigint) => (m === 0n ? `<span class="muted">${money(m, t)}</span>` : money(m, t))
  const rows = view.weeks.map((w) =>
    row([`${day(w.start)}${w.partial ? ' <span class="muted small">so far</span>' : ''}`, cell(w.policy), cell(w.manual), cell(w.policy + w.manual), w.runs ? String(w.runs) : '<span class="muted">0</span>'], { numeric }),
  )
  rows.push(row([`<strong>${view.weeks.length} weeks</strong>`, ...[view.policy, view.manual, view.total].map((m) => `<strong>${money(m, t)}</strong>`), `<strong>${view.runs}</strong>`], { numeric }))
  return table('Paid per week, the numbers', ['Week of', 'By a policy', 'By hand', 'Total', 'Runs'], rows, { numeric })
}

/** Paid per week: the total, a legend in words, the chart (wide and narrow) and its numbers; a calm line when nothing was paid. */
export function paidWeeks(view: PaidByWeekView): string {
  const head = '<h3>Paid per week</h3>'
  const n = view.weeks.length
  if (view.total === 0n) {
    return part(`${head}<p class="empty">Nothing paid in the last ${n} weeks.</p><p class="quiet">Each paid run shows here in the week it was paid, the runs a policy made apart from the runs made by hand.</p>`)
  }
  const legend =
    '<p class="legend"><span><span class="key policy"></span>Made by a policy</span><span><span class="key manual"></span>Made by hand</span></p>'
  return part(
    `${head}<div class="figures">${figure(`Last ${n} weeks`, view.total, view.token)}</div>${legend}${weeksChart(view, 'wide')}${weeksChart(view, 'narrow')}` +
      `<details><summary>Show the numbers</summary>${numbers(view)}</details>`,
  )
}

/** The panel: the bot key's budget and, when the server wires the weekly payouts, paid per week. */
export function atAGlance(d: { key: ChainRead<KeyStatusView>; payouts: PaidByWeekView | null }): string {
  return `<section class="card glance" aria-labelledby="glance"><h2 id="glance">At a glance</h2><div class="glance-grid${d.payouts ? ' two' : ''}">${keyBudget(d.key)}${d.payouts ? paidWeeks(d.payouts) : ''}</div></section>`
}
