import type { AiUsage, AiUsagePurpose, NewAiUsage } from '../../domain/aiUsage.js'
import type { BotKey, Community, SetupLink } from '../../domain/community.js'
import type { LinkToken, Payee } from '../../domain/payee.js'
import type { AuditEvent, AuditQuery, NewAuditEvent } from '../../domain/policy/audit.js'
import type { Policy, PolicyStatus, PolicyVersion } from '../../domain/policy/policy.js'
import type { PolicyKey } from '../../domain/policy/policyKey.js'
import type { PolicyRun, PolicyRunStatus } from '../../domain/policy/policyRun.js'
import { err, ok } from '../../domain/result.js'
import type { Run } from '../../domain/run.js'
import type { Clock } from '../../ports/clock.js'
import type {
  AiUsageRepository,
  AuditLog,
  CommunityRepository,
  PayeeRepository,
  PolicyKeyRepository,
  PolicyRepository,
  PolicyRunRepository,
  RunRepository,
} from '../../ports/repositories.js'
import { KvProposalRepository } from '../kv/proposals.js'
import { MemoryKeyValueStore } from './keyValue.js'

/** In-memory repositories for unit tests. Same contract as SQLite (test/support/repositoryContracts.ts). */
const copy = <T>(value: T): T => structuredClone(value)
const newestFirst = <T extends { createdAt: Date }>(a: T, b: T) => b.createdAt.getTime() - a.createdAt.getTime()

export class MemoryCommunityRepository implements CommunityRepository {
  private communities = new Map<string, Community>()
  private keys = new Map<string, BotKey>()
  private setupLinks = new Map<string, SetupLink>()

  async get(id: string) {
    const c = this.communities.get(id)
    return c ? copy(c) : null
  }
  async insert(c: Community) {
    if (this.communities.has(c.id)) return err({ code: 'already_exists' as const })
    this.communities.set(c.id, copy(c))
    return ok(undefined)
  }
  async update(c: Community) {
    if (this.communities.has(c.id)) this.communities.set(c.id, copy(c))
  }
  async saveBotKey(key: BotKey) {
    this.keys.set(key.address, copy(key))
  }
  async getBotKey(address: string) {
    const k = this.keys.get(address)
    return k ? copy(k) : null
  }
  async listBotKeys(communityId: string) {
    return [...this.keys.values()].filter((k) => k.communityId === communityId).sort(newestFirst).map(copy)
  }
  async insertSetupLink(link: SetupLink) {
    this.setupLinks.set(link.tokenHash, copy(link))
  }
  async getSetupLink(tokenHash: string) {
    const l = this.setupLinks.get(tokenHash)
    return l ? copy(l) : null
  }
}

export class MemoryPayeeRepository implements PayeeRepository {
  private payees = new Map<string, Payee>()
  private tokens = new Map<string, LinkToken>()
  private key = (communityId: string, userId: string) => `${communityId}:${userId}`

  async get(communityId: string, discordUserId: string) {
    const p = this.payees.get(this.key(communityId, discordUserId))
    return p ? copy(p) : null
  }
  async upsert(p: Payee) {
    this.payees.set(this.key(p.communityId, p.discordUserId), copy(p))
  }
  async list(communityId: string) {
    return [...this.payees.values()].filter((p) => p.communityId === communityId).map(copy)
  }
  async insertLinkToken(t: LinkToken) {
    this.tokens.set(t.tokenHash, copy(t))
  }
  async getLinkToken(tokenHash: string) {
    const t = this.tokens.get(tokenHash)
    return t ? copy(t) : null
  }
  async consumeLinkToken(tokenHash: string, at: Date) {
    const t = this.tokens.get(tokenHash)
    if (!t || t.consumedAt !== null) return false
    this.tokens.set(tokenHash, { ...t, consumedAt: at })
    return true
  }
}

export class MemoryRunRepository implements RunRepository {
  private runs = new Map<string, Run>()

