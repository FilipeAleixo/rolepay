import { type Failure, type NetworkName, type PolicyRun, type Run, type RunLine, lineToken, swapLegs } from '@rolepay/core'
import { type ActionRow, type Button, ButtonStyle, ComponentType, type Embed, type Message } from '../api.js'
import { type RunAction, encodeCustomId, encodeVetoButton } from '../components/customId.js'
import { COLORS, NO_PINGS, count, escapeMarkdown, mention, money, relativeTime, roleMention, shortAddress, tokenLabel, txUrl } from './format.js'

export type RunViewContext = {
  network: NetworkName
  /** Shown on a run awaiting approval: who may approve it. */
  approverRoleId?: string | null
  /**
   * Why an approved run has not been paid yet (a pre-flight failure such as a revoked key), or
   * why Rolepay stopped on a failed one (for example, the chain already shows its payments).
   */
  problem?: string
  /** A payment (or retry) is in progress: show it as paying whatever the stored status says. */
  paying?: boolean
  /** On a paid run: DM receipts being sent, or how many went out. */
  receipts?: 'sending' | { sent: number; total: number }
  /** On an executing run: the transaction is out but not confirmed yet. */
  stillConfirming?: boolean
  /**
   * Show the node's or sponsor's own error text on a failure. Only for replies just to the caller
   * (`/rolepay status run:`): a public message shows the reason code alone (L2).
   */
  showDetail?: boolean
  /** The run was made by a standing policy: which one, which version, for which period. */
  policy?: { name: string; version: number; periodStart: Date; periodEnd: Date }
  /**
   * An autopilot run: while it waits it shows when it pays and a Veto button (instead of Approve);
   * `vetoedBy` once vetoed; `stopped` when autopilot did not approve it (it waits for a person).
   */
  autopilot?: { policyRunId: string; executeAfter: Date; vetoedBy?: string | null; stopped?: string }
  /**
   * Autopilot approved this run after its veto window (`releasedOnAutopilot`): nobody approved this
   * run itself, so the status says so, and names who approved the policy version that made it.
   */
  released?: AutopilotRelease
}

/** Who approved the policy version that made a run autopilot released (null: not known any more). */
export type AutopilotRelease = { version: number; policyApprovedBy: string | null }

/**
 * Whether autopilot approved this run, rather than a person: its policy run was released, and the
 * run was approved once the veto window was over. A person who approved it during the window (Rolepay
 * then paid it at release), or after autopilot stopped, approved it themselves: "Approved by" stays.
 */
export function releasedOnAutopilot(run: Run, pr: PolicyRun, policyApprovedBy: string | null): AutopilotRelease | undefined {
  const autopilot = pr.mode === 'autopilot' && pr.status === 'released' && pr.vetoedAt === null && pr.executeAfter !== null
  if (!autopilot || !run.approvedAt || !pr.executeAfter || run.approvedAt < pr.executeAfter) return undefined
  return { version: pr.policyVersion, policyApprovedBy }
}

/**
 * The one message for a run, whatever its status: the review embed, the "paying"
 * state, the receipt or the failure. Buttons follow the status, so a stale message
 * can never offer an action the run no longer allows.
 */
export function runMessage(run: Run, ctx: RunViewContext): Message {
  const head = header(run, ctx)
  const fields: Embed['fields'] = [
    { name: 'Total', value: money(run.total, run.token), inline: true },
    { name: 'People', value: String(run.lines.length), inline: true },
    { name: 'Created by', value: mention(run.createdBy), inline: true },
    { name: 'Status', value: head.status },
  ]
  if (ctx.problem && !ctx.paying) {
    if (run.status === 'approved') fields.push({ name: 'Not paid yet', value: ctx.problem })
    if (run.status === 'failed') fields.push({ name: 'Note', value: ctx.problem })
  }
  const swaps = swapsText(run)
  if (swaps) fields.push({ name: 'Swaps', value: swaps })
  if (ctx.policy) {
    const p = ctx.policy
    fields.push({ name: 'Policy', value: `**${escapeMarkdown(p.name)}** (version ${p.version}), for <t:${unix(p.periodStart)}:f> to <t:${unix(p.periodEnd)}:f>` })
  }
  if (ctx.autopilot?.stopped && !ctx.paying) fields.push({ name: 'Autopilot stopped', value: ctx.autopilot.stopped })
  if (ctx.receipts && run.status === 'paid') fields.push({ name: 'Receipts', value: receiptsText(ctx.receipts) })
  if (ctx.stillConfirming && run.status === 'executing') {
    fields.push({ name: 'Confirming', value: 'The transaction is out but not confirmed yet. Rolepay keeps checking; /rolepay status shows the result.' })
  }
  const embed: Embed = {
    title: head.title,
    color: head.color,
    description: [run.note ? `**${escapeMarkdown(run.note)}**` : null, ...run.lines.map((l) => lineText(l, run.token))].filter(Boolean).join('\n'),
    fields,
    footer: { text: `Run ${run.id}` },
  }
  return { embeds: [embed], components: rows(buttonsFor(run, ctx)), allowed_mentions: NO_PINGS }
}

