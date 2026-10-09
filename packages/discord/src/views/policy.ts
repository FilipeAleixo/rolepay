import {
  type Hold,
  MAX_LINES_PER_RUN,
  type Micros,
  type Policy,
  type PolicyKeyStatus,
  type PolicyPreview,
  type PolicyRun,
  type PolicySummary,
  describeRule,
  describeSchedule,
  displayAmount,
} from '@rolepay/core'
import { type ActionRow, ButtonStyle, ComponentType, type Embed, type Message, MessageFlags } from '../api.js'
import { encodePolicyButton } from '../components/customId.js'
import { COLORS, NO_PINGS, count, escapeAiText, escapeMarkdown, mention, money, roleMention } from './format.js'

export type PolicyViewContext = {
  /** The community's payout token, for amounts. */
  token: string
  approverRoleId: string | null
  /** Whose budget pays the policy, with what the chain says (show reads it); absent: not shown. */
  budget?: PolicyKeyStatus | null
  /** The treasury page for this policy's own budget: only in an answer to an approver, never in a public message. */
  budgetUrl?: string | null
  /**
   * The copy of a draft's preview in a public channel while its buttons are in the treasury channel:
   * the same preview, with its status, without Approve policy and Discard.
   */
  mirror?: boolean
}

const FIELD_MAX = 1024
const SHOWN = 15
const unix = (d: Date) => Math.floor(d.getTime() / 1000)
const when = (d: Date) => `<t:${unix(d)}:f> (<t:${unix(d)}:R>)`

/** Lines into one embed field, cut (with "...and N more") to Discord's 1024 characters. */
function listField(lines: string[], more: number): string {
  const out: string[] = []
  let length = 0
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i + more
    const tail = `…and ${rest} more`
    if (length + line.length + 1 > FIELD_MAX - tail.length - 1) {
      out.push(tail)
      return out.join('\n')
    }
    out.push(line)
    length += line.length + 1
  }
  if (more > 0) out.push(`…and ${more} more`)
  return out.join('\n')
}

