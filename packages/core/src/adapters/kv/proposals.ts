import { type Proposal, ProposalSchema } from '../../domain/proposal/proposal.js'
import type { Clock } from '../../ports/clock.js'
import type { KeyValueStore } from '../../ports/keyValueStore.js'
import type { ProposalRepository } from '../../ports/repositories.js'

/**
 * Proposals on the KeyValueStore: one JSON record each, expiring with the proposal, so the same
 * code serves memory (tests) and SQLite (production) and moves to Postgres with the store. Bigints
 * and dates are tagged on write and restored on read, and every read is re-validated by the
 * domain schema.
 */
export class KvProposalRepository implements ProposalRepository {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  async get(id: string): Promise<Proposal | null> {
    const stored = await this.kv.get<unknown>(key(id))
    return stored === undefined ? null : ProposalSchema.parse(decode(stored))
  }

  async save(proposal: Proposal): Promise<void> {
    await this.kv.set(key(proposal.id), encode(ProposalSchema.parse(proposal)), { ttl: this.ttl(proposal) })
  }

  async claim(id: string): Promise<boolean> {
    const proposal = await this.get(id)
    return this.kv.create(claimKey(id), true, { ttl: proposal ? this.ttl(proposal) : 60 })
  }

  async release(id: string): Promise<void> {
    await this.kv.delete(claimKey(id))
  }

  /** Seconds until the proposal expires (at least one, so an expiring record is still written). */
  private ttl(p: Proposal) {
    return Math.max(1, Math.ceil((p.expiresAt.getTime() - this.clock.now().getTime()) / 1000))
  }
}

const key = (id: string) => `proposal:${id}`
const claimKey = (id: string) => `proposal-claim:${id}`

/** JSON with bigints as { $bigint: "123" } and dates as { $date: "ISO" }. */
function encode(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, k, v) {
      const raw = this[k]
      if (typeof raw === 'bigint') return { $bigint: raw.toString() }
      if (raw instanceof Date) return { $date: raw.toISOString() }
      return v
    }),
  )
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value === null || typeof value !== 'object') return value
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1 && typeof o.$bigint === 'string' && /^\d+$/.test(o.$bigint)) return BigInt(o.$bigint)
  if (keys.length === 1 && typeof o.$date === 'string') return new Date(o.$date)
  return Object.fromEntries(keys.map((k) => [k, decode(o[k])]))
}
