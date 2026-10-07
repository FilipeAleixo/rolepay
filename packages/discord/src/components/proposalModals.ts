import { type Result, err, ok, parseLooseAmount } from '@rolepay/core'
import type { ModalHandler } from '../app/handlers.js'
import { type DeferredResult, ephemeralReply } from '../app/outcome.js'
import { requireProposer } from '../commands/guards.js'
import { explainProposalError } from '../views/errors.js'
import { DRAFTING, proposalMessage } from '../views/proposal.js'

/**
 * The instruction for a "Draft pay run with AI" message command. The target message was kept when the
 * command opened this modal; the AI reads it (as untrusted data) and the proposal comes back
 * only for the caller. Deferred: the model takes longer than 3 seconds.
 */
export const instructionModalSubmit: ModalHandler = async ({ id: messageId, fields, ctx }, { rolepay, pendingSources }) => {
  const guard = await requireProposer(ctx, rolepay, { ai: true })
  if (!guard.ok) return guard.reply
  const target = await pendingSources.take({ userId: ctx.caller.userId, messageId })
  if (!target) return ephemeralReply('That form expired. Right-click the message again and use Apps > Draft pay run with AI.')
  const community = guard.community
  const instruction = (fields.instruction ?? '').trim()
  return {
    kind: 'defer',
    ephemeral: true,
    placeholder: DRAFTING.message,
    work: async (): Promise<DeferredResult> => {
      const proposed = await rolepay.proposals.proposeFromMessages({
        guildId: ctx.guildId,
        actor: ctx.caller.userId,
        actorRoleIds: ctx.caller.roles,
        instruction,
        source: { kind: 'messages', channelId: target.channelId, messages: [target] },
      })
      if (!proposed.ok) return { ok: false, message: { content: explainProposalError(proposed.error, { community, token: community.payoutToken }) } }
      return { ok: true, message: proposalMessage(proposed.value, { approverRoleId: community.approverRoleId }) }
    },
  }
}

const LINE = /^(?:<@!?(\d{17,20})>|@?(\d{17,20}))\s*[=:]\s*(\S+)$/

/**
 * The Edit modal's text: one `@user=amount` per line, `#` starts a comment. Mentions typed in a
 * modal stay as text, so `<@id>`, `@id` and a bare ID all work (the prefilled lines use `<@id>`).
 */
export function parseEditLines(text: string): Result<{ discordUserId: string; amount: bigint }[], { code: 'invalid_input'; issues: string[] }> {
  const lines: { discordUserId: string; amount: bigint }[] = []
  const issues: string[] = []
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = LINE.exec(line)
    if (!m) {
      issues.push(`line ${i + 1}: write it as @user=amount`)
      continue
    }
    const amount = parseLooseAmount(m[3] as string)
    if (!amount.ok) {
      issues.push(`line ${i + 1}: "${m[3]}" is not an amount`)
      continue
    }
    lines.push({ discordUserId: (m[1] ?? m[2]) as string, amount: amount.value })
  }
  return issues.length ? err({ code: 'invalid_input', issues: issues.slice(0, 10) }) : ok(lines)
}

/** Edit: the lines become exactly what was typed; the proposal message is updated in place. */
export const editModalSubmit: ModalHandler = async ({ id: proposalId, fields, ctx }, { rolepay }) => {
  const guard = await requireProposer(ctx, rolepay, { ai: false })
  if (!guard.ok) return guard.reply
  const parsed = parseEditLines(fields.lines ?? '')
  if (!parsed.ok) return ephemeralReply(explainProposalError(parsed.error))
  const edited = await rolepay.proposals.edit({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, proposalId, lines: parsed.value })
  if (!edited.ok) return ephemeralReply(explainProposalError(edited.error, { community: guard.community }))
  return { kind: 'update', message: proposalMessage(edited.value, { approverRoleId: guard.community.approverRoleId }) }
}
