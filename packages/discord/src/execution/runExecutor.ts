import type { ExecuteOutcome, NetworkName, Rolepay, Run } from '@rolepay/core'
import type { Message } from '../api.js'
import { autopilotReleaseOf } from '../app/runContext.js'
import { updateMirror } from '../app/treasury.js'
import type { DiscordRest, ExecutionJob, RunNotices } from '../ports.js'
import { explainError } from '../views/errors.js'
import { type RunViewContext, runMessage } from '../views/run.js'
import { sendReceipts } from './receipts.js'

/**
 * One line per job, content-free: how it ended (the run's status, or the error code), how long it
 * took in all, and where: `pay` (core: the chain and the database, waits between checks included)
 * and `discord` (editing the message, the receipts). `checks`: re-checks of a pending outcome;
 * `contended`: times another worker had the run (it was followed, never raced).
 */
export type JobReport = {
  runId: string
  status: string
  ms: number
  phases: { pay: number; discord: number }
  checks: number
  contended: number
}

export type RunExecutorDeps = {
  rolepay: Rolepay
  rest: DiscordRest
  /** Where the review message is and whether receipts went out, shared with the recovery notifier. */
  notices: RunNotices
  network: NetworkName
  /** The server's account page, linked from every receipt (where a payee sees and moves the money). */
  accountUrl?: string | null
  now: () => Date
  sleep: (ms: number) => Promise<void>
  /** How many times to re-check a pending outcome before handing over to the recovery sweep. */
  maxChecks?: number
  onError?: (error: unknown, job: ExecutionJob) => void
  /** Called once per job as it ends. */
  onDone?: (report: JobReport) => void
}

const DEFAULT_MAX_CHECKS = 12
const RECHECK_MS = 5_000
/** Wait a little past the deadline the service names, so the chain's clock has passed it too. */
const DEADLINE_SLACK_MS = 1_000
const OUTAGE =
  'Rolepay could not reach the Tempo network, so nothing was sent. Press Retry in a moment.'

/** What a run already settled by another worker reads as, or null while it is not settled. */
function settled(run: Run): ExecuteOutcome | null {
  if (run.status === 'paid') return { status: 'paid', run }
  if (run.status === 'failed' && run.failure) return { status: 'failed', run, failure: run.failure }
  return null
}

/**
 * The job behind the Approve (and Retry) button: pay the run, keep checking while the
 * outcome is pending, show the result on the original message, then DM each payee a
 * receipt. All payment safety lives in core (`execute` is idempotent); this only
 * reports. It never throws: every path ends with a message.
 *
 * Another worker on the same run (another instance, or its recovery sweep) shows up as
 * `concurrent_update`. The job then reads the run again: settled, it reports that at once; still
 * being paid, it waits and follows with reconcile (which never signs anything new); still approved
 * (the other worker let go without starting it), it pays it after the wait. It never drops the run
 * and never reports a contention as a failure.
 */
export function createRunExecutor(deps: RunExecutorDeps): (job: ExecutionJob) => Promise<void> {
  const maxChecks = deps.maxChecks ?? DEFAULT_MAX_CHECKS
  const { payRuns } = deps.rolepay

  return async (job) => {
    const ref = { guildId: job.guildId, runId: job.runId }
    const started = performance.now()
    const report: JobReport = { runId: job.runId, status: 'error', ms: 0, phases: { pay: 0, discord: 0 }, checks: 0, contended: 0 }
    const timedDiscord = async <T>(work: () => Promise<T>): Promise<T> => {
      const t = performance.now()
      try {
        return await work()
      } finally {
        report.phases.discord += performance.now() - t
      }
    }
    // A run autopilot released says so rather than "Approved by" (read once the run is loaded).
    let released: Pick<RunViewContext, 'released'> = {}
    const view = (run: Run, extra: Omit<RunViewContext, 'network'> = {}) => runMessage(run, { network: deps.network, ...released, ...extra })
    const publish = (message: Message) =>
      timedDiscord(async () => {
        const edited = await deps.rest.editOriginal(job.reply, message)
        // Interaction tokens last 15 minutes; after that, post as the bot instead.
        if (!edited.ok && job.channelId) await deps.rest.postToChannel(job.channelId, message)
      })
    /** The run's message, and its copy without buttons when its buttons are in the treasury channel. */
    const show = async (run: Run, extra: Omit<RunViewContext, 'network'> = {}) => {
      await publish(view(run, extra))
      await timedDiscord(() => updateMirror(deps, run.id, view(run, { ...extra, mirror: true })))
    }

    try {
      if (job.channelId) await deps.notices.rememberMessage(job.runId, { channelId: job.channelId, messageId: job.messageId })
      const before = await payRuns.get(ref)
      if (!before.ok) {
        report.status = before.error.code
        return await publish({ content: explainError(before.error) })
      }
      const alreadyPaid = before.value.status === 'paid'
      released = await autopilotReleaseOf(deps.rolepay, before.value)

      let outcome = await payRuns.execute(ref)
      for (let checks = 0; checks < maxChecks; checks++) {
        // A failed run reported pending is waiting for its last attempt's deadline before a new
        // one: ask execute again then (it re-checks the chain). Anything in flight is reconciled.
        let next = payRuns.reconcile.bind(payRuns)
        if (outcome.ok && outcome.value.status === 'pending') {
          const retryAfter = outcome.value.retryAfter
          if (outcome.value.run.status === 'failed') next = payRuns.execute.bind(payRuns)
          report.checks++
          await deps.sleep(retryAfter ? Math.max(0, retryAfter.getTime() - deps.now().getTime()) + DEADLINE_SLACK_MS : RECHECK_MS)
        } else if (!outcome.ok && outcome.error.code === 'concurrent_update') {
          // Another worker has or just changed this run: read what it did before doing anything.
          report.contended++
          const current = await payRuns.get(ref)
          if (!current.ok) break
          const done = settled(current.value)
          if (done) {
            outcome = { ok: true, value: done }
            break
          }
          if (current.value.status === 'approved') next = payRuns.execute.bind(payRuns)
          else if (current.value.status !== 'executing') break
          await deps.sleep(RECHECK_MS)
        } else break
        outcome = await next(ref)
      }

      if (!outcome.ok) {
        report.status = outcome.error.code
        const current = await payRuns.get(ref)
        if (!current.ok) return await publish({ content: explainError(outcome.error) })
        return await show(current.value, { problem: explainError(outcome.error, { token: current.value.token }) })
      }

      const { run } = outcome.value
      report.status = outcome.value.status
      switch (outcome.value.status) {
        case 'pending':
          return await show(run, { stillConfirming: true })
        case 'failed':
          return await show(run)
        case 'paid': {
          // Receipts go out once per run, whoever finishes it (this job or the recovery sweep).
          if (alreadyPaid || !(await deps.notices.claimReceipts(run.id))) return await show(run)
          await show(run, { receipts: 'sending' })
          const sent = await timedDiscord(() => sendReceipts(deps, run))
          return await show(run, { receipts: { sent, total: run.lines.length } })
        }
      }
    } catch (error) {
      report.status = 'error'
      deps.onError?.(error, job)
      try {
        const current = await payRuns.get(ref)
        if (current.ok) await show(current.value, { problem: OUTAGE, stillConfirming: true })
      } catch (again) {
        deps.onError?.(again, job)
      }
    } finally {
      report.ms = Math.round(performance.now() - started)
      report.phases.discord = Math.round(report.phases.discord)
      report.phases.pay = Math.max(0, report.ms - report.phases.discord)
      deps.onDone?.(report)
    }
  }
}