/**
 * The DM a payee gets once their line is paid. `accountUrl` is the server's account page, where
 * the payee signs in with their passkey to see the balance and send it on.
 */
export function receiptDm(run: Run, line: RunLine, ctx: { network: NetworkName; communityName: string | null; accountUrl?: string | null }): Message {
  const tx = run.paidTxHash
  const embed: Embed = {
    title: `You were paid ${money(line.amount, lineToken(run, line))}`,
    color: COLORS.paid,
    description: [
      `From **${escapeMarkdown(ctx.communityName ?? 'your Discord server')}**, through Rolepay on Tempo.`,
      line.swap ? `In ${tokenLabel(line.swap.token)}, the stablecoin you chose: swapped from ${tokenLabel(run.token)} on Tempo's stablecoin exchange in the same transaction.` : null,
      run.note ? `Note: ${escapeMarkdown(run.note)}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    fields: [
      { name: 'To your account', value: shortAddress(line.address), inline: true },
      { name: 'Pay run', value: `${run.id}, line ${line.line}`, inline: true },
      ...(tx ? [{ name: 'Transaction', value: txUrl(ctx.network, tx) }] : []),
      ...(ctx.accountUrl ? [{ name: 'Your money', value: `To see your balance or send it on, sign in with your passkey at ${ctx.accountUrl}` }] : []),
    ],
  }
  const link: Button[] = [
    ...(tx ? [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'View transaction', url: txUrl(ctx.network, tx) } as const] : []),
    ...(ctx.accountUrl ? [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Your account', url: ctx.accountUrl } as const] : []),
  ]
  return { embeds: [embed], components: rows(link), allowed_mentions: NO_PINGS }
}

/**
 * Plain English for why an attempt failed, and whether it is safe to try again. Each says what
 * Rolepay actually checked, never "nothing was paid": Retry waits until the last transaction can
 * no longer land and checks the chain for this run's payments before it sends anything.
 */
export function explainFailure(failure: Failure, opts: { showDetail?: boolean } = {}): string {
  switch (failure.reason) {
    case 'rejected': {
      // The detail starts with Rolepay's reason code ("insufficient_balance: ..."); the rest is the
      // node's or sponsor's own text, which can carry URLs and HTML. Public messages get the code.
      const code = /^([a-z_]+):/.exec(failure.detail)?.[1] ?? 'other'
      return `The network or the fee sponsor refused the transaction (${opts.showDetail ? failure.detail : code}). Retry is safe: it waits until that transaction can no longer land and checks the chain first.`
    }
    case 'reverted':
      return 'The transaction reverted on chain, so none of its transfers happened. Retry once the cause is fixed: it checks the chain first.'
    case 'not_landed':
      return 'The transaction did not land before its deadline, and the chain shows nothing paid for this run. Retry is safe: it checks the chain first.'
    case 'partial_match':
      return `Only some lines show as paid on chain (${failure.detail}). Do not retry: someone needs to check the explorer.`
    case 'transfer_mismatch':
      return `The chain shows transfers that do not match this run (${failure.detail}). Do not retry: someone needs to check the explorer.`
  }
}

// ---- internals ---------------------------------------------------------------

function header(run: Run, ctx: RunViewContext): { title: string; color: number; status: string } {
  const approvedBy = run.approvedBy ? mention(run.approvedBy) : 'the treasurer'
  const released = ctx.released
  /** Who approved this run: a person, or autopilot after the window (then who approved the rule). */
  const approval = released ? RELEASED : `Approved by ${approvedBy}.`
  const policyApproval = released ? policyApprovalText(released, run.approvedBy) : ''
  if (ctx.paying && run.status !== 'paid') return { title: 'Approved, paying…', color: COLORS.working, status: `${approval} Paying…` }
  const auto = ctx.autopilot
  if (auto && !auto.stopped && run.status === 'pending_approval') {
    const at = unix(auto.executeAfter)
    const who = ctx.approverRoleId ? `a member with ${roleMention(ctx.approverRoleId)}` : 'an approver'
    return { title: `Autopilot: pays <t:${at}:t> unless vetoed`, color: COLORS.pending, status: `Pays <t:${at}:f> (<t:${at}:R>) unless ${who} vetoes it.` }
  }
  if (auto?.vetoedBy && run.status === 'cancelled') return { title: 'Vetoed', color: COLORS.muted, status: `Vetoed by ${mention(auto.vetoedBy)}. The run was cancelled before it paid anything.` }
  switch (run.status) {
    case 'draft':
    case 'pending_approval':
      return {
        title: 'Pay run awaiting approval',
        color: COLORS.pending,
        status: ctx.approverRoleId ? `Waiting for a member with ${roleMention(ctx.approverRoleId)} to approve.` : 'Waiting for approval.',
      }
    case 'approved':
      return ctx.problem
        ? { title: 'Approved, not paid yet', color: COLORS.failed, status: released ? `${approval} ${policyApproval}` : approval }
        : { title: 'Approved, paying…', color: COLORS.working, status: `${approval} Paying…` }
    case 'executing':
      return { title: 'Approved, paying…', color: COLORS.working, status: `${approval} Paying…` }
    case 'paid': {
      const when = run.paidAt ? ` ${relativeTime(run.paidAt)}` : ''
      const tx = run.paidTxHash ? `\n${txUrl(ctx.network, run.paidTxHash)}` : ''
      if (released) return { title: 'Paid', color: COLORS.paid, status: `Paid on autopilot after the veto window${when}; no veto. ${policyApproval}${tx}` }
      return { title: 'Paid', color: COLORS.paid, status: `Paid in one transaction${when}. Approved by ${approvedBy}.${tx}` }
    }
    case 'failed':
      return { title: 'Payment failed', color: COLORS.failed, status: run.failure ? explainFailure(run.failure, { showDetail: ctx.showDetail ?? false }) : 'The payment failed.' }
    case 'cancelled':
      return { title: 'Cancelled', color: COLORS.muted, status: `Cancelled by ${run.cancelledBy ? mention(run.cancelledBy) : 'an admin'}.` }
  }
}

const RELEASED = 'Released on autopilot after the veto window; no veto.'

/** "Policy approved by @A (version 2)." and, when someone else switched autopilot on (the run is approved in their name), who. */
function policyApprovalText(r: AutopilotRelease, autopilotBy: string | null): string {
  const policy = r.policyApprovedBy ? `Policy approved by ${mention(r.policyApprovedBy)} (version ${r.version}).` : `Policy version ${r.version}.`
  return autopilotBy && autopilotBy !== r.policyApprovedBy ? `${policy} Autopilot switched on by ${mention(autopilotBy)}.` : policy
}

function buttonsFor(run: Run, ctx: RunViewContext): Button[] {
  const action = (a: RunAction, label: string, style: 1 | 3 | 4): Button => ({ type: ComponentType.Button, style, label, custom_id: encodeCustomId(a, run.id) })
  if (ctx.paying && run.status !== 'paid') return []
  if (ctx.autopilot && !ctx.autopilot.stopped && run.status === 'pending_approval') {
    return [{ type: ComponentType.Button, style: ButtonStyle.Danger, label: 'Veto', custom_id: encodeVetoButton(ctx.autopilot.policyRunId) }]
  }
  switch (run.status) {
    case 'draft':
    case 'pending_approval':
      return [action('approve', 'Approve and pay', ButtonStyle.Success), action('cancel', 'Cancel', ButtonStyle.Danger)]
    case 'approved':
      return ctx.problem ? [action('retry', 'Retry', ButtonStyle.Primary), action('cancel', 'Cancel', ButtonStyle.Danger)] : []
    case 'failed':
      return run.failure?.retryable ? [action('retry', 'Retry', ButtonStyle.Primary), action('cancel', 'Cancel', ButtonStyle.Danger)] : []
    case 'paid':
      return run.paidTxHash ? [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'View transaction', url: txUrl(ctx.network, run.paidTxHash) }] : []
    default:
      return []
  }
}

function receiptsText(r: NonNullable<RunViewContext['receipts']>): string {
  if (r === 'sending') return 'Sending receipts by DM…'
  if (r.sent === r.total) return r.total === 1 ? 'Sent by DM to 1 person.' : `Sent by DM to all ${r.total} people.`
  const missed = r.total - r.sent
  return `Sent by DM to ${r.sent} of ${count(r.total, 'person', 'people')} (${missed} ${missed === 1 ? 'does' : 'do'} not accept DMs from this server).`
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000)

const rows = (buttons: Button[]): ActionRow[] => (buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : [])

/** "1. @ana  5 AlphaUSD → 5 BetaUSD (swapped)  ·  0x1111…1111" for a line paid in the payee's preferred stablecoin. */
const lineText = (l: RunLine, token: string) =>
  `${l.line}. ${mention(l.payeeDiscordId)}  ${money(l.amount, token)}${l.swap ? ` → ${money(l.amount, l.swap.token)} (swapped)` : ''}  ·  ${shortAddress(l.address)}`

/** For a run with swapped lines: how many, and the most the swaps may spend (the batch reverts whole past it). */
function swapsText(run: Run): string | null {
  const swapped = run.lines.filter((l) => l.swap)
  if (swapped.length === 0) return null
  const max = swapLegs(run.lines).reduce((s, l) => s + l.maxIn, 0n)
  const who = swapped.length === 1 ? '1 line is' : `${swapped.length} lines are`
  return `${who} paid in another stablecoin, as the payee chose. In the same transaction, Tempo's stablecoin exchange swaps at most ${money(max, run.token)} for ${swapped.length === 1 ? 'it' : 'them'}; past that the whole run reverts and nobody is paid.`
}
