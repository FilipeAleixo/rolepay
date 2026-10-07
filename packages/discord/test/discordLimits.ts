// Discord's documented limits for what Rolepay sends, as a validator for the tests: interaction
// responses (the HTTP answer) and messages sent over REST (edits, follow-ups, channel posts, DMs).
// Discord refuses a body that breaks any of these, and for a button the person sees only "This
// interaction failed". Sources (developer docs): Message Resource (content, embeds and their limits,
// allowed mentions), Components (action rows, buttons, text inputs), Receiving and Responding
// (callback types, the flags each accepts, modal and autocomplete limits).
import { z } from 'zod'

export const FLAG = { SuppressEmbeds: 1 << 2, Ephemeral: 1 << 6, SuppressNotifications: 1 << 12, ComponentsV2: 1 << 15 } as const

const EmbedField = z.strictObject({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().optional() })
const Embed = z.strictObject({
  title: z.string().min(1).max(256).optional(),
  description: z.string().min(1).max(4096).optional(),
  url: z.url().optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  fields: z.array(EmbedField).max(25).optional(),
  footer: z.strictObject({ text: z.string().min(1).max(2048) }).optional(),
  timestamp: z.iso.datetime().optional(),
})
const CustomId = z.string().min(1).max(100)
const ActionButton = z.strictObject({
  type: z.literal(2),
  style: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  label: z.string().min(1).max(80),
  custom_id: CustomId,
  disabled: z.boolean().optional(),
})
const LinkButton = z.strictObject({ type: z.literal(2), style: z.literal(5), label: z.string().min(1).max(80), url: z.url().max(512), disabled: z.boolean().optional() })
const ActionRow = z.strictObject({ type: z.literal(1), components: z.array(z.union([ActionButton, LinkButton])).min(1).max(5) })
const AllowedMentions = z
  .strictObject({ parse: z.array(z.enum(['roles', 'users', 'everyone'])), users: z.array(z.string()).max(100).optional(), roles: z.array(z.string()).max(100).optional() })
  .refine((m) => !(m.users && m.parse.includes('users')) && !(m.roles && m.parse.includes('roles')), 'allowed_mentions cannot list users (roles) and also parse them')

/** A message body in JSON: what a reply, an update, an edit, a follow-up or a post carries. */
const MessageBody = z
  .strictObject({
    content: z.string().max(2000).optional(),
    embeds: z.array(Embed).max(10).optional(),
    components: z.array(ActionRow).max(5).optional(),
    allowed_mentions: AllowedMentions.optional(),
    flags: z.number().int().nonnegative().optional(),
    attachments: z.array(z.strictObject({ id: z.number().int(), filename: z.string().min(1) })).max(10).optional(),
  })
  .superRefine((m, ctx) => {
    // Every embed's title, description, field names and values and footer text count toward one 6000 limit.
    const chars = (m.embeds ?? []).reduce(
      (n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((f, x) => f + x.name.length + x.value.length, 0),
      0,
    )
    if (chars > 6000) ctx.addIssue({ code: 'custom', message: `embeds carry ${chars} characters, over 6000` })
    const ids = (m.components ?? []).flatMap((row) => row.components.flatMap((b) => ('custom_id' in b ? [b.custom_id] : [])))
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'a custom_id appears twice in one message' })
  })

const TextInput = z.strictObject({
  type: z.literal(4),
  custom_id: CustomId,
  label: z.string().min(1).max(45),
  style: z.union([z.literal(1), z.literal(2)]),
  min_length: z.number().int().min(0).max(4000).optional(),
  max_length: z.number().int().min(1).max(4000).optional(),
  required: z.boolean().optional(),
  value: z.string().max(4000).optional(),
  placeholder: z.string().max(100).optional(),
})
/** Markdown text above a modal's inputs (Components: Text Display, allowed in messages and modals). */
const TextDisplay = z.strictObject({ type: z.literal(10), content: z.string().min(1).max(4000) })
const Modal = z.strictObject({
  custom_id: CustomId,
  title: z.string().min(1).max(45),
  components: z
    .array(z.union([z.strictObject({ type: z.literal(1), components: z.tuple([TextInput]) }), TextDisplay]))
    .min(1)
    .max(5)
    .refine((cs) => cs.some((c) => c.type === 1), 'a modal needs at least one input'),
})
const Choices = z.strictObject({ choices: z.array(z.strictObject({ name: z.string().min(1).max(100), value: z.string().max(100) })).max(25) })

