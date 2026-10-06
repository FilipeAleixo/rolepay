import type { z } from 'zod'
import { explainError } from '../views/errors.js'
import type { DiscordAppDeps } from './deps.js'
import type { InteractionContext, OptionValue } from './interaction.js'
import { type Outcome, ephemeralReply } from './outcome.js'

/** Handlers only ever run inside a server. */
export type GuildContext = InteractionContext & { guildId: string }

export type CommandInput = { options: Record<string, OptionValue>; ctx: GuildContext }
export type CommandHandler = (input: CommandInput, deps: DiscordAppDeps) => Promise<Outcome>
export type AutocompleteHandler = (input: CommandInput & { focused: string | null }, deps: DiscordAppDeps) => Promise<Outcome>
export type ButtonHandler = (input: { runId: string; messageId: string | null; ctx: GuildContext }, deps: DiscordAppDeps) => Promise<Outcome>

/** Parses command options with a Zod schema; a failure comes with the ephemeral reply to send. */
export function parseOptions<S extends z.ZodType>(
  schema: S,
  options: Record<string, OptionValue>,
): { ok: true; value: z.infer<S> } | { ok: false; reply: Outcome } {
  const parsed = schema.safeParse(options)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(options)'}: ${i.message}`)
  return { ok: false, reply: ephemeralReply(explainError({ code: 'invalid_input', issues })) }
}

/** Turns a service error into the ephemeral reply the caller sees. */
export const replyError = (error: { code: string } & Record<string, unknown>, ctx: { token?: string } = {}): Outcome =>
  ephemeralReply(explainError(error, ctx))
