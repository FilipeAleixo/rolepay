import { type RunStatus, TOKEN_SYMBOLS, displayAmount } from '@rolepay/core'
import { esc } from '../../views/page.js'

/** Display helpers shared by the dashboard views. Everything a person or Discord wrote goes through `esc`. */
export { esc }

/** People named by the bot's view of the guild; anyone missing is shown by their Discord ID. */
export type Names = ReadonlyMap<string, string>

export const tokenLabel = (token: string) => TOKEN_SYMBOLS[token.toLowerCase()] ?? `${token.slice(0, 6)}...${token.slice(-4)}`

/** "12.5 AlphaUSD", "999,995 AlphaUSD" (thousands grouped, for reading; the CSV keeps plain digits). Money is bigint micro-units throughout. */
export const money = (amount: bigint, token: string) => `${displayAmount(amount)} ${esc(tokenLabel(token))}`

const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-10-06 12:00 UTC" in a <time> element. */
export function when(d: Date): string {
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  return `<time datetime="${d.toISOString()}">${s}</time>`
}

/** "2026-10-06". */
export const day = (d: Date) => `<time datetime="${d.toISOString()}">${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}</time>`

/** A person by name, or by Discord ID when the bot could not name them. */
export const person = (id: string | null, names: Names) => (id === null ? 'Rolepay' : names.has(id) ? esc(names.get(id) as string) : `<span class="muted">user ${esc(id)}</span>`)

export const shortHex = (h: string) => `${h.slice(0, 8)}...${h.slice(-6)}`

export const addressLink = (explorer: string, address: string, opts: { full?: boolean } = {}) =>
  `<a href="${esc(`${explorer}/address/${address}`)}" rel="noreferrer" target="_blank"><code>${esc(opts.full ? address : shortHex(address))}</code></a>`

export const txLink = (explorer: string, hash: string) => `<a href="${esc(`${explorer}/tx/${hash}`)}" rel="noreferrer" target="_blank"><code>${esc(shortHex(hash))}</code></a>`

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  executing: 'Paying',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const RUN_TONES: Record<RunStatus, string> = { draft: '', pending_approval: 'warn', approved: 'info', executing: 'info', paid: 'ok', failed: 'bad', cancelled: '' }

/** A status as a labelled pill: the word carries the meaning, the colour only repeats it. */
export const pill = (label: string, tone = '') => `<span class="pill${tone ? ` ${tone}` : ''}">${esc(label)}</span>`
export const runPill = (s: RunStatus) => pill(RUN_STATUS_LABELS[s], RUN_TONES[s])

/** "every 30 days", "every 12 hours", or "for the key's whole life". */
export function period(seconds: number | null): string {
  if (seconds === null) return "for the key's whole life"
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'every day' : `every ${seconds / 86_400} days`
  return `every ${Math.round(seconds / 3600)} hours`
}

/** A table that scrolls sideways on a phone instead of breaking the page; focusable so a keyboard can scroll it. */
export const table = (label: string, head: string[], rows: string[], opts: { numeric?: number[] } = {}) => {
  const num = new Set(opts.numeric ?? [])
  return `<div class="table-wrap" role="region" aria-label="${esc(label)}" tabindex="0"><table><thead><tr>${head
    .map((h, i) => `<th scope="col"${num.has(i) ? ' class="num"' : ''}>${h}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

export const row = (cells: string[], opts: { numeric?: number[] } = {}) => {
  const num = new Set(opts.numeric ?? [])
  return `<tr>${cells.map((c, i) => `<td${num.has(i) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`
}
