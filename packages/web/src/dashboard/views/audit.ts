import { secondsText, usdText } from '@rolepay/core'
import type { AiProposalView, AuditEventView } from '../policyPort.js'
import { type Names, esc, person, pill, row, table, when } from './format.js'

export type AuditFilters = { type: string | null; actor: string | null; policy: string | null }

/** The filters as a query string (for the pager and the CSV link), with more parameters if given. */
export function auditQuery(f: AuditFilters, more: Record<string, string> = {}): string {
  const q = new URLSearchParams()
  if (f.type) q.set('type', f.type)
  if (f.actor) q.set('actor', f.actor)
  if (f.policy) q.set('policy', f.policy)
  for (const [k, v] of Object.entries(more)) q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function auditBody(d: {
  guildId: string
  /** null: no audit stream on this server. */
  events: AuditEventView[] | null
  filters: AuditFilters
  eventTypes: readonly string[]
  /** The people and policies the filter offers. */
  actors: string[]
  policies: { id: string; name: string }[]
  names: Names
  /** The id of the oldest event shown when there are older ones (the next page). */
  olderThan: string | null
  newer: boolean
  /** The latest proposals that reached the model; null: the AI spend is not wired on this server. */
  aiProposals?: AiProposalView[] | null
}): string {
  const g = esc(d.guildId)
  if (d.events === null) {
    return `<h1>Audit log</h1><div class="card"><p>The audit log is not available on this server yet. It arrives with policies.</p></div>`
  }
  const policyName = new Map(d.policies.map((p) => [p.id, p.name]))
  const opt = (value: string, label: string, current: string | null) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
  const filters = `<form class="filters" method="get" action="/dashboard/${g}/audit">
<div><label for="type">Event</label><select id="type" name="type">${opt('', 'Any', d.filters.type)}${d.eventTypes.map((t) => opt(t, t, d.filters.type)).join('')}</select></div>
<div><label for="actor">By</label><select id="actor" name="actor">${opt('', 'Anyone', d.filters.actor)}${d.actors.map((a) => opt(a, d.names.get(a) ?? `user ${a}`, d.filters.actor)).join('')}</select></div>
<div><label for="policy">Policy</label><select id="policy" name="policy">${opt('', 'Any', d.filters.policy)}${d.policies.map((p) => opt(p.id, p.name, d.filters.policy)).join('')}</select></div>
<div><button type="submit" class="secondary">Filter</button></div></form>`
  const rows = d.events.map((e) =>
    row([
      when(e.at),
      `<code>${esc(e.type)}</code>`,
      person(e.actorId, d.names),
      e.policyId ? `<a href="/dashboard/${g}/policies/${encodeURIComponent(e.policyId)}">${esc(policyName.get(e.policyId) ?? e.policyId)}</a>` : '',
      e.runId ? `<a href="/dashboard/${g}/runs/${encodeURIComponent(e.runId)}">${esc(e.runId)}</a>` : '',
      esc(e.summary),
    ]),
  )
  const list = rows.length ? table('Audit log', ['When', 'Event', 'By', 'Policy', 'Run', 'What happened'], rows) : '<p class="muted">No events match.</p>'
  const pager = `<nav class="pager" aria-label="Pages">${d.newer ? `<a href="/dashboard/${g}/audit${esc(auditQuery(d.filters))}">Newest events</a>` : '<span></span>'}${
    d.olderThan ? `<a href="/dashboard/${g}/audit${esc(auditQuery(d.filters, { before: d.olderThan }))}">Older events</a>` : ''
  }</nav>`
  return `<h1>Audit log</h1><p class="lede">Every policy and run event, who did it and when: the governance record a community can publish.</p>
${filters}<p><a class="button secondary" href="/dashboard/${g}/audit/csv${esc(auditQuery(d.filters))}">Export CSV</a></p><section class="card">${list}${pager}</section>${aiSection(d.guildId, d.aiProposals ?? null, d.names)}`
}

const unknown = '<span class="muted">?</span>'

/** Each proposal that reached the model: who asked, the model, the time and the cost, and the run it became. */
function aiSection(guildId: string, proposals: AiProposalView[] | null, names: Names): string {
  if (proposals === null) return ''
  const g = esc(guildId)
  const rows = proposals.map((p) =>
    row(
      [
        when(p.at),
        person(p.actorId, names),
        p.mode === 'messages' ? 'from messages' : 'from criteria',
        esc(p.model),
        p.latencyMs === null ? unknown : esc(secondsText(p.latencyMs)),
        p.costMicroUsd === null ? unknown : esc(usdText(p.costMicroUsd)),
        p.outcome === 'proposed' ? pill('drafted', 'ok') : `<code>${esc(p.outcome)}</code>`,
        p.runId ? `<a href="/dashboard/${g}/runs/${encodeURIComponent(p.runId)}">${esc(p.runId)}</a>` : '',
      ],
      { numeric: [4, 5] },
    ),
  )
  const list = rows.length ? table('AI proposals', ['When', 'By', 'Mode', 'Model', 'Time', 'Cost', 'Outcome', 'Run'], rows, { numeric: [4, 5] }) : '<p class="muted">No proposals yet.</p>'
  return `<section class="card"><h2>AI proposals</h2><p class="muted small">The latest proposals that reached the model, newest first, with the estimated cost of each. No instruction or message text is kept for them.</p>${list}</section>`
}
