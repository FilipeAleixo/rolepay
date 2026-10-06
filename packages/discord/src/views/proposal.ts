import {
  type AmountPlan,
  type Criteria,
  type HoldReason,
  MAX_LINES_PER_RUN,
  PROPOSAL_LIMITS,
  type Problem,
  type Proposal,
  type ProposalLine,
  type Run,
  blockingProblems,
  formatAmount,
} from '@payrun/core'
import { type ActionRow, type Button, ButtonStyle, ComponentType, type Embed, type Message, type Modal, TextInputStyle } from '../api.js'
import { encodeProposalId, encodeProposalModalId } from '../components/customId.js'
import { COLORS, NO_PINGS, count, escapeMarkdown, mention, money, relativeTime, roleMention } from './format.js'

/**
 * The proposal, for the person who asked (an ephemeral message): what the AI understood, one
 * line per person with the amount and why, what was left out and why, and the total against the
 * bot key. A draft only: "Create pay run" makes a normal run that still needs approval.
 */

const DESCRIPTION_MAX = 4000
const EMBED_MAX = 5900
const FIELD_MAX = 1024

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
export const messageLink = (guildId: string, channelId: string, messageId: string) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
const day = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:D>`
const channels = (ids: readonly string[]) => ids.map((c) => `<#${c}>`).join(' or ')
const either = (ids: readonly string[], render: (id: string) => string) => ids.map(render).join(' or ')

const HOLDS: Record<HoldReason, string> = {
  self_sourced: 'their own message is the only source',
  suspicious_source: 'its source message tried to instruct the AI',
  no_source: 'no message backs it',
  amount_unreadable: 'the amount could not be read',
  amount_not_in_instruction: 'the amount is not in your instruction',
  amount_not_in_source: 'no message by someone else states that amount',
  duplicate: 'listed twice',
  over_remaining_budget: 'more than the bot key has left',
}

const PROBLEMS: Record<Problem, string> = {
  no_lines: 'Nobody to pay yet. Edit adds people.',
  too_many_lines: `More than ${MAX_LINES_PER_RUN} people: a run pays at most ${MAX_LINES_PER_RUN}. Edit it down.`,
  amount_not_in_instruction: 'The amount rule uses an amount your instruction does not state. Check it and use Edit: the lines you type are exactly what gets paid.',
  amount_from_message: 'Some amounts come from messages, which anyone in the channel could have written. Check them, then confirm with Edit (submit the lines as they should be).',
  over_budget: 'The total is more than the bot key has left: the run will be refused until the limit resets or the treasury authorises a larger key.',
  no_active_key: 'The bot key is not active: the run cannot be paid until the treasury authorises one.',
  scan_truncated: `The ${PROPOSAL_LIMITS.maxScannedMessages.toLocaleString('en-US')}-message bound was reached: counts may be low for the oldest days.`,
  source_truncated: `Only the newest ${PROPOSAL_LIMITS.maxSourceMessages} messages were read.`,
  lookback_clamped: `History is read at most ${PROPOSAL_LIMITS.maxLookbackDays} days back.`,
}

