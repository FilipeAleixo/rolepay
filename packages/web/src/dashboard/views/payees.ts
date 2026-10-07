import type { Payee } from '@rolepay/core'
import { type Names, addressLink, day, esc, money, person, row, table } from './format.js'

export type PayeeTotals = { thisPeriod: bigint; lastPeriod: bigint; allTime: bigint; last: { at: Date; runId: string; amount: bigint } | null }

export function payeesBody(d: {
  guildId: string
  token: string
  explorer: string
  payees: Payee[]
  totals: ReadonlyMap<string, PayeeTotals>
  names: Names
  /** For example "October 2026" and "September 2026" (UTC calendar months). */
  periods: { this: string; last: string }
}): string {
  const g = esc(d.guildId)
  const none: PayeeTotals = { thisPeriod: 0n, lastPeriod: 0n, allTime: 0n, last: null }
  const rows = d.payees.map((p) => {
    const t = d.totals.get(p.discordUserId) ?? none
    return row(
      [
        person(p.discordUserId, d.names),
        addressLink(d.explorer, p.address),
        money(t.thisPeriod, d.token),
        money(t.lastPeriod, d.token),
        money(t.allTime, d.token),
        t.last ? `${day(t.last.at)}, ${money(t.last.amount, d.token)} <a href="/dashboard/${g}/runs/${encodeURIComponent(t.last.runId)}">run</a>` : '<span class="muted">never</span>',
        day(p.registeredAt),
      ],
      { numeric: [2, 3, 4] },
    )
  })
  const list = rows.length
    ? table('Payees', ['Person', 'Paid to', esc(d.periods.this), esc(d.periods.last), 'All time', 'Last payment', 'Registered'], rows, { numeric: [2, 3, 4] })
    : '<p class="muted">Nobody has linked a payout account yet. Members run <code>/payee link</code> in Discord.</p>'
  return `<h1>Payees</h1><p class="lede">People registered to be paid, and what paid runs sent them (calendar months, UTC).</p><section class="card">${list}</section>`
}
