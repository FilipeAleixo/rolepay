import { AddressSchema, type Community, DiscordIdSchema, FeeModeSchema, parseAmount } from '@payrun/core'
import { z } from 'zod'
import { type DiscordAppDeps, devShortcutsOn } from '../app/deps.js'
import { type CommandHandler, type GuildContext, parseOptions } from '../app/handlers.js'
import { type DeferredResult, ephemeralReply } from '../app/outcome.js'
import { canManageGuild } from '../app/permissions.js'
import { explainError } from '../views/errors.js'
import { roleMention, shortAddress } from '../views/format.js'
import { type SetupLinkView, firstSetupMessage, setupMessage } from '../views/setup.js'

const SetupOptions = z.object({
  approver_role: DiscordIdSchema.optional(),
  fees: FeeModeSchema.optional(),
  fee_token: AddressSchema.optional(),
  token: AddressSchema.optional(),
  treasury: AddressSchema.optional(),
  key_limit: z.string().optional(),
  new_key: z.boolean().optional(),
})
type Options = z.infer<typeof SetupOptions>
type Fees = { feeMode: 'sponsor' | 'fee_budget'; feeToken: string | null }

const fail = (content: string): DeferredResult => ({ ok: false, message: { content } })

/** A fee budget for a key issued on the dev path in fee_budget mode (1 unit of the fee token per period). */
const DEV_FEE_BUDGET = 1_000_000n

const DEV_SHORTCUTS_OFF =
  '`treasury`, `new_key` and `key_limit` are testnet dev shortcuts, and they are off on this server. Run /payrun setup without them: the treasurer sets up the treasury and the bot key on the treasury page.'

/**
 * /payrun setup (Manage Server). The production path: a member who also holds the approver
 * role gets a short-lived link to the treasury page, where the treasurer's passkey creates
 * the community account (the first time), authorises the bot key or revokes it. The command
 * itself sets the approver role, the fee mode and the server name. Dev path (Moderato with
 * PAYRUN_DEV_SHORTCUTS=true only, and only for a member who holds the approver role): the
 * `treasury` option registers an existing account and `new_key` issues a key here, for
 * `pnpm dev:authorize-key`. Deferred, because the key status is read from the chain.
 */
export const setupCommand: CommandHandler = async ({ options, ctx }, deps) => {
  if (!canManageGuild(ctx.caller)) return ephemeralReply('Only members with Manage Server can run /payrun setup.')
  const parsed = parseOptions(SetupOptions, options)
  if (!parsed.ok) return parsed.reply
  const o = parsed.value
  const dev = o.treasury !== undefined || o.new_key !== undefined || o.key_limit !== undefined
  if (dev && !devShortcutsOn(deps.config)) return ephemeralReply(DEV_SHORTCUTS_OFF)
  let limit = deps.config.botKey.limit
  if (o.key_limit !== undefined) {
    const l = parseAmount(o.key_limit)
    if (!l.ok) return ephemeralReply(`key_limit: "${o.key_limit}" is not an amount (${l.error.code}).`)
    limit = l.value
  }
  return { kind: 'defer', ephemeral: true, work: () => runSetup(o, limit, ctx, deps) }
}