  async insert(r: Run) {
    if (this.runs.has(r.id)) throw new Error(`run ${r.id} already exists`)
    this.runs.set(r.id, copy(r))
  }
  async get(id: string) {
    const r = this.runs.get(id)
    return r ? copy(r) : null
  }
  async listByCommunity(communityId: string, opts: { limit?: number } = {}) {
    const all = [...this.runs.values()].filter((r) => r.communityId === communityId).sort(newestFirst)
    return all.slice(0, opts.limit ?? all.length).map(copy)
  }
  async listByStatus(status: Run['status']) {
    return [...this.runs.values()].filter((r) => r.status === status).sort(newestFirst).map(copy)
  }
  async listPaid(communityId: string, opts: { since: Date }) {
    const paidAt = (r: Run) => r.paidAt?.getTime() ?? 0
    return [...this.runs.values()]
      .filter((r) => r.communityId === communityId && r.status === 'paid' && r.paidAt !== null && paidAt(r) >= opts.since.getTime())
      .sort((a, b) => paidAt(b) - paidAt(a) || (b.id < a.id ? -1 : 1))
      .map(copy)
  }
  async update(next: Run) {
    const stored = this.runs.get(next.id)
    if (!stored || stored.version !== next.version - 1) return 'conflict' as const
    this.runs.set(next.id, copy(next))
    return 'updated' as const
  }
}

export class MemoryPolicyRepository implements PolicyRepository {
  private policies = new Map<string, Policy>()
  private versions = new Map<string, PolicyVersion>()
  private vkey = (policyId: string, version: number) => `${policyId}:${version}`

  async insert(p: Policy, v: PolicyVersion) {
    if (this.policies.has(p.id)) throw new Error(`policy ${p.id} already exists`)
    this.policies.set(p.id, copy(p))
    this.versions.set(this.vkey(v.policyId, v.version), copy(v))
  }
  async get(id: string) {
    const p = this.policies.get(id)
    return p ? copy(p) : null
  }
  async listByCommunity(communityId: string) {
    return [...this.policies.values()].filter((p) => p.communityId === communityId).sort(newestFirst).map(copy)
  }
  async listByStatus(status: PolicyStatus) {
    return [...this.policies.values()].filter((p) => p.status === status).sort(newestFirst).map(copy)
  }
  async update(next: Policy, version?: PolicyVersion) {
    const stored = this.policies.get(next.id)
    if (!stored || stored.rev !== next.rev - 1) return 'conflict' as const
    this.policies.set(next.id, copy(next))
    if (version) this.versions.set(this.vkey(version.policyId, version.version), copy(version))
    return 'updated' as const
  }
  async listVersions(policyId: string) {
    return [...this.versions.values()].filter((v) => v.policyId === policyId).sort((a, b) => a.version - b.version).map(copy)
  }
  async getVersion(policyId: string, version: number) {
    const v = this.versions.get(this.vkey(policyId, version))
    return v ? copy(v) : null
  }
}

const byPeriodDesc = (a: PolicyRun, b: PolicyRun) => b.periodEnd.getTime() - a.periodEnd.getTime() || b.createdAt.getTime() - a.createdAt.getTime()

export class MemoryPolicyRunRepository implements PolicyRunRepository {
  private runs = new Map<string, PolicyRun>()

  async claim(r: PolicyRun) {
    if (this.runs.has(r.id) || [...this.runs.values()].some((x) => x.policyId === r.policyId && x.periodKey === r.periodKey)) return false
    this.runs.set(r.id, copy(r))
    return true
  }
  async get(id: string) {
    const r = this.runs.get(id)
    return r ? copy(r) : null
  }
  async getByPeriod(policyId: string, periodKey: string) {
    const r = [...this.runs.values()].find((x) => x.policyId === policyId && x.periodKey === periodKey)
    return r ? copy(r) : null
  }
  async getByRunId(runId: string) {
    const r = [...this.runs.values()].find((x) => x.runId === runId)
    return r ? copy(r) : null
  }
  async list(communityId: string, opts: { policyId?: string; statuses?: readonly PolicyRunStatus[]; limit?: number } = {}) {
    const all = [...this.runs.values()]
      .filter((r) => r.communityId === communityId && (!opts.policyId || r.policyId === opts.policyId) && (!opts.statuses || opts.statuses.includes(r.status)))
      .sort(byPeriodDesc)
    return all.slice(0, opts.limit ?? all.length).map(copy)
  }
  async listByStatus(statuses: readonly PolicyRunStatus[]) {
    return [...this.runs.values()].filter((r) => statuses.includes(r.status)).sort(byPeriodDesc).map(copy)
  }
  async update(next: PolicyRun) {
    const stored = this.runs.get(next.id)
    if (!stored || stored.rev !== next.rev - 1) return 'conflict' as const
    this.runs.set(next.id, copy(next))
    return 'updated' as const
  }
}

