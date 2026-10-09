import { POLICY_LIMITS, PROPOSAL_LIMITS, type Run, secondsText, usdText } from '@rolepay/core'
import type { AiCallView, PolicyBudgetView, PolicyDetail, PolicyPreview, PolicySchedule, PolicySummary, PolicyVersionView, RunOrigin } from '../policyPort.js'
import { POLICY_KEY_WORDS, keyBudget } from './charts.js'
import { lineDiff } from './diff.js'
import { type Names, esc, money, paysUnlessVetoed, person, pill, row, runPill, table, when } from './format.js'
import { csrfField } from './layout.js'

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')

/** "Every day at 18:00 (UTC)", "Every Monday at 18:30 (UTC)", "Monthly on day 1 at 09:00 (Europe/Lisbon)". */
export function scheduleWords(s: PolicySchedule): string {
  const at = `${pad(s.hour)}:${pad(s.minute ?? 0)} (${esc(s.timezone)})`
  if (s.kind === 'daily') return `Every day at ${at}`
  return s.kind === 'weekly' ? `Every ${WEEKDAYS[s.weekday] ?? '?'} at ${at}` : `Monthly on day ${s.day} at ${at}`
}

/** Why a daily schedule is refused on a server without the testnet demo controls. */
export const DAILY_REFUSED = 'A daily schedule is a testnet demo control, off on this server: choose weekly or monthly.'

const STATUS: Record<PolicySummary['status'], [string, string]> = { draft: ['Draft', 'warn'], active: ['Active', 'ok'], paused: ['Paused', ''], archived: ['Archived', ''] }
export const statusPill = (s: PolicySummary['status']) => pill(...STATUS[s])
export const modePill = (m: PolicySummary['mode']) => (m === 'autopilot' ? pill('Autopilot', 'info') : pill('Propose'))

const METRIC_WORDS: Record<string, [string, string]> = { messages: ['message', 'messages'], activeDays: ['active day', 'active days'], replies: ['reply', 'replies'] }
/** { replies: 12, activeDays: 4 } -> "12 replies, 4 active days". */
export const metricWords = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([k, v]) => (METRIC_WORDS[k] ? `${v} ${METRIC_WORDS[k][v === 1 ? 0 : 1]}` : `${esc(k)}: ${v}`))
    .join(', ')

/** Messages after an action, by code. Codes outside these lists are never shown (nothing from the URL is echoed). */
const DONE: Record<string, string> = {
  created: 'Created as a draft. Check who it applies to below, then approve it.',
  edited: 'Saved. The new version waits for approval.',
  applied: 'Saved. The new version is in force.',
  approved: 'Approved.',
  discarded: 'Discarded.',
  paused: 'Paused. No runs until it is resumed.',
  resumed: 'Resumed.',
  mode_changed: 'Mode switched.',
  archived: 'Archived. It will not run again.',
  vetoed: 'Vetoed. This run is cancelled and nothing will be paid for it.',
}
const ERRORS: Record<string, string> = {
  not_permitted: 'The policy services refused: only the Treasurer role can do that.',
  illegal_state: "That is not possible in the policy's current state.",
  policy_not_found: 'That policy no longer exists.',
  concurrent_update: 'Someone changed it at the same moment. Reload and try again.',
  invalid_input: 'Some of the values were not valid.',
  version_mismatch: 'That version is no longer the one waiting for approval. Reload and check what you approve.',
  policy_blocked: 'It cannot be approved: the rule uses an amount the instruction does not state. Edit the instruction to state it.',
  creator_cannot_approve: 'This community requires a second person: the author of a version cannot approve it or switch on its autopilot.',
  invalid_veto_window: 'That veto window is not allowed here (at least 1 hour, at most 7 days).',
  policy_not_approved: 'Approve the policy before switching on autopilot.',
  community_not_found: 'This community is not registered with Rolepay.',
  too_late: 'Too late to veto: the run has already been released for payment.',
  schedule_not_allowed: 'A daily schedule is a testnet demo control, off on this server. Edit the policy to run weekly or monthly.',
}

