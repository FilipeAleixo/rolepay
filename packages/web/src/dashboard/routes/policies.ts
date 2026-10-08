import { POLICY_LIMITS, PROPOSAL_LIMITS } from '@rolepay/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { type CommunityAccess, actionAccess, communityAccess } from '../access.js'
import { type DashboardKit, html, redirect } from '../kit.js'
import type { PolicyDraft, PolicyError, PolicyPort, RunOrigin } from '../policyPort.js'
import { type Section, messagePage, shell } from '../views/layout.js'
import { DAILY_REFUSED, type EditApplies, type LatestPolicyRun, type PolicyBudgetRead, type PolicyFormValues, notice, policiesBody, policyBody, policyFormBody } from '../views/policies.js'

const MAX_NAMED = 60
/** A chain read slower than this is shown as unavailable rather than holding the page. */
const CHAIN_TIMEOUT_MS = 5_000
const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref?.())

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
  kind: z.enum(['daily', 'weekly', 'monthly'], 'Choose weekly or monthly.'),
  hour: z.coerce.number().int().min(0, 'The hour is 0 to 23.').max(23, 'The hour is 0 to 23.'),
  timezone: z.string().trim().min(1).refine(validTimezone, 'Unknown timezone: use a name such as UTC or Europe/Lisbon.'),
})
/** Read only for the kinds that use them: a weekly form's day of the month (hidden, maybe stale) is never read, nor a monthly one's weekday. */
const WeekdayField = z.coerce.number().int().min(0, 'Choose a day of the week.').max(6, 'Choose a day of the week.')
const DayField = z.coerce.number().int().min(1, 'The day of the month is 1 to 28.').max(28, 'The day of the month is 1 to 28.')

const ModeForm = z.object({ mode: z.enum(['propose', 'autopilot']), vetoWindowHours: z.coerce.number().int().min(1).max(168) })
const VersionForm = z.object({ version: z.coerce.number().int().min(1) })
const MAX_VETO = POLICY_LIMITS.maxVetoMinutes
const EditVetoField = z.coerce
  .number()
  .int('The veto window is a whole number of minutes.')
  .min(1, `The veto window is 1 to ${MAX_VETO.toLocaleString('en-US')} minutes.`)
  .max(MAX_VETO, `The veto window is 1 to ${MAX_VETO.toLocaleString('en-US')} minutes (7 days).`)

/**
 * The mode an edit sets, when the editor offered it (only for an edit in force at once): propose, or
 * autopilot with its veto window. No `mode` field: the edit leaves the mode alone. With propose
 * chosen the veto window (hidden on the page) is not read, as with the schedule fields.
 */
function modeFrom(form: Record<string, string>): { ok: true; mode: { mode?: 'propose' | 'autopilot'; vetoWindowMinutes?: number } } | { ok: false; error: string } {
  if (form.mode === undefined) return { ok: true, mode: {} }
  if (form.mode === 'propose') return { ok: true, mode: { mode: 'propose' } }
  if (form.mode !== 'autopilot') return { ok: false, error: 'Choose propose or autopilot.' }
  const minutes = EditVetoField.safeParse(form.vetoWindowMinutes)
  return minutes.success ? { ok: true, mode: { mode: 'autopilot', vetoWindowMinutes: minutes.data } } : { ok: false, error: minutes.error.issues[0]?.message ?? 'Check the veto window.' }
}

/** Refusals of an edit that are about what was sent: the editor reopens with it and why (nothing was saved). */
const EDIT_REFUSED: Record<string, string> = {
  policy_blocked: 'Nothing was saved: the new rule uses an amount the instruction does not state, so it cannot be put in force. State the amount in the instruction.',
  invalid_veto_window: 'Nothing was saved: that veto window is not allowed here (at least 1 hour, at most 7 days).',
  policy_not_approved: 'Nothing was saved: autopilot can be switched on only for an approved policy, and this change waits for approval first.',
}

/** The draft a form describes. A daily schedule only where the policy services allow it (the testnet demo controls); refused here first, in words. */
function draftFrom(form: Record<string, string>, opts: { daily: boolean }): { ok: true; draft: PolicyDraft } | { ok: false; error: string } {
  const parsed = DraftForm.safeParse(form)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Some of the values were not valid.' }
  const f = parsed.data
  if (f.kind === 'daily' && !opts.daily) return { ok: false, error: DAILY_REFUSED }
  if (f.kind === 'daily') return { ok: true, draft: { name: f.name, instruction: f.instruction, schedule: { kind: 'daily', hour: f.hour, timezone: f.timezone } } }
  if (f.kind === 'weekly') {
    const weekday = WeekdayField.safeParse(form.weekday)
    if (!weekday.success) return { ok: false, error: weekday.error.issues[0]?.message ?? 'Choose a day of the week.' }
    return { ok: true, draft: { name: f.name, instruction: f.instruction, schedule: { kind: 'weekly', weekday: weekday.data, hour: f.hour, timezone: f.timezone } } }
  }
  const day = DayField.safeParse(form.day)
  if (!day.success) return { ok: false, error: day.error.issues[0]?.message ?? 'The day of the month is 1 to 28.' }
  return { ok: true, draft: { name: f.name, instruction: f.instruction, schedule: { kind: 'monthly', day: day.data, hour: f.hour, timezone: f.timezone } } }
}

