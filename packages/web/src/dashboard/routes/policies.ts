import { POLICY_LIMITS, PROPOSAL_LIMITS } from '@rolepay/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { type CommunityAccess, actionAccess, communityAccess } from '../access.js'
import { type DashboardKit, html, redirect } from '../kit.js'
import type { PolicyDraft, PolicyError, PolicyPort } from '../policyPort.js'
import { type Section, messagePage, shell } from '../views/layout.js'
import { type PolicyFormValues, notice, policiesBody, policyBody, policyFormBody } from '../views/policies.js'

const MAX_NAMED = 60

const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Core's own limits, so the form refuses what core would, in words. */
const MAX_NAME = POLICY_LIMITS.maxNameLength
const MAX_INSTRUCTION = PROPOSAL_LIMITS.maxInstructionLength

const DraftForm = z.object({
  name: z.string().trim().min(1, 'Give the policy a name.').max(MAX_NAME, `The name is at most ${MAX_NAME} characters.`),
  instruction: z
    .string()
    .trim()
    .min(1, 'Write the instruction: who gets paid, how much, and when.')
    .max(MAX_INSTRUCTION, `The instruction is at most ${MAX_INSTRUCTION.toLocaleString('en-US')} characters.`),
  kind: z.enum(['weekly', 'monthly'], 'Choose weekly or monthly.'),
  weekday: z.coerce.number().int().min(0).max(6),
  day: z.coerce.number().int().min(1, 'The day of the month is 1 to 28.').max(28, 'The day of the month is 1 to 28.'),
  hour: z.coerce.number().int().min(0, 'The hour is 0 to 23.').max(23, 'The hour is 0 to 23.'),
  timezone: z.string().trim().min(1).refine(validTimezone, 'Unknown timezone: use a name such as UTC or Europe/Lisbon.'),
})

const ModeForm = z.object({ mode: z.enum(['propose', 'autopilot']), vetoWindowHours: z.coerce.number().int().min(1).max(168) })
const VersionForm = z.object({ version: z.coerce.number().int().min(1) })

function draftFrom(form: Record<string, string>): { ok: true; draft: PolicyDraft } | { ok: false; error: string } {
  const parsed = DraftForm.safeParse(form)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Some of the values were not valid.' }
  const f = parsed.data
  const schedule = f.kind === 'weekly' ? { kind: 'weekly' as const, weekday: f.weekday, hour: f.hour, timezone: f.timezone } : { kind: 'monthly' as const, day: f.day, hour: f.hour, timezone: f.timezone }
  return { ok: true, draft: { name: f.name, instruction: f.instruction, schedule } }
}

const formValues = (form: Record<string, string>): PolicyFormValues => ({
  name: form.name ?? '',
  instruction: form.instruction ?? '',
  kind: form.kind ?? 'weekly',
  weekday: form.weekday ?? '1',
  day: form.day ?? '1',
  hour: form.hour ?? '18',
  timezone: form.timezone ?? 'UTC',
})

/** The policy's page with a message after an action: `done` on success, the error code otherwise. */
const back = (base: string, r: { ok: true } | { ok: false; error: PolicyError }, done: string) => redirect(`${base}?${r.ok ? `done=${done}` : `error=${encodeURIComponent(r.error.code)}`}`, 303)

/**
 * Policies: the list and each policy's page for any member (read only), the actions for the
 * Treasurer role. Everything goes through the policy port; every action is gated by
 * `actionAccess` (CSRF, roles read fresh from Discord, approver role) and core re-checks the
 * actor's roles. Forms post and redirect back with a message code (PRG).
 */
