import { type Community, type Payrun, canPropose } from '@payrun/core'
import { type GuildContext, replyError } from '../app/handlers.js'
import { type Outcome, ephemeralReply } from '../app/outcome.js'
import { canOperate } from '../app/permissions.js'
import { AI_NOT_CONFIGURED, AI_OFF, proposerOnly } from '../views/errors.js'

/** The community, if the caller may operate it (create runs, read status, export). */
export async function requireOperator(
  ctx: GuildContext,
  payrun: Payrun,
  action: string,
): Promise<{ ok: true; community: Community } | { ok: false; reply: Outcome }> {
  const community = await payrun.communities.get(ctx.guildId)
  if (!community.ok) return { ok: false, reply: replyError(community.error) }
  if (!canOperate(ctx.caller, community.value)) return { ok: false, reply: ephemeralReply(`${action} needs Manage Server or the approver role.`) }
  return { ok: true, community: community.value }
}

/**
 * The community, if the caller may propose pay runs with AI: the approver role or the community's
 * proposer role, from the roles Discord signed into this interaction (core checks again). With
 * `ai`, the server must have a model and the community must have AI proposals switched on; Edit,
 * Discard and Create on an existing proposal call no model and need neither.
 */
export async function requireProposer(
  ctx: GuildContext,
  payrun: Payrun,
  opts: { ai: boolean },
): Promise<{ ok: true; community: Community } | { ok: false; reply: Outcome }> {
  if (opts.ai && !payrun.proposals.isConfigured()) return { ok: false, reply: ephemeralReply(AI_NOT_CONFIGURED) }
  const community = await payrun.communities.get(ctx.guildId)
  if (!community.ok) return { ok: false, reply: replyError(community.error) }
  if (!canPropose(community.value, ctx.caller.roles)) return { ok: false, reply: ephemeralReply(proposerOnly(community.value)) }
  if (opts.ai && !community.value.aiProposals) return { ok: false, reply: ephemeralReply(AI_OFF) }
  return { ok: true, community: community.value }
}
