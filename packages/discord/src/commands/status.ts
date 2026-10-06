import { z } from 'zod'
import { type CommandHandler, parseOptions, replyError } from '../app/handlers.js'
import { runMessage } from '../views/run.js'
import { statusMessage } from '../views/status.js'
import { requireOperator } from './guards.js'

const StatusOptions = z.object({ run: z.string().trim().min(1).max(64).optional() })
const RECENT = 10

/**
 * /payrun status: one run in detail (immediate, from the database), or the overview
 * (deferred, because the bot key is read from the chain). Both only for the caller.
 */
export const statusCommand: CommandHandler = async ({ options, ctx }, { payrun, config }) => {
  const guard = await requireOperator(ctx, payrun, 'Reading pay runs')
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(StatusOptions, options)
  if (!parsed.ok) return parsed.reply

  if (parsed.value.run) {
    const run = await payrun.payRuns.get({ guildId: ctx.guildId, runId: parsed.value.run })
    if (!run.ok) return replyError(run.error)
    // Approved but not paid: the job may have been lost in a restart, so offer Retry.
    const problem = run.value.status === 'approved' ? 'Approved, but not paid yet. If it does not start within a minute, press Retry.' : undefined
    return {
      kind: 'reply',
      ephemeral: true,
      // Only the caller sees this reply, so it may carry the node's own error text.
      message: runMessage(run.value, { network: config.network, approverRoleId: guard.community.approverRoleId, showDetail: true, ...(problem ? { problem } : {}) }),
    }
  }

  const guildId = ctx.guildId
  return {
    kind: 'defer',
    ephemeral: true,
    work: async () => {
      const [runs, key] = await Promise.all([payrun.payRuns.list({ guildId, limit: RECENT }), payrun.communities.keyStatus({ guildId })])
      return { ok: true, message: statusMessage({ community: guard.community, runs, key: key.ok ? key.value : null }) }
    },
  }
}
