import { DiscordIdSchema } from '../domain/ids.js'
import { type AuditEvent, type AuditEventType, AuditQuerySchema } from '../domain/policy/audit.js'
import { type ReceivedLine, linesPaidTo } from '../domain/received.js'
import type { LiveFeed } from '../ports/liveFeed.js'
import type { AuditLog, CommunityRepository, PayeeRepository, RunRepository } from '../ports/repositories.js'
import type { Clock } from '../ports/clock.js'

/**
 * One audit event as a live page sees it: what changed and where, nothing else (no actor, no
 * details). A page re-reads what it shows from the server when one arrives.
 */
export type LiveEvent = Pick<AuditEvent, 'seq' | 'at' | 'type' | 'communityId' | 'runId' | 'policyId' | 'policyRunId'>

/** A line paid to one address, with the community's name (null when it has none). `seq` is the run.paid event's, when live. */
export type ReceivedPayment = ReceivedLine & { communityName: string | null; seq?: number }

/** At most this many missed events are replayed to a page that reconnects (it re-reads its panels anyway). */
const MAX_REPLAY = 50
/** The account's list of what arrived reads the paid runs of the last year. */
const RECEIVED_WINDOW_MS = 365 * 86_400_000

const toLive = (e: AuditEvent): LiveEvent => ({ seq: e.seq, at: e.at, type: e.type, communityId: e.communityId, runId: e.runId, policyId: e.policyId, policyRunId: e.policyRunId })

/**
 * Live updates for the web pages, over the live feed (every audit event, as it is appended):
 *
 * - `community`: one community's events, for its dashboard pages (the web layer checks who may see them);
 * - `payments`: the lines paid to one address, for that passkey's account page, read from the run
 *   once per payment and handed only to that address's listeners;
 * - `received`: what an address was paid recently (the account's list), and `since`: the events a
 *   reconnecting page missed.
 *
 * Without a feed (`enabled` false) subscribing is harmless and nothing arrives.
 */
export class LiveService {
  private readonly payers = new Map<string, Set<(p: ReceivedPayment) => void>>()
  private stopPayments: (() => void) | null = null

  constructor(
    private readonly deps: {
      feed: LiveFeed | null
      audit: AuditLog
      runs: RunRepository
      payees: PayeeRepository
      communities: CommunityRepository
      clock: Clock
      onError?: (error: unknown) => void
    },
  ) {}

  get enabled(): boolean {
    return this.deps.feed !== null
  }

  /** Every event of this community from now on, until the returned function is called. */
  community(input: { guildId: string }, listener: (event: LiveEvent) => void): () => void {
    const feed = this.deps.feed
    if (!feed || !DiscordIdSchema.safeParse(input.guildId).success) return () => {}
    return feed.subscribe((e) => {
      if (e.communityId === input.guildId) listener(toLive(e))
    })
  }

  /** The community's events after `after` (a reconnecting page's Last-Event-ID), oldest first, at most 50. */
  async since(input: { guildId: string; after: number }): Promise<LiveEvent[]> {
    const q = AuditQuerySchema.safeParse({ guildId: input.guildId, limit: MAX_REPLAY })
    if (!q.success) return []
    const events = await this.deps.audit.query(q.data)
    return events.filter((e) => e.seq > input.after).reverse().map(toLive)
  }

  /** The lines paid to `address` from now on, one call per line, until the returned function is called. */
  payments(input: { address: string }, listener: (payment: ReceivedPayment) => void): () => void {
    const feed = this.deps.feed
    if (!feed) return () => {}
    const address = input.address.toLowerCase()
    const own = (p: ReceivedPayment) => listener(p)
    const set = this.payers.get(address) ?? new Set()
    set.add(own)
    this.payers.set(address, set)
    // One feed subscription for every account listening: a paid run is read once, whoever it paid.
    this.stopPayments ??= feed.subscribe((e) => {
      if (e.type === ('run.paid' satisfies AuditEventType) && e.runId) void this.dispatch(e.seq, e.communityId, e.runId).catch((error) => this.deps.onError?.(error))
    })
    return () => {
      set.delete(own)
      if (set.size === 0 && this.payers.get(address) === set) this.payers.delete(address)
      if (this.payers.size === 0 && this.stopPayments) {
        this.stopPayments()
        this.stopPayments = null
      }
    }
  }

  /** What `address` was paid in the last year, newest first (at most `limit`, 10 by default), across the communities it is registered in. */
  async received(input: { address: string; limit?: number }): Promise<ReceivedPayment[]> {
    const limit = Math.max(1, Math.min(50, input.limit ?? 10))
    const since = new Date(this.deps.clock.now().getTime() - RECEIVED_WINDOW_MS)
    const guilds = [...new Set((await this.deps.payees.listByAddress(input.address.toLowerCase())).map((p) => p.communityId))]
    const perGuild = await Promise.all(
      guilds.map(async (guildId) => {
        const [runs, community] = await Promise.all([this.deps.runs.listPaid(guildId, { since }), this.deps.communities.get(guildId)])
        return runs.flatMap((run) => linesPaidTo(run, input.address)).map((l) => ({ ...l, communityName: community?.name ?? null }))
      }),
    )
    return perGuild
      .flat()
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime() || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : b.line - a.line))
      .slice(0, limit)
  }

  private async dispatch(seq: number, guildId: string, runId: string) {
    const run = await this.deps.runs.get(runId)
    if (!run || run.communityId !== guildId || !run.lines.some((l) => this.payers.has(l.address.toLowerCase()))) return
    const community = await this.deps.communities.get(guildId)
    for (const line of run.lines) {
      const listeners = this.payers.get(line.address.toLowerCase())
      const paid = listeners ? linesPaidTo(run, line.address).find((p) => p.line === line.line) : undefined
      if (!listeners || !paid) continue
      for (const listener of [...listeners]) {
        try {
          listener({ ...paid, communityName: community?.name ?? null, seq })
        } catch (error) {
          this.deps.onError?.(error)
        }
      }
    }
  }
}
