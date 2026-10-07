import type { Kysely, Selectable } from 'kysely'
import { type AuditEvent, AuditEventSchema, type AuditQuery, type NewAuditEvent } from '../../domain/policy/audit.js'
import { type Policy, PolicySchema, type PolicyStatus, type PolicyVersion, PolicyVersionSchema } from '../../domain/policy/policy.js'
import { type PolicyRun, PolicyRunSchema, type PolicyRunStatus } from '../../domain/policy/policyRun.js'
import type { AuditLog, PolicyRepository, PolicyRunRepository } from '../../ports/repositories.js'
import type { Database, PoliciesTable, PolicyRunsTable, PolicyVersionsTable } from './schema.js'

/*
 * Nested values (the compiled rule, the schedule, caps, lines) are JSON text with tagged bigints
 * and dates, so they come back exactly; every read is re-validated by the domain schema.
 */
function encode(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key]
    if (raw instanceof Date) return { $date: raw.toISOString() }
    if (typeof v === 'bigint') return { $bigint: v.toString() }
    return v
  })
}
function decode(text: string): unknown {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.$date === 'string' && Object.keys(v).length === 1) return new Date(v.$date)
      if (typeof v.$bigint === 'string' && Object.keys(v).length === 1) return BigInt(v.$bigint)
    }
    return v
  })
}
const iso = (d: Date) => d.toISOString()
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null)
const dateOrNull = (s: string | null) => (s ? new Date(s) : null)
const isUniqueViolation = (e: unknown) => /UNIQUE|PRIMARY KEY|duplicate key/i.test(String((e as Error)?.message))

function policyRow(p: Policy): PoliciesTable {
  return {
    id: p.id,
    community_id: p.communityId,
    name: p.name,
    instruction: p.instruction,
    compiled: encode(p.compiled),
    schedule: encode(p.schedule),
    caps: encode(p.caps),
    channel_id: p.channelId,
    status: p.status,
    version: p.version,
    mode: p.mode,
    veto_window_minutes: p.vetoWindowMinutes,
    autopilot: p.autopilot ? encode(p.autopilot) : null,
    created_by: p.createdBy,
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
    approved_by: p.approvedBy,
    approved_at: isoOrNull(p.approvedAt),
    active_since: isoOrNull(p.activeSince),
    rev: p.rev,
  }
}

function toPolicy(r: Selectable<PoliciesTable>): Policy {
  return PolicySchema.parse({
    id: r.id,
    communityId: r.community_id,
    name: r.name,
    instruction: r.instruction,
    compiled: decode(r.compiled),
    schedule: decode(r.schedule),
    caps: decode(r.caps),
    channelId: r.channel_id,
    status: r.status,
    version: r.version,
    mode: r.mode,
    vetoWindowMinutes: r.veto_window_minutes,
    autopilot: r.autopilot ? decode(r.autopilot) : null,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    approvedBy: r.approved_by,
    approvedAt: dateOrNull(r.approved_at),
    activeSince: dateOrNull(r.active_since),
    rev: r.rev,
  })
}

function versionRow(v: PolicyVersion): PolicyVersionsTable {
  return {
    policy_id: v.policyId,
    version: v.version,
    community_id: v.communityId,
    name: v.name,
    instruction: v.instruction,
    compiled: encode(v.compiled),
    schedule: encode(v.schedule),
    caps: encode(v.caps),
    authored_by: v.authoredBy,
    authored_at: iso(v.authoredAt),
    approved_by: v.approvedBy,
    approved_at: isoOrNull(v.approvedAt),
    discarded_by: v.discardedBy,
    discarded_at: isoOrNull(v.discardedAt),
  }
}

function toVersion(r: Selectable<PolicyVersionsTable>): PolicyVersion {
  return PolicyVersionSchema.parse({
    policyId: r.policy_id,
    version: r.version,
    communityId: r.community_id,
    name: r.name,
    instruction: r.instruction,
    compiled: decode(r.compiled),
    schedule: decode(r.schedule),
    caps: decode(r.caps),
    authoredBy: r.authored_by,
    authoredAt: new Date(r.authored_at),
    approvedBy: r.approved_by,
    approvedAt: dateOrNull(r.approved_at),
    discardedBy: r.discarded_by,
    discardedAt: dateOrNull(r.discarded_at),
  })
}