/** "34 replies", "12 messages on 3 days": the counts code made for this person. */
function metricsText(l: Pick<ProposalLine, 'metrics'>): string | null {
  const m = l.metrics
  if (!m) return null
  const parts = [
    m.messages !== null ? count(m.messages, 'message', 'messages') : null,
    m.activeDays !== null ? `active on ${count(m.activeDays, 'day', 'days')}` : null,
    m.replies !== null ? count(m.replies, 'reply', 'replies') : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** Why this person: the AI's words (message mode, escaped) or the counts (criteria mode), and a link to the source. */
function why(p: Proposal, l: Pick<ProposalLine, 'reason' | 'metrics' | 'sources'>): string {
  const reason = l.reason ? escapeMarkdown(l.reason) : metricsText(l)
  const source = l.sources[0] ? `[source](${messageLink(p.communityId, l.sources[0].channelId, l.sources[0].messageId)})` : null
  return [reason, source].filter(Boolean).join(' · ')
}

const lineText = (p: Proposal, l: ProposalLine, i: number) =>
  [
    `${i + 1}. ${mention(l.discordUserId)}  ${money(l.amount, p.token)}`,
    why(p, l),
    l.flags.includes('amount_from_message') ? 'amount from a message' : null,
    l.flags.includes('capped') ? 'capped' : null,
  ]
    .filter(Boolean)
    .join(' · ')

/** The criteria restated in plain words, for the treasurer to confirm before creating the run. */
export function criteriaInWords(c: Criteria, guildId: string): string {
  const when = (w: { since: Date; until: Date }, made: Date) =>
    Math.abs(w.until.getTime() - made.getTime()) < 60_000 ? `since ${day(w.since)}` : `from ${day(w.since)} to ${day(w.until)}`
  const clauses: string[] = []
  if (c.hasRole.length) clauses.push(`who have ${either(c.hasRole, roleMention)}`)
  if (c.lacksRole.length) clauses.push(`who do not have ${either(c.lacksRole, roleMention)}`)
  if (c.joinedBefore) clauses.push(`who joined before ${day(c.joinedBefore)}`)
  if (c.joinedAfter) clauses.push(`who joined after ${day(c.joinedAfter)}`)
  const made = new Date(Math.max(...[c.messagesIn, c.activeDaysIn, c.repliesIn].filter((w) => w !== null).map((w) => w.until.getTime()), 0))
  if (c.messagesIn) clauses.push(`who sent at least ${count(c.messagesIn.min, 'message', 'messages')} in ${channels(c.messagesIn.channelIds)} ${when(c.messagesIn, made)}`)
  if (c.activeDaysIn) clauses.push(`who were active on at least ${count(c.activeDaysIn.min, 'day', 'days')} in ${channels(c.activeDaysIn.channelIds)} ${when(c.activeDaysIn, made)}`)
  if (c.repliesIn) clauses.push(`who replied to other people at least ${c.repliesIn.min === 1 ? 'once' : `${c.repliesIn.min} times`} in ${channels(c.repliesIn.channelIds)} ${when(c.repliesIn, made)}`)
  if (c.reactedTo) {
    const emoji = c.reactedTo.emoji ? (/^<a?:\w{1,32}:\d{17,20}>$/.test(c.reactedTo.emoji) ? c.reactedTo.emoji : escapeMarkdown(c.reactedTo.emoji.slice(0, 32))) : null
    clauses.push(`who reacted${emoji ? ` ${emoji}` : ''} to [this message](${messageLink(guildId, c.reactedTo.channelId, c.reactedTo.messageId)})`)
  }
  if (c.mentionedIn) clauses.push(`mentioned in [this message](${messageLink(guildId, c.mentionedIn.channelId, c.mentionedIn.messageId)})`)
  if (c.postedIn) clauses.push(`who posted in <#${c.postedIn.threadId}> in the last ${PROPOSAL_LIMITS.maxLookbackDays} days`)
  if (c.paidInRun) clauses.push(c.paidInRun.last ? `paid in the last run${c.paidInRun.runId ? ` (${c.paidInRun.runId})` : ' (there is none yet)'}` : `paid in run ${c.paidInRun.runId}`)
  const except = [...c.exclude.map(mention), ...(c.excludeProposer ? ['the person proposing'] : [])]
  if (except.length) clauses.push(`except ${except.join(', ')}`)
  const joined = clauses.length <= 1 ? (clauses[0] ?? '') : `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`
  return clauses.length ? `Registered payees ${joined}.` : 'Every registered payee.'
}

export function amountInWords(plan: AmountPlan, token: string): string {
  const r = plan.rule
  const unit = { messages: 'message', activeDays: 'active day', replies: 'reply' } as const
  const by = { messages: 'messages', activeDays: 'active days', replies: 'replies', equal: '' } as const
  const base =
    r.kind === 'flat'
      ? `${money(r.amount, token)} each`
      : r.kind === 'perUnit'
        ? `${money(r.amount, token)} per ${unit[r.per]}${r.cap ? `, at most ${money(r.cap, token)} each` : ''}`
        : r.splitBy === 'equal'
          ? `${money(r.total, token)} split equally`
          : `${money(r.total, token)} split by ${by[r.splitBy]}`
  const extras = [
    ...plan.overrides.map((o) => `${mention(o.discordUserId)} gets ${money(o.amount, token)}`),
    ...(plan.perPersonCap ? [`at most ${money(plan.perPersonCap, token)} for anyone`] : []),
  ]
  return `${base}${extras.length ? `; ${extras.join('; ')}` : ''}.`
}

function header(p: Proposal): string[] {
  const out: string[] = []
  if (p.mode === 'criteria' && p.criteria && p.amountPlan) {
    out.push(`**Who:** ${criteriaInWords(p.criteria, p.communityId)}`)
    out.push(`**Amount:** ${amountInWords(p.amountPlan, p.token)}`)
    if (p.scans.length) {
      out.push(`**Scanned:** ${p.scans.map((s) => `${count(s.messages, 'message', 'messages')} in <#${s.channelId}> since ${day(s.since)}${s.truncated ? ' (bound reached)' : ''}`).join('; ')}.`)
    }
  } else if (p.source) {
    const n = p.source.messageIds.length
    const first = p.source.messageIds[0]
    const what = n === 1 && first ? `[1 message](${messageLink(p.communityId, p.source.channelId, first)})` : count(n, 'message', 'messages')
    out.push(`**From:** ${what} in <#${p.source.channelId}>.`)
  }
  out.push(`**Instruction:** ${escapeMarkdown(clip(p.instruction, 300))}`)
  if (p.note) out.push(`**Note on the run:** ${escapeMarkdown(p.note)}`)
  // Many exclusions or overrides could make the criteria long: each part has a bound.
  return out.map((x) => clip(x, 900))
}

/** Shrinks the longest list fields (never Total and Bot key) until they fit `budget` characters. */
function fitFields(fs: NonNullable<Embed['fields']>, budget: number): NonNullable<Embed['fields']> {
  const out = [...fs]
  const size = () => out.reduce((n, f) => n + f.name.length + f.value.length, 0)
  while (size() > budget && out.length > 2) {
    const rest = out.slice(2)
    const longest = rest.reduce((a, b) => (b.value.length > a.value.length ? b : a))
    const i = out.indexOf(longest)
    if (longest.value.length <= 120) out.splice(i, 1)
    else out[i] = { ...longest, value: clip(longest.value, Math.floor(longest.value.length / 2)) }
  }
  return out
}

function fields(p: Proposal): NonNullable<Embed['fields']> {
  const f: NonNullable<Embed['fields']> = [
    { name: 'Total', value: `${money(p.total, p.token)} for ${count(p.lines.length, 'person', 'people')}`, inline: true },
    { name: 'Bot key', value: p.remaining === null ? 'Not active' : `${money(p.remaining, p.token)} left`, inline: true },
  ]
  const list = (name: string, items: string[], suffix = '') => {
    if (!items.length) return
    const shown: string[] = []
    let size = suffix.length
    for (const item of items) {
      if (size + item.length + 1 > FIELD_MAX - 40) {
        shown.push(`…and ${items.length - shown.length} more`)
        break
      }
      shown.push(item)
      size += item.length + 1
    }
    f.push({ name, value: clip([...shown, ...(suffix ? [suffix] : [])].join('\n'), FIELD_MAX) })
  }
  list(
    'Left out (shown, not in the run)',
    p.held.map((h) => `${mention(h.discordUserId)}${h.amount !== null ? ` ${money(h.amount, p.token)}` : ''}: ${h.holds.map((x) => HOLDS[x]).join('; ')}.`),
  )
  list(
    'Not registered payees',
    p.unregistered.map((u) => `${mention(u.discordUserId)}${u.amount !== null && u.amount > 0n ? ` (${money(u.amount, p.token)})` : ''}${metricsText(u) ? `: ${metricsText(u)}` : ''}`),
    'They register with `/payee link`, then propose again.',
  )
  list('Could not resolve', p.unresolved.map((u) => `"${escapeMarkdown(u.text)}": ${escapeMarkdown(u.why)}`))
  list(
    'Ignored instructions in messages',
    p.suspicious.map((s) => `[A message](${messageLink(p.communityId, s.channelId, s.messageId)}) by ${mention(s.authorId)}: ${escapeMarkdown(s.summary)}`),
  )
  list('Assumptions', p.assumptions.map((a) => `• ${escapeMarkdown(a)}`))
  list('Check before creating', p.problems.map((x) => `${blockingProblems({ problems: [x] }).length ? '⛔' : '⚠️'} ${PROBLEMS[x]}`))
  return f.slice(0, 25)
}

export type ProposalViewContext = { approverRoleId: string | null }

export function proposalMessage(p: Proposal, ctx: ProposalViewContext): Message {
  const title = p.editedBy ? 'Pay run proposal (edited)' : 'Pay run proposal'
  const head = header(p).join('\n')
  const footer = `Proposal ${p.id}. A draft: nothing is paid until a member with the approver role approves the run.`
  const expires = `Expires ${relativeTime(p.expiresAt)}.${ctx.approverRoleId ? ` Create posts the run for ${roleMention(ctx.approverRoleId)} to approve.` : ''}`
  // The lines get whatever room the header, the expiry line, the fields and the footer leave,
  // and at least 1,000 characters: the fields shrink first (Discord refuses an embed over 6,000).
  const fixed = head.length + expires.length + 8
  const fs = fitFields(fields(p), EMBED_MAX - title.length - footer.length - fixed - 1000)
  const others = title.length + footer.length + fs.reduce((s, x) => s + x.name.length + x.value.length, 0)
  const room = Math.min(DESCRIPTION_MAX - fixed, EMBED_MAX - others - fixed)
  const lines: string[] = []
  let size = 0
  for (const [i, l] of p.lines.entries()) {
    const t = lineText(p, l, i)
    if (size + t.length + 1 > room - 50) {
      lines.push(`…and ${p.lines.length - i} more (Edit shows every line)`)
      break
    }
    lines.push(t)
    size += t.length + 1
  }
  const embed: Embed = {
    title,
    color: blockingProblems(p).length ? COLORS.failed : COLORS.pending,
    description: clip([head, '', ...(lines.length ? lines : ['Nobody to pay.']), '', expires].join('\n'), DESCRIPTION_MAX),
    fields: fs,
    footer: { text: footer },
  }
  return { embeds: [embed], components: proposalButtons(p), allowed_mentions: NO_PINGS }
}

function proposalButtons(p: Proposal): ActionRow[] {
  const blocked = blockingProblems(p).length > 0 || p.lines.length === 0
  const b = (action: 'create' | 'edit' | 'discard', label: string, style: 1 | 2 | 3 | 4, disabled = false): Button => ({
    type: ComponentType.Button,
    style,
    label,
    custom_id: encodeProposalId(action, p.id),
    ...(disabled ? { disabled: true } : {}),
  })
  return [{ type: ComponentType.ActionRow, components: [b('create', 'Create pay run', ButtonStyle.Success, blocked), b('edit', 'Edit', ButtonStyle.Secondary), b('discard', 'Discard', ButtonStyle.Danger)] }]
}

/** The ephemeral proposal after Create: where the run is now. */
export function proposalCreatedMessage(p: Proposal, run: Run, ctx: ProposalViewContext): Message {
  return {
    embeds: [
      {
        title: 'Pay run created',
        color: COLORS.paid,
        description: `Run ${run.id} (${money(run.total, run.token)} for ${count(run.lines.length, 'person', 'people')}) is posted in this channel for ${ctx.approverRoleId ? roleMention(ctx.approverRoleId) : 'the approver role'} to approve. Nothing is paid before that.`,
        footer: { text: `From proposal ${p.id}` },
      },
    ],
    components: [],
    allowed_mentions: NO_PINGS,
  }
}

export function proposalDiscardedMessage(p: Proposal): Message {
  return { embeds: [{ title: 'Proposal discarded', color: COLORS.muted, description: 'Nothing was created.', footer: { text: `Proposal ${p.id}` } }], components: [], allowed_mentions: NO_PINGS }
}

/** The form "Propose pay run" opens on a message: what to pay. */
export function instructionModal(messageId: string): Modal {
  return {
    custom_id: encodeProposalModalId('instruct', messageId),
    title: 'Propose pay run',
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: 'instruction',
            label: 'What should this run pay?',
            style: TextInputStyle.Paragraph,
            min_length: 1,
            max_length: PROPOSAL_LIMITS.maxInstructionLength,
            required: true,
            placeholder: '50 each, the indexer one 200, note: October bounties',
          },
        ],
      },
    ],
  }
}

