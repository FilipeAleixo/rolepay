import type { Clock, NetworkName, Rolepay } from '@rolepay/core'
import type { DiscordRest, ExecutionQueue, MemberDirectory, PendingSources, PolicyAnnouncer } from '../ports.js'

/** Operational settings for the Discord layer (the server builds these from env). */
export type DiscordAppConfig = {
  network: NetworkName
  /** `/payee link` replies with `${claimBaseUrl}/${token}`. The claim page itself lives elsewhere. */
  claimBaseUrl: string
  /** `/rolepay setup` hands the treasurer `${setupBaseUrl}/${token}`: the treasury page. */
  setupBaseUrl: string
  /** The fee token when `/rolepay setup fees:fee_budget` names none (pathUSD on testnet). null = it must be named. */
  defaultFeeToken: string | null
  /** Payout token for a community registered without an explicit `token` option. */
  defaultPayoutToken: string
  /** The bot key `/rolepay setup` provisions when the community has none. */
  botKey: { limit: bigint; periodSeconds: number; validitySeconds: number }
  /** A second way to authorise a pending key, shown in /rolepay setup (the dev script on testnet). `{guildId}` is filled in. */
  authorizeHint: string | null
  /**
   * The testnet dev shortcuts (`/rolepay setup treasury:`, `new_key`, `key_limit`). Honoured only
   * on Moderato: on any other network they do not exist, whatever this says.
   */
  devShortcuts: boolean
  /**
   * The demo controls for standing policies (`/rolepay policy run_now`, `veto_minutes`), still for
   * the approver role only. Separate from the dev shortcuts, so a public demo can have them without
   * the treasury and key shortcuts. Honoured only on Moderato.
   */
  demoControls: boolean
}

/** Whether the dev shortcuts exist here: the flag is on AND the network is the Moderato testnet. */
export const devShortcutsOn = (c: Pick<DiscordAppConfig, 'devShortcuts' | 'network'>) => c.devShortcuts && c.network === 'moderato'

/** Whether the demo controls exist here: the flag is on AND the network is the Moderato testnet. */
export const demoControlsOn = (c: Pick<DiscordAppConfig, 'demoControls' | 'network'>) => c.demoControls && c.network === 'moderato'

/** Everything the interaction handlers use. Core is reached only through its services. */
export type DiscordAppDeps = {
  rolepay: Rolepay
  rest: DiscordRest
  queue: ExecutionQueue
  members: MemberDirectory
  /** The message-command target between the command and its instruction modal. */
  pendingSources: PendingSources
  clock: Clock
  config: DiscordAppConfig
  /** Posts what the policy scheduler did (used by the demo control that makes a run now). */
  announcer?: PolicyAnnouncer
  onError?: (error: unknown) => void
}
