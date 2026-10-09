import { z } from 'zod'
import { PROPOSAL_LIMITS } from '../../constants/limits.js'
import { DiscordIdSchema } from '../ids.js'

/**
 * A Discord message as Rolepay reads it. `content` is empty for other people's messages when the
 * bot lacks the Message Content intent; author, mentions, time and reply target are always there.
 */
export const SourceMessageSchema = z.object({
  id: DiscordIdSchema,
  channelId: DiscordIdSchema,
  authorId: DiscordIdSchema,
  authorIsBot: z.boolean(),
  content: z.string().max(10_000),
  mentionIds: z.array(DiscordIdSchema).max(100),
  at: z.date(),
  replyTo: z.object({ messageId: DiscordIdSchema, authorId: DiscordIdSchema.nullable() }).nullable(),
})
export type SourceMessage = z.infer<typeof SourceMessageSchema>

/** A message as the model sees it: tokens instead of IDs, oldest first. */
export type PseudonymizedMessage = { ref: string; author: string; at: string; text: string; replyTo: string | null }

/**
 * How tokens map back to Discord, kept in code (never sent). `text` is the original, for checks in
 * code; `authorIsBot`, so a bot (or webhook) can back a line but never be paid.
 */
export type MessageTokenMap = {
  users: Record<string, string>
  messages: Record<string, { messageId: string; channelId: string; authorId: string; authorIsBot: boolean; text: string }>
}

const USER_MENTION = /<@!?(\d{17,20})>/g
const ROLE_MENTION = /<@&\d{17,20}>/g
const CHANNEL_MENTION = /<#\d{17,20}>/g
const CUSTOM_EMOJI = /<a?:(\w{1,32}):\d{17,20}>/g
const SNOWFLAKE = /(?<!\d)\d{17,20}(?!\d)/g

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * Replaces every user ID and mention with a token (U1, U2, ... in order of first appearance) and
 * every message with M1, M2, ... (oldest first), so no Discord ID reaches the model; the map
 * back stays in code. Roles and channels become "@role" and "#channel". Names typed as plain
 * text cannot be recognised and stay as written (the setup card says so).
 */
