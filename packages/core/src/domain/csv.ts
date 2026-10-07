import { formatAmount } from './money.js'
import { lineToken } from './reconcile.js'
import type { Run } from './run.js'

const COLUMNS = [
  'run_id',
  'line',
  'discord_user_id',
  'address',
  'amount',
  'token',
  'memo',
  'status',
  'tx_hash',
  'explorer_url',
  'paid_at',
  'approved_by',
  'note',
  'delivered_token',
] as const

/**
 * One CSV cell. Quotes per RFC 4180, and defuses spreadsheet formulas: a note is
 * user text, and "=..." in a treasurer's spreadsheet is code.
 */
export function csvCell(value: string): string {
  const defused = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(defused) ? `"${defused.replace(/"/g, '""')}"` : defused
}

/**
 * Accounting export for one run: one row per payout line. `token` is the run's (what the treasury
 * pays in); `delivered_token`, added last so existing columns keep their places, is what the payee
 * received: the same token, or the stablecoin they prefer, bought on the DEX in the same transaction.
 */
export function runToCsv(run: Run, opts: { explorerTxUrl: (txHash: string) => string }): string {
  const rows = run.lines.map((l) => [
    run.id,
    String(l.line),
    l.payeeDiscordId,
    l.address,
    formatAmount(l.amount, { fixed: true }),
    run.token,
    l.memo,
    run.status,
    run.paidTxHash ?? '',
    run.paidTxHash ? opts.explorerTxUrl(run.paidTxHash) : '',
    run.paidAt?.toISOString() ?? '',
    run.approvedBy ?? '',
    run.note ?? '',
    lineToken(run, l),
  ])
  return [COLUMNS as readonly string[], ...rows].map((r) => `${r.map(csvCell).join(',')}\r\n`).join('')
}
