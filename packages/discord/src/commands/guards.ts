import type { Community, Payrun } from '@payrun/core'
import { type GuildContext, replyError } from '../app/handlers.js'
import { type Outcome, ephemeralReply } from '../app/outcome.js'
import { canOperate } from '../app/permissions.js'

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
