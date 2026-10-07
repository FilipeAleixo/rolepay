import { DiscordIdSchema, PROPOSAL_LIMITS } from '@rolepay/core'
import { z } from 'zod'
import { type CommandHandler, parseOptions } from '../app/handlers.js'
import { type DeferredResult, ephemeralReply } from '../app/outcome.js'
import { canReadHistory } from '../app/permissions.js'
import { explainProposalError } from '../views/errors.js'
import { proposalMessage } from '../views/proposal.js'
import { requireProposer } from './guards.js'

const ProposeOptions = z.object({
  instruction: z.string().trim().min(1).max(PROPOSAL_LIMITS.maxInstructionLength),
  source: DiscordIdSchema.optional(),
  since: z
    .string()
    .trim()
    .regex(/^\d{1,3}\s*[hdw]$/i, 'write it like 24h, 7d or 2w')
    .optional(),
})

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const
const DEFAULT_SINCE_MS = 7 * UNIT_MS.d

/**
 * /payrun propose instruction:"..." [source:#channel] [since:7d]. With `source` the AI reads that
 * channel's or thread's recent messages (message mode: needs the Message Content intent); without
 * it the AI turns the instruction into a filter that payrun runs over registered payees (criteria
 * mode). Either way the answer is a proposal, only for the caller, with Create, Edit and Discard.
 * Deferred: reading history and the model take longer than Discord's 3 seconds.
 */
export const proposeCommand: CommandHandler = async ({ options, ctx, channels }, { rolepay, clock }) => {
  const guard = await requireProposer(ctx, rolepay, { ai: true })
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(ProposeOptions, options)
  if (!parsed.ok) return parsed.reply
  const o = parsed.value
  if (o.since && !o.source) return ephemeralReply('`since` goes with `source`: it says how far back to read that channel.')
  // The bot may read more than the caller: never propose from a channel the caller cannot read themselves.
  if (o.source && !canReadHistory(channels?.[o.source]?.permissions)) return ephemeralReply(explainProposalError({ code: 'source_not_readable' }))
  const community = guard.community
  const who = { guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles }
  const sinceMs = o.since ? Number.parseInt(o.since, 10) * UNIT_MS[o.since.slice(-1).toLowerCase() as keyof typeof UNIT_MS] : DEFAULT_SINCE_MS
  return {
    kind: 'defer',
    ephemeral: true,
    work: async (): Promise<DeferredResult> => {
      const proposed = o.source
        ? await rolepay.proposals.proposeFromMessages({
            ...who,
            instruction: o.instruction,
            source: { kind: 'history', channelId: o.source, since: new Date(clock.now().getTime() - sinceMs) },
          })
        : await rolepay.proposals.proposeFromCriteria({ ...who, instruction: o.instruction })
      if (!proposed.ok) return { ok: false, message: { content: explainProposalError(proposed.error, { community, token: community.payoutToken }) } }
      return { ok: true, message: proposalMessage(proposed.value, { approverRoleId: community.approverRoleId }) }
    },
  }
}
