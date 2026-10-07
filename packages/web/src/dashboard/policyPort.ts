import type { Result } from '@rolepay/core'

/**
 * THE POLICY SEAM. The dashboard's Policies and Audit pages read and act through these two ports,
 * never through core's policy services directly: the types stay plain (Dates, bigint micro-units,
 * words written by code) and the pages stay testable without the AI or Discord. The server wires
 * them with a thin adapter over core's `PolicyService` and `AuditService` (`policyPortFromCore`
 * and `auditPortFromCore` in apps/server, see docs/ARCHITECTURE.md "The policy seam"). Tests use
 * `InMemoryPolicies` from `@rolepay/web/testing`, and the page contract (`@rolepay/web/contract`)
 * runs the same page tests against both. Without them the pages say policies are not available.
 *
 * Money is bigint micro-units, as everywhere in Rolepay. Times are Dates. Every text field here
 * is shown escaped; none of it may carry Discord message text (only what a run already stores).
 */

/** The member acting, as the bot read them just now: core re-checks the approver role from these. */
export type PolicyActor = { id: string; roleIds: string[] }

export type PolicyStatus = 'draft' | 'active' | 'paused' | 'archived'
export type PolicyMode = 'propose' | 'autopilot'

/** When a policy runs, in the community's timezone (an IANA name, default UTC). */
export type PolicySchedule =
  | { kind: 'weekly'; /** 0 = Sunday ... 6 = Saturday */ weekday: number; hour: number; timezone: string }
  | { kind: 'monthly'; /** 1-28 */ day: number; hour: number; timezone: string }

export type PolicySummary = {
  id: string
  name: string
  status: PolicyStatus
  mode: PolicyMode
  schedule: PolicySchedule
  /** The version in force (the latest approved one), or the draft's version before any approval. */
  version: number
  nextRunAt: Date | null
  /** How many people the rule matches right now, if known without reading Discord again. */
  matchesNow: number | null
}

export type PolicyDetail = PolicySummary & {
  /** What the treasurer typed, kept next to the compiled rule. */
  instruction: string
  /** The compiled rule in plain words (written by code from the filter, not by the model). */
  ruleInWords: string
  /** The exact compiled filter and amount plan, JSON-safe (bigints as strings). */
  filter: unknown
  /** Autopilot: how long a run waits for a veto before it pays. */
  vetoWindowMinutes: number
  caps: { perRun: bigint | null; perPerson: bigint | null }
  createdBy: string
  createdAt: Date
  approvedBy: string | null
  approvedAt: Date | null
  /** A newer version (an edit) waiting for approval, or null. */
  pendingVersion: number | null
}

export type PolicyMatch = {
  userId: string
  /** For example { messages: 12, activeDays: 4 }. */
  metrics: Record<string, number>
  /** Why they match, in plain words, from the filter (never message text). */
  reasons: string[]
  /** What the next run would pay them; null when nothing is worked out for them (not registered). */
  amount: bigint | null
  /** false: they match but have not linked a payout account (`/payee link`), so nothing is paid to them. */
  registered: boolean
}

export type PolicyNearMiss = { userId: string; metrics: Record<string, number>; missing: string }

/** Who the rule applies to right now, and what its next run would pay against the key's budget. */
export type PolicyPreview = {
  asOf: Date
  window: { since: Date; until: Date } | null
  matches: PolicyMatch[]
  nearMisses: PolicyNearMiss[]
  nextRunAt: Date | null
  total: bigint
  /** The bot key's remaining budget now, or null when unknown (no key, or the chain could not be read). */
  remainingBudget: bigint | null
  /** Why the next run would be held instead of paid (over budget, over a cap), in plain words; null when it would go ahead. */
  held: string | null
}

export type PolicyVersionView = {
  version: number
  instruction: string
  ruleInWords: string
  filter: unknown
  createdBy: string
  createdAt: Date
  approvedBy: string | null
  approvedAt: Date | null
  status: 'approved' | 'pending' | 'superseded' | 'discarded'
}