const cut = (text: string, max = FIELD_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const veto = (minutes: number) => (minutes % 60 === 0 ? count(minutes / 60, 'hour', 'hours') : count(minutes, 'minute', 'minutes'))

/** Why a run would be (or was) held, in plain words with the numbers. */
export function explainHold(hold: Pick<Hold, 'code' | 'total' | 'limit'>, ctx: { token: string; autopilotBy?: string | null }): string {
  const m = (v: Micros | null) => (v === null ? '?' : money(v, ctx.token))
  switch (hold.code) {
    case 'over_budget':
      return `The run would pay ${m(hold.total)}, more than the bot key has left (${m(hold.limit)}). Held whole: nothing was paid. Raise the key's limit on the setup page, or wait for its next period.`
    case 'insufficient_limit':
      return `The run pays ${m(hold.total)}, more than the bot key has left (${m(hold.limit)}). Nothing was paid; press Retry once the key has room.`
    case 'over_policy_cap':
      return `The run would pay ${m(hold.total)}, over this policy's cap of ${m(hold.limit)} per run. Held whole: nothing was paid.`
    case 'too_many_lines':
      return `More than ${MAX_LINES_PER_RUN} people matched, and one run pays at most ${MAX_LINES_PER_RUN}. Held: nothing was paid. Narrow the rule.`
    case 'no_active_key':
      return 'There is no active bot key, so nothing can be paid. Held: nothing was paid. Authorise a key on the setup page.'
    case 'over_policy_budget':
      return `The run would pay ${m(hold.total)}, more than this policy's own key has left (${m(hold.limit)}). Held whole: nothing was paid, and the chain would refuse it anyway. A treasurer raises this policy's budget on the treasury page (\`/rolepay policy show\`), or it waits for the key's next period.`
    case 'swaps_over_budget':
      return `With its swaps into the stablecoins people prefer counted at their most, the run could take ${m(hold.total)} from the bot key, which has ${m(hold.limit)} left. Held whole: nothing was paid. Raise the key's limit on the setup page, or wait for its next period.`
    case 'swaps_over_policy_budget':
      return `With its swaps into the stablecoins people prefer counted at their most, the run could take ${m(hold.total)} from this policy's own key, which has ${m(hold.limit)} left. Held whole: nothing was paid. A treasurer raises this policy's budget on the treasury page (\`/rolepay policy show\`), or it waits for the key's next period.`
    case 'policy_key_inactive':
      return "This policy's own key cannot pay (revoked or expired), and a policy with its own key never falls back to the bot key. Held: nothing was paid. A treasurer gives it a new budget on the treasury page (`/rolepay policy show`)."
    case 'key_revoked':
    case 'key_expired':
    case 'key_expires_too_soon':
    case 'key_not_authorized':
      return 'The bot key cannot pay any more (revoked or expired). Nothing was paid. Authorise a new key on the setup page, then press Retry.'
    case 'policy_not_active':
      return 'The policy was paused or changed during the veto window, so autopilot did not approve this run. A treasurer can approve it by hand.'
    case 'autopilot_off':
      return 'Autopilot was switched off during the veto window, so this run waits for the normal approval.'
    case 'policy_changed':
      return 'The policy was edited after this run was made, so autopilot did not approve it. A treasurer can approve it by hand.'
    case 'approver_changed':
      return `${ctx.autopilotBy ? mention(ctx.autopilotBy) : 'The treasurer who switched autopilot on'} no longer holds the approver role (or the role changed), so autopilot did not approve this run. A treasurer can approve it by hand.`
    case 'creator_cannot_approve':
      return 'This server requires a separate approver, and the run would have been approved by its own author. A different treasurer approves it by hand.'
    case 'cannot_read':
      return 'Rolepay could not read a channel the rule counts in (the bot needs View Channel and Read Message History there). Nothing was paid.'
    default:
      return `Held (${hold.code}). Nothing was paid.`
  }
}

const PROBLEM_WORDS: Record<string, string> = {
  amount_not_in_instruction: 'An amount in the rule is not stated in your instruction, so it cannot be approved. Rewrite the instruction with the amounts.',
  scan_truncated: 'Rolepay reads at most 10,000 messages per run, so some counts may be low.',
  too_many_lines: `More than ${MAX_LINES_PER_RUN} people would be paid: the run would be held (one run pays at most ${MAX_LINES_PER_RUN}).`,
  over_policy_cap: "Over this policy's cap per run: the run would be held whole.",
  no_active_key: 'No active bot key: the run would be held.',
  over_budget: 'More than the bot key has left: the run would be held whole, never paid in part.',
  over_policy_budget: "More than this policy's own key has left: the run would be held whole, never paid in part (the chain would refuse it anyway).",
  swaps_over_budget: 'With its swaps into preferred stablecoins counted at their most, more than the bot key has left: the run would be held whole, never paid in part.',
  swaps_over_policy_budget: "With its swaps into preferred stablecoins counted at their most, more than this policy's own key has left: the run would be held whole, never paid in part.",
  policy_key_inactive: "This policy's own key cannot pay (revoked or expired): the run would be held. It never falls back to the bot key.",
}

function statusLine(p: Policy, ctx: PolicyViewContext): string {
  const approver = ctx.approverRoleId ? `a member with ${roleMention(ctx.approverRoleId)}` : 'an approver (no approver role is set yet)'
  switch (p.status) {
    case 'draft':
      return `Draft, version ${p.version}. Waiting for ${approver} to approve.`
    case 'active':
      return `Active. Approved by ${p.approvedBy ? mention(p.approvedBy) : 'a treasurer'}${p.approvedAt ? ` <t:${unix(p.approvedAt)}:R>` : ''}, version ${p.version}.`
    case 'paused':
      return `Paused, version ${p.version}. An approver resumes it with \`/rolepay policy resume\`.`
    case 'archived':
      return 'Archived. It never runs again.'
  }
}

const TITLES: Record<Policy['status'], string> = { draft: 'Policy draft', active: 'Policy', paused: 'Policy paused', archived: 'Policy archived' }

/**
 * A policy: the rule in plain words (and the original instruction), the schedule, the mode and,
 * with a preview, who it applies to right now. A draft carries Approve and Discard, for the version
 * shown, except on its copy without buttons (`mirror`).
 */
export function policyMessage(p: Policy, ctx: PolicyViewContext & { preview?: PolicyPreview | null; previewProblem?: string; nextRunAt?: Date | null }): Message {
  const rule = ctx.preview?.rule ?? describeRule(p.compiled, { schedule: p.schedule, caps: p.caps, guildId: p.communityId })
  const fields: NonNullable<Embed['fields']> = [{ name: 'Instruction', value: cut(`> ${escapeMarkdown(p.instruction)}`) }]
  const next = ctx.preview?.nextRunAt ?? ctx.nextRunAt ?? null
  fields.push({ name: 'Schedule', value: `${describeSchedule(p.schedule)}.${next && p.status !== 'archived' && p.status !== 'paused' ? ` ${p.status === 'draft' ? 'First run after approval' : 'Next run'}: ${when(next)}.` : ''}` })
  fields.push({
    name: 'Mode',
    value:
      p.mode === 'autopilot' && p.autopilot
        ? `Autopilot: each run pays ${veto(p.vetoWindowMinutes)} after it is posted unless vetoed, approved in the name of ${mention(p.autopilot.enabledBy)}.`
        : 'Propose: each run waits for the one-tap approval.',
  })
  const pv = ctx.preview
  if (pv) {
    const payable = pv.matches.filter((m) => m.registered && m.amount !== null && m.amount > 0n)
    // A payee paid in their preferred stablecoin reads as the run review shows it: "5 AlphaUSD → 5 BetaUSD (swapped)".
    const shown = payable
      .slice(0, SHOWN)
      .map((m) => `${mention(m.discordUserId)}  ${money(m.amount as Micros, ctx.token)}${m.swapped ? ` → ${money(m.amount as Micros, m.token)} (swapped)` : ''}${m.capped ? ' (capped)' : ''}  ·  ${m.reasonText}`)
    fields.push({ name: 'Who it applies to right now', value: shown.length ? listField(shown, payable.length - shown.length) : 'Nobody matches yet in this period.' })
    const unregistered = pv.matches.filter((m) => !m.registered)
    if (unregistered.length) {
      fields.push({ name: 'Matches, not registered', value: cut(`${unregistered.slice(0, 20).map((m) => mention(m.discordUserId)).join(' ')}${unregistered.length > 20 ? ` …and ${unregistered.length - 20} more` : ''}. They run \`/payee link\` to be paid.`) })
    }
    if (pv.nearMisses.length) fields.push({ name: 'Just below the line', value: listField(pv.nearMisses.map((n) => `${mention(n.userId)}  ${n.text}`), 0) })
    const own = pv.budgetKey === 'policy'
    const left =
      pv.remaining === null
        ? own
          ? "This policy's own key cannot pay."
          : 'There is no active bot key.'
        : `${own ? "This policy's own key" : 'The bot key'} has ${money(pv.remaining, ctx.token)} left.`
    fields.push({ name: 'The next run so far', value: `${money(pv.total, ctx.token)} for ${count(payable.length, 'person', 'people')} so far, counting since <t:${unix(pv.window.start)}:f>. ${left}` })
    if (pv.problems.length) fields.push({ name: 'Look first', value: cut(pv.problems.map((x) => `• ${PROBLEM_WORDS[x] ?? x}`).join('\n')) })
  } else if (ctx.previewProblem) fields.push({ name: 'Who it applies to right now', value: cut(ctx.previewProblem) })
  if (p.compiled.assumptions.length) fields.push({ name: 'The AI assumed', value: cut(p.compiled.assumptions.map((a) => `• ${escapeAiText(a)}`).join('\n')) })
  if (ctx.budget) fields.push({ name: 'Budget', value: budgetLine(ctx.budget, ctx.token) })
  fields.push({ name: 'Status', value: statusLine(p, ctx) })
  const embed: Embed = {
    title: cut(`${TITLES[p.status]}: ${p.name}`, 256),
    color: p.status === 'active' ? COLORS.paid : p.status === 'draft' ? COLORS.pending : COLORS.muted,
    description: cut(rule.join('\n'), 4096),
    fields: fields.slice(0, 25),
    footer: { text: `Policy ${p.id} · version ${p.version}` },
  }
  const components: ActionRow[] =
    p.status === 'draft' && !ctx.mirror
      ? [
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Success, label: 'Approve policy', custom_id: encodePolicyButton('approve', p.id, p.version) },
              { type: ComponentType.Button, style: ButtonStyle.Danger, label: 'Discard', custom_id: encodePolicyButton('discard', p.id, p.version) },
            ],
          },
        ]
      : []
  if (ctx.budgetUrl) {
    const label = ctx.budget?.signs === 'own' ? 'Manage its budget' : 'Give this policy its own budget'
    components.push({ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label, url: ctx.budgetUrl }] })
  }
  return { embeds: [embed], components, allowed_mentions: NO_PINGS }
}

