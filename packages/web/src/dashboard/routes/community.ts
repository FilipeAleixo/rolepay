import { RUN_STATUSES, type Run, type RunStatus } from '@rolepay/core'
import { Hono } from 'hono'
import { actionAccess, communityAccess } from '../access.js'
import { type DashboardKit, html, redirect } from '../kit.js'
import type { RunOrigin } from '../policyPort.js'
import type { Names } from '../views/format.js'
import { type Section, messagePage, shell } from '../views/layout.js'
import { type ChainRead, overviewBody } from '../views/overview.js'
import { type PayeeTotals, payeesBody } from '../views/payees.js'
import { notice } from '../views/policies.js'
import { releasedOnAutopilot, runBody, runsBody } from '../views/runs.js'
import type { CommunityAccess } from '../access.js'

/** How many runs a page reads to filter and total in memory. A repository query can replace this when communities have more. */
export const MAX_RUNS_READ = 1_000
const PAGE_SIZE = 25
/** At most this many people are named per page (one Discord lookup each, cached ten minutes); the rest show their ID. */
export const MAX_NAMED = 60
/** A chain read slower than this is shown as unavailable rather than holding the page. */
const CHAIN_TIMEOUT_MS = 5_000

const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref?.())

/** A chain read that must not break the page: the value, missing, or unavailable (RPC down or slow). */
async function chainRead<T>(read: () => Promise<{ ok: true; value: T } | { ok: false; error: { code: string } }>): Promise<ChainRead<T>> {
  try {
    const r = await Promise.race([read(), timeout(CHAIN_TIMEOUT_MS)])
    return r.ok ? { kind: 'ok', value: r.value } : { kind: 'missing' }
  } catch {
    return { kind: 'unavailable' }
  }
}

const monthLabel = (year: number, month: number) => new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** What each person was paid by paid runs: this calendar month, last month, all time (UTC), and their last payment. */
export function payeeTotals(runs: Run[], now: Date): { totals: Map<string, PayeeTotals>; periods: { this: string; last: string } } {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const thisStart = Date.UTC(y, m, 1)
  const lastStart = Date.UTC(y, m - 1, 1)
  const totals = new Map<string, PayeeTotals>()
  for (const run of runs) {
    if (run.status !== 'paid' || !run.paidAt) continue
    const at = run.paidAt.getTime()
    for (const line of run.lines) {
      const t = totals.get(line.payeeDiscordId) ?? { thisPeriod: 0n, lastPeriod: 0n, allTime: 0n, last: null }
      t.allTime += line.amount
      if (at >= thisStart) t.thisPeriod += line.amount
      else if (at >= lastStart) t.lastPeriod += line.amount
      if (!t.last || at > t.last.at.getTime()) t.last = { at: run.paidAt, runId: run.id, amount: line.amount }
      totals.set(line.payeeDiscordId, t)
    }
  }
  return { totals, periods: { this: monthLabel(y, m), last: monthLabel(y, m - 1) } }
}

/** The people a list of runs mentions (creators, approvers, cancellers, payees, vetoers). */
const peopleIn = (runs: Run[], origins: Record<string, RunOrigin> = {}) =>
  runs.flatMap((r) => [r.createdBy, r.approvedBy, r.cancelledBy, origins[r.id]?.vetoedBy ?? null, ...r.lines.map((l) => l.payeeDiscordId)]).filter((id): id is string => id !== null)

