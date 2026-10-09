import type { KeyStatusView, Result } from '@rolepay/core'

/**
 * THE POLICY SEAM. The dashboard's Policies and Audit pages read and act through these ports,
 * never through core's policy services directly: the types stay plain (Dates, bigint micro-units,
 * words written by code) and the pages stay testable without the AI or Discord. The server wires
 * them with a thin adapter over core's `PolicyService` and `AuditService` (`policyPortFromCore`
 * and `auditPortFromCore` in apps/server, see docs/ARCHITECTURE.md "The policy seam"). Tests use
 * `InMemoryPolicies` from `@rolepay/web/testing`, and the page contract (`@rolepay/web/contract`)
 * runs the same page tests against both. Without them the pages say policies are not available.
 * The AI spend (`AiUsagePort`, at the end) is read the same way, over core's AiUsageService.
 *
 * Money is bigint micro-units, as everywhere in Rolepay. Times are Dates. Every text field here
 * is shown escaped; none of it may carry Discord message text (only what a run already stores).
 */

/** The member acting, as the bot read them just now: core re-checks the approver role from these. */
export type PolicyActor = { id: string; roleIds: string[] }

export type PolicyStatus = 'draft' | 'active' | 'paused' | 'archived'
export type PolicyMode = 'propose' | 'autopilot'

/**
 * When a policy runs, in the community's timezone (an IANA name, default UTC), at `hour`:`minute`
 * (`minute` 0 to 59; absent is 0, on the hour). Daily is the testnet demo's only (`PolicyPort.dailySchedules`).
 */
export type PolicySchedule =
  | { kind: 'daily'; hour: number; minute?: number; timezone: string }
  | { kind: 'weekly'; /** 0 = Sunday ... 6 = Saturday */ weekday: number; hour: number; minute?: number; timezone: string }
  | { kind: 'monthly'; /** 1-28 */ day: number; hour: number; minute?: number; timezone: string }

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
  /** The same, for reading: the mentions in it (`<#id>`, `<@&id>`) as names. Absent: show `instruction`. */
  instructionInWords?: string
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
  /** A version waiting for approval (a new draft, or an edit that needs one), or null. */
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
  /**
   * The token they will receive, when it is not the payout token: their preferred stablecoin, bought
   * on the exchange in the run's transaction (the community pays in preferred stablecoins). Absent: the payout token.
   */
  swappedTo?: string
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
  /** The remaining budget now of the key that pays this policy, or null when unknown (no key, or the chain could not be read). */
  remainingBudget: bigint | null
  /** Whose key that is: the policy's own (`policy`) or the bot key, shared (`bot`, the default). */
  budgetKey?: 'bot' | 'policy'
  /** Why the next run would be held instead of paid (over budget, over a cap), in plain words; null when it would go ahead. */
  held: string | null
}

export type PolicyVersionView = {
  version: number
  instruction: string
  instructionInWords?: string
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
  /**
   * Whether policies here may run daily: only on a testnet server with the demo controls on
   * (ROLEPAY_DEMO_CONTROLS). Absent or false: the form offers weekly and monthly, and the policy
   * services refuse a daily schedule (`schedule_not_allowed`) anyway.
   */
  readonly dailySchedules?: boolean
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
  /**
   * A new version (the instruction recompiled when it changed). From the approver role, on a policy
   * approved before, with no separate approver required, it is in force at once (`inForce`): the
   * policy keeps running and keeps its mode unless `mode` names one (`vetoWindowMinutes` with it,
   * checked by the services). Otherwise it waits for an approval, the policy stops meanwhile, and a
   * `mode` of autopilot is refused (`policy_not_approved`).
   */
  edit(input: Ref & { actor: PolicyActor; draft: PolicyDraft; mode?: PolicyMode; vetoWindowMinutes?: number }): Promise<Result<{ version: number; inForce: boolean }, PolicyError>>
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

// ---- the AI spend --------------------------------------------------------------------------

/**
 * One model call, as the dashboard shows it: the model, how long it took and what it cost. Rows
 * hold no one's words (core stores counts, codes, IDs and the cost only). Money is bigint
 * micro-dollars, estimated from the model's list price.
 */
export type AiCallView = {
  at: Date
  /** The model as people say it, for example "Sonnet 5.5". */
  model: string
  latencyMs: number | null
  /** null when the model has no price (or the call returned no usage). */
  costMicroUsd: bigint | null
}

/** A proposal attempt that reached the model, and the pay run it became. */
export type AiProposalView = AiCallView & {
  mode: 'messages' | 'criteria'
  /** Who asked. */
  actorId: string
  /** `proposed`, or the code that stopped it (`could_not_propose`, `criteria_unclear`, `cannot_read`, ...). */
  outcome: string
  runId: string | null
}

/** This month's AI spend (UTC, from the first of the month). */
export type AiSpendView = {
  since: Date
  calls: number
  totalMicroUsd: bigint
  /** Calls on a model with no price: counted, not in the total. */
  unpriced: number
  /** Drafted proposals this month, and the average cost of one (null with none). */
  proposals: number
  averagePerProposalMicroUsd: bigint | null
}

/** What the AI cost the community. Absent: the pages leave the AI spend out. */
export interface AiUsagePort {
  spend(input: { guildId: string }): Promise<AiSpendView>
  /** Newest first. */
  proposals(input: { guildId: string; limit: number }): Promise<AiProposalView[]>
  /** What compiling each version of a policy cost, by version number; a version made without the model is absent. */
  compiles(input: { guildId: string; policyId: string }): Promise<Record<number, AiCallView>>
}

// ---- what was paid, week by week ---------------------------------------------------------

/** One UTC week (Monday 00:00 to Monday 00:00) of paid runs. Money is bigint micro-units of the payout token. */
export type PaidWeekView = {
  /** Monday 00:00 UTC. */
  start: Date
  /** Sent by runs a policy made. */
  policy: bigint
  /** Sent by runs made by hand. */
  manual: bigint
  /** How many runs were paid. */
  runs: number
  /** The week in progress: what it shows is so far. */
  partial: boolean
}

/** Paid runs only (a draft, a run waiting for approval, a failed or cancelled run sent nothing), summed per week. */
export type PaidByWeekView = {
  /** The payout token's address. */
  token: string
  /** Oldest first; the last one is the current week. */
  weeks: PaidWeekView[]
  total: bigint
  policy: bigint
  manual: bigint
  runs: number
}

/**
 * What was paid each week, runs a policy made apart from runs made by hand (which runs a policy
 * made is policy knowledge, so it comes through the seam). Absent: the Overview leaves the chart out.
 */
export interface PayoutsPort {
  /** The last 12 UTC weeks, the current one last; null for a community Rolepay does not know. */
  paidByWeek(input: { guildId: string }): Promise<PaidByWeekView | null>
}

// ---- a policy's own budget -------------------------------------------------------------------

/**
 * A policy's own budget (its own access key, authorised by the treasury passkey on the treasury
 * page), as the policy's page shows it: `shared` (it pays from the bot key's budget, with every
 * other run), `own` (its own key, with what the chain says now: the same view as the bot key's on
 * the Overview), `retired` (its own key was revoked: it pays nothing until it gets a new one).
 */
export type PolicyBudgetView = { kind: 'shared' } | { kind: 'own'; key: KeyStatusView } | { kind: 'retired' }

/** Policies' own keys, through the seam (which key pays a policy is policy knowledge). Absent: the policy page leaves the budget out. */
export interface PolicyKeysPort {
  /** null for a policy Rolepay does not know in this community. Reads the chain. */
  budget(input: { guildId: string; policyId: string }): Promise<PolicyBudgetView | null>
}
