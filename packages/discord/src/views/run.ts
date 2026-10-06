import type { Failure, NetworkName, Run, RunLine } from '@payrun/core'
import { type ActionRow, type Button, ButtonStyle, ComponentType, type Embed, type Message } from '../api.js'
import { type RunAction, encodeCustomId } from '../components/customId.js'
import { COLORS, NO_PINGS, mention, money, relativeTime, roleMention, shortAddress, txUrl } from './format.js'

export type RunViewContext = {
  network: NetworkName
  /** Shown on a run awaiting approval: who may approve it. */
  approverRoleId?: string | null
  /** Why an approved run has not been paid yet (a pre-flight failure such as a revoked key). */
  problem?: string
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
  if (ctx.problem && run.status === 'approved') fields.push({ name: 'Not paid yet', value: ctx.problem })
  const embed: Embed = {
    title: head.title,
    color: head.color,
    description: [run.note ? `**${run.note}**` : null, ...run.lines.map((l) => lineText(l, run.token))].filter(Boolean).join('\n'),
    fields,
    footer: { text: `Run ${run.id}` },
  }
  return { embeds: [embed], components: rows(buttonsFor(run, ctx)), allowed_mentions: NO_PINGS }
}

/** The DM a payee gets once their line is paid. */
export function receiptDm(run: Run, line: RunLine, ctx: { network: NetworkName; communityName: string | null }): Message {
  const tx = run.paidTxHash
  const embed: Embed = {
    title: `You were paid ${money(line.amount, run.token)}`,
    color: COLORS.paid,
    description: [`From **${ctx.communityName ?? 'your Discord server'}**, through payrun on Tempo.`, run.note ? `Note: ${run.note}` : null]
      .filter(Boolean)
      .join('\n'),
    fields: [
      { name: 'To your account', value: shortAddress(line.address), inline: true },
      { name: 'Pay run', value: `${run.id}, line ${line.line}`, inline: true },
      ...(tx ? [{ name: 'Transaction', value: txUrl(ctx.network, tx) }] : []),
    ],
  }
  const link: Button[] = tx ? [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'View transaction', url: txUrl(ctx.network, tx) }] : []
  return { embeds: [embed], components: rows(link), allowed_mentions: NO_PINGS }
}

/** Plain English for why an attempt failed, and whether it is safe to try again. */
export function explainFailure(failure: Failure): string {
  switch (failure.reason) {
    case 'rejected':
      return `The network or the fee sponsor refused the transaction (${failure.detail}). Nothing was paid, so it is safe to retry.`
    case 'reverted':
      return 'The transaction reverted on chain. Nothing was paid, so it is safe to retry once the cause is fixed.'
    case 'not_landed':
      return 'The transaction did not land before its deadline. Nothing was paid, so it is safe to retry.'
    case 'partial_match':
      return `Only some lines show as paid on chain (${failure.detail}). Do not retry: someone needs to check the explorer.`
    case 'transfer_mismatch':
      return `The chain shows transfers that do not match this run (${failure.detail}). Do not retry: someone needs to check the explorer.`
  }
}

// ---- internals ---------------------------------------------------------------

function header(run: Run, ctx: RunViewContext): { title: string; color: number; status: string } {
  const approvedBy = run.approvedBy ? mention(run.approvedBy) : 'the treasurer'
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
        ? { title: 'Approved, not paid yet', color: COLORS.failed, status: `Approved by ${approvedBy}.` }
        : { title: 'Approved, paying…', color: COLORS.working, status: `Approved by ${approvedBy}. Paying…` }
    case 'executing':
      return { title: 'Approved, paying…', color: COLORS.working, status: `Approved by ${approvedBy}. Paying…` }
    case 'paid': {
      const when = run.paidAt ? ` ${relativeTime(run.paidAt)}` : ''
      const tx = run.paidTxHash ? `\n${txUrl(ctx.network, run.paidTxHash)}` : ''
      return { title: 'Paid', color: COLORS.paid, status: `Paid in one transaction${when}. Approved by ${approvedBy}.${tx}` }
    }
    case 'failed':
      return { title: 'Payment failed', color: COLORS.failed, status: run.failure ? explainFailure(run.failure) : 'The payment failed.' }
    case 'cancelled':
      return { title: 'Cancelled', color: COLORS.muted, status: `Cancelled by ${run.cancelledBy ? mention(run.cancelledBy) : 'an admin'}.` }
  }
}

function buttonsFor(run: Run, ctx: RunViewContext): Button[] {
  const action = (a: RunAction, label: string, style: 1 | 3 | 4): Button => ({ type: ComponentType.Button, style, label, custom_id: encodeCustomId(a, run.id) })
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

const rows = (buttons: Button[]): ActionRow[] => (buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : [])

const lineText = (l: RunLine, token: string) => `${l.line}. ${mention(l.payeeDiscordId)}  ${money(l.amount, token)}  ·  ${shortAddress(l.address)}`
