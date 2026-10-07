import { DiscordIdSchema, MAX_NOTE_LENGTH, parseAmount } from '@rolepay/core'
import { z } from 'zod'
import { type CommandHandler, parseOptions, replyError } from '../app/handlers.js'
import { type DeferredResult, ephemeralReply } from '../app/outcome.js'
import { phaseTimer } from '../app/timing.js'
import { explainError } from '../views/errors.js'
import { roleMention } from '../views/format.js'
import { runMessage } from '../views/run.js'
import { requireOperator } from './guards.js'
import { parseRecipients } from './recipients.js'

const NewRunOptions = z.object({
  amount: z.string(),
  role: DiscordIdSchema.optional(),
  users: z.string().optional(),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
})

const fail = (content: string): DeferredResult => ({ ok: false, message: { content } })

/**
 * /rolepay new: one amount per person, for registered payees holding `role` and/or the
 * listed `users` (a listed `@bob=40` overrides the amount). Creates the run, submits it
 * for approval and posts the review publicly, so the treasurer can approve in place.
 * Deferred, because role lookups go through Discord.
 */
export const newRunCommand: CommandHandler = async ({ options, ctx }, { rolepay, members, config }) => {
  const guard = await requireOperator(ctx, rolepay, 'Creating a pay run')
  if (!guard.ok) return guard.reply
  const community = guard.community
  const parsed = parseOptions(NewRunOptions, options)
  if (!parsed.ok) return parsed.reply
  const o = parsed.value
  const amount = parseAmount(o.amount.trim())
  if (!amount.ok) return ephemeralReply(`amount: "${o.amount}" is not an amount (${amount.error.code}). Use digits and a dot, for example 12.50.`)
  const listed = parseRecipients(o.users ?? '')
  if (!listed.ok) return replyError(listed.error)
  if (!o.role && listed.value.length === 0) return ephemeralReply('Say who to pay: pick a role, list users, or both.')

  const guildId = ctx.guildId
  const caller = ctx.caller.userId
  return {
    kind: 'defer',
    ephemeral: false,
    work: async () => {
      // For the log line: time on Discord (role holders) and on the database (payees, the run).
      const timer = phaseTimer()
      const done = (result: DeferredResult): DeferredResult => ({ ...result, timings: timer.phases })
      const lines = listed.value.map((r) => ({ discordUserId: r.userId, amount: r.amount ?? amount.value }))
      if (o.role) {
        const role = o.role
        const already = new Set(lines.map((l) => l.discordUserId))
        const candidates = (await timer.time('db', () => rolepay.payees.list({ guildId }))).map((p) => p.discordUserId).filter((id) => !already.has(id))
        const holders = await timer.time('discord', () => members.withRole({ guildId, roleId: role, userIds: candidates }))
        if (holders.length === 0 && lines.length === 0) {
          return done(fail(`No registered payee has ${roleMention(role)}. Members with the role register first with /payee link.`))
        }
        lines.push(...holders.map((id) => ({ discordUserId: id, amount: amount.value })))
      }

      const created = await timer.time('db', () => rolepay.payRuns.create({ guildId, createdBy: caller, note: o.note ?? null, lines }))
      if (!created.ok) return done(fail(explainError(created.error, { token: community.payoutToken })))
      const submitted = await timer.time('db', () => rolepay.payRuns.submit({ guildId, runId: created.value.id, actor: caller }))
      if (!submitted.ok) return done(fail(explainError(submitted.error)))
      return done({ ok: true, message: runMessage(submitted.value, { network: config.network, approverRoleId: community.approverRoleId }) })
    },
  }
}
