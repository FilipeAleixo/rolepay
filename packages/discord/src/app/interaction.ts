import { DiscordIdSchema, type Result, err, ok } from '@payrun/core'
import { z } from 'zod'
import { InteractionType, OptionType } from '../api.js'

/** Who clicked or typed, as Discord vouches for them in the signed interaction. */
export type Caller = { userId: string; roles: string[]; permissions: bigint }

export type InteractionContext = {
  applicationId: string
  token: string
  guildId: string | null
  channelId: string | null
  caller: Caller
}

export type OptionValue = string | number | boolean

export type ParsedInteraction =
  | { kind: 'ping' }
  | { kind: 'command'; command: string; sub: string | null; options: Record<string, OptionValue>; focused: null; ctx: InteractionContext }
  | { kind: 'autocomplete'; command: string; sub: string | null; options: Record<string, OptionValue>; focused: string | null; ctx: InteractionContext }
  | { kind: 'component'; customId: string; ctx: InteractionContext }

type RawOption = { name: string; type: number; value?: OptionValue; options?: RawOption[]; focused?: boolean }
const OptionSchema: z.ZodType<RawOption> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.number().int(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(OptionSchema).optional(),
    focused: z.boolean().optional(),
  }),
)

const UserSchema = z.object({ id: DiscordIdSchema })
const MemberSchema = z.object({ user: UserSchema, roles: z.array(DiscordIdSchema), permissions: z.string().regex(/^\d+$/) })
const common = {
  application_id: DiscordIdSchema,
  token: z.string().min(1),
  guild_id: DiscordIdSchema.optional(),
  channel_id: DiscordIdSchema.optional(),
  member: MemberSchema.optional(),
  user: UserSchema.optional(),
}
const CommandDataSchema = z.object({ name: z.string(), options: z.array(OptionSchema).optional() })

const InteractionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(InteractionType.Ping) }),
  z.object({ type: z.literal(InteractionType.ApplicationCommand), ...common, data: CommandDataSchema }),
  z.object({ type: z.literal(InteractionType.Autocomplete), ...common, data: CommandDataSchema }),
  z.object({
    type: z.literal(InteractionType.MessageComponent),
    ...common,
    data: z.object({ custom_id: z.string().max(100), component_type: z.number().int() }),
  }),
])

/** Validates an interaction body and flattens it into what handlers need. */
export function parseInteraction(body: unknown): Result<ParsedInteraction, { code: 'unsupported_interaction'; detail: string }> {
  const parsed = InteractionSchema.safeParse(body)
  if (!parsed.success) {
    return err({ code: 'unsupported_interaction', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
  }
  const i = parsed.data
  if (i.type === InteractionType.Ping) return ok({ kind: 'ping' })

  const callerUser = i.member?.user ?? i.user
  if (!callerUser) return err({ code: 'unsupported_interaction', detail: 'no member or user' })
  const ctx: InteractionContext = {
    applicationId: i.application_id,
    token: i.token,
    guildId: i.guild_id ?? null,
    channelId: i.channel_id ?? null,
    caller: { userId: callerUser.id, roles: i.member?.roles ?? [], permissions: i.member ? BigInt(i.member.permissions) : 0n },
  }
  if (i.type === InteractionType.MessageComponent) return ok({ kind: 'component', customId: i.data.custom_id, ctx })

  const top = i.data.options ?? []
  const sub = top.find((o) => o.type === OptionType.SubCommand)
  const leaves = sub ? (sub.options ?? []) : top
  const options: Record<string, OptionValue> = {}
  for (const o of leaves) if (o.value !== undefined) options[o.name] = o.value
  const base = { command: i.data.name, sub: sub?.name ?? null, options, ctx }
  return i.type === InteractionType.Autocomplete
    ? ok({ kind: 'autocomplete', ...base, focused: leaves.find((o) => o.focused)?.name ?? null })
    : ok({ kind: 'command', ...base, focused: null })
}
