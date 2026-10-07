import type { NetworkName, Policy, PolicyRun, Rolepay, Run, SchedulerEvent } from '@rolepay/core'
import type { Message } from '../api.js'
import type { DiscordRest, PolicyAnnouncer, RunNotices } from '../ports.js'
import { explainHold, policyRunNoticeMessage } from '../views/policy.js'
import { type RunViewContext, runMessage } from '../views/run.js'
import { sendReceipts } from './receipts.js'

export type PolicyNotifierDeps = {
  rolepay: Rolepay
  rest: DiscordRest
  /** Where each run's message is and whether its receipts went out, shared with the executor and the recovery sweep. */
  notices: RunNotices
  network: NetworkName
  onError?: (error: unknown) => void
}

/**
 * Tells each policy's channel what the scheduler did. A new run is posted as the bot (and its
 * message remembered, so the executor, the recovery sweep and this notifier edit that same
 * message later): propose-mode runs with the normal review embed (Approve and Cancel), autopilot
 * runs with when they pay and a Veto button, held runs with why and the numbers, empty periods in
 * one line. When autopilot releases a run, the message becomes the result (receipts go out once);
 * when autopilot stops, it becomes the normal review with why. A policy with no channel posts
 * nothing. It never throws: a failure is reported and the next event goes on.
 */
export function createPolicyNotifier(deps: PolicyNotifierDeps): PolicyAnnouncer {
  async function context(policy: Policy, pr: PolicyRun): Promise<RunViewContext> {
    const community = await deps.rolepay.communities.get(policy.communityId)
    return {
      network: deps.network,
      approverRoleId: community.ok ? community.value.approverRoleId : null,
      policy: { name: policy.name, version: pr.policyVersion, periodStart: pr.periodStart, periodEnd: pr.periodEnd },
    }
  }

  async function post(channelId: string, runId: string | null, message: Message) {
    const posted = await deps.rest.postMessage(channelId, message)
    if (runId) await deps.notices.rememberMessage(runId, { channelId, messageId: posted.ok ? posted.value.messageId : null })
  }

  /** Edits the run's message where it was posted, or posts the update there if it cannot be edited. */
  async function update(channelId: string, run: Run, message: Message) {
    const ref = (await deps.notices.message(run.id)) ?? { channelId, messageId: null }
    if (ref.messageId && (await deps.rest.editChannelMessage(ref.channelId, ref.messageId, message)).ok) return
    await post(ref.channelId, run.id, message)
  }

  async function announceOne(e: SchedulerEvent) {
    const channelId = e.policy.channelId
    if (!channelId) return
    const pr = e.policyRun
    const ctx = await context(e.policy, pr)
    const community = await deps.rolepay.communities.get(e.policy.communityId)
    const token: string = e.run?.token ?? (community.ok ? community.value.payoutToken : '')
    const autopilot = (extra: Partial<NonNullable<RunViewContext['autopilot']>> = {}) => ({ autopilot: { policyRunId: pr.id, executeAfter: pr.executeAfter ?? pr.updatedAt, vetoedBy: pr.vetoedBy, ...extra } })
    switch (e.kind) {
      case 'generated': {
        if (!e.run) return post(channelId, null, policyRunNoticeMessage(e.policy, pr, { token, approverRoleId: ctx.approverRoleId ?? null }))
        return post(channelId, e.run.id, runMessage(e.run, { ...ctx, ...(pr.status === 'scheduled' ? autopilot() : {}) }))
      }
      case 'released': {
        let receipts: { sent: number; total: number } | undefined
        if (e.run.status === 'paid' && (await deps.notices.claimReceipts(e.run.id))) receipts = { sent: await sendReceipts(deps, e.run), total: e.run.lines.length }
        else if (e.run.status === 'paid') return
        return update(channelId, e.run, runMessage(e.run, { ...ctx, ...(receipts ? { receipts } : {}), ...(e.run.status === 'executing' ? { stillConfirming: true } : {}) }))
      }
      case 'held': {
        if (!e.run) return post(channelId, null, policyRunNoticeMessage(e.policy, pr, { token, approverRoleId: ctx.approverRoleId ?? null }))
        const why = pr.hold ? explainHold(pr.hold, { token: e.run.token, autopilotBy: e.policy.autopilot?.enabledBy ?? null }) : 'Autopilot did not approve this run.'
        // A pending run waits for the normal approval; an approved one that the key could not pay offers Retry.
        return update(channelId, e.run, runMessage(e.run, { ...ctx, ...autopilot({ stopped: why }), ...(e.run.status === 'approved' ? { problem: why } : {}) }))
      }
      case 'cancelled':
        return e.run ? update(channelId, e.run, runMessage(e.run, ctx)) : undefined
    }
  }

  return {
    async announce(events) {
      for (const e of events) {
        try {
          await announceOne(e)
        } catch (error) {
          deps.onError?.(error)
        }
      }
    },
  }
}
