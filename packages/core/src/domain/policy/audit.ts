import { z } from 'zod'
import { csvCell } from '../csv.js'
import { DiscordIdSchema, RunIdSchema } from '../ids.js'
import { PolicyIdSchema } from './policy.js'
import { PolicyRunIdSchema } from './policyRun.js'

/**
 * The audit stream: every policy, run and funding event, append-only, for the dashboard's audit log and
 * the governance report a DAO can publish. Details are codes, amounts, counts and IDs, never
 * anyone's words (instructions, notes and names stay on their own records).
 */
export const AUDIT_EVENT_TYPES = [
  'policy.created',
  'policy.compiled',
  'policy.edited',
  'policy.approved',
  'policy.discarded',
  'policy.paused',
  'policy.resumed',
  'policy.mode_changed',
  'policy.archived',
  'policy_key.authorized',
  'policy_key.revoked',
  'policy_run.generated',
  'policy_run.held',
  'policy_run.empty',
  'policy_run.vetoed',
  'policy_run.released',
  'policy_run.cancelled',
  'run.created',
  'run.submitted',
  'run.approved',
  'run.cancelled',
  'run.executing',
  'run.paid',
  'run.failed',
  'funding_source.created',
  'deposit.received',
] as const
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES)
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>

const DetailValue = z.union([z.string().max(120), z.number(), z.boolean(), z.null()])
export const AuditDetailsSchema = z.record(z.string().regex(/^[a-zA-Z_]{1,40}$/), DetailValue).refine((d) => Object.keys(d).length <= 20, 'at most 20 details')
export type AuditDetails = z.infer<typeof AuditDetailsSchema>

export const NewAuditEventSchema = z.object({
  communityId: DiscordIdSchema,
  at: z.date(),
  type: AuditEventTypeSchema,
  /** Who did it, as Discord vouched for them. null = Rolepay itself (the scheduler, the recovery sweep). */
  actor: DiscordIdSchema.nullable(),
  policyId: PolicyIdSchema.nullable(),
  policyVersion: z.number().int().min(1).nullable(),
  policyRunId: PolicyRunIdSchema.nullable(),
  runId: RunIdSchema.nullable(),
  details: AuditDetailsSchema,
})
export type NewAuditEvent = z.infer<typeof NewAuditEventSchema>

/** A stored event: `seq` is assigned by the store, increasing, and is the cursor for paging. */
export const AuditEventSchema = NewAuditEventSchema.extend({ seq: z.number().int().min(1) })
export type AuditEvent = z.infer<typeof AuditEventSchema>

/** Filters for the audit log. Newest first; `before` is the `seq` to continue below. */
export const AuditQuerySchema = z.object({
  guildId: DiscordIdSchema,
  types: z.array(AuditEventTypeSchema).max(AUDIT_EVENT_TYPES.length).default([]),
  actor: DiscordIdSchema.nullable().default(null),
  /** Events of this policy, its runs and the pay runs it made. */
  policyId: PolicyIdSchema.nullable().default(null),
  runId: RunIdSchema.nullable().default(null),
  since: z.date().nullable().default(null),
  until: z.date().nullable().default(null),
  before: z.number().int().min(1).nullable().default(null),
  limit: z.number().int().min(1).max(500).default(100),
})
export type AuditQuery = z.infer<typeof AuditQuerySchema>
export type AuditQueryInput = z.input<typeof AuditQuerySchema>

const COLUMNS = ['seq', 'at', 'type', 'actor', 'policy_id', 'policy_version', 'policy_run_id', 'run_id', 'details'] as const

/** The audit log as CSV, oldest first. The actor column says "rolepay" for Rolepay's own actions. */
export function auditToCsv(events: readonly AuditEvent[]): string {
  const rows = [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => [
      String(e.seq),
      e.at.toISOString(),
      e.type,
      e.actor ?? 'rolepay',
      e.policyId ?? '',
      e.policyVersion === null ? '' : String(e.policyVersion),
      e.policyRunId ?? '',
      e.runId ?? '',
      JSON.stringify(e.details),
    ])
  return [COLUMNS as readonly string[], ...rows].map((r) => `${r.map(csvCell).join(',')}\r\n`).join('')
}
