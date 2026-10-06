import type { Clock } from '../../ports/clock.js'
import type { KeyValueStore } from '../../ports/keyValueStore.js'

type Entry = { json: string; expiresAt: number | null }

/** In-memory KeyValueStore for tests. Same contract as SQLite (test/support/keyValueContract.ts). */
export class MemoryKeyValueStore implements KeyValueStore {
  private entries = new Map<string, Entry>()

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.expiresAt !== null && this.clock.now().getTime() >= e.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return e
  }

  private entry(value: unknown, ttl: number | undefined): Entry {
    return { json: JSON.stringify(value), expiresAt: ttl ? this.clock.now().getTime() + ttl * 1000 : null }
  }

  async get<T>(key: string) {
    const e = this.live(key)
    return e ? (JSON.parse(e.json) as T) : undefined
  }
  async set(key: string, value: unknown, options?: { ttl?: number }) {
    this.entries.set(key, this.entry(value, options?.ttl))
  }
  async delete(key: string) {
    this.entries.delete(key)
  }
  // Synchronous between the check and the write, so atomic within the process.
  async create(key: string, value: unknown, options?: { ttl?: number }) {
    if (this.live(key)) return false
    this.entries.set(key, this.entry(value, options?.ttl))
    return true
  }
  async sweep() {
    let n = 0
    for (const key of [...this.entries.keys()]) {
      const e = this.entries.get(key)
      if (e && e.expiresAt !== null && this.clock.now().getTime() >= e.expiresAt) {
        this.entries.delete(key)
        n++
      }
    }
    return n
  }

  async take<T>(key: string) {
    const e = this.live(key)
    this.entries.delete(key)
    return e ? (JSON.parse(e.json) as T) : undefined
  }
}
