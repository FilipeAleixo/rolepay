import { z } from 'zod'
import { type CommandHandler, parseOptions, replyError } from '../app/handlers.js'
import { ephemeralReply } from '../app/outcome.js'
import { requireOperator } from './guards.js'

const ExportOptions = z.object({ run: z.string().trim().min(1).max(64).optional() })

/** /payrun export: the run (default: the latest) as a CSV attachment, only for the caller. */
export const exportCommand: CommandHandler = async ({ options, ctx }, { rolepay }) => {
  const guard = await requireOperator(ctx, rolepay, 'Exporting pay runs')
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(ExportOptions, options)
  if (!parsed.ok) return parsed.reply

  const runId = parsed.value.run ?? (await rolepay.payRuns.list({ guildId: ctx.guildId, limit: 1 }))[0]?.id
  if (!runId) return ephemeralReply('No pay runs yet. Create one with `/payrun new`.')
  const exported = await rolepay.payRuns.exportCsv({ guildId: ctx.guildId, runId })
  if (!exported.ok) return replyError(exported.error)
  return {
    kind: 'reply',
    ephemeral: true,
    message: {
      content: `Pay run ${runId} as CSV, one row per person. Amounts have 6 decimals; links point at the explorer.`,
      files: [{ name: exported.value.filename, contentType: 'text/csv; charset=utf-8', data: exported.value.csv }],
    },
  }
}
