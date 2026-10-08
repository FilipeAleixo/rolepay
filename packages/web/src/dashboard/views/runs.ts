import { RUN_STATUSES, type Run, type RunStatus } from '@rolepay/core'
import type { PolicySummary, RunOrigin } from '../policyPort.js'
import { type Names, RUN_STATUS_LABELS, addressLink, esc, money, paysUnlessVetoed, person, pill, row, runPill, shortHex, table, txLink, when } from './format.js'
import { csrfField } from './layout.js'
import { RUN_COLUMNS, runRows } from './overview.js'

export type RunFilters = { status: RunStatus | null; policy: string | null; page: number }

export function runsBody(d: {
  guildId: string
  runs: Run[]
  origins: Record<string, RunOrigin>
  names: Names
  filters: RunFilters
  /** null: no policy services on this server (no policy filter). */
  policies: PolicySummary[] | null
  hasMore: boolean
}): string {
  const g = esc(d.guildId)
  const option = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`
  const statusSelect = `<div><label for="status">Status</label><select id="status" name="status">${option('', 'Any', d.filters.status === null)}${RUN_STATUSES.map((s) =>
    option(s, RUN_STATUS_LABELS[s], d.filters.status === s),
  ).join('')}</select></div>`
  const policySelect = d.policies
    ? `<div><label for="policy">Made by</label><select id="policy" name="policy">${option('', 'Any', d.filters.policy === null)}${option('manual', 'By hand', d.filters.policy === 'manual')}${d.policies
        .map((p) => option(p.id, p.name, d.filters.policy === p.id))
        .join('')}</select></div>`
    : ''
  const query = (page: number) => {
    const q = new URLSearchParams()
    if (d.filters.status) q.set('status', d.filters.status)
    if (d.filters.policy) q.set('policy', d.filters.policy)
    if (page > 1) q.set('page', String(page))
    const s = q.toString()
    return `/dashboard/${g}/runs${s ? `?${esc(s)}` : ''}`
  }
  const list = d.runs.length ? table('Runs', RUN_COLUMNS, runRows(d.guildId, d.runs, d.origins, d.names), { numeric: [3, 4] }) : '<p class="muted">No runs match.</p>'
  const pager = `<nav class="pager" aria-label="Pages">${d.filters.page > 1 ? `<a href="${query(d.filters.page - 1)}">Newer runs</a>` : '<span></span>'}${d.hasMore ? `<a href="${query(d.filters.page + 1)}">Older runs</a>` : ''}</nav>`
  return `<h1>Runs</h1><p class="lede">Every pay run, newest first.</p>
<form class="filters" method="get" action="/dashboard/${g}/runs">${statusSelect}${policySelect}<div><button type="submit" class="secondary">Filter</button></div></form>
<section class="card" data-live-region="runs">${list}${pager}</section>`
}

const FAILURE_WORDS: Record<string, string> = {
  rejected: 'the network refused the transaction',
  reverted: 'the transaction reverted',
  not_landed: 'the transaction never landed before its deadline',
  partial_match: 'the chain shows only some of the payments: a person must look',
  transfer_mismatch: 'the chain shows payments that differ from the run: a person must look',
}

type Event = { at: Date; text: string }

/**
 * Autopilot approved this run, rather than a person: its policy run was released and the run was
 * approved once the veto window was over (the same rule as the Discord run message). A person who
 * approved it during the window, or after autopilot stopped, approved it themselves.
 */
export const releasedOnAutopilot = (run: Run, o: RunOrigin | undefined): o is RunOrigin =>
  !!o && o.mode === 'autopilot' && o.executedAt !== null && o.vetoedAt === null && o.executesAt !== null && run.approvedAt !== null && run.approvedAt >= o.executesAt

/**
 * "Released on autopilot after the veto window; no veto. Policy approved by A (version 3); autopilot
 * switched on by B." Nobody approved such a run itself; the run is approved in the name of whoever
 * switched autopilot on, named when that is not who approved the policy version.
 */
function autopilotApproval(run: Run, o: RunOrigin, policyApprovedBy: string | null, names: Names): string {
  const policy = policyApprovedBy ? `Policy approved by ${person(policyApprovedBy, names)} (version ${o.version})` : `Policy version ${o.version}`
  const switched = run.approvedBy && run.approvedBy !== policyApprovedBy ? `; autopilot switched on by ${person(run.approvedBy, names)}` : ''
  return `Released on autopilot after the veto window; no veto. ${policy}${switched}.`
}

/** The run's story in order. Events at the same moment keep their logical order. */
function timeline(run: Run, origin: RunOrigin | undefined, names: Names, explorer: string, policyApprovedBy: string | null): Event[] {
  const events: Event[] = [{ at: run.createdAt, text: `Created by ${person(run.createdBy, names)}${origin ? ` for <strong>${esc(origin.policyName)}</strong>` : ''}` }]
  if (run.submittedAt) events.push({ at: run.submittedAt, text: 'Submitted for approval' })
  if (origin?.vetoedAt) events.push({ at: origin.vetoedAt, text: `Vetoed by ${person(origin.vetoedBy, names)}` })
  if (run.approvedAt) {
    events.push({ at: run.approvedAt, text: releasedOnAutopilot(run, origin) ? autopilotApproval(run, origin, policyApprovedBy, names) : `Approved by ${person(run.approvedBy, names)}` })
  }
  for (const a of run.attempts) {
    events.push({ at: a.startedAt, text: `Attempt ${a.number}${a.txHash ? `: signed and sent, ${txLink(explorer, a.txHash)}` : ' started'}` })
  }
  if (run.failure) events.push({ at: run.failure.at, text: `Failed: ${esc(FAILURE_WORDS[run.failure.reason] ?? run.failure.reason)} (${esc(run.failure.reason)}${run.failure.retryable ? ', can be retried' : ''})` })
  if (run.paidAt) events.push({ at: run.paidAt, text: `Paid in block ${run.paidBlock ?? '?'}${run.paidTxHash ? `, ${txLink(explorer, run.paidTxHash)}` : ''}` })
  if (run.cancelledAt) events.push({ at: run.cancelledAt, text: `Cancelled by ${person(run.cancelledBy, names)}` })
  if (origin?.executesAt && !origin.vetoedAt && !origin.executedAt && run.status === 'pending_approval') {
    events.push({ at: origin.executesAt, text: 'Pays then unless vetoed (autopilot)' })
  }
  return events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i).map(({ e }) => e)
}

/** Where an autopilot run stands: released after its window, vetoed, or paying at a time unless vetoed. */
const autopilotWords = (o: RunOrigin) =>
  o.executedAt ? `, released after its veto window ${when(o.executedAt)}` : o.vetoedAt ? ', vetoed' : o.executesAt ? `, ${paysUnlessVetoed(o.executesAt)}` : ''

/** An autopilot run inside its veto window: the Veto button for the Treasurer role, a line for everyone else. */
function vetoControl(d: { guildId: string; run: Run; origin: RunOrigin; canAct: boolean; csrf: string }): string {
  if (!d.origin.vetoable) return ''
  if (!d.canAct) return '<p class="muted small">A Treasurer can veto it until then.</p>'
  return `<form method="post" action="/dashboard/${esc(d.guildId)}/runs/${encodeURIComponent(d.run.id)}/veto">${csrfField(d.csrf)}<button type="submit" class="danger">Veto this run</button></form>`
}

export function runBody(d: {
  guildId: string
  run: Run
  origin: RunOrigin | undefined
  names: Names
  explorer: string
  /** The viewer holds the Treasurer role (may veto an autopilot run). */
  canAct?: boolean
  csrf?: string
  /** A message after an action (escaped by its builder). */
  notice?: string
  /** For a run autopilot released: who approved the policy version that made it (null: not known). */
  policyApprovedBy?: string | null
}): string {
  const { run, origin, names, explorer } = d
  const g = esc(d.guildId)
  const approver = releasedOnAutopilot(run, origin)
    ? 'Autopilot, after the veto window (no veto)'
    : run.approvedBy
      ? person(run.approvedBy, names)
      : '<span class="muted">not yet</span>'
  const facts = [
    ['Total', money(run.total, run.token)],
    ['Lines', String(run.lines.length)],
    ['Creator', person(run.createdBy, names)],
    ['Approver', approver],
    ...(run.paidTxHash ? [['Transaction', txLink(explorer, run.paidTxHash)]] : []),
  ]
  const originCard = origin
    ? `<section class="card"><h2>Made by a policy</h2><dl class="facts"><dt>Policy</dt><dd><a href="/dashboard/${g}/policies/${encodeURIComponent(origin.policyId)}">${esc(origin.policyName)}</a>, version ${origin.version}</dd><dt>Period</dt><dd>${esc(origin.period)}</dd><dt>Mode</dt><dd>${origin.mode === 'autopilot' ? `autopilot${autopilotWords(origin)}` : 'propose (a treasurer approves it in Discord)'}</dd><dt>Scheduled for</dt><dd>${when(origin.scheduledFor)}</dd>${
        origin.vetoedAt ? `<dt>Veto</dt><dd>Vetoed by ${person(origin.vetoedBy, names)}, ${when(origin.vetoedAt)}</dd>` : ''
      }</dl>${vetoControl({ guildId: d.guildId, run, origin, canAct: d.canAct ?? false, csrf: d.csrf ?? '' })}</section>`
    : ''
  const lines = table(
    'Lines',
    ['#', 'Person', 'Paid to', 'Amount', 'Memo'],
    run.lines.map((l) =>
      row(
        [
          String(l.line),
          person(l.payeeDiscordId, names),
          addressLink(explorer, l.address),
          // A line paid in the payee's preferred stablecoin: bought on the exchange in the same transaction.
          l.swap ? `${money(l.amount, run.token)} → ${money(l.amount, l.swap.token)} (swapped)` : money(l.amount, run.token),
          `<code class="small" title="${esc(l.memo)}">${esc(shortHex(l.memo))}</code>`,
        ],
        { numeric: [0, 3] },
      ),
    ),
    { numeric: [0, 3] },
  )
  const steps = timeline(run, origin, names, explorer, d.policyApprovedBy ?? null)
    .map((e) => `<li>${e.text}<br><span class="small muted">${when(e.at)}</span></li>`)
    .join('')
  return `<p class="small"><a href="/dashboard/${g}/runs">All runs</a></p>
<div data-live-region="run" data-live-run="${esc(run.id)}"><h1>Run ${esc(run.id)} ${runPill(run.status)}</h1>${d.notice ?? ''}${run.note ? `<p class="lede">${esc(run.note)}</p>` : ''}
<div class="grid"><section class="card"><h2>Summary</h2><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
<p><a class="button secondary" href="/dashboard/${g}/runs/${encodeURIComponent(run.id)}/csv">Download CSV</a></p></section>${originCard}</div>
<section class="card"><h2>Lines</h2>${lines}</section>
<section class="card"><h2>Timeline</h2><ol class="timeline">${steps}</ol>${run.status === 'failed' && run.failure && !run.failure.retryable ? `<p>${pill('needs a person', 'bad')}</p>` : ''}</section></div>`
}
