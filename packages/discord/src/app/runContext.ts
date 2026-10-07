import type { Rolepay, Run } from '@rolepay/core'
import { type AutopilotRelease, releasedOnAutopilot } from '../views/run.js'

/**
 * For a run a policy's autopilot released after its veto window: what its status says instead of
 * "Approved by" (who approved the policy version that made it). Nothing for any other run. For
 * every place that shows a run without the scheduler's event at hand: the executor (Retry), the
 * recovery sweep's report, the Retry button and /rolepay status. One read for a run made by hand;
 * a second only when the policy has a newer version than the one that made the run.
 */
export async function autopilotReleaseOf(rolepay: Rolepay, run: Run): Promise<{ released?: AutopilotRelease }> {
  if (!run.approvedAt) return {}
  const origin = await rolepay.policies.runFor({ guildId: run.communityId, runId: run.id })
  if (!origin) return {}
  const { policy, policyRun } = origin
  if (!releasedOnAutopilot(run, policyRun, null)) return {}
  let approvedBy = policy.approvedBy
  if (policy.version !== policyRun.policyVersion) {
    const detail = await rolepay.policies.detail({ guildId: run.communityId, policyId: policy.id, runs: 1 })
    approvedBy = detail.ok ? (detail.value.versions.find((v) => v.version === policyRun.policyVersion)?.approvedBy ?? null) : null
  }
  const released = releasedOnAutopilot(run, policyRun, approvedBy)
  return released ? { released } : {}
}
