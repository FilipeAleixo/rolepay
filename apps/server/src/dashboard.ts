import type { KeyValueStore } from '@rolepay/core'
import { type DiscordRest, confirmTreasuryChannel, readTextChannels } from '@rolepay/discord'
import {
  type AiUsagePort,
  type AuditPort,
  type DashboardDeps,
  type DiscordOAuth,
  FetchDiscordOAuth,
  type GuildChannels,
  type GuildMembers,
  type PayoutsPort,
  type PolicyKeysPort,
  type PolicyPort,
} from '@rolepay/web'
import type { ServerConfig } from './config.js'

/** The bot's view of guild members for the dashboard: Get Guild Member as the bot (no privileged intent). */
export const restGuildMembers = (rest: Pick<DiscordRest, 'getMember'>): GuildMembers => ({
  async member(guildId, userId) {
    const m = await rest.getMember(guildId, userId)
    return m ? { roles: m.roles, name: m.name } : null
  },
})

/**
 * The server's text channels and Rolepay's confirmation in one, for the dashboard's treasury channel
 * setting, as the bot (no privileged intent): whether @everyone can see each comes from the @everyone
 * role and the channel's overwrite for it. A channel Rolepay cannot post in (no access, no permission
 * to send messages, deleted) is `cannot_post`; anything else Discord answers is `unavailable`.
 */
export const restGuildChannels = (rest: Pick<DiscordRest, 'getGuildChannels' | 'getGuildRoles' | 'postToChannel'>): GuildChannels => ({
  textChannels: (guildId) => readTextChannels(rest, guildId, { visibility: true }),
  async confirm(channelId) {
    const posted = await confirmTreasuryChannel(rest, channelId)
    if (posted.ok) return { ok: true, value: undefined }
    return { ok: false, error: { code: posted.error.code === 'forbidden' || posted.error.code === 'not_found' ? 'cannot_post' : 'unavailable' } }
  },
})

/** What a composition root (or a test) may hand the dashboard instead of the defaults. */
export type DashboardOverrides = {
  /** Default: Discord's OAuth2 when ROLEPAY_DISCORD_CLIENT_SECRET is set, else null (sign-in not configured). */
  oauth?: DiscordOAuth | null
  /** Default: the bot's REST client. */
  members?: GuildMembers
  /**
   * THE POLICY SEAM. main.ts passes the adapters over core's policy services and audit stream
   * (`policyPortFromCore(rolepay)`, `auditPortFromCore(rolepay)` in policySeam.ts; see
   * docs/ARCHITECTURE.md, "The policy seam"). Absent: the Policies and Audit pages say they are
   * not available. Page tests may pass `InMemoryPolicies` from `@rolepay/web/testing` instead.
   */
  policies?: PolicyPort
  audit?: AuditPort
  /** The AI spend (`aiUsagePortFromCore(rolepay)` in policySeam.ts). Absent: the pages leave it out. */
  aiUsage?: AiUsagePort
  /** What was paid each week (`payoutsPortFromCore(rolepay)` in policySeam.ts). Absent: the Overview leaves that chart out. */
  payouts?: PayoutsPort
  /** Policies' own budgets (`policyKeysPortFromCore(rolepay)` in policySeam.ts). Absent: a policy's page leaves its budget out. */
  policyKeys?: PolicyKeysPort
  /** Default: the bot's REST client (`restGuildChannels`). */
  channels?: GuildChannels
}

/** The dashboard's dependencies: sessions in the server's KeyValueStore, the bot's member and channel views, Discord OAuth2 from config. */
export function dashboardDeps(opts: {
  config: ServerConfig
  rest: Pick<DiscordRest, 'getMember' | 'getGuildChannels' | 'getGuildRoles' | 'postToChannel'>
  kv: KeyValueStore
  overrides?: DashboardOverrides
  onError: (error: unknown) => void
}): DashboardDeps {
  const { clientId, clientSecret } = opts.config.dashboard
  const o = opts.overrides ?? {}
  return {
    kv: opts.kv,
    oauth: o.oauth !== undefined ? o.oauth : clientSecret ? new FetchDiscordOAuth({ clientId, clientSecret }) : null,
    members: o.members ?? restGuildMembers(opts.rest),
    ...(o.policies ? { policies: o.policies } : {}),
    ...(o.audit ? { audit: o.audit } : {}),
    ...(o.aiUsage ? { aiUsage: o.aiUsage } : {}),
    ...(o.payouts ? { payouts: o.payouts } : {}),
    ...(o.policyKeys ? { policyKeys: o.policyKeys } : {}),
    channels: o.channels ?? restGuildChannels(opts.rest),
    onError: opts.onError,
  }
}