export class SqlitePolicyRepository implements PolicyRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(p: Policy, v: PolicyVersion) {
    await this.db.transaction().execute(async (tx) => {
      await tx.insertInto('policies').values(policyRow(p)).execute()
      await tx.insertInto('policy_versions').values(versionRow(v)).execute()
    })
  }

  async get(id: string) {
    const row = await this.db.selectFrom('policies').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toPolicy(row) : null
  }

  async listByCommunity(communityId: string) {
    const rows = await this.db.selectFrom('policies').selectAll().where('community_id', '=', communityId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()
    return rows.map(toPolicy)
  }

  async listByStatus(status: PolicyStatus) {
    return (await this.db.selectFrom('policies').selectAll().where('status', '=', status).orderBy('created_at', 'desc').execute()).map(toPolicy)
  }

  async update(next: Policy, version?: PolicyVersion) {
    return this.db.transaction().execute(async (tx) => {
      const { id, ...rest } = policyRow(next)
      const res = await tx.updateTable('policies').set(rest).where('id', '=', id).where('rev', '=', next.rev - 1).executeTakeFirst()
      if (res.numUpdatedRows !== 1n) return 'conflict' as const
      if (version) {
        const row = versionRow(version)
        const { policy_id: _p, version: _v, ...update } = row
        await tx
          .insertInto('policy_versions')
          .values(row)
          .onConflict((oc) => oc.columns(['policy_id', 'version']).doUpdateSet(update))
          .execute()
      }
      return 'updated' as const
    })
  }

  async listVersions(policyId: string) {
    return (await this.db.selectFrom('policy_versions').selectAll().where('policy_id', '=', policyId).orderBy('version').execute()).map(toVersion)
  }

  async getVersion(policyId: string, version: number) {
    const row = await this.db.selectFrom('policy_versions').selectAll().where('policy_id', '=', policyId).where('version', '=', version).executeTakeFirst()
    return row ? toVersion(row) : null
  }
}

function runRow(r: PolicyRun): PolicyRunsTable {
  return {
    id: r.id,
    policy_id: r.policyId,
    policy_version: r.policyVersion,
    community_id: r.communityId,
    period_key: r.periodKey,
    period_start: iso(r.periodStart),
    period_end: iso(r.periodEnd),
    mode: r.mode,
    status: r.status,
    run_id: r.runId,
    execute_after: isoOrNull(r.executeAfter),
    lines: encode(r.lines),
    unregistered: encode(r.unregistered),
    total: r.total.toString(),
    remaining: r.remaining === null ? null : r.remaining.toString(),
    problems: encode(r.problems),
    hold: r.hold ? encode(r.hold) : null,
    vetoed_by: r.vetoedBy,
    vetoed_at: isoOrNull(r.vetoedAt),
    released_by: r.releasedBy,
    released_at: isoOrNull(r.releasedAt),
    lease_until: isoOrNull(r.leaseUntil),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
    rev: r.rev,
  }
}

function toRun(r: Selectable<PolicyRunsTable>): PolicyRun {
  return PolicyRunSchema.parse({
    id: r.id,
    policyId: r.policy_id,
    policyVersion: r.policy_version,
    communityId: r.community_id,
    periodKey: r.period_key,
    periodStart: new Date(r.period_start),
    periodEnd: new Date(r.period_end),
    mode: r.mode,
    status: r.status,
    runId: r.run_id,
    executeAfter: dateOrNull(r.execute_after),
    lines: decode(r.lines),
    unregistered: decode(r.unregistered),
    total: BigInt(r.total),
    remaining: r.remaining === null ? null : BigInt(r.remaining),
    problems: decode(r.problems),
    hold: r.hold ? decode(r.hold) : null,
    vetoedBy: r.vetoed_by,
    vetoedAt: dateOrNull(r.vetoed_at),
    releasedBy: r.released_by,
    releasedAt: dateOrNull(r.released_at),
    leaseUntil: dateOrNull(r.lease_until),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    rev: r.rev,
  })
}

