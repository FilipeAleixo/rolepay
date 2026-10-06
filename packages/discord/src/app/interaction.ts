import { DiscordIdSchema, type Result, type SourceMessage, err, ok } from '@payrun/core'
import { z } from 'zod'
import { CommandType, ComponentType, InteractionType, OptionType } from '../api.js'
import { DiscordMessageSchema, toSourceMessage } from '../wire.js'

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
  | { kind: 'component'; customId: string; messageId: string | null; ctx: InteractionContext }
  /** A right-click command on a message (Apps > ...): the message arrives in the interaction, text included, with no intent. */
  | { kind: 'message_command'; command: string; target: SourceMessage; ctx: InteractionContext }
  /** A modal's form, by text input custom_id. `messageId` is the message whose button opened it, if any. */
  | { kind: 'modal'; customId: string; fields: Record<string, string>; messageId: string | null; ctx: InteractionContext }

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
const CommandDataSchema = z.object({ name: z.string(), type: z.number().int().optional(), options: z.array(OptionSchema).optional() })
const MessageCommandDataSchema = z.object({
  name: z.string(),
  type: z.literal(CommandType.Message),
  target_id: DiscordIdSchema,
  resolved: z.object({ messages: z.record(z.string(), z.unknown()) }),
})
type ModalField = { type: number; custom_id?: string; value?: string; component?: ModalField; components?: ModalField[] }
const ModalFieldSchema: z.ZodType<ModalField> = z.lazy(() =>
  z.object({
    type: z.number().int(),
    custom_id: z.string().optional(),
    value: z.string().optional(),
    component: ModalFieldSchema.optional(),
    components: z.array(ModalFieldSchema).optional(),
  }),
)

const InteractionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(InteractionType.Ping) }),
  z.object({ type: z.literal(InteractionType.ApplicationCommand), ...common, data: z.union([MessageCommandDataSchema, CommandDataSchema]) }),
  z.object({ type: z.literal(InteractionType.Autocomplete), ...common, data: CommandDataSchema }),
  z.object({
    type: z.literal(InteractionType.MessageComponent),
    ...common,
    data: z.object({ custom_id: z.string().max(100), component_type: z.number().int() }),
    message: z.object({ id: DiscordIdSchema }).optional(),
  }),
  z.object({
    type: z.literal(InteractionType.ModalSubmit),
    ...common,
    data: z.object({ custom_id: z.string().max(100), components: z.array(ModalFieldSchema).max(10) }),
    message: z.object({ id: DiscordIdSchema }).optional(),
  }),
])

/** Text inputs of a modal, whether in action rows (the classic form) or in labels (the newer one). */
function modalFields(components: readonly ModalField[]): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (c: ModalField) => {
    if (c.type === ComponentType.TextInput && c.custom_id !== undefined) out[c.custom_id] = c.value ?? ''
    if (c.component) visit(c.component)
    for (const child of c.components ?? []) visit(child)
  }
  components.forEach(visit)
  return out
}

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
  if (i.type === InteractionType.MessageComponent) return ok({ kind: 'component', customId: i.data.custom_id, messageId: i.message?.id ?? null, ctx })
  if (i.type === InteractionType.ModalSubmit) return ok({ kind: 'modal', customId: i.data.custom_id, fields: modalFields(i.data.components), messageId: i.message?.id ?? null, ctx })
  if ('target_id' in i.data) {
    const target = DiscordMessageSchema.safeParse(i.data.resolved.messages[i.data.target_id])
    if (!target.success) return err({ code: 'unsupported_interaction', detail: 'the target message is missing or malformed' })
    return ok({ kind: 'message_command', command: i.data.name, target: toSourceMessage(target.data), ctx })
  }

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