/**
 * Whose budget pays the policy, as the chain says: "Own budget: 20 of 30 AlphaUSD left this period
 * (chain-enforced)", or the bot key's budget, shared, or nothing (its own key revoked or expired).
 */
export function budgetLine(b: PolicyKeyStatus, token: string): string {
  const k = b.key
  const s = b.state
  if (b.signs === 'retired') return 'Own budget: its key is revoked, so it pays nothing until a treasurer gives it a new one. It never falls back to the bot key.'
  if (b.signs === 'bot' || !k || !s) {
    const waiting = k?.status === 'pending_authorization' ? ' A key of its own waits for the treasury passkey.' : ''
    return `Shared: it pays from the bot key's budget, with manual runs, AI-proposed runs and other policies.${waiting}`
  }
  if (s.status === 'expired') return 'Own budget: its key has expired, so it pays nothing until a treasurer gives it a new one. It never falls back to the bot key.'
  if (s.status !== 'active') return 'Own budget: its key cannot pay right now, so it pays nothing until a treasurer gives it a new one.'
  const limit = k.policy.limit
  const left = s.remaining > limit ? limit : s.remaining
  const periodic = k.policy.periodSeconds !== null
  const timing = periodic && s.periodEnd ? ` Resets <t:${s.periodEnd}:R>, expires <t:${s.expiry}:R>.` : ` Expires <t:${s.expiry}:R>.`
  return `Own budget: ${displayAmount(left)} of ${money(limit, token)} left ${periodic ? 'this period' : 'in total'} (chain-enforced).${timing}`
}