/** A run a policy will generate. */
export type ScheduledRunView = { policyId: string; policyName: string; at: Date; mode: PolicyMode }

/** Which policy (and version) generated a run, and its autopilot story. */
export type RunOrigin = {
  policyId: string
  /** The policy's run for that period (what a veto acts on). */
  policyRunId: string
  policyName: string
  version: number
  /** The period the run covers, in words (for example "week of 2026-10-05"). */
  period: string
  mode: PolicyMode
  scheduledFor: Date
  /** Autopilot: when it pays unless vetoed. */
  executesAt: Date | null
  vetoedBy: string | null
  vetoedAt: Date | null
  executedAt: Date | null
  /** An autopilot run still inside its veto window: a Treasurer may veto it now. */
  vetoable: boolean
}

export type PolicyDraft = { name: string; instruction: string; schedule: PolicySchedule }

/** Expected failures, as everywhere: `not_permitted`, `policy_not_found`, `illegal_state`, `could_not_compile`, ... */
export type PolicyError = { code: string; message?: string }

type Ref = { guildId: string; policyId: string }

export interface PolicyPort {
  list(input: { guildId: string }): Promise<PolicySummary[]>
  get(input: Ref): Promise<Result<PolicyDetail, PolicyError>>
  /** Evaluates the rule now (reads Discord activity, so it can take a few seconds). */
  preview(input: Ref): Promise<Result<PolicyPreview, PolicyError>>
  /** Oldest first. */
  versions(input: Ref): Promise<PolicyVersionView[]>
  /** The next scheduled runs across the community's active policies, soonest first. */
  upcoming(input: { guildId: string; limit: number }): Promise<ScheduledRunView[]>
  /** The policy behind each of these runs; runs made by hand are absent. */
  runOrigins(input: { guildId: string; runIds: string[] }): Promise<Record<string, RunOrigin>>

  /** Compiles the instruction once (the AI) into a draft, which needs an approval to run. */
  create(input: { guildId: string; actor: PolicyActor; draft: PolicyDraft }): Promise<Result<{ policyId: string }, PolicyError>>
  /** Recompiles into a new version, which needs a new approval. */
  edit(input: Ref & { actor: PolicyActor; draft: PolicyDraft }): Promise<Result<{ version: number }, PolicyError>>
  approve(input: Ref & { actor: PolicyActor; version: number }): Promise<Result<void, PolicyError>>
  /** Drops a version waiting for approval. */
  discard(input: Ref & { actor: PolicyActor; version: number }): Promise<Result<void, PolicyError>>
  pause(input: Ref & { actor: PolicyActor }): Promise<Result<void, PolicyError>>
  resume(input: Ref & { actor: PolicyActor }): Promise<Result<void, PolicyError>>
  archive(input: Ref & { actor: PolicyActor }): Promise<Result<void, PolicyError>>
  setMode(input: Ref & { actor: PolicyActor; mode: PolicyMode; vetoWindowMinutes: number }): Promise<Result<void, PolicyError>>
  /** Vetoes an autopilot run during its veto window: it is cancelled and nothing is paid. */
  veto(input: { guildId: string; runId: string; actor: PolicyActor }): Promise<Result<void, PolicyError>>
}

/** One event of the audit stream: every policy and run event, who did it, and a summary in plain words. */
export type AuditEventView = {
  id: string
  at: Date
  /** For example `policy.approved`, `policy_run.vetoed`. */
  type: string
  /** The Discord user, or null for Rolepay itself (the scheduler). */
  actorId: string | null
  policyId: string | null
  runId: string | null
  summary: string
}

export type AuditQuery = {
  guildId: string
  type?: string
  actorId?: string
  policyId?: string
  /** Newest first; events strictly older than this event (the next page). */
  beforeId?: string
  limit: number
}

export interface AuditPort {
  /** The event types the filter offers. */
  readonly eventTypes: readonly string[]
  events(query: AuditQuery): Promise<AuditEventView[]>
}
