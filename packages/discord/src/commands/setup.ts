import { AddressSchema, DiscordIdSchema, parseAmount } from '@payrun/core'
import { z } from 'zod'
import { type CommandHandler, parseOptions } from '../app/handlers.js'
import { type DeferredResult, ephemeralReply } from '../app/outcome.js'
import { canManageGuild } from '../app/permissions.js'
import { explainError } from '../views/errors.js'
import { shortAddress } from '../views/format.js'
import { setupMessage } from '../views/setup.js'

const SetupOptions = z.object({
  treasury: AddressSchema.optional(),
  approver_role: DiscordIdSchema.optional(),
  token: AddressSchema.optional(),
  key_limit: z.string().optional(),
  new_key: z.boolean().optional(),
})

const fail = (content: string): DeferredResult => ({ ok: false, message: { content } })

/**
 * /payrun setup (Manage Server): register the community, set the approver role, and make
 * sure there is a usable bot key (provisioning one when there is none, it was revoked or
 * it expired, or `new_key` is set). Deferred, because the key status is read from the chain.
 */
export const setupCommand: CommandHandler = async ({ options, ctx }, { payrun, config, clock }) => {
  if (!canManageGuild(ctx.caller)) return ephemeralReply('Only members with Manage Server can run /payrun setup.')
  const parsed = parseOptions(SetupOptions, options)
  if (!parsed.ok) return parsed.reply
  const o = parsed.value
  let limit = config.botKey.limit
  if (o.key_limit !== undefined) {
    const l = parseAmount(o.key_limit)
    if (!l.ok) return ephemeralReply(`key_limit: "${o.key_limit}" is not an amount (${l.error.code}).`)
    limit = l.value
  }
  const guildId = ctx.guildId

  return {
    kind: 'defer',
    ephemeral: true,
    work: async () => {
      const notices: string[] = []
      let community = await payrun.communities.get(guildId)
      if (!community.ok) {
        if (!o.treasury) return fail('The first /payrun setup needs `treasury`: the address of the Tempo account that holds the community funds.')
        const registered = await payrun.communities.register({
          guildId,
          name: null,
          treasuryAddress: o.treasury,
          payoutToken: o.token ?? config.defaultPayoutToken,
          feeMode: 'sponsor',
          approverRoleId: o.approver_role ?? null,
        })
        if (!registered.ok) return fail(explainError(registered.error))
        community = registered
      } else {
        if (o.treasury && o.treasury !== community.value.treasuryAddress) {
          notices.push(`The treasury cannot be changed once registered (it is ${shortAddress(community.value.treasuryAddress)}).`)
        }
        if (o.token && o.token !== community.value.payoutToken) notices.push('The payout token cannot be changed once registered.')
        if (o.approver_role && o.approver_role !== community.value.approverRoleId) {
          const updated = await payrun.communities.setApproverRole({ guildId, approverRoleId: o.approver_role })
          if (!updated.ok) return fail(explainError(updated.error))
          community = updated
        }
      }

      let key = await payrun.communities.keyStatus({ guildId })
      const unusable =
        !key.ok || key.value.key.status === 'revoked' || key.value.state.status === 'revoked' || key.value.state.status === 'expired'
      if (o.new_key || unusable) {
        const provisioned = await payrun.communities.provisionBotKey({
          guildId,
          limit,
          periodSeconds: config.botKey.periodSeconds,
          expiresAt: Math.floor(clock.now().getTime() / 1000) + config.botKey.validitySeconds,
        })
        if (!provisioned.ok) return fail(explainError(provisioned.error))
        key = await payrun.communities.keyStatus({ guildId })
      }

      return {
        ok: true,
        message: setupMessage({ community: community.value, key: key.ok ? key.value : null, notices, authorizeHint: config.authorizeHint, network: config.network }),
      }
    },
  }
}
