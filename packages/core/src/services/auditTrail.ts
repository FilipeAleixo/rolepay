import { formatAmount } from '../domain/money.js'
import { type AuditDetails, type AuditEventType, type AuditQueryInput, AuditQuerySchema, type NewAuditEvent, NewAuditEventSchema, auditToCsv, type AuditEvent } from '../domain/policy/audit.js'
import { type Result, ok } from '../domain/result.js'
import type { Run } from '../domain/run.js'
import type { Clock } from '../ports/clock.js'
import type { LiveFeed } from '../ports/liveFeed.js'
import type { AuditLog, PolicyRunRepository } from '../ports/repositories.js'
import { type InvalidInput, invalidInput } from './common.js'

/**
 * Writes the audit stream for the services. Policy and policy run events are written as part of
 * the action (an outage throws, like any write). Pay run events are best effort: a failed audit
 * write never fails a payment step (it is reported through `onError`). A pay run made by a policy
 * carries the policy, its version and the policy run. Every stored event is also published to the
 * live feed (when there is one), for the pages that update as it happens; publishing never fails
 * the write.
 */
export class AuditTrail {
  constructor(
    private readonly deps: { log: AuditLog; policyRuns: PolicyRunRepository; clock: Clock; live?: LiveFeed | null; onError?: (error: unknown) => void },
  ) {}

  async record(e: Omit<NewAuditEvent, 'at' | 'policyVersion' | 'policyRunId' | 'runId' | 'policyId'> & Partial<Pick<NewAuditEvent, 'policyId' | 'policyVersion' | 'policyRunId' | 'runId'>>): Promise<void> {
    const event = NewAuditEventSchema.parse({ policyId: null, policyVersion: null, policyRunId: null, runId: null, ...e, at: this.deps.clock.now() })
    const stored = await this.deps.log.append(event)
    try {
      this.deps.live?.publish(stored)
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  /** An event that must never fail the step that caused it (a deposit already stored): a failure is reported through `onError`. */
  async bestEffort(e: Parameters<AuditTrail['record']>[0]): Promise<void> {
    try {
      await this.record(e)
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  /** A pay run moved (created, approved, paid...). Never throws. */
  async run(run: Run, type: Extract<AuditEventType, `run.${string}`>, actor: string | null, details: AuditDetails = {}): Promise<void> {
    try {
      const link = await this.deps.policyRuns.getByRunId(run.id)
      await this.record({
        communityId: run.communityId,
        type,
        actor,
        runId: run.id,
        policyId: link?.policyId ?? null,
        policyVersion: link?.policyVersion ?? null,
        policyRunId: link?.id ?? null,
        details: { total: formatAmount(run.total), lines: run.lines.length, ...details },
      })
    } catch (error) {
      this.deps.onError?.(error)
    }
  }
}

/**
 * The audit log for the dashboard: every policy and run event of a community, newest first,
 * filterable by type, actor, policy, run and time, and as CSV (the governance report).
 */
export class AuditService {
  constructor(private readonly deps: { log: AuditLog }) {}

  async list(input: AuditQueryInput): Promise<Result<{ events: AuditEvent[]; next: number | null }, InvalidInput>> {
    const q = AuditQuerySchema.safeParse(input)
    if (!q.success) return invalidInput(q.error)
    const events = await this.deps.log.query(q.data)
    const last = events.at(-1)
    return ok({ events, next: events.length === q.data.limit && last ? last.seq : null })
  }

  /** Every matching event (up to 10,000), oldest first, as CSV. */
  async exportCsv(input: Omit<AuditQueryInput, 'limit' | 'before'>): Promise<Result<{ filename: string; csv: string; count: number }, InvalidInput>> {
    const q = AuditQuerySchema.safeParse({ ...input, limit: 500 })
    if (!q.success) return invalidInput(q.error)
    const all: AuditEvent[] = []
    let before: number | null = null
    do {
      const page = await this.deps.log.query({ ...q.data, before })
      all.push(...page)
      before = page.length === q.data.limit ? (page.at(-1)?.seq ?? null) : null
    } while (before !== null && all.length < 10_000)
    return ok({ filename: `rolepay-audit-${q.data.guildId}.csv`, csv: auditToCsv(all), count: all.length })
  }
}
