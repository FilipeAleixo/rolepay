type RecoveryResult = { runId: string; status: string; error?: string }

/**
 * The crash-recovery sweep: `payRuns.recoverInFlight()` on start and every interval.
 * Sweeps never overlap; a failed sweep is reported and the next one still runs.
 */
export function startRecovery(opts: {
  recover: () => Promise<RecoveryResult[]>
  intervalMs: number
  onResult?: (results: RecoveryResult[]) => void
  onError?: (error: unknown) => void
}): { stop: () => Promise<void> } {
  let current: Promise<void> | null = null
  const sweep = () => {
    if (current) return // the previous sweep is still running
    current = opts
      .recover()
      .then((results) => {
        if (results.length) opts.onResult?.(results)
      })
      .catch((error) => opts.onError?.(error))
      .finally(() => {
        current = null
      })
  }
  const first = setTimeout(sweep, 0)
  const timer = setInterval(sweep, opts.intervalMs)
  return {
    async stop() {
      clearTimeout(first)
      clearInterval(timer)
      await current
    },
  }
}
