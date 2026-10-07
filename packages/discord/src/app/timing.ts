/**
 * Milliseconds per named phase (Discord REST, the database, the chain...) for the log line of work
 * done after the first answer. Several calls to the same phase add up; `phases` rounds once.
 */
export function phaseTimer() {
  const totals: Record<string, number> = {}
  return {
    async time<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const started = performance.now()
      try {
        return await work()
      } finally {
        totals[phase] = (totals[phase] ?? 0) + performance.now() - started
      }
    },
    get phases(): Record<string, number> {
      return Object.fromEntries(Object.entries(totals).map(([phase, ms]) => [phase, Math.round(ms)]))
    },
  }
}
