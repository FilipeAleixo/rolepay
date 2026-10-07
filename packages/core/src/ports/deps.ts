import type { NetworkName } from '../constants/tempo.js'
import type { Clock } from './clock.js'
import type { IdGenerator } from './idGenerator.js'
import type { KeyVault } from './keyVault.js'
import type { PayoutChain } from './payoutChain.js'
import type { ActivityReader } from './activityReader.js'
import type { ProposalLog } from './proposalLog.js'
import type { AuditLog, CommunityRepository, PayeeRepository, PolicyRepository, PolicyRunRepository, ProposalRepository, RunRepository } from './repositories.js'
import type { RunProposer } from './runProposer.js'

/** Everything `createRolepay` needs: one implementation of each port. */
export type RolepayDeps = {
  chain: PayoutChain
  repositories: {
    communities: CommunityRepository
    payees: PayeeRepository
    runs: RunRepository
    proposals: ProposalRepository
    policies: PolicyRepository
    policyRuns: PolicyRunRepository
    audit: AuditLog
  }
  vault: KeyVault
  ids: IdGenerator
  clock: Clock
  network: NetworkName
  /** How long a `/payee link` stays valid. Default 30 minutes. */
  linkTtlSeconds?: number
  /** AI proposals: the model. Without it (no ANTHROPIC_API_KEY) proposing answers `ai_not_configured`. */
  proposer?: RunProposer | null
  /** AI proposals: Discord channel history, members and reactions (`@rolepay/discord`). */
  activity?: ActivityReader | null
  /** One line per proposal: counts, latency, cost. */
  proposalLog?: ProposalLog
  /** Standing policies: the shortest veto window, in minutes (default 60; the testnet dev setting lowers it for manual tests). */
  minVetoMinutes?: number
  /** A pay run's audit event could not be written (it never fails the payment): for the server's log. */
  onAuditError?: (error: unknown) => void
}
