import { type Deposit, type FundingMonth, type FundingStatus, type FundingSummary, formatAmount } from '@rolepay/core'
import { type Names, addressLink, day, esc, money, person, row, table, tokenLabel, txLink, when } from './format.js'
import { csrfField } from './layout.js'
import { qrSvg } from './qr.js'

const DONE: Record<string, string> = { source_created: 'Funding source created. Share its deposit address with the funder.' }
const ERRORS: Record<string, string> = {
  name_taken: 'A funding source already has that name.',
  invalid_input: 'Give the source a name: one line, up to 80 characters.',
  not_set_up: 'Deposit addresses are not set up yet: a treasurer sets them up once on the treasury page (<code>/rolepay setup</code> in Discord).',
  not_permitted: 'Only the Treasurer role can create funding sources.',
  too_many_sources: 'This community has as many funding sources as Rolepay keeps (200).',
}

export function fundingNotice(done: string | undefined, error: string | undefined): string {
  if (done && DONE[done]) return `<p class="notice ok" role="status">${DONE[done]}</p>`
  if (error && /^[a-z_]{1,40}$/.test(error)) return `<p class="notice bad" role="alert">${ERRORS[error] ?? `That did not work (${esc(error)}).`}</p>`
  return ''
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * An amount that came in: in its token when there is one, else "7.5 USD" (they are all USD
 * stablecoins with 6 decimals) and, with `breakdown`, each token's part.
 */
export function received(s: Pick<FundingSummary, 'total' | 'byToken'>, fallbackToken: string, opts: { breakdown?: boolean } = {}): string {
  const only = s.byToken.length === 1 ? s.byToken[0] : undefined
  if (only) return money(only.amount, only.token)
  if (s.byToken.length === 0) return money(0n, fallbackToken)
  const parts = opts.breakdown ? ` <span class="muted small">(${s.byToken.map((b) => money(b.amount, b.token)).join(', ')})</span>` : ''
  return `${formatAmount(s.total)} USD${parts}`
}

/** The Overview's card, once deposit addresses are set up: what came in this UTC month and from how many sources. */
export function fundedCard(guildId: string, month: FundingMonth | null, payoutToken: string): string {
  if (!month?.setUp) return ''
  const from = month.deposits === 0 ? 'No deposits yet this month.' : `from ${plural(month.sources, 'source', 'sources')}, since ${day(month.since)}.`
  return `<section class="card"><h2>Funded this month</h2><p class="big">${received(month, payoutToken)}</p><p class="muted small">${from}</p>
<p><a href="/dashboard/${esc(guildId)}/funding">Funding sources and deposits</a></p></section>`
}

const WARNING = 'Only TIP-20 stablecoins on Tempo. A token sent from another network, or any other kind of token, does not arrive.'

export function fundingBody(d: {
  guildId: string
  status: FundingStatus
  month: FundingMonth
  deposits: Deposit[]
  treasury: string
  payoutToken: string
  explorer: string
  names: Names
  canAct: boolean
  csrf: string
  notice: string
}): string {
  const g = esc(d.guildId)
  const head = `<h1>Funding</h1><p class="lede">Where the treasury's money comes from. Each funding source has its own deposit address: whatever is sent there lands in the treasury itself, with no sweep, and Rolepay records which source it came from. A deposit address can only ever add money.</p>${d.notice}`
  if (!d.status.configured) return `${head}<section class="card"><p>Deposit addresses are not available on this Rolepay server.</p></section>`
  const master = d.status.master
  if (!master) {
    return `${head}<section class="card"><h2>Deposit addresses are not set up</h2><p>A treasurer sets them up once on the treasury page: <code>/rolepay setup</code> in Discord gives the link. It takes about a minute of work in the browser and one passkey prompt.</p></section>`
  }
  const sourceName = new Map(d.status.sources.map((s) => [s.source.id, s.source.name]))
  const summary = `<section class="card" data-live-region="funded"><h2>Funded this month</h2><p class="big">${received(d.month, d.payoutToken, { breakdown: true })}</p>
<p class="muted small">${d.month.deposits === 0 ? 'No deposits yet this month.' : `from ${plural(d.month.sources, 'source', 'sources')}, since ${day(d.month.since)}.`}</p>
<dl class="facts"><dt>Lands in</dt><dd>${addressLink(d.explorer, d.treasury, { full: true })}</dd><dt>Addresses start with</dt><dd><code>${esc(master.masterId)}</code></dd>${
    master.txHash ? `<dt>Registered</dt><dd>${txLink(d.explorer, master.txHash)}</dd>` : ''
  }</dl></section>`
  const create = d.canAct
    ? `<form class="card" method="post" action="/dashboard/${g}/funding/sources">${csrfField(d.csrf)}<h2>New funding source</h2>
<div class="field"><label for="name">Name</label><input id="name" name="name" maxlength="80" required placeholder="Q4 bounty sponsor: Acme DAO"></div>
<button type="submit">Create its deposit address</button><p class="muted small">Or in Discord: <code>/rolepay fund new name:</code></p></form>`
    : '<section class="card"><h2>Adding a source</h2><p class="muted">A Treasurer creates funding sources here or with <code>/rolepay fund new</code> in Discord.</p></section>'
  const sources = d.status.sources.length
    ? `<div class="grid">${d.status.sources
        .map(({ source, received: r }) => {
          const got = r.deposits === 0 ? 'Nothing received yet' : `Received ${received(r, d.payoutToken)} in ${plural(r.deposits, 'deposit', 'deposits')}`
          return `<section class="card"><h2>${esc(source.name)}</h2><p class="muted small">${got} · created by ${person(source.createdBy, d.names)}, ${day(source.createdAt)}</p>
<div class="deposit-to">${qrSvg(source.depositAddress, { label: `QR code of the deposit address ${source.depositAddress}` })}<div><p class="label">Deposit address</p><p><code>${esc(source.depositAddress)}</code></p><p class="small"><a href="${esc(`${d.explorer}/address/${source.depositAddress}`)}" rel="noreferrer" target="_blank">On the explorer</a></p></div></div></section>`
        })
        .join('')}</div>`
    : '<section class="card"><p class="muted">No funding sources yet.</p></section>'
  const rows = d.deposits.map((x) =>
    row(
      [when(x.blockTime), esc(sourceName.get(x.sourceId) ?? x.sourceId), money(x.amount, x.token), x.from === '0x0000000000000000000000000000000000000000' ? '<span class="muted">minted</span>' : addressLink(d.explorer, x.from), txLink(d.explorer, x.txHash)],
      { numeric: [2] },
    ),
  )
  const deposits = rows.length
    ? table('Deposits', ['When', 'Source', 'Amount', 'From', 'Transaction'], rows, { numeric: [2] })
    : '<p class="muted">No deposits yet. They show here within a minute of landing.</p>'
  return `${head}<div class="grid">${summary}${create}</div>
<p class="muted small">${WARNING}</p>
<div data-live-region="sources">${sources}</div>
<section class="card" data-live-region="deposits"><h2>Deposits</h2>${deposits}<p class="muted small">"From" is whoever sent it: anyone can send to a deposit address, so a source says where the money arrived, not who signed for it. Amounts in ${esc(tokenLabel(d.payoutToken))} and the network's other USD stablecoins.</p></section>`
}