async function runSetup(o: Options, limit: bigint, ctx: GuildContext, deps: DiscordAppDeps): Promise<DeferredResult> {
  const { payrun, config, clock } = deps
  const guildId = ctx.guildId
  const notices: string[] = []
  // Interactions carry no guild name; the bot reads it (no intent needed). Best effort.
  const guildName = await deps.rest.getGuild(guildId).then(
    (g) => g?.name.slice(0, 100) ?? null,
    () => null,
  )
  const fees: Fees | null = o.fees ? { feeMode: o.fees, feeToken: o.fees === 'fee_budget' ? (o.fee_token ?? config.defaultFeeToken) : null } : null
  if (fees?.feeMode === 'fee_budget' && !fees.feeToken) return fail('fees:fee_budget needs `fee_token`: the token the bot pays network fees in.')

  let community = await payrun.communities.get(guildId)
  if (!community.ok) {
    if (!o.treasury) return firstSetup(o, fees, guildName, ctx, deps)
    // Dev path: register an existing treasury account (its root key signs elsewhere). The same
    // rule as the treasury page link: Manage Server AND the approver role being set.
    const role = chosenRole(o, ctx)
    if (!('roleId' in role)) return role
    const registered = await payrun.communities.register({
      guildId,
      name: guildName,
      treasuryAddress: o.treasury,
      payoutToken: o.token ?? config.defaultPayoutToken,
      feeMode: fees?.feeMode ?? 'sponsor',
      feeToken: fees?.feeToken ?? null,
      approverRoleId: role.roleId,
    })
    if (!registered.ok) return fail(explainError(registered.error))
    community = registered
  } else {
    if (o.treasury && o.treasury !== community.value.treasuryAddress) {
      notices.push(`The treasury cannot be changed once registered (it is ${shortAddress(community.value.treasuryAddress)}).`)
    }
    if (o.token && o.token !== community.value.payoutToken) notices.push('The payout token cannot be changed once registered.')
    if (guildName && guildName !== community.value.name) {
      const renamed = await payrun.communities.setName({ guildId, name: guildName })
      if (renamed.ok) community = renamed
    }
    if (o.approver_role && o.approver_role !== community.value.approverRoleId) {
      const updated = await payrun.communities.setApproverRole({ guildId, approverRoleId: o.approver_role })
      if (!updated.ok) return fail(explainError(updated.error))
      community = updated
    }
    if (fees && (fees.feeMode !== community.value.feeMode || fees.feeToken !== community.value.feeToken)) {
      const switched = await payrun.communities.setFeeMode({ guildId, ...fees })
      if (!switched.ok) return fail(explainError(switched.error))
      community = { ok: true, value: switched.value.community }
      if (switched.value.keyNeedsFeeBudget) {
        notices.push('The bot key has no fee budget for this: authorise a new bot key on the treasury page (with a fee budget) before the next run.')
      }
    }
  }

  // Dev path only: issue a key here for `pnpm dev:authorize-key`. On the treasury page the treasurer chooses its limits.
  let key = await payrun.communities.keyStatus({ guildId })
  const unusable = !key.ok || key.value.key.status === 'revoked' || key.value.state.status === 'revoked' || key.value.state.status === 'expired'
  if (o.new_key || (o.treasury && unusable)) {
    if (!isTreasurer(ctx, community.value)) {
      const role = community.value.approverRoleId
      return fail(`Only a member with ${role ? roleMention(role) : 'the approver role'} can issue a bot key here.`)
    }
    const provisioned = await payrun.communities.provisionBotKey({
      guildId,
      limit,
      periodSeconds: config.botKey.periodSeconds,
      expiresAt: Math.floor(clock.now().getTime() / 1000) + config.botKey.validitySeconds,
      ...(community.value.feeMode === 'fee_budget' ? { feeBudget: DEV_FEE_BUDGET } : {}),
    })
    if (!provisioned.ok) return fail(explainError(provisioned.error))
    key = await payrun.communities.keyStatus({ guildId })
  }

  const link = isTreasurer(ctx, community.value) ? await issueLink(community.value, ctx, deps) : null
  return {
    ok: true,
    message: setupMessage({
      community: community.value,
      key: key.ok ? key.value : null,
      notices,
      setupLink: link,
      authorizeHint: config.authorizeHint?.replaceAll('{guildId}', guildId) ?? null,
      network: config.network,
    }),
  }
}

/** First setup: the caller names the approver role and holds it (a treasurer with Manage Server). */
function chosenRole(o: Options, ctx: GuildContext): { ok: true; roleId: string } | DeferredResult {
  if (!o.approver_role) {
    return fail(
      'The first /payrun setup needs `approver_role`: the role that approves pay runs (the Treasurer). A member with Manage Server who holds it gets the treasury page link.',
    )
  }
  if (!ctx.caller.roles.includes(o.approver_role)) {
    return fail(
      `The treasury page link goes to a member with Manage Server who also holds ${roleMention(o.approver_role)}. Give yourself the role, or ask a treasurer to run /payrun setup.`,
    )
  }
  return { ok: true, roleId: o.approver_role }
}

/** Nothing is registered yet: the treasury does not exist until the treasurer creates it on the page. */
async function firstSetup(o: Options, fees: Fees | null, guildName: string | null, ctx: GuildContext, deps: DiscordAppDeps): Promise<DeferredResult> {
  const role = chosenRole(o, ctx)
  if (!('roleId' in role)) return role
  const settings = {
    name: guildName,
    payoutToken: o.token ?? deps.config.defaultPayoutToken,
    feeMode: fees?.feeMode ?? ('sponsor' as const),
    feeToken: fees?.feeToken ?? null,
    approverRoleId: role.roleId,
  }
  const link = await deps.payrun.communities.issueSetupLink({ guildId: ctx.guildId, discordUserId: ctx.caller.userId, settings })
  if (!link.ok) return fail(explainError(link.error))
  return { ok: true, message: firstSetupMessage({ settings, setupLink: { url: setupUrl(deps, link.value.token), expiresAt: link.value.expiresAt } }) }
}

const isTreasurer = (ctx: GuildContext, c: Community) => c.approverRoleId !== null && ctx.caller.roles.includes(c.approverRoleId)

async function issueLink(c: Community, ctx: GuildContext, deps: DiscordAppDeps): Promise<SetupLinkView | null> {
  const link = await deps.payrun.communities.issueSetupLink({
    guildId: c.id,
    discordUserId: ctx.caller.userId,
    settings: { name: c.name, payoutToken: c.payoutToken, feeMode: c.feeMode, feeToken: c.feeToken, approverRoleId: c.approverRoleId },
  })
  return link.ok ? { url: setupUrl(deps, link.value.token), expiresAt: link.value.expiresAt } : null
}

const setupUrl = (deps: DiscordAppDeps, token: string) => `${deps.config.setupBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(token)}`