type Parsed = { success: true } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }
const issues = (r: Parsed, where: string) =>
  r.success ? [] : r.error.issues.map((i) => `${where}${i.path.length ? `.${i.path.map(String).join('.')}` : ''}: ${i.message}`)

function flagProblems(flags: number | undefined, allowed: number, where: string): string[] {
  const extra = (flags ?? 0) & ~allowed
  return extra ? [`${where}.flags: ${extra} is not allowed here`] : []
}

const hasBody = (m: z.infer<typeof MessageBody>) => Boolean(m.content || m.embeds?.length || m.components?.length || m.attachments?.length)

/**
 * What Discord would refuse in an interaction response, as readable lines (empty: acceptable).
 * `multipart`: the body travels with files, so `attachments` may describe them.
 */
export function responseProblems(body: { type: number; data?: unknown }, opts: { multipart?: boolean } = {}): string[] {
  const data = body.data
  switch (body.type) {
    case 1:
    case 6:
      return data === undefined ? [] : [`type ${body.type} carries no data`]
    case 4:
    case 7: {
      const parsed = MessageBody.safeParse(data ?? {})
      if (!parsed.success) return issues(parsed, `type ${body.type}`)
      const m = parsed.data
      const out: string[] = []
      if (body.type === 4) {
        out.push(...flagProblems(m.flags, FLAG.Ephemeral | FLAG.SuppressEmbeds | FLAG.SuppressNotifications | FLAG.ComponentsV2, 'type 4'))
        if (!hasBody(m)) out.push('type 4: a message needs content, an embed, a component or a file')
      } else {
        // UPDATE_MESSAGE edits the message the component is on: it cannot make it ephemeral (or public).
        out.push(...flagProblems(m.flags, FLAG.SuppressEmbeds | FLAG.ComponentsV2, 'type 7'))
      }
      if (m.attachments && !opts.multipart) out.push(`type ${body.type}: attachments without the files (a JSON body)`)
      return out
    }
    case 5: {
      const parsed = z.strictObject({ flags: z.number().int().nonnegative().optional() }).safeParse(data ?? {})
      if (!parsed.success) return issues(parsed, 'type 5')
      return flagProblems(parsed.data.flags, FLAG.Ephemeral, 'type 5')
    }
    case 8:
      return issues(Choices.safeParse(data), 'type 8')
    case 9:
      return issues(Modal.safeParse(data), 'type 9')
    default:
      return [`type ${body.type} is not an interaction response type`]
  }
}

/**
 * What Discord would refuse in a message sent over REST: an interaction edit or follow-up, a
 * channel post or edit, a DM. Files travel as multipart, so `files` stands for attachments here.
 * `ephemeral`: the message may carry the ephemeral flag (a follow-up only).
 */
export function messageProblems(message: Record<string, unknown>, opts: { ephemeral?: boolean } = {}): string[] {
  const { files, ...json } = message as { files?: { name: string }[] } & Record<string, unknown>
  const body = files?.length ? { ...json, attachments: files.map((f, i) => ({ id: i, filename: f.name })) } : json
  const parsed = MessageBody.safeParse(body)
  if (!parsed.success) return issues(parsed, 'message')
  const out = flagProblems(parsed.data.flags, FLAG.SuppressEmbeds | FLAG.SuppressNotifications | FLAG.ComponentsV2 | (opts.ephemeral ? FLAG.Ephemeral : 0), 'message')
  if (!hasBody(parsed.data)) out.push('message: needs content, an embed, a component or a file')
  return out
}
