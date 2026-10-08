import { type Community, type NetworkName, type Policy, type PolicyRun, type Rolepay, type Run, type SchedulerEvent, quietWhenEmpty } from '@rolepay/core'
import type { Message } from '../api.js'
import { type TreasuryEvent, postForTreasurer, postRunForTreasurer, updateRunMessages } from '../app/treasury.js'
import type { DiscordRest, PolicyAnnouncer, RunNotices } from '../ports.js'
import { explainHold, policyRunNoticeMessage } from '../views/policy.js'
import { type RunViewContext, releasedOnAutopilot, runMessage } from '../views/run.js'
import { sendReceipts } from './receipts.js'

export type PolicyNotifierDeps = {
  rolepay: Rolepay
  rest: DiscordRest
  /** Where each run's message is and whether its receipts went out, shared with the executor and the recovery sweep. */
  notices: RunNotices
  network: NetworkName
  /** The server's account page, linked from every receipt. */
  accountUrl?: string | null
  /** Rolepay found #treasury, or could not post in the treasury channel (the message went to the policy's channel). */
  onTreasury?: (event: TreasuryEvent) => void
  onError?: (error: unknown) => void
}

/**
 * Tells each policy's channel what the scheduler did. A new run is posted as the bot (and its
 * message remembered, so the executor, the recovery sweep and this notifier edit that same
 * message later): propose-mode runs with the normal review embed (Approve and Cancel), autopilot
 * runs with when they pay and a Veto button, held runs with why and the numbers, empty periods in
 * one line (a daily policy's empty days in none: the audit log has them). When autopilot releases
 * a run, the message becomes the result (receipts go out once); when autopilot stops, it becomes
 * the normal review with why; when the run is vetoed elsewhere (the web dashboard), it says who
 * vetoed it. A policy with no channel posts nothing, but its payees still get their receipts. It
 * never throws: a failure is reported and the next event goes on.
 *
 * With a treasury channel (set by a Treasurer, or a channel named "treasury" found when the first
 * such message is posted), what needs a Treasurer goes there with its buttons: a run to approve or
 * to veto, a held run. The policy's channel gets the same run without the buttons, and every later
 * update reaches both. A policy with no channel posts its runs in the treasury channel alone. When
 * Rolepay cannot post in the treasury channel, the run goes to the policy's channel with its
 * buttons, as without one, and that is reported (`onTreasury`).
 */
