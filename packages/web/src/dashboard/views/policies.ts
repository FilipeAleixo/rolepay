import { POLICY_LIMITS, PROPOSAL_LIMITS, secondsText, usdText } from '@rolepay/core'
import type { AiCallView, PolicyDetail, PolicyPreview, PolicySchedule, PolicySummary, PolicyVersionView } from '../policyPort.js'
import { lineDiff } from './diff.js'
import { type Names, esc, money, person, pill, row, table, when } from './format.js'
import { csrfField } from './layout.js'

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')

/** "Every Monday at 18:00 (UTC)", "Monthly on day 1 at 09:00 (Europe/Lisbon)". */
export function scheduleWords(s: PolicySchedule): string {
  const at = `${pad(s.hour)}:00 (${esc(s.timezone)})`
  return s.kind === 'weekly' ? `Every ${WEEKDAYS[s.weekday] ?? '?'} at ${at}` : `Monthly on day ${s.day} at ${at}`
}

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
  edited: 'Recompiled. The new version waits for approval.',
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
}

/** "1 minute", "90 minutes", "1 hour", "24 hours". */
export function vetoWords(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

export function notice(done: string | undefined, error: string | undefined): string {
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
                ? money(m.amount, d.token)
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
<p>The bot key has ${budget} left now.</p>${p.held ? `<p class="notice warn">${esc(p.held)}</p>` : ''}</section>
<section class="card"><h2>Applies to right now</h2>${window}${matches}</section>
<section class="card"><h2>Just below the line</h2>${near}</section>`
}

const versionText = (v: PolicyVersionView) => `Instruction:\n${v.instruction}\n\nRule:\n${v.ruleInWords}\n\nFilter:\n${JSON.stringify(v.filter, null, 2)}`

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
  return `<section class="card"><h2>Actions</h2>${pending}<div class="actions"><a class="button secondary" href="${base}/edit">Edit and recompile</a>${
    p.status === 'active' ? post('pause', 'Pause', 'secondary') : ''
  }${p.status === 'paused' ? post('resume', 'Resume') : ''}${post('archive', 'Archive', 'danger')}</div>${mode}</section>`
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
<div class="grid"><section class="card"><h2>The rule</h2><p>${esc(p.ruleInWords)}</p><h3>As written</h3><blockquote>${esc(p.instruction)}</blockquote>
<details><summary>Exact filter</summary><pre>${esc(JSON.stringify(p.filter, null, 2))}</pre></details></section>
<section class="card"><h2>Settings</h2><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section></div>
${previewSection({ preview: d.preview, names: d.names, token: d.token })}
${actions}
${versionsSection(d.versions, d.names, d.compiles ?? null)}`
}

export type PolicyFormValues = { name: string; instruction: string; kind: string; weekday: string; day: string; hour: string; timezone: string }

export function policyFormBody(d: { guildId: string; action: string; heading: string; values: PolicyFormValues; csrf: string; error: string | null; submit: string }): string {
  const v = d.values
  const opt = (value: string, label: string, current: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
  return `<p class="small"><a href="/dashboard/${esc(d.guildId)}/policies">All policies</a></p><h1>${esc(d.heading)}</h1>
<p class="lede">Write the rule in your own words. Rolepay's AI compiles it once into an exact filter and amounts; you then see who it applies to and approve it. Nothing runs before that.</p>
${d.error ? `<p class="notice bad" role="alert">${esc(d.error)}</p>` : ''}
<form class="card" method="post" action="${esc(d.action)}">${csrfField(d.csrf)}
<div class="field"><label for="name">Name</label><input id="name" name="name" maxlength="${POLICY_LIMITS.maxNameLength}" required value="${esc(v.name)}"></div>
<div class="field"><label for="instruction">Instruction</label><textarea id="instruction" name="instruction" maxlength="${PROPOSAL_LIMITS.maxInstructionLength}" required>${esc(v.instruction)}</textarea>
<p class="muted small">For example: every Monday, 1 per answered question in #help, at most 50 a week each.</p></div>
<div class="row"><div class="field"><label for="kind">Runs</label><select id="kind" name="kind">${opt('weekly', 'Weekly', v.kind)}${opt('monthly', 'Monthly', v.kind)}</select></div>
<div class="field"><label for="weekday">Day of the week (weekly)</label><select id="weekday" name="weekday">${WEEKDAYS.map((w, i) => opt(String(i), w, v.weekday)).join('')}</select></div>
<div class="field"><label for="day">Day of the month (monthly, 1-28)</label><input id="day" name="day" type="number" min="1" max="28" value="${esc(v.day)}"></div>
<div class="field"><label for="hour">Hour (0-23)</label><input id="hour" name="hour" type="number" min="0" max="23" value="${esc(v.hour)}"></div>
<div class="field"><label for="timezone">Timezone</label><input id="timezone" name="timezone" value="${esc(v.timezone)}"></div></div>
<button type="submit">${esc(d.submit)}</button></form>`
}