/** Overview, Runs (list, detail, CSV) and Payees for one community: read only, for any member. */
export function communityRoutes(kit: DashboardKit): Hono {
  const app = new Hono()
  const explorer = kit.config.explorerUrl

  const page = (a: CommunityAccess, section: Section, title: string, body: string, status = 200) =>
    html(shell({ title: `${title}: ${a.communityName} (Rolepay)`, testnet: kit.testnet, viewer: a.viewer, community: { id: a.community.id, name: a.communityName, section }, body }), status)
  const names = (guildId: string, ids: string[]): Promise<Names> => kit.members.names(guildId, ids, { limit: MAX_NAMED })
  const origins = async (guildId: string, runs: Run[]): Promise<Record<string, RunOrigin>> =>
    kit.policies && runs.length ? kit.policies.runOrigins({ guildId, runIds: runs.map((r) => r.id) }) : {}

  app.get('/dashboard/:guildId', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const guildId = a.community.id
    const [balance, key, recent, upcoming, aiSpend, payouts] = await Promise.all([
      chainRead(async () => {
        const r = await kit.rolepay.communities.treasuryBalance({ guildId })
        return r.ok ? { ok: true as const, value: r.value.balance } : r
      }),
      chainRead(() => kit.rolepay.communities.keyStatus({ guildId })),
      kit.rolepay.payRuns.list({ guildId, limit: 5 }),
      kit.policies ? kit.policies.upcoming({ guildId, limit: 5 }) : Promise.resolve(null),
      kit.aiUsage ? kit.aiUsage.spend({ guildId }) : Promise.resolve(null),
      kit.payouts ? kit.payouts.paidByWeek({ guildId }) : Promise.resolve(null),
    ])
    const runOrigins = await origins(guildId, recent)
    const body = overviewBody({ community: a.community, explorer, balance, key, upcoming, recent, origins: runOrigins, names: await names(guildId, peopleIn(recent)), aiSpend, payouts })
    return page(a, 'overview', 'Overview', body)
  })

  app.get('/dashboard/:guildId/runs', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const guildId = a.community.id
    const status = RUN_STATUSES.includes(c.req.query('status') as RunStatus) ? (c.req.query('status') as RunStatus) : null
    const policies = kit.policies ? await kit.policies.list({ guildId }) : null
    const policyParam = c.req.query('policy') ?? ''
    const policy = policyParam === 'manual' || policies?.some((p) => p.id === policyParam) ? policyParam : null
    const pageNumber = Math.max(1, Math.min(1_000, Number.parseInt(c.req.query('page') ?? '1', 10) || 1))
    const all = await kit.rolepay.payRuns.list({ guildId, limit: MAX_RUNS_READ })
    // Origins for every run read: the policy filter needs them (one batched port call).
    const runOrigins = policy ? await origins(guildId, all) : {}
    const matching = all.filter((r) => (!status || r.status === status) && (!policy || (policy === 'manual' ? !runOrigins[r.id] : runOrigins[r.id]?.policyId === policy)))
    const shown = matching.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE)
    const shownOrigins = policy ? runOrigins : await origins(guildId, shown)
    const body = runsBody({
      guildId,
      runs: shown,
      origins: shownOrigins,
      names: await names(guildId, peopleIn(shown, shownOrigins)),
      filters: { status, policy, page: pageNumber },
      policies,
      hasMore: matching.length > pageNumber * PAGE_SIZE,
    })
    return page(a, 'runs', 'Runs', body)
  })

  app.get('/dashboard/:guildId/runs/:runId', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const guildId = a.community.id
    const run = await kit.rolepay.payRuns.get({ guildId, runId: c.req.param('runId') })
    if (!run.ok) return page(a, 'runs', 'Run not found', '<h1>Run not found</h1><p><a href="runs">All runs</a></p>', 404)
    const origin = (await origins(guildId, [run.value]))[run.value.id]
    // Autopilot approved it: name who approved the policy version that made it, not an approver of this run.
    const policyApprovedBy =
      kit.policies && releasedOnAutopilot(run.value, origin) ? ((await kit.policies.versions({ guildId, policyId: origin.policyId })).find((v) => v.version === origin.version)?.approvedBy ?? null) : null
    const body = runBody({
      guildId,
      run: run.value,
      origin,
      policyApprovedBy,
      names: await names(guildId, [...peopleIn([run.value], origin ? { [run.value.id]: origin } : {}), ...(policyApprovedBy ? [policyApprovedBy] : [])]),
      explorer,
      canAct: a.viewer.canAct,
      csrf: a.viewer.csrf,
      notice: notice(c.req.query('done'), c.req.query('error')),
    })
    return page(a, 'runs', `Run ${run.value.id}`, body)
  })

  /**
   * Veto an autopilot run during its veto window (the Treasurer role, gated like every action:
   * CSRF, roles read fresh, core checks them again). The run is cancelled and nothing is paid.
   */
  app.post('/dashboard/:guildId/runs/:runId/veto', async (c) => {
    const access = await actionAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const runId = c.req.param('runId')
    const back = `/dashboard/${a.community.id}/runs/${encodeURIComponent(runId)}`
    if (!kit.policies) return redirect(`${back}?error=policy_not_found`, 303)
    const r = await kit.policies.veto({ guildId: a.community.id, runId, actor: a.actor })
    return redirect(`${back}?${r.ok ? 'done=vetoed' : `error=${encodeURIComponent(r.error.code)}`}`, 303)
  })

  app.get('/dashboard/:guildId/runs/:runId/csv', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const exported = await kit.rolepay.payRuns.exportCsv({ guildId: access.value.community.id, runId: c.req.param('runId') })
    if (!exported.ok) return html(messagePage({ title: 'not found', heading: 'Run not found', testnet: kit.testnet, viewer: access.value.viewer, body: '' }), 404)
    return new Response(exported.value.csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${exported.value.filename.replace(/[^\w.-]/g, '_')}"` },
    })
  })

  app.get('/dashboard/:guildId/payees', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const guildId = a.community.id
    const [payees, runs] = await Promise.all([kit.rolepay.payees.list({ guildId }), kit.rolepay.payRuns.list({ guildId, limit: MAX_RUNS_READ })])
    const { totals, periods } = payeeTotals(runs, kit.clock.now())
    const body = payeesBody({ guildId, token: a.community.payoutToken, explorer, payees, totals, periods, names: await names(guildId, payees.map((p) => p.discordUserId)) })
    return page(a, 'payees', 'Payees', body)
  })

  return app
}