export class SqlitePolicyRunRepository implements PolicyRunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async claim(r: PolicyRun) {
    try {
      await this.db.insertInto('policy_runs').values(runRow(r)).execute()
      return true
    } catch (e) {
      if (isUniqueViolation(e)) return false
      throw e
    }
  }

  async get(id: string) {
    const row = await this.db.selectFrom('policy_runs').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toRun(row) : null
  }

  async getByPeriod(policyId: string, periodKey: string) {
    const row = await this.db.selectFrom('policy_runs').selectAll().where('policy_id', '=', policyId).where('period_key', '=', periodKey).executeTakeFirst()
    return row ? toRun(row) : null
  }

  async getByRunId(runId: string) {
    const row = await this.db.selectFrom('policy_runs').selectAll().where('run_id', '=', runId).executeTakeFirst()
    return row ? toRun(row) : null
  }

  async list(communityId: string, opts: { policyId?: string; statuses?: readonly PolicyRunStatus[]; limit?: number } = {}) {
    let q = this.db.selectFrom('policy_runs').selectAll().where('community_id', '=', communityId)
    if (opts.policyId) q = q.where('policy_id', '=', opts.policyId)
    if (opts.statuses) q = opts.statuses.length ? q.where('status', 'in', [...opts.statuses]) : q.where('status', '=', '')
    q = q.orderBy('period_end', 'desc').orderBy('created_at', 'desc')
    if (opts.limit !== undefined) q = q.limit(opts.limit)
    return (await q.execute()).map(toRun)
  }

  async listByStatus(statuses: readonly PolicyRunStatus[]) {
    if (statuses.length === 0) return []
    return (await this.db.selectFrom('policy_runs').selectAll().where('status', 'in', [...statuses]).orderBy('period_end', 'desc').execute()).map(toRun)
  }

  async update(next: PolicyRun) {
    const { id, ...rest } = runRow(next)
    const res = await this.db.updateTable('policy_runs').set(rest).where('id', '=', id).where('rev', '=', next.rev - 1).executeTakeFirst()
    return res.numUpdatedRows === 1n ? ('updated' as const) : ('conflict' as const)
  }
}

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: Kysely<Database>) {}

  async append(e: NewAuditEvent): Promise<AuditEvent> {
    const row = await this.db
      .insertInto('audit_events')
      .values({
        community_id: e.communityId,
        at: iso(e.at),
        type: e.type,
        actor: e.actor,
        policy_id: e.policyId,
        policy_version: e.policyVersion,
        policy_run_id: e.policyRunId,
        run_id: e.runId,
        details: JSON.stringify(e.details),
      })
      .returning('seq')
      .executeTakeFirstOrThrow()
    return AuditEventSchema.parse({ ...e, seq: row.seq })
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    let s = this.db.selectFrom('audit_events').selectAll().where('community_id', '=', q.guildId)
    if (q.types.length) s = s.where('type', 'in', [...q.types])
    if (q.actor !== null) s = s.where('actor', '=', q.actor)
    if (q.policyId !== null) s = s.where('policy_id', '=', q.policyId)
    if (q.runId !== null) s = s.where('run_id', '=', q.runId)
    if (q.since !== null) s = s.where('at', '>=', iso(q.since))
    if (q.until !== null) s = s.where('at', '<=', iso(q.until))
    if (q.before !== null) s = s.where('seq', '<', q.before)
    const rows = await s.orderBy('seq', 'desc').limit(q.limit).execute()
    return rows.map((r) =>
      AuditEventSchema.parse({
        seq: r.seq,
        communityId: r.community_id,
        at: new Date(r.at),
        type: r.type,
        actor: r.actor,
        policyId: r.policy_id,
        policyVersion: r.policy_version,
        policyRunId: r.policy_run_id,
        runId: r.run_id,
        details: JSON.parse(r.details),
      }),
    )
  }
}
