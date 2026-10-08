import type { AuditEvent } from '../domain/policy/audit.js'

/**
 * The live feed: every audit event, handed to whoever is listening right now, as it is appended
 * (the web pages' server-sent events). Content-free like the audit stream it carries. No history:
 * a subscriber sees what is published after it subscribed; what it missed is in the audit log.
 *
 * `InProcessLiveFeed` (in memory) reaches only the subscribers of its own process: with two server
 * instances, a page sees only the events of the instance it is connected to.
 */
export interface LiveFeed {
  /** Hands the stored event to every current subscriber. Never throws: a subscriber's failure is its own. */
  publish(event: AuditEvent): void
  /** Calls `listener` with every event published from now on, until the returned function is called. */
  subscribe(listener: (event: AuditEvent) => void): () => void
}
