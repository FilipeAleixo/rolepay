import type { AuditEvent } from '../../domain/policy/audit.js'
import type { LiveFeed } from '../../ports/liveFeed.js'

/**
 * The live feed in memory: subscribers of this process only. One server instance sees all its own
 * events; with two instances, a page connected to one never sees the other's (a shared bus, such as
 * Postgres LISTEN/NOTIFY, can replace this behind the same port). Each subscriber gets its own copy,
 * and a subscriber that throws is reported and skipped, never the publisher's problem.
 */
export class InProcessLiveFeed implements LiveFeed {
  private readonly listeners = new Set<(event: AuditEvent) => void>()

  constructor(private readonly opts: { onError?: (error: unknown) => void } = {}) {}

  /** How many subscribers are listening (tests check that streams clean up after themselves). */
  get size(): number {
    return this.listeners.size
  }

  publish(event: AuditEvent): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue // unsubscribed while this event was handed out
      try {
        listener(structuredClone(event))
      } catch (error) {
        this.opts.onError?.(error)
      }
    }
  }

  subscribe(listener: (event: AuditEvent) => void): () => void {
    const own = (event: AuditEvent) => listener(event)
    this.listeners.add(own)
    return () => {
      this.listeners.delete(own)
    }
  }
}
