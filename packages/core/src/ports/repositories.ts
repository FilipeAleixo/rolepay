import type { BotKey, Community, SetupLink } from '../domain/community.js'
import type { LinkToken, Payee } from '../domain/payee.js'
import type { AuditEvent, AuditQuery, NewAuditEvent } from '../domain/policy/audit.js'
import type { Policy, PolicyStatus, PolicyVersion } from '../domain/policy/policy.js'
import type { PolicyRun, PolicyRunStatus } from '../domain/policy/policyRun.js'
import type { Proposal } from '../domain/proposal/proposal.js'
import type { Result } from '../domain/result.js'
import type { Run, RunStatus } from '../domain/run.js'

/** Everything is keyed by Discord guild ID (= community ID). */
export interface CommunityRepository {
  get(id: string): Promise<Community | null>
  insert(community: Community): Promise<Result<void, { code: 'already_exists' }>>
  update(community: Community): Promise<void>
  /** Upsert by key address. */
  saveBotKey(key: BotKey): Promise<void>
  getBotKey(address: string): Promise<BotKey | null>
  /** Newest first. */
  listBotKeys(communityId: string): Promise<BotKey[]>
  /** Setup links exist before the community does (no foreign key). */
  insertSetupLink(link: SetupLink): Promise<void>
  getSetupLink(tokenHash: string): Promise<SetupLink | null>
}

export interface PayeeRepository {
  get(communityId: string, discordUserId: string): Promise<Payee | null>
  /** Upsert by (communityId, discordUserId). */
  upsert(payee: Payee): Promise<void>
  list(communityId: string): Promise<Payee[]>
  insertLinkToken(token: LinkToken): Promise<void>
  getLinkToken(tokenHash: string): Promise<LinkToken | null>
  /** Compare-and-set: true only for the one call that consumed an unconsumed token. */
  consumeLinkToken(tokenHash: string, at: Date): Promise<boolean>
}

export interface RunRepository {
  insert(run: Run): Promise<void>
  get(id: string): Promise<Run | null>
  /** Newest first. */
  listByCommunity(communityId: string, opts?: { limit?: number }): Promise<Run[]>
  listByStatus(status: RunStatus): Promise<Run[]>
  /**
   * Compare-and-set on `version`: stores `next` only if the stored run is at
   * `next.version - 1`. This is what stops two workers from executing one run.
   */
  update(next: Run): Promise<'updated' | 'conflict'>
}

/** Proposals are drafts that expire (a day): small records, kept where the key-value records are. */
export interface ProposalRepository {
  get(id: string): Promise<Proposal | null>
  /** Upsert; the record expires at `proposal.expiresAt`. */
  save(proposal: Proposal): Promise<void>
  /** True exactly once per proposal: whoever gets true creates its run. */
  claim(id: string): Promise<boolean>
  /** Gives a claim back after creating the run failed, so it can be tried again. */
  release(id: string): Promise<void>
}

/** Standing policies and their version history. Written only by PolicyService. */
export interface PolicyRepository {
  /** A new policy with its first version, in one write. Throws if the ID exists. */
  insert(policy: Policy, version: PolicyVersion): Promise<void>
  get(id: string): Promise<Policy | null>
  /** Newest first. */
  listByCommunity(communityId: string): Promise<Policy[]>
  /** Every community's policies in one status (the scheduler reads the active ones). */
  listByStatus(status: PolicyStatus): Promise<Policy[]>
  /**
   * Compare-and-set on `rev`: stores `next` only if the stored policy is at `next.rev - 1`. With a
   * `version`, that version row is inserted or replaced in the same write (a new version, an approval).
   */
  update(next: Policy, version?: PolicyVersion): Promise<'updated' | 'conflict'>
  /** Oldest first. */
  listVersions(policyId: string): Promise<PolicyVersion[]>
  getVersion(policyId: string, version: number): Promise<PolicyVersion | null>
}

/** Runs of policies, one per policy per period. Written by the scheduler and by vetoes. */
export interface PolicyRunRepository {
  /**
   * Insert-if-absent on (policyId, periodKey): true only for the one call that created the
   * period's run. A restart, a double tick or a second instance gets false and does nothing.
   */
  claim(run: PolicyRun): Promise<boolean>
  get(id: string): Promise<PolicyRun | null>
  getByPeriod(policyId: string, periodKey: string): Promise<PolicyRun | null>
  /** The policy run that made (or will make) this pay run. */
  getByRunId(runId: string): Promise<PolicyRun | null>
  /** Newest period first. */
  list(communityId: string, opts?: { policyId?: string; statuses?: readonly PolicyRunStatus[]; limit?: number }): Promise<PolicyRun[]>
  /** Across communities (the scheduler's work: generating, scheduled, releasing). */
  listByStatus(statuses: readonly PolicyRunStatus[]): Promise<PolicyRun[]>
  /** Compare-and-set on `rev`, like runs. */
  update(next: PolicyRun): Promise<'updated' | 'conflict'>
}

/** The append-only audit stream. */
export interface AuditLog {
  /** Stores the event and returns it with its sequence number (increasing). */
  append(event: NewAuditEvent): Promise<AuditEvent>
  /** Newest first, filtered (see AuditQuery). */
  query(query: AuditQuery): Promise<AuditEvent[]>
}