/**
 * The lines as text for Edit: `<@id>=amount`, one per line; held and unregistered people as
 * comments to copy in. The payable lines always come first and in full (comments are dropped
 * before any of them would be), because submitting the form makes them exactly the run.
 */
export function editText(p: Proposal): string {
  const LIMIT = 3900
  const note = (text: string | null) => (text ? `  # ${text.replace(/[\r\n#]+/g, ' ').slice(0, 40)}` : '')
  const bare = p.lines.map((l) => `<@${l.discordUserId}>=${formatAmount(l.amount)}`)
  const noted = p.lines.map((l, i) => `${bare[i]}${note(l.reason ?? metricsText(l))}`)
  let rows = noted.join('\n').length <= LIMIT ? noted : bare
  if (rows.join('\n').length > LIMIT) {
    // Only a proposal over the run limit (more than 50 people) gets here: say what is missing.
    const kept: string[] = []
    for (const r of rows) {
      if ([...kept, r].join('\n').length > LIMIT - 80) break
      kept.push(r)
    }
    return [...kept, `# ${rows.length - kept.length} more lines are not shown: submitting keeps only the lines above`].join('\n')
  }
  const comments = [
    ...p.held.map((h) => `# <@${h.discordUserId}>=${h.amount !== null ? formatAmount(h.amount) : '?'}  (left out: ${h.holds.map((x) => HOLDS[x]).join('; ')})`),
    ...p.unregistered.map((u) => `# <@${u.discordUserId}>  (not registered)`),
  ]
  for (const c of comments) {
    if ([...rows, c].join('\n').length > LIMIT) break
    rows = [...rows, c]
  }
  return rows.join('\n')
}

export function editModal(p: Proposal): Modal {
  return {
    custom_id: encodeProposalModalId('edit', p.id),
    title: 'Edit the pay run lines',
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: 'lines',
            label: 'One per line: @user=amount (# = comment)',
            style: TextInputStyle.Paragraph,
            max_length: 4000,
            required: false,
            value: editText(p),
          },
        ],
      },
    ],
  }
}
