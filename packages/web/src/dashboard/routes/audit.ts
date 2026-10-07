import { csvCell } from '@rolepay/core'
import { Hono } from 'hono'
import { communityAccess } from '../access.js'
import { type DashboardKit, html } from '../kit.js'
import type { AuditEventView, AuditPort } from '../policyPort.js'
import { type AuditFilters, auditBody } from '../views/audit.js'
import { shell } from '../views/layout.js'

const PAGE_SIZE = 50
/** Events read to offer the people in the "By" filter. */
const SAMPLE_FOR_FILTERS = 500
/** The CSV export reads the stream this many events at a time, up to the cap. */
const EXPORT_BATCH = 500
const EXPORT_CAP = 50_000
const MAX_NAMED = 60
/** The latest proposals listed with their model, latency and cost. */
const AI_PROPOSALS_SHOWN = 50
const SAFE_ID = /^[\w.:-]{1,100}$/

const COLUMNS = ['at', 'type', 'actor_id', 'actor_name', 'policy_id', 'policy_name', 'run_id', 'summary']

/** Filters from the query string. Anything that is not a plain ID or a known type is ignored, never echoed. */
function filtersFrom(q: (name: string) => string | undefined, audit: AuditPort): AuditFilters {
  const id = (v: string | undefined) => (v && SAFE_ID.test(v) ? v : null)
  const type = q('type')
  return { type: type && audit.eventTypes.includes(type) ? type : null, actor: id(q('actor')), policy: id(q('policy')) }
}

const query = (guildId: string, f: AuditFilters) => ({
  guildId,
  ...(f.type ? { type: f.type } : {}),
  ...(f.actor ? { actorId: f.actor } : {}),
  ...(f.policy ? { policyId: f.policy } : {}),
})

/** The audit log for any member: filter, page back, export the filtered stream as CSV. Read only. */
export function auditRoutes(kit: DashboardKit): Hono {
  const app = new Hono()

  app.get('/dashboard/:guildId/audit', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const guildId = a.community.id
    const audit = kit.audit
    const render = (body: string) => html(shell({ title: `Audit log: ${a.communityName} (Rolepay)`, testnet: kit.testnet, viewer: a.viewer, community: { id: guildId, name: a.communityName, section: 'audit' }, body }))
    const policies = kit.policies ? (await kit.policies.list({ guildId })).map((p) => ({ id: p.id, name: p.name })) : []
    if (!audit) return render(auditBody({ guildId, events: null, filters: { type: null, actor: null, policy: null }, eventTypes: [], actors: [], policies, names: new Map(), olderThan: null, newer: false }))
    const filters = filtersFrom((n) => c.req.query(n), audit)
    const before = c.req.query('before')
    const [page, sample, aiProposals] = await Promise.all([
      audit.events({ ...query(guildId, filters), limit: PAGE_SIZE + 1, ...(before && SAFE_ID.test(before) ? { beforeId: before } : {}) }),
      audit.events({ guildId, limit: SAMPLE_FOR_FILTERS }),
      kit.aiUsage ? kit.aiUsage.proposals({ guildId, limit: AI_PROPOSALS_SHOWN }) : Promise.resolve(null),
    ])
    const events = page.slice(0, PAGE_SIZE)
    const actors = [...new Set([...sample.map((e) => e.actorId), filters.actor].filter((x): x is string => x !== null))]
    const people = [...events.map((e) => e.actorId).filter((x): x is string => x !== null), ...actors, ...(aiProposals ?? []).map((p) => p.actorId)]
    const names = await kit.members.names(guildId, people, { limit: MAX_NAMED })
    return render(
      auditBody({
        guildId,
        events,
        filters,
        eventTypes: audit.eventTypes,
        actors,
        policies,
        names,
        olderThan: page.length > PAGE_SIZE ? (events.at(-1)?.id ?? null) : null,
        newer: Boolean(before),
        aiProposals,
      }),
    )
  })

  app.get('/dashboard/:guildId/audit/csv', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const audit = kit.audit
    if (!audit) return html(shell({ title: 'Not found', testnet: kit.testnet, viewer: a.viewer, body: '<h1>Not found</h1>' }), 404)
    const guildId = a.community.id
    const filters = filtersFrom((n) => c.req.query(n), audit)
    const all: AuditEventView[] = []
    for (let beforeId: string | undefined; all.length < EXPORT_CAP; ) {
      const batch = await audit.events({ ...query(guildId, filters), limit: EXPORT_BATCH, ...(beforeId ? { beforeId } : {}) })
      all.push(...batch)
      if (batch.length < EXPORT_BATCH) break
      beforeId = batch.at(-1)?.id
    }
    const policyNames = new Map(kit.policies ? (await kit.policies.list({ guildId })).map((p) => [p.id, p.name]) : [])
    const names = await kit.members.names(guildId, all.map((e) => e.actorId).filter((x): x is string => x !== null), { limit: MAX_NAMED })
    const rows = all.map((e) => [
      e.at.toISOString(),
      e.type,
      e.actorId ?? '',
      e.actorId === null ? 'Rolepay' : (names.get(e.actorId) ?? ''),
      e.policyId ?? '',
      e.policyId ? (policyNames.get(e.policyId) ?? '') : '',
      e.runId ?? '',
      e.summary,
    ])
    const csv = [COLUMNS, ...rows].map((r) => `${r.map(csvCell).join(',')}\r\n`).join('')
    const date = kit.clock.now().toISOString().slice(0, 10)
    return new Response(csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="rolepay-audit-${guildId}-${date}.csv"` },
    })
  })

  return app
}
