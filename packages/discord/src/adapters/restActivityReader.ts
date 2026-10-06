import { type ActivityReader, type ChannelKind, DiscordIdSchema, type MemberFacts, type NamedChannel, type ReadError, type Result, type SourceMessage, err, ok } from '@payrun/core'
import { z } from 'zod'
import { ChannelType } from '../api.js'
import type { DiscordRest, RestError } from '../ports.js'
import { DiscordMessageSchema, emojiParam, snowflakeAt, toSourceMessage } from '../wire.js'

const PAGE = 100
/** At most this many reactors per emoji (10 pages). */
const MAX_REACTORS = 1000
const MAX_CHANNELS_LISTED = 250

const RoleSchema = z.object({ id: DiscordIdSchema, name: z.string(), managed: z.boolean().optional() })
const ChannelSchema = z.object({ id: DiscordIdSchema, name: z.string().nullable().optional(), type: z.number().int() })
const ReactorSchema = z.object({ id: DiscordIdSchema, bot: z.boolean().optional() })

const KIND: Partial<Record<number, ChannelKind>> = {
  [ChannelType.Text]: 'text',
  [ChannelType.Announcement]: 'announcement',
  [ChannelType.Forum]: 'forum',
  [ChannelType.Media]: 'forum',
  [ChannelType.AnnouncementThread]: 'thread',
  [ChannelType.PublicThread]: 'thread',
  [ChannelType.PrivateThread]: 'thread',
}

/** Expected refusals become results; anything else (an outage) is thrown. A 400 is Discord refusing the read itself. */
const readError = (channelId: string, e: RestError): ReadError | null =>
  e.code === 'forbidden' || e.code === 'not_found'
    ? { code: 'cannot_read', channelId, reason: e.code }
    : e.code === 'http_error' && e.status === 400
      ? { code: 'cannot_read', channelId, reason: 'unsupported' }
      : null

/**
 * Core's ActivityReader over Discord's REST API, for AI proposals. History is paged newest first
 * (100 per request) back to `since` or up to `limit` messages, whichever comes first; the REST
 * adapter waits when a rate-limit bucket empties. Members are looked up one by one (no privileged
 * intent). Shapes are validated with Zod; a message Discord sends in an unexpected shape is skipped.
 */
export class RestActivityReader implements ActivityReader {
  private readonly concurrency: number

  constructor(
    private readonly rest: Pick<DiscordRest, 'getMember' | 'getChannelMessages' | 'getMessage' | 'getReactions' | 'getGuildRoles' | 'getGuildChannels' | 'getActiveThreads'>,
    opts: { concurrency?: number } = {},
  ) {
    this.concurrency = opts.concurrency ?? 5
  }

  async guildNames(guildId: string) {
    const [roles, channels, threads] = await Promise.all([this.rest.getGuildRoles(guildId), this.rest.getGuildChannels(guildId), this.rest.getActiveThreads(guildId)])
    const list = <T>(r: Result<unknown, RestError>, schema: z.ZodType<T>, pick: (v: unknown) => unknown = (v) => v): T[] => {
      if (!r.ok) return []
      const items = pick(r.value)
      return Array.isArray(items) ? items.flatMap((x) => (schema.safeParse(x).success ? [schema.parse(x)] : [])) : []
    }
    const named = (c: z.infer<typeof ChannelSchema>): NamedChannel[] => {
      const kind = KIND[c.type]
      return kind && c.name ? [{ id: c.id, name: c.name, kind }] : []
    }
    return {
      // @everyone (its ID is the guild's) and roles managed by integrations are not roles people hold by choice.
      roles: list(roles, RoleSchema)
        .filter((r) => r.id !== guildId && !r.managed)
        .map((r) => ({ id: r.id, name: r.name })),
      channels: [...list(channels, ChannelSchema).flatMap(named), ...list(threads, ChannelSchema, (v) => (v as { threads?: unknown })?.threads).flatMap(named)].slice(0, MAX_CHANNELS_LISTED),
    }
  }

