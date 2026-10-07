import { weekStartUtc } from '@rolepay/core'
import type { PaidByWeekView, PayoutsPort } from '../dashboard/policyPort.js'

const WEEK_MS = 7 * 86_400_000

/**
 * The weekly payouts port in memory, for the dashboard's page tests: whatever a test sets is what
 * the Overview shows, and by default twelve empty weeks ending this week. Core's behaviour (which
 * runs count, the weeks, the policy split) is tested in core and through the server's adapter
 * (`payoutsPortFromCore`).
 */
export class InMemoryPayouts implements PayoutsPort {
  private readonly views = new Map<string, PaidByWeekView | null>()

  constructor(
    private readonly clock: { now(): Date } = { now: () => new Date() },
    private readonly token = '0x20c0000000000000000000000000000000000001',
  ) {}

  set(guildId: string, view: PaidByWeekView | null) {
    this.views.set(guildId, view)
  }

  /** Twelve weeks ending this week, each with `amounts[i]` (policy, by hand) micro-units, oldest first; missing weeks are empty. */
  weeks(amounts: ([bigint, bigint] | null)[], token = this.token): PaidByWeekView {
    const current = weekStartUtc(this.clock.now()).getTime()
    const weeks = Array.from({ length: 12 }, (_, i) => {
      const [policy, manual] = amounts[i] ?? [0n, 0n]
      return { start: new Date(current - (11 - i) * WEEK_MS), policy, manual, runs: (policy > 0n ? 1 : 0) + (manual > 0n ? 1 : 0), partial: i === 11 }
    })
    const sum = (k: 'policy' | 'manual') => weeks.reduce((a, w) => a + w[k], 0n)
    return { token, weeks, policy: sum('policy'), manual: sum('manual'), total: sum('policy') + sum('manual'), runs: weeks.reduce((a, w) => a + w.runs, 0) }
  }

  async paidByWeek(input: { guildId: string }): Promise<PaidByWeekView | null> {
    return this.views.has(input.guildId) ? (this.views.get(input.guildId) ?? null) : this.weeks([])
  }
}
