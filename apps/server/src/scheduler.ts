import type { SchedulerEvent, TickReport } from '@rolepay/core'
import { startRecovery } from './recovery.js'

/**
 * The policy scheduler's loop: `scheduler.tick()` on start and every interval, then the Discord
 * announcement of what it did. Driven like the recovery sweep (the same loop: ticks never
 * overlap, a failed tick is reported and the next one still runs). Safe with restarts and with a
 * second instance: core claims each period once and moves runs by compare-and-set.
 */
export function startScheduler(opts: {
  tick: () => Promise<TickReport>
  announce: (events: readonly SchedulerEvent[]) => Promise<void>
  intervalMs: number
  onReport?: (report: TickReport) => void
  onError?: (error: unknown) => void
}): { stop: () => Promise<void> } {
  return startRecovery({
    recover: async () => {
      const report = await opts.tick()
      await opts.announce(report.events)
      if (report.events.length || report.errors.length) opts.onReport?.(report)
      return []
    },
    intervalMs: opts.intervalMs,
    ...(opts.onError ? { onError: opts.onError } : {}),
  })
}