  async members(guildId: string, userIds: readonly string[]): Promise<Record<string, MemberFacts | null>> {
    const out: Record<string, MemberFacts | null> = {}
    let next = 0
    const worker = async () => {
      while (next < userIds.length) {
        const id = userIds[next++] as string
        const m = await this.rest.getMember(guildId, id)
        out[id] = m ? { roleIds: m.roles, joinedAt: m.joinedAt } : null
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, userIds.length) }, worker))
    return out
  }

  async history(input: { channelId: string; since: Date; until: Date; limit: number }): Promise<Result<{ messages: SourceMessage[]; truncated: boolean }, ReadError>> {
    const out: SourceMessage[] = []
    // The first page starts at `until` (a snowflake made from the time), later pages at the oldest message seen.
    let before = (BigInt(snowflakeAt(input.until)) + (1n << 22n)).toString()
    while (out.length <= input.limit) {
      const asked = Math.min(PAGE, input.limit + 1 - out.length)
      const page = await this.rest.getChannelMessages(input.channelId, { before, limit: asked })
      if (!page.ok) {
        const e = readError(input.channelId, page.error)
        if (e) return err(e)
        throw new Error(`Discord history read failed: ${page.error.code}`)
      }
      const parsed = page.value.flatMap((raw) => {
        const m = DiscordMessageSchema.safeParse(raw)
        return m.success ? [m.data] : []
      })
      for (const m of parsed) {
        const message = toSourceMessage(m)
        if (message.at < input.since) return ok({ messages: out.slice(0, input.limit), truncated: false })
        if (message.at <= input.until) out.push(message)
      }
      const last = page.value.at(-1) as { id?: unknown } | undefined
      // A short page is the start of the channel.
      if (page.value.length < asked || typeof last?.id !== 'string') break
      before = last.id
    }
    return ok({ messages: out.slice(0, input.limit), truncated: out.length > input.limit })
  }

  async message(input: { channelId: string; messageId: string }): Promise<Result<SourceMessage, ReadError>> {
    const r = await this.rest.getMessage(input.channelId, input.messageId)
    if (!r.ok) {
      const e = readError(input.channelId, r.error)
      if (e) return err(e)
      throw new Error(`Discord message read failed: ${r.error.code}`)
    }
    const m = DiscordMessageSchema.safeParse(r.value)
    return m.success ? ok(toSourceMessage(m.data)) : err({ code: 'cannot_read', channelId: input.channelId, reason: 'not_found' })
  }

  async reactions(input: { channelId: string; messageId: string; emoji: string | null; limit: number }): Promise<Result<{ userIds: string[]; truncated: boolean }, ReadError>> {
    let emojis: string[]
    if (input.emoji !== null) emojis = [emojiParam(input.emoji)]
    else {
      // Any emoji: the message lists its reactions, then each one's users are read.
      const r = await this.rest.getMessage(input.channelId, input.messageId)
      if (!r.ok) {
        const e = readError(input.channelId, r.error)
        if (e) return err(e)
        throw new Error(`Discord message read failed: ${r.error.code}`)
      }
      const m = DiscordMessageSchema.safeParse(r.value)
      emojis = (m.success ? (m.data.reactions ?? []) : []).flatMap((x) => {
        const name = x.emoji.name
        if (!name) return []
        return [encodeURIComponent(x.emoji.id ? `${name}:${x.emoji.id}` : name)]
      })
    }
    const limit = Math.min(input.limit, MAX_REACTORS)
    const users = new Set<string>()
    let truncated = false
    for (const emoji of emojis) {
      let after: string | undefined
      for (;;) {
        const page = await this.rest.getReactions(input.channelId, input.messageId, emoji, { limit: PAGE, ...(after ? { after } : {}) })
        if (!page.ok) {
          const e = readError(input.channelId, page.error)
          if (e) return err(e)
          throw new Error(`Discord reactions read failed: ${page.error.code}`)
        }
        for (const raw of page.value) {
          const u = ReactorSchema.safeParse(raw)
          if (u.success && !u.data.bot) users.add(u.data.id)
        }
        const last = page.value.at(-1) as { id?: unknown } | undefined
        if (page.value.length < PAGE || typeof last?.id !== 'string') break
        if (users.size >= limit) {
          truncated = true
          break
        }
        after = last.id
      }
    }
    return ok({ userIds: [...users].slice(0, limit), truncated: truncated || users.size > limit })
  }
}
