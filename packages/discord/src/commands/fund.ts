import { FUNDING_LIMITS } from '@rolepay/core'
import { z } from 'zod'
import { type CommandHandler, parseOptions, replyError } from '../app/handlers.js'
import { ephemeralReply } from '../app/outcome.js'
import { holdsApproverRole } from '../app/permissions.js'
import { roleMention } from '../views/format.js'
import { NOT_SET_UP, fundingListMessage, fundingSourceMessage, nameTakenText } from '../views/funding.js'
import { requireOperator } from './guards.js'

const NewOptions = z.object({ name: z.string().trim().min(1).max(FUNDING_LIMITS.maxNameLength) })

/**
 * /rolepay fund new name: a funding source with its own deposit address (a Tempo virtual address
 * of the treasury). The approver role only, from the roles Discord signed (core checks again). The
 * address is posted in the channel, to share with the funder; refusals are private.
 */
export const fundNewCommand: CommandHandler = async ({ options, ctx }, { rolepay, config }) => {
  const parsed = parseOptions(NewOptions, options)
  if (!parsed.ok) return parsed.reply
  const community = await rolepay.communities.get(ctx.guildId)
  if (!community.ok) return replyError(community.error)
  const c = community.value
  if (!c.approverRoleId) return ephemeralReply('No approver role is set, so nobody can create funding sources yet. An admin runs `/rolepay setup approver_role:@Treasurer`.')
  if (!holdsApproverRole(ctx.caller, c)) return ephemeralReply(`Only members with ${roleMention(c.approverRoleId)} can create funding sources.`)
  const created = await rolepay.funding.createSource({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, name: parsed.value.name })
  if (!created.ok) {
    if (created.error.code === 'name_taken') return ephemeralReply(nameTakenText(created.error.source))
    if (created.error.code === 'not_set_up') return ephemeralReply(NOT_SET_UP)
    if (created.error.code === 'too_many_sources') return ephemeralReply(`This server has as many funding sources as Rolepay keeps (${FUNDING_LIMITS.maxSources}).`)
    if (created.error.code === 'not_permitted') return ephemeralReply(`Only members with ${roleMention(c.approverRoleId)} can create funding sources.`)
    return replyError(created.error)
  }
  return { kind: 'reply', ephemeral: false, message: fundingSourceMessage({ source: created.value, network: config.network, dashboardBaseUrl: config.dashboardBaseUrl ?? null }) }
}

/** /rolepay fund list: every funding source, its address and what it received (admins and treasurers, privately). */
export const fundListCommand: CommandHandler = async ({ ctx }, { rolepay, config }) => {
  const operator = await requireOperator(ctx, rolepay, 'Listing funding sources')
  if (!operator.ok) return operator.reply
  const status = await rolepay.funding.status({ guildId: ctx.guildId })
  if (!status.ok) return replyError(status.error)
  if (!status.value.master) return ephemeralReply(NOT_SET_UP)
  return {
    kind: 'reply',
    ephemeral: true,
    message: fundingListMessage({ sources: status.value.sources, guildId: ctx.guildId, dashboardBaseUrl: config.dashboardBaseUrl ?? null }),
  }
}
