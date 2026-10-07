/**
 * Who is working on a pay run right now, across processes: the Approve job, the recovery sweep,
 * another server instance on the same database. A worker takes the run's lease for one step
 * (execute, reconcile, one sweep of the run) and gives it back after; a run whose lease someone
 * else holds is left alone. A lease ends by itself after `ttlSeconds`, so a process that died
 * holding one cannot block a run for long.
 *
 * Leases keep two workers from doubling up (two broadcasts, two reports). They are not what makes
 * a double payment impossible: that stays with the version compare-and-set, the persisted signed tx
 * and its deadline, which hold whether or not leases are wired.
 */
export interface RunLeases {
  /** Takes the run for this worker until released or `ttlSeconds` pass. False when another worker holds it. */
  acquire(runId: string, ttlSeconds: number): Promise<boolean>
  /** Gives the run back. Does nothing if this worker does not hold it (it expired and someone else took it). */
  release(runId: string): Promise<void>
}