export function pseudonymizeMessages(input: { instruction: string; messages: readonly SourceMessage[] }): {
  instruction: string
  messages: PseudonymizedMessage[]
  map: MessageTokenMap
} {
  const users: Record<string, string> = {}
  const tokenOf = new Map<string, string>()
  const token = (userId: string) => {
    let t = tokenOf.get(userId)
    if (!t) {
      t = `U${tokenOf.size + 1}`
      tokenOf.set(userId, t)
      users[t] = userId
    }
    return t
  }
  const scrub = (text: string) =>
    text
      .replace(USER_MENTION, (_m, id: string) => `@${token(id)}`)
      .replace(ROLE_MENTION, '@role')
      .replace(CHANNEL_MENTION, '#channel')
      .replace(CUSTOM_EMOJI, ':$1:')
      .replace(SNOWFLAKE, (id) => tokenOf.get(id) ?? '[id]')

  const sorted = [...input.messages].sort((a, b) => a.at.getTime() - b.at.getTime() || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  const refOf = new Map(sorted.map((m, i) => [m.id, `M${i + 1}`]))
  const messages: MessageTokenMap['messages'] = {}
  const out = sorted.map((m) => {
    const ref = refOf.get(m.id) as string
    const author = token(m.authorId)
    for (const id of [...m.content.matchAll(USER_MENTION)].map((x) => x[1] as string)) token(id)
    for (const id of m.mentionIds) token(id)
    messages[ref] = { messageId: m.id, channelId: m.channelId, authorId: m.authorId, authorIsBot: m.authorIsBot, text: m.content }
    return {
      ref,
      author,
      at: m.at.toISOString(),
      text: cut(scrub(m.content), PROPOSAL_LIMITS.maxMessageChars),
      replyTo: m.replyTo ? (refOf.get(m.replyTo.messageId) ?? null) : null,
    }
  })
  return { instruction: scrub(input.instruction), messages: out, map: { users, messages } }
}

export type ChannelKind = 'text' | 'announcement' | 'forum' | 'thread' | 'other'
export type NamedRole = { id: string; name: string }
export type NamedChannel = { id: string; name: string; kind: ChannelKind }

/** How the tokens in a criteria instruction map back to Discord. Kept in code, never sent. */
export type InstructionRefs = {
  users: Record<string, string>
  roles: Record<string, string>
  channels: Record<string, string>
  messages: Record<string, { channelId: string; messageId: string }>
  /** Custom emoji as the model sees them (":pepe:") to Discord's form ("<:pepe:123...>"). */
  emojis: Record<string, string>
}

/** A token's entry, never an inherited property: "constructor" or "__proto__" from an injected text finds nothing. */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

const MESSAGE_LINK = /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/g
const ROLE_ID = /<@&(\d{17,20})>/g
const CHANNEL_ID = /<#(\d{17,20})>/g

/**
 * Criteria mode: the instruction with roles (R1...), channels (C1...), people (U1...) and links
 * to messages in this server (M1...) as tokens, plus every role and channel of the server by
 * token and name, so the model can match "Mods" or "#help" written as plain text. Links into
 * another server are refused in the text.
 */
export function tokenizeInstruction(
  instruction: string,
  guild: { guildId: string; roles: readonly NamedRole[]; channels: readonly NamedChannel[] },
): { text: string; refs: InstructionRefs; roles: { ref: string; name: string }[]; channels: { ref: string; name: string; kind: ChannelKind }[] } {
  const refs: InstructionRefs = { users: {}, roles: {}, channels: {}, messages: {}, emojis: {} }
  const roles = guild.roles.map((r, i) => ({ ref: `R${i + 1}`, id: r.id, name: cut(r.name, 100) }))
  const channels = guild.channels.map((c, i) => ({ ref: `C${i + 1}`, id: c.id, name: cut(c.name, 100), kind: c.kind }))
  const roleRef = (id: string) => {
    let r = roles.find((x) => x.id === id)
    if (!r) roles.push((r = { ref: `R${roles.length + 1}`, id, name: '(mentioned)' }))
    return r.ref
  }
  const channelRef = (id: string) => {
    let c = channels.find((x) => x.id === id)
    if (!c) channels.push((c = { ref: `C${channels.length + 1}`, id, name: '(mentioned)', kind: 'other' }))
    return c.ref
  }
  const userTokens = new Map<string, string>()
  const userRef = (id: string) => {
    let t = userTokens.get(id)
    if (!t) userTokens.set(id, (t = `U${userTokens.size + 1}`))
    return t
  }
  let messageCount = 0
  const text = instruction
    .replace(MESSAGE_LINK, (_m, g: string, channelId: string, messageId: string) => {
      if (g !== guild.guildId) return '[a link to another server]'
      const ref = `M${++messageCount}`
      refs.messages[ref] = { channelId, messageId }
      return `[message ${ref}]`
    })
    .replace(ROLE_ID, (_m, id: string) => `@${roleRef(id)}`)
    .replace(CHANNEL_ID, (_m, id: string) => `#${channelRef(id)}`)
    .replace(USER_MENTION, (_m, id: string) => `@${userRef(id)}`)
    .replace(CUSTOM_EMOJI, (m: string, name: string) => {
      refs.emojis[`:${name}:`] = m
      return `:${name}:`
    })
    .replace(SNOWFLAKE, '[id]')
  for (const r of roles) refs.roles[r.ref] = r.id
  for (const c of channels) refs.channels[c.ref] = c.id
  for (const [id, t] of userTokens) refs.users[t] = id
  return { text, refs, roles: roles.map(({ ref, name }) => ({ ref, name })), channels: channels.map(({ ref, name, kind }) => ({ ref, name, kind })) }
}

// ---- the way back: tokens in the model's words become names -------------------------------

/**
 * What the tokens of one request stand for: `MessageTokenMap` (people and messages) or
 * `InstructionRefs` (also roles and channels). A kind left out is not a token in that mode, so
 * "R2" in message mode is ordinary text and stays as written.
 */
export type TokenNames = {
  users: Readonly<Record<string, string>>
  messages?: Readonly<Record<string, unknown>>
  roles?: Readonly<Record<string, string>>
  channels?: Readonly<Record<string, string>>
}

/** Discord markup the model wrote itself (it never saw an ID, so it can only have made one up or echoed one of ours). */
const MARKUP = /<(@!?|@&|#)(\d{1,20})>/g
/** "a U token", "M tokens", "a message token": how the model talks about the tokens. Never "a token of thanks" or "the payout token". */
const JARGON = /\b(?:([Aa]n?) )?(?:([UMRC])|([Uu]ser|[Pp]erson|[Mm]essage|[Rr]ole|[Cc]hannel))[- ]([Tt]okens?)\b/g
const NOUN: Record<string, string> = { u: 'mention', user: 'mention', person: 'mention', m: 'message', message: 'message', r: 'role', role: 'role', c: 'channel', channel: 'channel' }
/**
 * A token on its own: "M1" (with the words the model puts around one: "the M1", "message M1",
 * "[message M1]"), "@U2", "@R1", "#C3". Not inside a word or a number ("MU1", "U1x", "U1.5").
 */
const TOKEN = /(?<![\w@#&])(?:\[message (M[1-9]\d{0,3})\]|(?:([Tt]he|[Aa]) )?(?:[Mm]essages? )?(M[1-9]\d{0,3})|[@#]?([URC][1-9]\d{0,3}))(?!\w|\.\d)/g
const SENTENCE_START = /(?:^\s*|[.!?]\s+|\n\s*)$/

/**
 * Each match becomes `to(match)`; a replacement at the start of a sentence starts with a capital,
 * unless the model began it in lower case ("an M token" stays "a message").
 */
function swap(text: string, pattern: RegExp, to: (m: RegExpMatchArray) => string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0
    out += text.slice(last, at)
    const word = to(m)
    out += word !== m[0] && /^[a-z]/.test(word) && !/^[a-z]/.test(m[0]) && SENTENCE_START.test(out) ? `${word[0]?.toUpperCase()}${word.slice(1)}` : word
    last = at + m[0].length
  }
  return out + text.slice(last)
}

/**
 * The model's free text (reasons, notes, assumptions, what it could not resolve) is shown to people,
 * and it writes people and messages as the tokens it was given. This maps them back with the
 * request's own tokens: people, roles and channels to their Discord mentions (`<@id>`, `<@&id>`,
 * `<#id>`, the way lines and criteria name them: read as names, and Rolepay's messages ping
 * nobody), messages to "the message" or "message 2 of 3" (oldest first, or in the order the
 * instruction links them). A token the request never made is a neutral word ("someone", "a
 * message"), never the raw token, and so is any mention the model wrote itself that is not one of
 * the request's: only people, roles and channels of this request survive. Talk about tokens ("not
 * by a U token") becomes plain words ("not by a mention"). Idempotent.
 */
export function detokenize(text: string, names: TokenNames): string {
  const users = new Set(Object.values(names.users))
  const roles = new Set(Object.values(names.roles ?? {}))
  const channels = new Set(Object.values(names.channels ?? {}))
  const messages = names.messages ?? {}
  const count = Object.keys(messages).length

  const marked = swap(text, MARKUP, ([, kind, id = '']) =>
    kind === '#' ? (channels.has(id) ? `<#${id}>` : 'a channel') : kind === '@&' ? (roles.has(id) ? `<@&${id}>` : 'a role') : users.has(id) ? `<@${id}>` : 'someone',
  )
  const plain = swap(marked, JARGON, ([, article, letter, word, tokens = '']) => {
    const noun = `${NOUN[(letter ?? word ?? '').toLowerCase()]}${tokens.toLowerCase().endsWith('s') ? 's' : ''}`
    return article ? `${article[0]} ${noun}` : noun
  })
  return swap(plain, TOKEN, (m) => {
    const [whole, linked, , message, other = ''] = m
    const ref = linked ?? message
    if (ref) {
      if (!names.messages) return whole
      if (own(messages, ref) === undefined) return 'a message'
      return count === 1 ? 'the message' : `message ${ref.slice(1)} of ${count}`
    }
    const id = (table: Readonly<Record<string, string>>) => own(table, other)
    if (other.startsWith('U')) {
      const user = id(names.users)
      return user ? `<@${user}>` : 'someone'
    }
    if (other.startsWith('R')) {
      if (!names.roles) return whole
      const role = id(names.roles)
      return role ? `<@&${role}>` : 'a role'
    }
    if (!names.channels) return whole
    const channel = id(names.channels)
    return channel ? `<#${channel}>` : 'a channel'
  })
}