/**
 * After an approval, to the approver alone: give the policy its own budget on the treasury page. The
 * link is a setup link (30 minutes); the treasury passkey signs the key there and the chain enforces it.
 */
export function policyBudgetOffer(p: Policy, opts: { url: string; expiresAt: Date }): Message {
  return {
    content:
      `Give **${escapeMarkdown(p.name)}** its own budget? A key of its own on the treasury, with a limit the chain enforces, so this policy can never spend more than that, whatever the bot key has left. ` +
      `The treasury passkey signs it on the page; the link works until <t:${unix(opts.expiresAt)}:t>. Optional: without it, the policy pays from the bot key as before.`,
    components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Give this policy its own budget', url: opts.url }] }],
    flags: MessageFlags.Ephemeral,
    allowed_mentions: NO_PINGS,
  }
}

/** A draft that was discarded (and, for an edit, which approved version is back). */
export function policyDiscardedMessage(p: Policy, by: string): Message {
  const back = p.status === 'paused' ? ` Version ${p.version} is back, paused.` : ''
  return { embeds: [{ title: cut(`Discarded: ${p.name}`, 256), color: COLORS.muted, description: `Discarded by ${mention(by)}.${back}`, footer: { text: `Policy ${p.id}` } }], components: [], allowed_mentions: NO_PINGS }
}

