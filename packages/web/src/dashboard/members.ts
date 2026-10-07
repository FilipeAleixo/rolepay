import type { Clock } from '@rolepay/core'
import type { GuildMember, GuildMembers } from './ports.js'

/** Roles decide what someone may see: a page trusts them for a minute at most. Actions always read fresh. */
export const ROLES_MAX_AGE_SECONDS = 60
/** Display names are only labels: ten minutes is fine. */
export const NAMES_MAX_AGE_SECONDS = 600
const MAX_ENTRIES = 5_000
const CONCURRENCY = 5

type Entry = { member: GuildMember | null; at: number }

/**
 * The bot's view of guild members with a short in-memory cache (per process), so browsing the
 * dashboard does not cost one Discord request per page per person. Absence (not a member) is
 * cached too. `fresh: true` skips the cache: every action re-checks the member's roles with Discord.
 */
export class CachedGuildMembers {
  private readonly cache = new Map<string, Entry>()

  constructor(
    private readonly inner: GuildMembers,
    private readonly clock: Clock,
  ) {}

  async member(guildId: string, userId: string, opts: { fresh?: boolean } = {}): Promise<GuildMember | null> {
    const cached = this.cache.get(`${guildId}:${userId}`)
    if (!opts.fresh && cached && this.age(cached) <= ROLES_MAX_AGE_SECONDS) return cached.member
    return this.load(guildId, userId)
  }

  /** Display names for these people (members without a name, and non-members, are left out). Asks Discord for at most `limit` of them. */
  async names(guildId: string, userIds: readonly string[], opts: { limit: number }): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)]
    const stale = unique.filter((id) => {
      const e = this.cache.get(`${guildId}:${id}`)
      return !e || this.age(e) > NAMES_MAX_AGE_SECONDS
    })
    const queue = stale.slice(0, opts.limit)
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.load(guildId, id)
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    const out = new Map<string, string>()
    for (const id of unique) {
      const name = this.cache.get(`${guildId}:${id}`)?.member?.name
      if (name) out.set(id, name)
    }
    return out
  }

  private age(e: Entry) {
    return (this.clock.now().getTime() - e.at) / 1000
  }

  private async load(guildId: string, userId: string): Promise<GuildMember | null> {
    const member = await this.inner.member(guildId, userId)
    if (this.cache.size >= MAX_ENTRIES) this.cache.clear()
    this.cache.set(`${guildId}:${userId}`, { member, at: this.clock.now().getTime() })
    return member
  }
}
