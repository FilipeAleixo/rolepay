import { type Community, type KeyStatusView, type Run, usdText } from '@rolepay/core'
import type { AiSpendView, RunOrigin, ScheduledRunView } from '../policyPort.js'
import { type Names, addressLink, day, esc, money, period, person, pill, row, runPill, table, tokenLabel, when } from './format.js'

/** A chain read that may have failed: the value, `missing` (no key yet), or `unavailable` (the RPC). */
export type ChainRead<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'unavailable' }

export type OverviewData = {
  community: Community
  explorer: string
  balance: ChainRead<bigint>
  key: ChainRead<KeyStatusView>
  /** null: the policy services are not wired on this server. */
  upcoming: ScheduledRunView[] | null
  recent: Run[]
  origins: Record<string, RunOrigin>
  names: Names
  /** null: the AI spend is not wired on this server (the card is left out). */
  aiSpend: AiSpendView | null
}

const UNREADABLE = '<p class="muted">Rolepay could not read the chain just now. Reload in a moment.</p>'

function keyCard(d: OverviewData): string {
  const head = '<h2>Bot key</h2>'
  if (d.key.kind === 'unavailable') return `<section class="card">${head}${UNREADABLE}</section>`
  if (d.key.kind === 'missing') {
    return `<section class="card">${head}<p>No bot key yet. A treasurer authorises one on the setup page: <code>/rolepay setup</code> in Discord.</p></section>`
  }
  const { key, state } = d.key.value
  const tone = state.status === 'active' ? 'ok' : state.status === 'not_authorized' ? 'warn' : 'bad'
  const label = key.status === 'pending_authorization' && state.status === 'not_authorized' ? 'waiting for authorisation' : state.status.replace('_', ' ')
  const limit = `${money(key.policy.limit, key.policy.token)} ${period(key.policy.periodSeconds)}`
  const remaining =
    state.status === 'active'
      ? `<p class="big">${money(state.remaining, key.policy.token)} left</p>${state.periodEnd ? `<p class="muted small">this period, until ${when(new Date(state.periodEnd * 1000))}</p>` : ''}`
      : ''
  return `<section class="card"><h2>Bot key ${pill(label, tone)}</h2>${remaining}
<dl class="facts"><dt>Limit</dt><dd>${limit}</dd><dt>Expiry</dt><dd>Expires ${when(new Date(state.expiry * 1000 || key.policy.expiresAt * 1000))}</dd><dt>Key</dt><dd>${addressLink(d.explorer, key.address)}</dd></dl>
<p class="muted small">The bot can only send ${esc(tokenLabel(key.policy.token))} with a memo, within this limit. The treasury's passkey can revoke it at any time.</p></section>`
}

function treasuryCard(d: OverviewData): string {
  const balance =
    d.balance.kind === 'ok' ? `<p class="big">${money(d.balance.value, d.community.payoutToken)}</p>` : d.balance.kind === 'unavailable' ? UNREADABLE : ''
  return `<section class="card"><h2>Treasury</h2>${balance}<dl class="facts"><dt>Account</dt><dd>${addressLink(d.explorer, d.community.treasuryAddress, { full: true })}</dd><dt>Pays in</dt><dd>${esc(tokenLabel(d.community.payoutToken))}</dd><dt>Fees</dt><dd>${d.community.feeMode === 'sponsor' ? 'paid by the sponsor' : 'from the fee budget'}</dd></dl></section>`
}

function upcomingCard(d: OverviewData): string {
  const body =
    d.upcoming === null
      ? '<p class="muted">Scheduled runs come with policies, which this server does not run yet.</p>'
      : d.upcoming.length === 0
        ? '<p class="muted">No policy is scheduled to run.</p>'
        : `<ul>${d.upcoming
            .map(
              (u) =>
                `<li><a href="/dashboard/${esc(d.community.id)}/policies/${encodeURIComponent(u.policyId)}">${esc(u.policyName)}</a>: ${when(u.at)} ${pill(u.mode === 'autopilot' ? 'autopilot' : 'needs approval', u.mode === 'autopilot' ? 'info' : '')}</li>`,
            )
            .join('')}</ul>`
  return `<section class="card"><h2>Next scheduled runs</h2>${body}</section>`
}

const calls = (n: number) => `${n} model ${n === 1 ? 'call' : 'calls'}`

/** This month's AI spend: the estimated total and the average cost of a drafted proposal. */
function aiCard(spend: AiSpendView | null): string {
  if (!spend) return ''
  const head = `<h2>AI this month</h2><p class="big">${esc(usdText(spend.totalMicroUsd))}</p>`
  if (spend.calls === 0) return `<section class="card">${head}<p class="muted">No model calls this month.</p></section>`
  const average =
    spend.proposals === 0 ? 'no proposal drafted yet' : `${spend.averagePerProposalMicroUsd === null ? 'unknown' : esc(usdText(spend.averagePerProposalMicroUsd))} (${spend.proposals} drafted)`
  const unpriced = spend.unpriced
    ? `<p class="muted small">${spend.unpriced === 1 ? '1 call on a model with no price is' : `${spend.unpriced} calls on a model with no price are`} not in the total.</p>`
    : ''
  return `<section class="card">${head}<p class="muted small">${calls(spend.calls)} since ${day(spend.since)}, estimated from the list price.</p>
<dl class="facts"><dt>Average per proposal</dt><dd>${average}</dd></dl>${unpriced}</section>`
}

export function runRows(guildId: string, runs: Run[], origins: Record<string, RunOrigin>, names: Names): string[] {
  return runs.map((r) =>
    row(
      [
        `<a href="/dashboard/${esc(guildId)}/runs/${encodeURIComponent(r.id)}">${esc(r.id)}</a>${r.note ? `<br><span class="small muted">${esc(r.note)}</span>` : ''}`,
        when(r.createdAt),
        runPill(r.status),
        String(r.lines.length),
        money(r.total, r.token),
        person(r.createdBy, names),
        origins[r.id] ? esc(origins[r.id]?.policyName ?? '') : '<span class="muted">by hand</span>',
      ],
      { numeric: [3, 4] },
    ),
  )
}

export const RUN_COLUMNS = ['Run', 'Created', 'Status', 'Lines', 'Total', 'Created by', 'Policy']

export function overviewBody(d: OverviewData): string {
  const g = esc(d.community.id)
  const recent = d.recent.length
    ? table('Recent runs', RUN_COLUMNS, runRows(d.community.id, d.recent, d.origins, d.names), { numeric: [3, 4] })
    : '<p class="muted">No runs yet. <code>/rolepay new</code> in Discord makes one.</p>'
  return `<h1>Overview</h1><p class="lede">The treasury, what the bot may spend, and what is coming.</p>
<div class="grid">${treasuryCard(d)}${keyCard(d)}${upcomingCard(d)}${aiCard(d.aiSpend)}</div>
<section class="card"><h2>Recent runs</h2>${recent}<p><a href="/dashboard/${g}/runs">All runs</a> · <a href="/dashboard/${g}/payees">Payees</a> · <a href="/dashboard/${g}/policies">Policies</a> · <a href="/dashboard/${g}/audit">Audit log</a></p></section>`
}