/** "1 minute", "90 minutes", "1 hour", "24 hours". */
export function vetoWords(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/** The message after an action. `version`: the policy's version now, which an edit in force names ("Version 5 is in force"). */
export function notice(done: string | undefined, error: string | undefined, ctx: { version?: number } = {}): string {
  if (done === 'applied' && ctx.version !== undefined) return `<p class="notice ok" role="status">Saved. Version ${ctx.version} is in force.</p>`
  if (done && DONE[done]) return `<p class="notice ok" role="status">${DONE[done]}</p>`
  if (error && /^[a-z_]{1,40}$/.test(error)) return `<p class="notice bad" role="alert">${ERRORS[error] ?? `That did not work (${error}).`}</p>`
  return ''
}

export function policiesBody(d: { guildId: string; policies: PolicySummary[] | null; canAct: boolean }): string {
  const g = esc(d.guildId)
  if (d.policies === null) {
    return `<h1>Policies</h1><div class="card"><p>Policies are not available on this server yet.</p><p class="muted small">A policy is a standing rule ("every Monday, 1 per answered question in #help"): the AI writes it once, the Treasurer approves it, code runs it on schedule, the bot key's limit caps it.</p></div>`
  }
  const create = d.canAct ? `<p><a class="button" href="/dashboard/${g}/policies/new">New policy</a></p>` : ''
  const rows = d.policies.map((p) =>
    row(
      [
        `<a href="/dashboard/${g}/policies/${encodeURIComponent(p.id)}">${esc(p.name)}</a>`,
        scheduleWords(p.schedule),
        modePill(p.mode),
        statusPill(p.status),
        p.nextRunAt && p.status === 'active' ? when(p.nextRunAt) : '<span class="muted">none</span>',
        p.matchesNow === null ? '<span class="muted">?</span>' : String(p.matchesNow),
      ],
      { numeric: [5] },
    ),
  )
  const list = rows.length
    ? table('Policies', ['Name', 'Schedule', 'Mode', 'Status', 'Next run', 'Matches now'], rows, { numeric: [5] })
    : '<p class="muted">No policies yet.</p>'
  return `<h1>Policies</h1><p class="lede">Standing rules: written once, approved by the Treasurer, run by code on schedule, capped by the bot key.</p>${create}<section class="card">${list}</section>`
}

function previewSection(d: { preview: PolicyPreview | { error: string }; names: Names; token: string }): string {
  if ('error' in d.preview) return `<section class="card"><h2>Applies to right now</h2><p class="muted">Who it applies to could not be worked out just now. ${esc(d.preview.error)}</p></section>`
  const p = d.preview
  const matches = p.matches.length
    ? table(
        'Applies to right now',
        ['Person', 'Activity', 'Why', 'Next run pays'],
        p.matches.map((m) =>
          row(
            [
              `${person(m.userId, d.names)}${m.registered ? '' : ` ${pill('not registered', 'warn')}`}`,
              metricWords(m.metrics),
              m.reasons.map((r) => esc(r)).join('<br>'),
              m.registered && m.amount !== null
                ? m.swappedTo
                  ? `${money(m.amount, d.token)} → ${money(m.amount, m.swappedTo)} (swapped)`
                  : money(m.amount, d.token)
                : `<span class="muted">${m.amount === null ? 'nothing' : money(m.amount, d.token)}, not paid until they run <code>/payee link</code></span>`,
            ],
            { numeric: [3] },
          ),
        ),
        { numeric: [3] },
      )
    : '<p class="muted">Nobody matches right now.</p>'
  const near = p.nearMisses.length
    ? table('Just below the line', ['Person', 'Activity', 'Missing'], p.nearMisses.map((n) => row([person(n.userId, d.names), metricWords(n.metrics), esc(n.missing)])))
    : '<p class="muted">Nobody is just below the line.</p>'
  const paid = p.matches.filter((m) => m.registered && m.amount !== null && m.amount > 0n).length
  const window = p.window ? `<p class="muted small">Counts activity from ${when(p.window.since)} to ${when(p.window.until)}, as of ${when(p.asOf)}.</p>` : ''
  const budget = p.remainingBudget === null ? '<span class="muted">unknown</span>' : money(p.remainingBudget, d.token)
  return `<section class="card"><h2>Next run</h2><p>${p.nextRunAt ? `On ${when(p.nextRunAt)}` : 'When it next runs'}, it would pay <strong>${money(p.total, d.token)}</strong> to ${paid} ${paid === 1 ? 'person' : 'people'}.</p>
<p>${p.budgetKey === 'policy' ? "This policy's own key" : 'The bot key'} has ${budget} left now.</p>${p.held ? `<p class="notice warn">${esc(p.held)}</p>` : ''}</section>
<section class="card"><h2>Applies to right now</h2>${window}${matches}</section>
<section class="card"><h2>Just below the line</h2>${near}</section>`
}

const versionText = (v: PolicyVersionView) => `Instruction:\n${v.instructionInWords ?? v.instruction}\n\nRule:\n${v.ruleInWords}\n\nFilter:\n${JSON.stringify(v.filter, null, 2)}`

/** "Compiled by Sonnet 5.5 in 3.4 s for $0.018.": the one model call that made this version. */
function compileLine(c: AiCallView | undefined): string {
  if (!c) return ''
  const time = c.latencyMs === null ? '' : ` in ${esc(secondsText(c.latencyMs))}`
  const cost = c.costMicroUsd === null ? ' (no price for this model)' : ` for ${esc(usdText(c.costMicroUsd))}`
  return `<br><span class="small muted">Compiled by ${esc(c.model)}${time}${cost}.</span>`
}

function versionsSection(versions: PolicyVersionView[], names: Names, compiles: Record<number, AiCallView> | null): string {
  const items = versions
    .map((v, i) => {
      const status =
        v.status === 'approved'
          ? `${pill('in force', 'ok')} approved by ${person(v.approvedBy, names)}${v.approvedAt ? `, ${when(v.approvedAt)}` : ''}`
          : v.status === 'superseded'
            ? `${pill('replaced')} approved by ${person(v.approvedBy, names)}${v.approvedAt ? `, ${when(v.approvedAt)}` : ''}`
            : v.status === 'pending'
              ? pill('waiting for approval', 'warn')
              : pill('discarded')
      const previous = versions[i - 1]
      const diff = previous
        ? `<details><summary>What changed from version ${previous.version}</summary><pre class="diff">${lineDiff(versionText(previous), versionText(v))
            .map((l) => (l.op === ' ' ? `  ${esc(l.line)}` : `<span class="${l.op === '+' ? 'add' : 'del'}">${l.op} ${esc(l.line)}</span>`))
            .join('\n')}</pre></details>`
        : ''
      return `<li><strong>Version ${v.version}</strong> ${status}<br><span class="small muted">written by ${person(v.createdBy, names)}, ${when(v.createdAt)}</span>${compileLine(compiles?.[v.version])}${diff}</li>`
    })
    .reverse()
  return `<section class="card"><h2>Version history</h2><ol class="timeline">${items.join('')}</ol></section>`
}

function actionsSection(d: { base: string; policy: PolicyDetail; csrf: string }): string {
  const { policy: p, base } = d
  const post = (action: string, label: string, cls = '', extra = '') =>
    `<form method="post" action="${base}/${action}">${csrfField(d.csrf)}${extra}<button type="submit"${cls ? ` class="${cls}"` : ''}>${label}</button></form>`
  const version = (n: number) => `<input type="hidden" name="version" value="${n}">`
  const pending = p.pendingVersion
    ? `<div class="actions">${post('approve', `Approve version ${p.pendingVersion}`, '', version(p.pendingVersion))}${post('discard', 'Discard it', 'secondary', version(p.pendingVersion))}</div>`
    : ''
  if (p.status === 'archived') return `<section class="card"><h2>Actions</h2><p class="muted">Archived policies do not change.</p></section>`
  const mode = `<form method="post" action="${base}/mode">${csrfField(d.csrf)}<fieldset class="field"><legend>Mode</legend>
<label><input type="radio" name="mode" value="propose"${p.mode === 'propose' ? ' checked' : ''}> Propose: each run waits for a Treasurer to approve it in Discord</label>
<label><input type="radio" name="mode" value="autopilot"${p.mode === 'autopilot' ? ' checked' : ''}> Autopilot: each run pays after the veto window unless a Treasurer vetoes it</label>
<label for="vetoWindowHours">Veto window (hours, at least 1)</label><input id="vetoWindowHours" name="vetoWindowHours" type="number" min="1" max="168" value="${Math.max(1, Math.round(p.vetoWindowMinutes / 60))}"></fieldset>
<button type="submit" class="secondary">Save mode</button></form>`
  return `<section class="card"><h2>Actions</h2>${pending}<div class="actions"><a class="button secondary" href="${base}?edit=1#editor">Edit and recompile</a>${
    p.status === 'active' ? post('pause', 'Pause', 'secondary') : ''
  }${p.status === 'paused' ? post('resume', 'Resume') : ''}${post('archive', 'Archive', 'danger')}</div>${mode}</section>`
}

/** A policy's own budget as read for its page: the view, or the chain could not be read in time. */
export type PolicyBudgetRead = { kind: 'ok'; view: PolicyBudgetView } | { kind: 'unavailable' }

/**
 * What the policy may spend: its own key's budget (the Overview's picture, in the policy's words)
 * or the bot key's, shared. The Treasurer role gets the way to the treasury page, where the
 * treasury passkey gives it its own budget, changes it or revokes it. An archived policy whose key
 * is still live on chain is offered the revoke.
 */
function budgetSection(d: { base: string; budget: PolicyBudgetRead; canAct: boolean; csrf: string; archived: boolean }): string {
  const card = (body: string) => `<section class="card"><h2>Budget</h2>${body}</section>`
  const button = (label: string, cls = '') =>
    d.canAct ? `<form method="post" action="${d.base}/budget">${csrfField(d.csrf)}<button type="submit"${cls ? ` class="${cls}"` : ''}>${label}</button></form>` : ''
  const how = d.canAct ? '<p class="muted small">Opens the treasury page: the treasury passkey signs it, and the chain enforces it.</p>' : ''
  if (d.budget.kind === 'unavailable') return card("<p class=\"muted\">Rolepay could not read this policy's budget from the chain just now. Reload in a moment.</p>")
  const v = d.budget.view
  if (d.archived) {
    if (v.kind !== 'own' || v.key.state.status !== 'active') return ''
    return card(
      `<p class="notice warn">This policy is archived, but its own key is still live on chain. Revoke it on the treasury page, so nothing can spend with it.</p>${button('Revoke its key on the treasury page', 'danger')}`,
    )
  }
  if (v.kind === 'shared') return card(`<p>This policy pays from the bot key's budget, shared with manual runs, AI-proposed runs and other policies.</p>${button('Give this policy its own budget')}${how}`)
  if (v.kind === 'retired') {
    return card(
      `<p class="notice bad">This policy's own key is revoked: it pays nothing until a treasurer gives it a new budget. It never falls back to the bot key.</p>${button('Give this policy its own budget')}${how}`,
    )
  }
  return card(
    `${keyBudget({ kind: 'ok', value: v.key }, POLICY_KEY_WORDS)}<p class="muted small">Only this policy's runs are signed with this key; the bot key and other policies are not touched.</p>${button('Change or revoke its budget', 'secondary')}`,
  )
}

/** The policy's latest run as the policy page shows it: the pay run and where it stands (null: none yet). */
export type LatestPolicyRun = { run: Run; origin: RunOrigin | undefined } | null

/**
 * The latest run this policy made: its status, and on autopilot the veto window ("pays in 0:42 unless
 * vetoed" with the dashboard's script), then paid or vetoed. A run made by an earlier version (the
 * policy was edited during its window) is never released by autopilot, and says so instead. A live
 * region: the page re-reads it as the run moves.
 */
function latestRunSection(guildId: string, latest: LatestPolicyRun, version: number): string {
  const head = '<h2>Latest run</h2>'
  if (!latest) return `<section class="card" data-live-region="latest-run">${head}<p class="muted">No run yet. Its runs show here as they are made, paid or vetoed.</p></section>`
  const { run, origin: o } = latest
  const window =
    o?.vetoedAt
      ? `Vetoed ${when(o.vetoedAt)}: nothing is paid.`
      : o?.mode === 'autopilot' && o.executesAt && !o.executedAt && run.status === 'pending_approval'
        ? o.vetoable && o.version !== version
          ? `Autopilot will not pay it: version ${o.version} made it, and the policy has changed since. When its veto window ends it waits for a Treasurer's approval instead.`
          : `Autopilot: ${paysUnlessVetoed(o.executesAt)}.`
        : run.paidAt
          ? `Paid ${when(run.paidAt)}.`
          : ''
  return `<section class="card" data-live-region="latest-run">${head}<p><a href="/dashboard/${esc(guildId)}/runs/${encodeURIComponent(run.id)}">${esc(run.id)}</a> ${runPill(run.status)} ${money(run.total, run.token)} to ${run.lines.length} ${
    run.lines.length === 1 ? 'person' : 'people'
  }${o ? `, ${esc(o.period)}` : ''}</p>${window ? `<p>${window}</p>` : ''}</section>`
}

/**
 * What saving an edit does, as the policy services decide it (the page only says it): `now`, in
 * force at once (the viewer holds the approver role, the policy was approved before, and the
 * community does not require a separate approver); `second_approval`, it waits for another
 * Treasurer (a separate approver is required); `approval`, it waits for an approval (a draft).
 */
export type EditApplies = 'now' | 'approval' | 'second_approval'

/**
 * The policy page's editor: the form's values, whether to offer daily runs, whether it starts open,
 * a refusal to show in it, and what saving does (`applies`; the mode is offered only when it is `now`).
 */
export type PolicyEditor = { values: PolicyFormValues; daily: boolean; open: boolean; error: string | null; applies: EditApplies }

const EDIT_WORDS: Record<EditApplies, string> = {
  now: "Your change applies as soon as you save: the policy keeps running with it, and the new version is recorded as approved by you. With a new wording, Rolepay's AI compiles it once first.",
  second_approval:
    "This community requires a second person: the new version waits for another Treasurer to approve it here, and the policy does not run until then. With a new wording, Rolepay's AI compiles it once first.",
  approval: "The new version waits for approval here, and the policy does not run until it is approved. With a new wording, Rolepay's AI compiles it once first.",
}

/**
 * The mode an edit in force sets, pre-filled from the policy: propose or autopilot, and the veto
 * window in minutes (the services check its range). The window shows only with autopilot chosen
 * (CSS `:has`, no script), and the server reads it only then.
 */
function editModeFields(v: PolicyFormValues): string {
  const auto = v.mode === 'autopilot'
  return `<fieldset class="field"><legend>Mode</legend>
<label><input type="radio" name="mode" value="propose"${auto ? '' : ' checked'}> Propose: each run waits for a Treasurer to approve it in Discord</label>
<label><input type="radio" name="mode" value="autopilot"${auto ? ' checked' : ''}> Autopilot: each run pays after the veto window unless a Treasurer vetoes it</label>
<div class="field-veto"><label for="editVetoWindowMinutes">Veto window (minutes: 60 is an hour, 1440 a day)</label><input id="editVetoWindowMinutes" name="vetoWindowMinutes" type="number" min="1" max="${POLICY_LIMITS.maxVetoMinutes}" value="${esc(v.vetoWindowMinutes ?? '')}"></div></fieldset>`
}

/**
 * Edit in place: a disclosure in the rule's panel with the same fields as a new policy, pre-filled.
 * Saving posts to `/edit` and comes back to this page: with the new version in force, or waiting
 * for approval, as the words under the form say beforehand. No script: `<details>` opens it, and
 * the schedule fields (and the veto window) follow what is chosen, in CSS.
 */
function editorSection(base: string, csrf: string, e: PolicyEditor): string {
  const now = e.applies === 'now'
  return `<details class="editor" id="editor"${e.open ? ' open' : ''}><summary>Edit</summary>${e.error ? `<p class="notice bad" role="alert">${esc(e.error)}</p>` : ''}
<form method="post" action="${base}/edit">${csrfField(csrf)}
${policyFormFields(e.values, e.daily)}
${now ? editModeFields(e.values) : ''}<p class="muted small">${EDIT_WORDS[e.applies]}</p>
<button type="submit">${now ? 'Save and apply' : 'Recompile and preview'}</button></form></details>`
}

export function policyBody(d: {
  guildId: string
  policy: PolicyDetail
  preview: PolicyPreview | { error: string }
  versions: PolicyVersionView[]
  names: Names
  token: string
  canAct: boolean
  csrf: string
  notice: string
  /** What compiling each version cost; null: the AI spend is not wired on this server. */
  compiles?: Record<number, AiCallView> | null
  /** The policy's own budget; null: policy keys are not wired on this server (no card). */
  budget?: PolicyBudgetRead | null
  /** The latest run it made; undefined: not read on this server (no card). */
  latest?: LatestPolicyRun
  /**
   * The inline editor, for the Treasurer role (null or absent: no edit control). `open` shows it
   * expanded (`?edit=1`, the old /edit URL, or a refused edit with its `error` and the values sent).
   */
  editor?: PolicyEditor | null
}): string {
  const p = d.policy
  const g = esc(d.guildId)
  const base = `/dashboard/${g}/policies/${encodeURIComponent(p.id)}`
  const caps = [p.caps.perRun ? `at most ${money(p.caps.perRun, d.token)} per run` : '', p.caps.perPerson ? `at most ${money(p.caps.perPerson, d.token)} per person` : '']
    .filter(Boolean)
    .join(', ')
  const facts = [
    ['Schedule', scheduleWords(p.schedule)],
    ['Mode', p.mode === 'autopilot' ? `Autopilot, veto window ${vetoWords(p.vetoWindowMinutes)}` : 'Propose (each run waits for approval)'],
    ['Next run', p.nextRunAt && p.status === 'active' ? when(p.nextRunAt) : '<span class="muted">none</span>'],
    ['Caps', caps || '<span class="muted">the bot key limit only</span>'],
    ['Version', `${p.version}${p.approvedBy ? `, approved by ${person(p.approvedBy, d.names)}${p.approvedAt ? ` ${when(p.approvedAt)}` : ''}` : ', not approved yet'}`],
  ]
  const pending = p.pendingVersion ? `<p class="notice warn">Version ${p.pendingVersion} waits for approval.</p>` : ''
  const actions = d.canAct ? actionsSection({ base, policy: p, csrf: d.csrf }) : '<p class="muted">Only the Treasurer role can change policies.</p>'
  return `<p class="small"><a href="/dashboard/${g}/policies">All policies</a></p>
<h1>${esc(p.name)} ${statusPill(p.status)} ${modePill(p.mode)}</h1>${d.notice}${pending}
<div class="grid"><section class="card"><h2>The rule</h2><p>${esc(p.ruleInWords)}</p><h3>As written</h3><blockquote>${esc(p.instructionInWords ?? p.instruction)}</blockquote>
<details><summary>Exact filter</summary><pre>${esc(JSON.stringify(p.filter, null, 2))}</pre></details>${d.editor && p.status !== 'archived' ? editorSection(base, d.csrf, d.editor) : ''}</section>
<section class="card"><h2>Settings</h2><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section></div>
${d.latest === undefined ? '' : latestRunSection(d.guildId, d.latest, p.version)}
${previewSection({ preview: d.preview, names: d.names, token: d.token })}
${d.budget ? budgetSection({ base, budget: d.budget, canAct: d.canAct, csrf: d.csrf, archived: p.status === 'archived' }) : ''}
${actions}
${versionsSection(d.versions, d.names, d.compiles ?? null)}`
}

/** A policy form's values as typed. `mode` and `vetoWindowMinutes`: the editor's, when an edit applies at once. */
export type PolicyFormValues = {
  name: string
  instruction: string
  kind: string
  weekday: string
  day: string
  hour: string
  minute: string
  timezone: string
  mode?: string
  vetoWindowMinutes?: string
}

/**
 * The fields of the new and edit policy forms: name, instruction and the schedule (its time is an
 * hour and a minute, which every kind uses). Each schedule field a kind may not use says which kinds
 * use it (`field-weekday`, `field-day`), and the stylesheet shows only the ones the chosen kind uses
 * (CSS `:has`, no script); the server reads only those too (`draftFrom`).
 */
export function policyFormFields(v: PolicyFormValues, daily: boolean): string {
  const opt = (value: string, label: string, current: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
  return `<div class="field"><label for="name">Name</label><input id="name" name="name" maxlength="${POLICY_LIMITS.maxNameLength}" required value="${esc(v.name)}"></div>
<div class="field"><label for="instruction">Instruction</label><textarea id="instruction" name="instruction" maxlength="${PROPOSAL_LIMITS.maxInstructionLength}" required>${esc(v.instruction)}</textarea>
<p class="muted small">For example: every Monday, 1 per answered question in #help, at most 50 a week each.</p></div>
<div class="row"><div class="field"><label for="kind">Runs</label><select id="kind" name="kind">${daily || v.kind === 'daily' ? opt('daily', 'Daily (testnet demo)', v.kind) : ''}${opt('weekly', 'Weekly', v.kind)}${opt('monthly', 'Monthly', v.kind)}</select></div>
<div class="field field-weekday"><label for="weekday">Day of the week</label><select id="weekday" name="weekday">${WEEKDAYS.map((w, i) => opt(String(i), w, v.weekday)).join('')}</select></div>
<div class="field field-day"><label for="day">Day of the month (1-28)</label><input id="day" name="day" type="number" min="1" max="28" value="${esc(v.day)}"></div>
<div class="field"><label for="hour">Hour (0-23)</label><input id="hour" name="hour" type="number" min="0" max="23" value="${esc(v.hour)}"></div>
<div class="field"><label for="minute">Minute (0-59)</label><input id="minute" name="minute" type="number" min="0" max="59" value="${esc(v.minute)}"></div>
<div class="field"><label for="timezone">Timezone</label><input id="timezone" name="timezone" value="${esc(v.timezone)}"></div></div>`
}

export function policyFormBody(d: {
  guildId: string
  action: string
  heading: string
  values: PolicyFormValues
  csrf: string
  error: string | null
  submit: string
  /** Offer a daily schedule (the testnet demo controls). It is also shown when the policy already has one. */
  daily?: boolean
}): string {
  return `<p class="small"><a href="/dashboard/${esc(d.guildId)}/policies">All policies</a></p><h1>${esc(d.heading)}</h1>
<p class="lede">Write the rule in your own words. Rolepay's AI compiles it once into an exact filter and amounts; you then see who it applies to and approve it. Nothing runs before that.</p>
${d.error ? `<p class="notice bad" role="alert">${esc(d.error)}</p>` : ''}
<form class="card" method="post" action="${esc(d.action)}">${csrfField(d.csrf)}
${policyFormFields(d.values, d.daily ?? false)}
<button type="submit">${esc(d.submit)}</button></form>`
}
