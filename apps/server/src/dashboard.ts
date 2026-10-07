import type { KeyValueStore } from '@rolepay/core'
import type { DiscordRest } from '@rolepay/discord'
import { type AuditPort, type DashboardDeps, type DiscordOAuth, FetchDiscordOAuth, type GuildMembers, type PolicyPort } from '@rolepay/web'
import type { ServerConfig } from './config.js'

/** The bot's view of guild members for the dashboard: Get Guild Member as the bot (no privileged intent). */
export const restGuildMembers = (rest: Pick<DiscordRest, 'getMember'>): GuildMembers => ({
  async member(guildId, userId) {
    const m = await rest.getMember(guildId, userId)
    return m ? { roles: m.roles, name: m.name } : null
  },
})

/** What a composition root (or a test) may hand the dashboard instead of the defaults. */
export type DashboardOverrides = {
  /** Default: Discord's OAuth2 when ROLEPAY_DISCORD_CLIENT_SECRET is set, else null (sign-in not configured). */
  oauth?: DiscordOAuth | null
  /** Default: the bot's REST client. */
  members?: GuildMembers
  /**
   * THE POLICY SEAM. Absent: the Policies and Audit pages say they are not available. Once core's
   * policy services are on this branch, main.ts passes thin adapters over them here:
   * `policies: policyPortFromCore(rolepay)` and `audit: auditPortFromCore(rolepay)` (see
   * docs/ARCHITECTURE.md, "The policy seam"). Tests pass `InMemoryPolicies` from `@rolepay/web/testing`.
   */
  policies?: PolicyPort
  audit?: AuditPort
}

/** The dashboard's dependencies: sessions in the server's KeyValueStore, the bot's member view, Discord OAuth2 from config. */
export function dashboardDeps(opts: {
  config: ServerConfig
  rest: Pick<DiscordRest, 'getMember'>
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
    onError: opts.onError,
  }
}