export class MemoryAuditLog implements AuditLog {
  private events: AuditEvent[] = []

  async append(e: NewAuditEvent) {
    const stored = { ...copy(e), seq: this.events.length + 1 }
    this.events.push(stored)
    return copy(stored)
  }
  async query(q: AuditQuery) {
    return this.events
      .filter(
        (e) =>
          e.communityId === q.guildId &&
          (q.types.length === 0 || q.types.includes(e.type)) &&
          (q.actor === null || e.actor === q.actor) &&
          (q.policyId === null || e.policyId === q.policyId) &&
          (q.runId === null || e.runId === q.runId) &&
          (q.since === null || e.at >= q.since) &&
          (q.until === null || e.at <= q.until) &&
          (q.before === null || e.seq < q.before),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, q.limit)
      .map(copy)
  }
}

/** Ties broken by address (descending), as SQLite orders them. */
const newestKeyFirst = (a: PolicyKey, b: PolicyKey) => newestFirst(a, b) || (a.address < b.address ? 1 : a.address > b.address ? -1 : 0)

export class MemoryPolicyKeyRepository implements PolicyKeyRepository {
  private keys = new Map<string, PolicyKey>()

  async save(key: PolicyKey) {
    this.keys.set(key.address, copy(key))
  }
  async get(address: string) {
    const k = this.keys.get(address)
    return k ? copy(k) : null
  }
  async listByPolicy(policyId: string) {
    return [...this.keys.values()].filter((k) => k.policyId === policyId).sort(newestKeyFirst).map(copy)
  }
  async listByCommunity(communityId: string) {
    return [...this.keys.values()].filter((k) => k.communityId === communityId).sort(newestKeyFirst).map(copy)
  }
}

export class MemoryAiUsageRepository implements AiUsageRepository {
  private rows: AiUsage[] = []

  async append(row: NewAiUsage) {
    const stored = { ...copy(row), seq: this.rows.length + 1 }
    this.rows.push(stored)
    return copy(stored)
  }
  async linkRun(proposalId: string, runId: string) {
    this.rows = this.rows.map((r) => (r.proposalId === proposalId ? { ...r, runId } : r))
  }
  async list(communityId: string, opts: { purposes?: readonly AiUsagePurpose[]; policyId?: string; since?: Date; limit?: number } = {}) {
    const all = this.rows
      .filter(
        (r) =>
          r.communityId === communityId &&
          (!opts.purposes || opts.purposes.includes(r.purpose)) &&
          (!opts.policyId || r.policyId === opts.policyId) &&
          (!opts.since || r.createdAt >= opts.since),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq)
    return all.slice(0, opts.limit ?? all.length).map(copy)
  }
}

export function createMemoryRepositories(opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? { now: () => new Date() }
  return {
    communities: new MemoryCommunityRepository(),
    payees: new MemoryPayeeRepository(),
    runs: new MemoryRunRepository(),
    proposals: new KvProposalRepository(new MemoryKeyValueStore(clock), clock),
    policies: new MemoryPolicyRepository(),
    policyRuns: new MemoryPolicyRunRepository(),
    policyKeys: new MemoryPolicyKeyRepository(),
    audit: new MemoryAuditLog(),
    aiUsage: new MemoryAiUsageRepository(),
  }
}