/**
 * A preview whose version an edit replaced (on the dashboard): which version replaced it and who
 * edited it. Nothing about the new version's state, which this message is not told about later.
 */
export function policyReplacedMessage(p: Policy, replaced: number, by: string): Message {
  return {
    embeds: [{ title: cut(`Replaced: ${p.name}`, 256), color: COLORS.muted, description: `Version ${replaced} was replaced by version ${p.version}, edited by ${mention(by)}.`, footer: { text: `Policy ${p.id}` } }],
    components: [],
    allowed_mentions: NO_PINGS,
  }
}

/** /rolepay policy list. */
export function policyListMessage(items: readonly PolicySummary[]): Message {
  if (items.length === 0) return { content: 'No policies yet. Write one with `/rolepay policy new`.', allowed_mentions: NO_PINGS }
  const lines = items.slice(0, 20).map(({ policy: p, nextRunAt }) => {
    const next = nextRunAt ? `, next run <t:${unix(nextRunAt)}:R>` : ''
    return `**${escapeMarkdown(p.name)}** \`${p.id}\`: ${p.status}, ${p.mode}${next}\n${describeSchedule(p.schedule)}`
  })
  return { embeds: [{ title: 'Policies', color: COLORS.working, description: cut(lines.join('\n\n'), 4096), footer: { text: '/rolepay policy show for one in detail' } }], allowed_mentions: NO_PINGS }
}

/** The public line for a governance change (pause, resume, mode), so everyone in the channel sees it. */
export function policyChangedMessage(p: Policy, change: 'paused' | 'resumed' | 'mode', by: string, ctx: PolicyViewContext): Message {
  const name = `**${escapeMarkdown(p.name)}**`
  const who = ctx.approverRoleId ? `a member with ${roleMention(ctx.approverRoleId)}` : 'an approver'
  const content =
    change === 'paused'
      ? `Policy ${name} paused by ${mention(by)}. It makes no runs until it is resumed.`
      : change === 'resumed'
        ? `Policy ${name} resumed by ${mention(by)}. Periods it missed are not run.`
        : p.mode === 'autopilot'
          ? `Autopilot is on for ${name}, switched on by ${mention(by)}: each run pays ${veto(p.vetoWindowMinutes)} after it is posted unless ${who} vetoes it, within the bot key's limit.`
          : `${name} is back to propose, set by ${mention(by)}: each run waits for the one-tap approval.`
  return { content, allowed_mentions: NO_PINGS }
}

/** A policy run that made no pay run: held whole (with why) or nobody matched. */
export function policyRunNoticeMessage(p: Policy, pr: PolicyRun, ctx: PolicyViewContext): Message {
  const period = `the period to <t:${unix(pr.periodEnd)}:f>`
  if (pr.status === 'empty') {
    return { content: `**${escapeMarkdown(p.name)}**: nobody matched for ${period}, so there is no run this time.`, allowed_mentions: NO_PINGS }
  }
  const fields: NonNullable<Embed['fields']> = []
  if (pr.hold) fields.push({ name: 'Why', value: explainHold(pr.hold, { token: ctx.token, autopilotBy: p.autopilot?.enabledBy ?? null }) })
  if (pr.lines.length) {
    const shown = pr.lines.slice(0, SHOWN).map((l) => `${mention(l.discordUserId)}  ${money(l.amount, ctx.token)}`)
    fields.push({ name: `Would have paid ${money(pr.total, ctx.token)} to ${count(pr.lines.length, 'person', 'people')}`, value: listField(shown, pr.lines.length - shown.length) })
  }
  return {
    embeds: [{ title: cut(`Held: ${p.name}`, 256), color: COLORS.failed, description: `Policy run for ${period}. Nothing was paid.`, fields, footer: { text: `Policy ${p.id} · version ${pr.policyVersion} · ${pr.id}` } }],
    allowed_mentions: NO_PINGS,
  }
}
