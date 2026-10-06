import type { NetworkName, Payrun, Run } from '@payrun/core'
import type { Message } from '../api.js'
import type { DiscordRest, ExecutionJob, RunNotices } from '../ports.js'
import { explainError } from '../views/errors.js'
import { type RunViewContext, runMessage } from '../views/run.js'
import { sendReceipts } from './receipts.js'

export type RunExecutorDeps = {
  payrun: Payrun
  rest: DiscordRest
  /** Where the review message is and whether receipts went out, shared with the recovery notifier. */
  notices: RunNotices
  network: NetworkName
  now: () => Date
  sleep: (ms: number) => Promise<void>
  /** How many times to re-check a pending outcome before handing over to the recovery sweep. */
  maxChecks?: number
  onError?: (error: unknown, job: ExecutionJob) => void
}

const DEFAULT_MAX_CHECKS = 12
const RECHECK_MS = 5_000
/** Wait a little past the deadline the service names, so the chain's clock has passed it too. */
const DEADLINE_SLACK_MS = 1_000
const OUTAGE =
  'payrun could not reach the Tempo network, so nothing was sent. Press Retry in a moment.'

/**
 * The job behind the Approve (and Retry) button: pay the run, keep checking while the
 * outcome is pending, show the result on the original message, then DM each payee a
 * receipt. All payment safety lives in core (`execute` is idempotent); this only
 * reports. It never throws: every path ends with a message.
 */
export function createRunExecutor(deps: RunExecutorDeps): (job: ExecutionJob) => Promise<void> {
  const maxChecks = deps.maxChecks ?? DEFAULT_MAX_CHECKS
  const { payRuns } = deps.payrun

  return async (job) => {
    const ref = { guildId: job.guildId, runId: job.runId }
    const view = (run: Run, extra: Omit<RunViewContext, 'network'> = {}) => runMessage(run, { network: deps.network, ...extra })
    const publish = async (message: Message) => {
      const edited = await deps.rest.editOriginal(job.reply, message)
      // Interaction tokens last 15 minutes; after that, post as the bot instead.
      if (!edited.ok && job.channelId) await deps.rest.postToChannel(job.channelId, message)
    }

    try {
      if (job.channelId) await deps.notices.rememberMessage(job.runId, { channelId: job.channelId, messageId: job.messageId })
      const before = await payRuns.get(ref)
      if (!before.ok) return await publish({ content: explainError(before.error) })
      const alreadyPaid = before.value.status === 'paid'

      let outcome = await payRuns.execute(ref)
      for (let checks = 0; checks < maxChecks; checks++) {
        // A failed run reported pending is waiting for its last attempt's deadline before a new
        // one: ask execute again then (it re-checks the chain). Anything in flight is reconciled.
        let next = payRuns.reconcile.bind(payRuns)
        if (outcome.ok && outcome.value.status === 'pending') {
          const retryAfter = outcome.value.retryAfter
          if (outcome.value.run.status === 'failed') next = payRuns.execute.bind(payRuns)
          await deps.sleep(retryAfter ? Math.max(0, retryAfter.getTime() - deps.now().getTime()) + DEADLINE_SLACK_MS : RECHECK_MS)
        } else if (!outcome.ok && outcome.error.code === 'concurrent_update') {
          // Another worker (the recovery sweep) owns this attempt: follow it, never re-send.
          await deps.sleep(RECHECK_MS)
        } else break
        outcome = await next(ref)
      }

      if (!outcome.ok) {
        const current = await payRuns.get(ref)
        if (!current.ok) return await publish({ content: explainError(outcome.error) })
        return await publish(view(current.value, { problem: explainError(outcome.error, { token: current.value.token }) }))
      }

      const { run } = outcome.value
      switch (outcome.value.status) {
        case 'pending':
          return await publish(view(run, { stillConfirming: true }))
        case 'failed':
          return await publish(view(run))
        case 'paid': {
          // Receipts go out once per run, whoever finishes it (this job or the recovery sweep).
          if (alreadyPaid || !(await deps.notices.claimReceipts(run.id))) return await publish(view(run))
          await publish(view(run, { receipts: 'sending' }))
          const sent = await sendReceipts(deps, run)
          return await publish(view(run, { receipts: { sent, total: run.lines.length } }))
        }
      }
    } catch (error) {
      deps.onError?.(error, job)
      try {
        const current = await payRuns.get(ref)
        if (current.ok) await publish(view(current.value, { problem: OUTAGE, stillConfirming: true }))
      } catch (again) {
        deps.onError?.(again, job)
      }
    }
  }
}
