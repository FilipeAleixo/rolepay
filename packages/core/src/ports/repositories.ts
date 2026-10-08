import type { AiUsage, AiUsagePurpose, NewAiUsage } from '../domain/aiUsage.js'
import type { BotKey, Community, SetupLink, TreasuryChannel } from '../domain/community.js'
import type { Deposit, DepositMaster, FundingSource } from '../domain/funding.js'
import type { LinkToken, Payee } from '../domain/payee.js'
import type { AuditEvent, AuditQuery, NewAuditEvent } from '../domain/policy/audit.js'
import type { Policy, PolicyStatus, PolicyVersion } from '../domain/policy/policy.js'
import type { PolicyKey } from '../domain/policy/policyKey.js'
import type { PolicyRun, PolicyRunStatus } from '../domain/policy/policyRun.js'
import type { Proposal } from '../domain/proposal/proposal.js'
import type { Result } from '../domain/result.js'
import type { Run, RunStatus } from '../domain/run.js'

/** Everything is keyed by Discord guild ID (= community ID). */
export interface CommunityRepository {
  get(id: string): Promise<Community | null>
  insert(community: Community): Promise<Result<void, { code: 'already_exists' }>>
  /** Every setting but the treasury channel, which only `setTreasuryChannel` changes. */
  update(community: Community): Promise<void>
  /**
   * Sets the treasury channel. With `expected`, only while the stored setting is still exactly that
   * (a compare-and-set, so a channel Rolepay found by its name never overwrites a Treasurer's choice
   * made in between): false when it was not.
   */
  setTreasuryChannel(communityId: string, next: TreasuryChannel & { at: Date }, expected?: TreasuryChannel): Promise<boolean>
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
  /** Every registration of this address, across communities (a payee's account page). */
  listByAddress(address: string): Promise<Payee[]>
  insertLinkToken(token: LinkToken): Promise<void>
  getLinkToken(tokenHash: string): Promise<LinkToken | null>
  /** Compare-and-set: true only for the one call that consumed an unconsumed token. */
  consumeLinkToken(tokenHash: string, at: Date): Promise<boolean>
  /** The link's wallet nonce, replacing any before it. false (nothing stored) for an unknown or spent link. */
  setLinkNonce(tokenHash: string, nonce: string, at: Date): Promise<boolean>
  /** Compare-and-set: clears the link's wallet nonce and returns true only if it is `nonce` (single use, whatever comes next). */
  takeLinkNonce(tokenHash: string, nonce: string): Promise<boolean>
}

export interface RunRepository {
  insert(run: Run): Promise<void>
  get(id: string): Promise<Run | null>
  /** Newest first. */
  listByCommunity(communityId: string, opts?: { limit?: number }): Promise<Run[]>
  listByStatus(status: RunStatus): Promise<Run[]>
  /** One community's paid runs, paid at or after `since`, newest payment first (the dashboard's weekly totals). */
  listPaid(communityId: string, opts: { since: Date }): Promise<Run[]>
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

/**
 * Standing policies' own access keys, sealed like the bot key (one table apart from it, so nothing
 * that retires or rotates the bot key can touch them). Written only by PolicyKeyService; pay runs
 * read them to sign a policy's runs.
 */
export interface PolicyKeyRepository {
  /** Upsert by key address. */
  save(key: PolicyKey): Promise<void>
  get(address: string): Promise<PolicyKey | null>
  /** One policy's keys, newest first. */
  listByPolicy(policyId: string): Promise<PolicyKey[]>
  /** Every policy key of a community, newest first. */
  listByCommunity(communityId: string): Promise<PolicyKey[]>
}

/** The append-only audit stream. */
export interface AuditLog {
  /** Stores the event and returns it with its sequence number (increasing). */
  append(event: NewAuditEvent): Promise<AuditEvent>
  /** Newest first, filtered (see AuditQuery). */
  query(query: AuditQuery): Promise<AuditEvent[]>
}

/**
 * One content-free row per model call: the AI spend. Append-only; the one change is the link from
 * a proposal's rows to the pay run it became.
 */
export interface AiUsageRepository {
  /** Stores the row and returns it with its sequence number (increasing). */
  append(row: NewAiUsage): Promise<AiUsage>
  /** Sets the pay run on this proposal's rows. */
  linkRun(proposalId: string, runId: string): Promise<void>
  /** Newest first, filtered by purpose, policy and time. */
  list(communityId: string, opts?: { purposes?: readonly AiUsagePurpose[]; policyId?: string; since?: Date; limit?: number }): Promise<AiUsage[]>
}

/**
 * Funding with attribution (virtual addresses): the treasury's master registration and the
 * watcher's cursor, the named funding sources, and the deposits attributed to them. Written only
 * by FundingService.
 */
export interface FundingRepository {
  getMaster(communityId: string): Promise<DepositMaster | null>
  /** Insert-if-absent by community: true only for the call that stored it. */
  insertMaster(master: DepositMaster): Promise<boolean>
  /** Every community's master (the deposit watcher's work). */
  listMasters(): Promise<DepositMaster[]>
  /** Moves the watcher's cursor forward, never back (two instances may race to the same block). */
  advanceScan(communityId: string, scannedTo: bigint): Promise<void>
  /** `tag_taken` when the community already has a source with this user tag (two creates racing). */
  insertSource(source: FundingSource): Promise<'inserted' | 'tag_taken'>
  getSource(id: string): Promise<FundingSource | null>
  /** Oldest first. */
  listSources(communityId: string): Promise<FundingSource[]>
  /** Insert-if-absent on (txHash, logIndex): true only for the one call that stored the deposit. */
  insertDeposit(deposit: Deposit): Promise<boolean>
  /** Newest first (by block, then log index), filtered by source and time. */
  listDeposits(communityId: string, opts?: { sourceId?: string; since?: Date; limit?: number }): Promise<Deposit[]>
}
