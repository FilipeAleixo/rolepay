import type { BotKey, Community, SetupLink } from '../../domain/community.js'
import type { LinkToken, Payee } from '../../domain/payee.js'
import { err, ok } from '../../domain/result.js'
import type { Run } from '../../domain/run.js'
import type { Clock } from '../../ports/clock.js'
import type { CommunityRepository, PayeeRepository, RunRepository } from '../../ports/repositories.js'
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
  async update(next: Run) {
    const stored = this.runs.get(next.id)
    if (!stored || stored.version !== next.version - 1) return 'conflict' as const
    this.runs.set(next.id, copy(next))
    return 'updated' as const
  }
}

export function createMemoryRepositories(opts: { clock?: Clock } = {}) {
  const clock = opts.clock ?? { now: () => new Date() }
  return {
    communities: new MemoryCommunityRepository(),
    payees: new MemoryPayeeRepository(),
    runs: new MemoryRunRepository(),
    proposals: new KvProposalRepository(new MemoryKeyValueStore(clock), clock),
  }
}
