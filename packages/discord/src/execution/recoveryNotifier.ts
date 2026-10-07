import type { NetworkName, Rolepay, RecoveryResult } from '@rolepay/core'
import { autopilotReleaseOf } from '../app/runContext.js'
import type { DiscordRest, RunNotices } from '../ports.js'
import { runMessage } from '../views/run.js'
import { sendReceipts } from './receipts.js'

export type RecoveryNotifierDeps = {
  rolepay: Rolepay
  rest: DiscordRest
  notices: RunNotices
  network: NetworkName
  /** The server's account page, linked from every receipt. */
  accountUrl?: string | null
  onError?: (error: unknown) => void
}

/**
 * Finishes the story for runs the recovery sweep settled (typically after a restart, when
 * the job that would have reported is gone): DMs the receipts once, then updates the review
 * message in its channel as the bot, or posts the result there if it cannot be edited.
 * Runs another worker already reported are left alone (the receipts claim says so).
 */
export function createRecoveryNotifier(deps: RecoveryNotifierDeps): (results: RecoveryResult[]) => Promise<void> {
  async function report(result: RecoveryResult) {
    const run = await deps.rolepay.payRuns.get({ guildId: result.guildId, runId: result.runId })
    if (!run.ok) return
    let receipts: { sent: number; total: number } | undefined
    if (run.value.status === 'paid') {
      if (!(await deps.notices.claimReceipts(run.value.id))) return
      receipts = { sent: await sendReceipts(deps, run.value), total: run.value.lines.length }
    }
    const ref = await deps.notices.message(run.value.id)
    if (!ref) return
    const message = runMessage(run.value, { network: deps.network, ...(await autopilotReleaseOf(deps.rolepay, run.value)), ...(receipts ? { receipts } : {}) })
    if (ref.messageId && (await deps.rest.editChannelMessage(ref.channelId, ref.messageId, message)).ok) return
    await deps.rest.postToChannel(ref.channelId, message)
  }

  return async (results) => {
    for (const result of results) {
      if (result.status !== 'paid' && result.status !== 'failed') continue
      try {
        await report(result)
      } catch (error) {
        deps.onError?.(error)
      }
    }
  }
}