const formValues = (form: Record<string, string>): PolicyFormValues => ({
  name: form.name ?? '',
  instruction: form.instruction ?? '',
  kind: form.kind ?? 'weekly',
  weekday: form.weekday ?? '1',
  day: form.day ?? '1',
  hour: form.hour ?? '18',
  timezone: form.timezone ?? 'UTC',
  ...(form.mode === undefined ? {} : { mode: form.mode }),
  ...(form.vetoWindowMinutes === undefined ? {} : { vetoWindowMinutes: form.vetoWindowMinutes }),
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
  /** The policy's own budget, read from the chain through the policy keys port; null without the port (no card). */
  const budgetRead = async (ref: { guildId: string; policyId: string }): Promise<PolicyBudgetRead | null> => {
    if (!kit.policyKeys) return null
    try {
      const view = await Promise.race([kit.policyKeys.budget(ref), timeout(CHAIN_TIMEOUT_MS)])
      return view ? { kind: 'ok', view } : null
    } catch {
      return { kind: 'unavailable' }
    }
  }

  /**
   * The latest run this policy made, from core's policy runs, with where it stands (the port's run
   * origin: the veto window, a veto). undefined when it cannot be read (no card).
   */
  const latestRun = async (ref: { guildId: string; policyId: string }): Promise<LatestPolicyRun | undefined> => {
    try {
      const [last] = await kit.rolepay.policies.listRuns({ ...ref, limit: 1 })
      if (!last?.runId) return null
      const runId = last.runId
      const origins: Promise<Record<string, RunOrigin>> = kit.policies ? kit.policies.runOrigins({ guildId: ref.guildId, runIds: [runId] }) : Promise.resolve({})
      const [run, origin] = await Promise.all([kit.rolepay.payRuns.get({ guildId: ref.guildId, runId }), origins.then((o) => o[runId])])
      return run.ok ? { run: run.value, origin } : null
    } catch {
      return undefined
    }
  }

  app.get('/dashboard/:guildId/policies', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = kit.policies ? await kit.policies.list({ guildId: a.community.id }) : null
    return page(a, 'Policies', policiesBody({ guildId: a.community.id, policies, canAct: a.viewer.canAct }))
  })

  const daily = () => kit.policies?.dailySchedules === true
  const form = (a: CommunityAccess, opts: { action: string; heading: string; submit: string; values: PolicyFormValues; error: string | null }, status = 200) =>
    page(a, opts.heading, policyFormBody({ guildId: a.community.id, csrf: a.viewer.csrf, daily: daily(), ...opts }), status)

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
    const draft = draftFrom(a.form, { daily: daily() })
    if (!draft.ok) return form(a, { ...opts, error: draft.error }, 400)
    const created = await policies.create({ guildId: a.community.id, actor: a.actor, draft: draft.draft })
    if (!created.ok) return form(a, { ...opts, error: compileError(created.error) }, created.error.code === 'not_permitted' ? 403 : 422)
    return redirect(`${base(a, created.value.policyId)}?done=created`, 303)
  })

  /**
   * A policy's page, with the message after an action (`done` or `error`, codes from the URL). For
   * the Treasurer role it carries the inline editor: closed, open (`?edit=1`, the old /edit URL), or
   * open with a refused edit's values and why (`edit`).
   */
  async function policyPage(
    a: CommunityAccess,
    policies: PolicyPort,
    policyId: string,
    opts: { done?: string | undefined; error?: string | undefined; editOpen: boolean; edit?: { values: PolicyFormValues; error: string }; status?: number },
  ) {
    const ref = { guildId: a.community.id, policyId }
    const policy = await policies.get(ref)
    if (!policy.ok) return notFound(a)
    const [preview, versions, compiles, budget, latest] = await Promise.all([
      policies.preview(ref).catch(() => null),
      policies.versions(ref),
      kit.aiUsage ? kit.aiUsage.compiles(ref) : Promise.resolve(null),
      budgetRead(ref),
      latestRun(ref),
    ])
    const shown = preview?.ok ? preview.value : { error: preview && !preview.ok ? (preview.error.message ?? '') : '' }
    const people = [
      ...('error' in shown ? [] : [...shown.matches.map((m) => m.userId), ...shown.nearMisses.map((n) => n.userId)]),
      ...versions.flatMap((v) => [v.createdBy, v.approvedBy]),
      policy.value.approvedBy,
    ].filter((id): id is string => id !== null)
    const p = policy.value
    const s = p.schedule
    // The editor starts from the newest version's wording (a draft waiting for approval included).
    const current: PolicyFormValues = {
      name: p.name,
      instruction: versions.at(-1)?.instruction ?? p.instruction,
      kind: s.kind,
      weekday: String(s.kind === 'weekly' ? s.weekday : 1),
      day: String(s.kind === 'monthly' ? s.day : 1),
      hour: String(s.hour),
      timezone: s.timezone,
      mode: p.mode,
      vetoWindowMinutes: String(p.vetoWindowMinutes),
    }
    // What saving does, as the policy services decide it (the editor only says it beforehand): an approver's
    // edit of a policy approved before is in force at once, unless the community requires a separate approver.
    const applies: EditApplies = a.community.requireSeparateApprover
      ? 'second_approval'
      : a.viewer.canAct && (p.status === 'active' || p.status === 'paused')
        ? 'now'
        : 'approval'
    const editor = a.viewer.canAct ? { values: opts.edit?.values ?? current, daily: daily(), open: opts.editOpen || !!opts.edit, error: opts.edit?.error ?? null, applies } : null
    const body = policyBody({
      guildId: a.community.id,
      policy: p,
      preview: shown,
      versions,
      names: await kit.members.names(a.community.id, people, { limit: MAX_NAMED }),
      token: a.community.payoutToken,
      canAct: a.viewer.canAct,
      csrf: a.viewer.csrf,
      notice: notice(opts.done, opts.error, { version: p.version }),
      compiles,
      budget,
      latest,
      editor,
    })
    return page(a, p.name, body, opts.status ?? 200)
  }

  app.get('/dashboard/:guildId/policies/:policyId', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = port()
    if (!policies) return notFound(a)
    return policyPage(a, policies, c.req.param('policyId'), { done: c.req.query('done'), error: c.req.query('error'), editOpen: c.req.query('edit') === '1' })
  })

  /** The old edit page: the policy's page with its editor open (for anyone else, the page as they see it). */
  app.get('/dashboard/:guildId/policies/:policyId/edit', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    return redirect(`${base(access.value, c.req.param('policyId'))}?edit=1#editor`, 302)
  })

  app.post('/dashboard/:guildId/policies/:policyId/edit', async (c) => {
    const access = await actionAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const policies = port()
    if (!policies) return notFound(a)
    const policyId = c.req.param('policyId')
    // A refused edit comes back to the policy's page, the editor open with what was sent and why.
    const refusedEdit = (error: string, status: number) => policyPage(a, policies, policyId, { editOpen: true, edit: { values: formValues(a.form), error }, status })
    const draft = draftFrom(a.form, { daily: daily() })
    if (!draft.ok) return refusedEdit(draft.error, 400)
    const mode = modeFrom(a.form)
    if (!mode.ok) return refusedEdit(mode.error, 400)
    const edited = await policies.edit({ guildId: a.community.id, policyId, actor: a.actor, draft: draft.draft, ...mode.mode })
    if (!edited.ok && edited.error.code === 'could_not_compile') return refusedEdit(compileError(edited.error), 422)
    const refusal = edited.ok ? undefined : EDIT_REFUSED[edited.error.code]
    if (!edited.ok && refusal) return refusedEdit(edited.error.message ?? refusal, 422)
    // In force at once (an approver's edit) or waiting for approval: the page says which.
    return back(base(a, policyId), edited, edited.ok && edited.value.inForce ? 'applied' : 'edited')
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
  /**
   * "Give this policy its own budget": a fresh treasury page link for this policy (a setup link, the
   * same as /rolepay setup issues, 30 minutes), then the treasury page itself. Nothing changes here:
   * the treasury passkey signs the policy's key on that page, and the chain enforces it.
   */
  action('budget', 'budget', async (p, a, id) => {
    if (!kit.policyKeys) return notFound(a)
    if (!(await p.get({ guildId: a.community.id, policyId: id })).ok) return notFound(a)
    const c = a.community
    const link = await kit.rolepay.communities.issueSetupLink({
      guildId: c.id,
      discordUserId: a.actor.id,
      settings: { name: c.name, payoutToken: c.payoutToken, feeMode: c.feeMode, feeToken: c.feeToken, approverRoleId: c.approverRoleId, requireSeparateApprover: c.requireSeparateApprover },
    })
    if (!link.ok) return badRequest(a, 'Rolepay could not make a treasury page link just now. Try again.')
    return redirect(`/setup/${encodeURIComponent(link.value.token)}/policies/${encodeURIComponent(id)}`, 303)
  })
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
