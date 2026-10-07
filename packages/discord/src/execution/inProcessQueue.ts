import type { ExecutionJob, ExecutionQueue } from '../ports.js'

const runKey = (guildId: string, runId: string) => `${guildId}:${runId}`

/**
 * Runs jobs in this process, in the background, one at a time per run (different runs
 * in parallel). Losing it in a crash loses no money and pays nothing twice: execute is
 * idempotent and the server's recovery sweep reconciles anything left executing.
 * A durable queue can replace it behind the same port.
 */
export class InProcessExecutionQueue implements ExecutionQueue {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    private readonly runJob: (job: ExecutionJob) => Promise<void>,
    private readonly opts: { onError?: (error: unknown, job: ExecutionJob) => void } = {},
  ) {}

  async enqueue(job: ExecutionJob): Promise<void> {
    const key = runKey(job.guildId, job.runId)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next: Promise<void> = previous
      .then(() => this.runJob(job))
      .catch((error) => this.opts.onError?.(error, job))
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key)
      })
    this.tails.set(key, next)
  }

  /** Runs with work queued or in flight. */
  get size(): number {
    return this.tails.size
  }

  /**
   * Whether a job for this run is queued or running here, waits between its checks included. The
   * recovery sweep leaves such a run alone: the job pays it and reports it.
   */
  isBusy(guildId: string, runId: string): boolean {
    return this.tails.has(runKey(guildId, runId))
  }

  /** Resolves once every queued job has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all([...this.tails.values()])
  }
}
