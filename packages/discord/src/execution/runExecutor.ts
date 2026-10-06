import type { NetworkName, Payrun, Run } from '@payrun/core'
import type { Message } from '../api.js'
import type { DiscordRest, ExecutionJob } from '../ports.js'
import { explainError } from '../views/errors.js'
import { type RunViewContext, receiptDm, runMessage } from '../views/run.js'

export type RunExecutorDeps = {
  payrun: Payrun
  rest: DiscordRest
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
      const before = await payRuns.get(ref)
      if (!before.ok) return await publish({ content: explainError(before.error) })
      const alreadyPaid = before.value.status === 'paid'

      let outcome = await payRuns.execute(ref)
      for (let checks = 0; checks < maxChecks; checks++) {
        if (outcome.ok && outcome.value.status === 'pending') {
          const retryAfter = outcome.value.retryAfter
          await deps.sleep(retryAfter ? Math.max(0, retryAfter.getTime() - deps.now().getTime()) + DEADLINE_SLACK_MS : RECHECK_MS)
        } else if (!outcome.ok && outcome.error.code === 'concurrent_update') {
          // Another worker (the recovery sweep) owns this attempt: follow it, never re-send.
          await deps.sleep(RECHECK_MS)
        } else break
        outcome = await payRuns.reconcile(ref)
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
          if (alreadyPaid) return await publish(view(run))
          await publish(view(run, { receipts: 'sending' }))
          const sent = await sendReceipts(run)
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

  async function sendReceipts(run: Run): Promise<number> {
    const community = await deps.payrun.communities.get(run.communityId)
    const communityName = community.ok ? community.value.name : null
    let sent = 0
    // One at a time: DM channel creation is rate limited, and receipts are not urgent.
    for (const line of run.lines) {
      try {
        if ((await deps.rest.sendDm(line.payeeDiscordId, receiptDm(run, line, { network: deps.network, communityName }))).ok) sent++
      } catch {
        // A failed receipt never fails the run; it is counted as not delivered.
      }
    }
    return sent
  }
}
