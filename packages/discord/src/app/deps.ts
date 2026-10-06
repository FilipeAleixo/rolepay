import type { Clock, NetworkName, Payrun } from '@payrun/core'
import type { DiscordRest, ExecutionQueue, MemberDirectory } from '../ports.js'

/** Operational settings for the Discord layer (the server builds these from env). */
export type DiscordAppConfig = {
  network: NetworkName
  /** `/payee link` replies with `${claimBaseUrl}/${token}`. The claim page itself lives elsewhere. */
  claimBaseUrl: string
  /** `/payrun setup` hands the treasurer `${setupBaseUrl}/${token}`: the treasury page. */
  setupBaseUrl: string
  /** The fee token when `/payrun setup fees:fee_budget` names none (pathUSD on testnet). null = it must be named. */
  defaultFeeToken: string | null
  /** Payout token for a community registered without an explicit `token` option. */
  defaultPayoutToken: string
  /** The bot key `/payrun setup` provisions when the community has none. */
  botKey: { limit: bigint; periodSeconds: number; validitySeconds: number }
  /** A second way to authorise a pending key, shown in /payrun setup (the dev script on testnet). `{guildId}` is filled in. */
  authorizeHint: string | null
}

/** Everything the interaction handlers use. Core is reached only through its services. */
export type DiscordAppDeps = {
  payrun: Payrun
  rest: DiscordRest
  queue: ExecutionQueue
  members: MemberDirectory
  clock: Clock
  config: DiscordAppConfig
  onError?: (error: unknown) => void
}