export function policyRoutes(kit: DashboardKit): Hono {
  const app = new Hono()
  const page = (a: CommunityAccess, title: string, body: string, status = 200, section: Section = 'policies') =>
    html(shell({ title: `${title}: ${a.communityName} (Rolepay)`, testnet: kit.testnet, viewer: a.viewer, community: { id: a.community.id, name: a.communityName, section }, body }), status)
  const notFound = (a: CommunityAccess) => page(a, 'Not found', `<h1>Policy not found</h1><p><a href="/dashboard/${a.community.id}/policies">All policies</a></p>`, 404)
  const refused = (a: CommunityAccess) =>
    html(messagePage({ title: 'read only', heading: 'Only the Treasurer role can do that', testnet: kit.testnet, viewer: a.viewer, body: `<p><a href="/dashboard/${a.community.id}/policies">Back</a></p>` }), 403)
  const badRequest = (a: CommunityAccess, why: string) =>
    page(a, 'Not valid', `<h1>That was not valid</h1><p>${why}</p><p><a href="/dashboard/${a.community.id}/policies">Back to policies</a></p>`, 400)
  const base = (a: CommunityAccess, policyId: string) => `/dashboard/${a.community.id}/policies/${encodeURIComponent(policyId)}`
  /** The policy port, or null when this server has none (the pages say so). */
  const port = (): PolicyPort | null => kit.policies ?? null

  app.get('/dashboard/:guildId/policies', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = kit.policies ? await kit.policies.list({ guildId: a.community.id }) : null
    return page(a, 'Policies', policiesBody({ guildId: a.community.id, policies, canAct: a.viewer.canAct }))
  })

  const form = (a: CommunityAccess, opts: { action: string; heading: string; submit: string; values: PolicyFormValues; error: string | null }, status = 200) =>
    page(a, opts.heading, policyFormBody({ guildId: a.community.id, csrf: a.viewer.csrf, ...opts }), status)

  app.get('/dashboard/:guildId/policies/new', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    if (!port()) return notFound(a)
    if (!a.viewer.canAct) return refused(a)
    return form(a, { action: `/dashboard/${a.community.id}/policies`, heading: 'New policy', submit: 'Compile and preview', values: formValues({}), error: null })
  })

  app.post('/dashboard/:guildId/policies', async (c) => {
    const access = await actionAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = port()
    if (!policies) return notFound(a)
    const opts = { action: `/dashboard/${a.community.id}/policies`, heading: 'New policy', submit: 'Compile and preview', values: formValues(a.form) }
    const draft = draftFrom(a.form)
    if (!draft.ok) return form(a, { ...opts, error: draft.error }, 400)
    const created = await policies.create({ guildId: a.community.id, actor: a.actor, draft: draft.draft })
    if (!created.ok) return form(a, { ...opts, error: compileError(created.error) }, created.error.code === 'not_permitted' ? 403 : 422)
    return redirect(`${base(a, created.value.policyId)}?done=created`, 303)
  })

  app.get('/dashboard/:guildId/policies/:policyId', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = port()
    if (!policies) return notFound(a)
    const ref = { guildId: a.community.id, policyId: c.req.param('policyId') }
    const policy = await policies.get(ref)
    if (!policy.ok) return notFound(a)
    const [preview, versions] = await Promise.all([policies.preview(ref).catch(() => null), policies.versions(ref)])
    const shown = preview?.ok ? preview.value : { error: preview && !preview.ok ? (preview.error.message ?? '') : '' }
    const people = [
      ...('error' in shown ? [] : [...shown.matches.map((m) => m.userId), ...shown.nearMisses.map((n) => n.userId)]),
      ...versions.flatMap((v) => [v.createdBy, v.approvedBy]),
      policy.value.approvedBy,
    ].filter((id): id is string => id !== null)
    const body = policyBody({
      guildId: a.community.id,
      policy: policy.value,
      preview: shown,
      versions,
      names: await kit.members.names(a.community.id, people, { limit: MAX_NAMED }),
      token: a.community.payoutToken,
      canAct: a.viewer.canAct,
      csrf: a.viewer.csrf,
      notice: notice(c.req.query('done'), c.req.query('error')),
    })
    return page(a, policy.value.name, body)
  })

  app.get('/dashboard/:guildId/policies/:policyId/edit', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = port()
    if (!policies) return notFound(a)
    if (!a.viewer.canAct) return refused(a)
    const ref = { guildId: a.community.id, policyId: c.req.param('policyId') }
    const policy = await policies.get(ref)
    if (!policy.ok) return notFound(a)
    const latest = (await policies.versions(ref)).at(-1)
    const p = policy.value
    const s = p.schedule
    const values: PolicyFormValues = {
      name: p.name,
      instruction: latest?.instruction ?? p.instruction,
      kind: s.kind,
      weekday: String(s.kind === 'weekly' ? s.weekday : 1),
      day: String(s.kind === 'monthly' ? s.day : 1),
      hour: String(s.hour),
      timezone: s.timezone,
    }
    return form(a, { action: `${base(a, p.id)}/edit`, heading: `Edit ${p.name}`, submit: 'Recompile and preview', values, error: null })
  })

  app.post('/dashboard/:guildId/policies/:policyId/edit', async (c) => {
    const access = await actionAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = port()
    if (!policies) return notFound(a)
    const policyId = c.req.param('policyId')
    const opts = { action: `${base(a, policyId)}/edit`, heading: 'Edit policy', submit: 'Recompile and preview', values: formValues(a.form) }
    const draft = draftFrom(a.form)
    if (!draft.ok) return form(a, { ...opts, error: draft.error }, 400)
    const edited = await policies.edit({ guildId: a.community.id, policyId, actor: a.actor, draft: draft.draft })
    if (!edited.ok && edited.error.code === 'could_not_compile') return form(a, { ...opts, error: compileError(edited.error) }, 422)
    return back(base(a, policyId), edited, 'edited')
  })

  /** One policy action: gate it, call the port with the actor, go back to the policy's page. */
  const action = (path: string, done: string, run: (p: PolicyPort, a: CommunityAccess & { actor: { id: string; roleIds: string[] }; form: Record<string, string> }, policyId: string) => Promise<Response | { ok: true } | { ok: false; error: PolicyError }>) =>
    app.post(`/dashboard/:guildId/policies/:policyId/${path}`, async (c: Context) => {
      const access = await actionAccess(kit, c)
      if (!access.ok) return access.response
      const a = access.value
      const policies = port()
      if (!policies) return notFound(a)
      const policyId = c.req.param('policyId') as string
      const r = await run(policies, a, policyId)
      return r instanceof Response ? r : back(base(a, policyId), r, done)
    })

  const ref = (a: CommunityAccess & { actor: { id: string; roleIds: string[] } }, policyId: string) => ({ guildId: a.community.id, policyId, actor: a.actor })

  action('approve', 'approved', async (p, a, id) => {
    const v = VersionForm.safeParse(a.form)
    return v.success ? p.approve({ ...ref(a, id), version: v.data.version }) : badRequest(a, 'Which version? Reload the page and try again.')
  })
  action('discard', 'discarded', async (p, a, id) => {
    const v = VersionForm.safeParse(a.form)
    return v.success ? p.discard({ ...ref(a, id), version: v.data.version }) : badRequest(a, 'Which version? Reload the page and try again.')
  })
  action('pause', 'paused', (p, a, id) => p.pause(ref(a, id)))
  action('resume', 'resumed', (p, a, id) => p.resume(ref(a, id)))
  action('archive', 'archived', (p, a, id) => p.archive(ref(a, id)))
  action('mode', 'mode_changed', async (p, a, id) => {
    const m = ModeForm.safeParse(a.form)
    return m.success
      ? p.setMode({ ...ref(a, id), mode: m.data.mode, vetoWindowMinutes: m.data.vetoWindowHours * 60 })
      : badRequest(a, 'Choose propose or autopilot, and a veto window of 1 to 168 hours.')
  })

  return app
}

/** A refusal while compiling, in words: the services' own message when they give one. */
const compileError = (e: PolicyError) =>
  e.code === 'not_permitted' ? 'Only the Treasurer role can create or change policies.' : (e.message ?? (e.code === 'could_not_compile' ? 'The rule could not be compiled from that instruction.' : `That did not work (${e.code}).`))