export function createPolicyNotifier(deps: PolicyNotifierDeps): PolicyAnnouncer {
  const treasury = { rolepay: deps.rolepay, rest: deps.rest, notices: deps.notices, ...(deps.onTreasury ? { onTreasury: deps.onTreasury } : {}), ...(deps.onError ? { onError: deps.onError } : {}) }

  function context(community: Community | null, policy: Policy, pr: PolicyRun): RunViewContext {
    return {
      network: deps.network,
      approverRoleId: community?.approverRoleId ?? null,
      policy: { name: policy.name, version: pr.policyVersion, periodStart: pr.periodStart, periodEnd: pr.periodEnd },
    }
  }

  async function post(channelId: string, runId: string | null, message: Message) {
    const posted = await deps.rest.postMessage(channelId, message)
    if (runId) await deps.notices.rememberMessage(runId, { channelId, messageId: posted.ok ? posted.value.messageId : null })
  }

  /** A new run: its buttons in the treasury channel when there is one (its copy without them here), else here with them. */
  async function postRun(community: Community | null, channelId: string | null, run: Run, view: (mirror: boolean) => Message) {
    const routed = community ? await postRunForTreasurer(treasury, { community, runId: run.id, view, channelId }) : { routed: false as const }
    if (!routed.routed && channelId) await post(channelId, run.id, view(false))
  }

  /** A run held whole (no pay run): a Treasurer looks at it in the treasury channel; the policy's channel is told too. */
  async function postHeld(community: Community | null, channelId: string | null, message: Message) {
    if (community) await postForTreasurer(treasury, community, message, channelId)
    if (channelId) await post(channelId, null, message)
  }

  /** Edits the run's messages where they were posted, or posts the update there if they cannot be edited. */
  const update = (channelId: string | null, run: Run, view: (mirror: boolean) => Message) =>
    updateRunMessages(treasury, run, view, channelId ? { channelId, messageId: null } : null)

  async function announceOne(e: SchedulerEvent) {
    const channelId = e.policy.channelId
    const read = await deps.rolepay.communities.get(e.policy.communityId)
    const community = read.ok ? read.value : null
    // A policy with no channel posts nothing, unless there is a treasury channel (or may be one to find); a paid run's receipts still go out (below).
    const treasuryMayPost = community !== null && (community.treasuryChannelId !== null || community.treasuryChannelSource === 'unset')
    if (!channelId && !treasuryMayPost && e.kind !== 'released') return
    /** For a policy with no channel, a run is updated only where it was posted: in the treasury channel. */
    const postedForTreasurer = async (run: Run) => community?.treasuryChannelId != null && (await deps.notices.message(run.id))?.channelId === community.treasuryChannelId
    const pr = e.policyRun
    const ctx = context(community, e.policy, pr)
    const token: string = e.run?.token ?? community?.payoutToken ?? ''
    const autopilot = (extra: Partial<NonNullable<RunViewContext['autopilot']>> = {}) => ({ autopilot: { policyRunId: pr.id, executeAfter: pr.executeAfter ?? pr.updatedAt, vetoedBy: pr.vetoedBy, ...extra } })
    const views = (run: Run, extra: Omit<RunViewContext, 'network'>) => (mirror: boolean) => runMessage(run, { ...ctx, ...extra, mirror })
    switch (e.kind) {
      case 'generated': {
        if (!e.run) {
          // Nobody matched: a daily policy stays quiet (no run was made, the audit log records the day).
          if (pr.status === 'empty' && quietWhenEmpty(e.policy.schedule)) return
          const notice = policyRunNoticeMessage(e.policy, pr, { token, approverRoleId: ctx.approverRoleId ?? null })
          // Nobody to pay is not a Treasurer's to act on: only the policy's channel hears of it.
          if (pr.status === 'empty') return channelId ? post(channelId, null, notice) : undefined
          return postHeld(community, channelId, notice)
        }
        return postRun(community, channelId, e.run, views(e.run, pr.status === 'scheduled' ? autopilot() : {}))
      }
      case 'released': {
        let receipts: { sent: number; total: number } | undefined
        if (e.run.status === 'paid' && (await deps.notices.claimReceipts(e.run.id))) receipts = { sent: await sendReceipts(deps, e.run), total: e.run.lines.length }
        else if (e.run.status === 'paid') return
        if (!channelId && !(await postedForTreasurer(e.run))) return
        // Autopilot approved it, nobody approved this run: say so, with who approved the rule (the release checked the version).
        const released = releasedOnAutopilot(e.run, pr, e.policy.version === pr.policyVersion ? e.policy.approvedBy : null)
        return update(channelId, e.run, views(e.run, { ...(released ? { released } : {}), ...(receipts ? { receipts } : {}), ...(e.run.status === 'executing' ? { stillConfirming: true } : {}) }))
      }
      case 'held': {
        if (!e.run) return postHeld(community, channelId, policyRunNoticeMessage(e.policy, pr, { token, approverRoleId: ctx.approverRoleId ?? null }))
        if (!channelId && !(await postedForTreasurer(e.run))) return
        const why = pr.hold ? explainHold(pr.hold, { token: e.run.token, autopilotBy: e.policy.autopilot?.enabledBy ?? null }) : 'Autopilot did not approve this run.'
        // A pending run waits for the normal approval; an approved one that the key could not pay offers Retry.
        return update(channelId, e.run, views(e.run, { ...autopilot({ stopped: why }), ...(e.run.status === 'approved' ? { problem: why } : {}) }))
      }
      case 'cancelled':
        // Cancelled during the window: by a veto (the dashboard's, say), or by hand.
        if (!e.run || (!channelId && !(await postedForTreasurer(e.run)))) return
        return update(channelId, e.run, views(e.run, pr.vetoedBy ? autopilot() : {}))
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
