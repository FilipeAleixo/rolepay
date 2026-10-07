import type { ScanReport } from '@rolepay/core'
import { startRecovery } from './recovery.js'

/**
 * The deposit watcher's loop: `funding.scan()` on start and every interval (the same loop as the
 * recovery sweep and the scheduler: scans never overlap, a failed scan is reported and the next one
 * still runs). Safe with restarts and with a second instance: core stores each deposit once, by
 * transaction and log index, and a range that could not be read is read again. A server where no
 * community set up deposit addresses makes no chain call at all.
 */
export function startFundingWatcher(opts: {
  scan: () => Promise<ScanReport>
  intervalMs: number
  onReport?: (report: ScanReport) => void
  onError?: (error: unknown) => void
}): { stop: () => Promise<void> } {
  return startRecovery({
    recover: async () => {
      const report = await opts.scan()
      if (report.deposits.length || report.errors.length) opts.onReport?.(report)
      return []
    },
    intervalMs: opts.intervalMs,
    ...(opts.onError ? { onError: opts.onError } : {}),
  })
}
