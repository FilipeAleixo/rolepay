import type { SourceMessage } from '@rolepay/core'
import type { Message } from '../api.js'
import type {
  DiscordRest,
  ExecutionJob,
  ExecutionQueue,
  InteractionLog,
  MemberDirectory,
  PendingSources,
  ReplyHandle,
  RestError,
  RestResult,
  RunMessageRef,
  RunNotices,
} from '../ports.js'
import type { WireMessage } from './messages.js'

const OK: RestResult = { ok: true, value: undefined }
const fail = (code: 'forbidden' | 'not_found') => ({ ok: false as const, error: { code } as RestError })
const byIdDesc = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)

/**
 * An in-memory Discord: records every edit, follow-up, channel post and DM, and serves
 * guild members from a map. Faults (expired tokens, closed DMs) are set explicitly.
 */
export class FakeDiscordRest implements DiscordRest {
  readonly edits: { reply: ReplyHandle; message: Message }[] = []
  readonly deletes: ReplyHandle[] = []
  readonly followUps: { reply: ReplyHandle; message: Message }[] = []
  readonly channelPosts: { channelId: string; message: Message; messageId?: string }[] = []
  readonly channelEdits: { channelId: string; messageId: string; message: Message }[] = []
  readonly goneMessages = new Set<string>()
  readonly guilds = new Map<string, string>()
  readonly dms: { userId: string; message: Message }[] = []
  readonly expiredTokens = new Set<string>()
  readonly closedDms = new Set<string>()
  /** Channels the bot may not read (View Channel or Read Message History missing). */
  readonly forbiddenChannels = new Set<string>()
  /** Every read, in order, for tests of paging and bounds. */
  readonly reads: string[] = []
  readonly roles = new Map<string, { id: string; name: string; managed?: boolean }[]>()
  readonly channels = new Map<string, { id: string; name: string; type: number }[]>()
  readonly threads = new Map<string, { id: string; name: string; type: number; parent_id?: string }[]>()
  private members = new Map<string, { roles: string[]; joinedAt: Date | null; name: string | null }>()
  private history = new Map<string, WireMessage[]>()
  private reacted = new Map<string, Map<string, { id: string; bot?: boolean }[]>>()

  setMember(guildId: string, userId: string, roles: string[], joinedAt: Date | null = null, name: string | null = null) {
    this.members.set(`${guildId}:${userId}`, { roles, joinedAt, name })
  }

  /** Messages in a channel or thread, as Discord would send them. */
  addChannelMessages(...messages: WireMessage[]) {
    for (const m of messages) this.history.set(m.channel_id, [...(this.history.get(m.channel_id) ?? []), structuredClone(m)])
  }

  /** Who reacted to a message with an emoji (the character, or `name:id` for a custom one). */
  setReactions(channelId: string, messageId: string, emoji: string, users: { id: string; bot?: boolean }[]) {
    const key = `${channelId}:${messageId}`
    const byEmoji = this.reacted.get(key) ?? new Map()
    byEmoji.set(emoji, users)
    this.reacted.set(key, byEmoji)
  }

  /** The latest edit of a reply (what the user now sees), if any. */
  lastEdit(token: string): Message | undefined {
    return this.edits.filter((e) => e.reply.token === token).at(-1)?.message
  }

  async editOriginal(reply: ReplyHandle, message: Message): Promise<RestResult> {
    if (this.expiredTokens.has(reply.token)) return { ok: false, error: { code: 'token_expired' } }
    this.edits.push({ reply, message })
    return OK
  }

  async deleteOriginal(reply: ReplyHandle): Promise<RestResult> {
    if (this.expiredTokens.has(reply.token)) return { ok: false, error: { code: 'token_expired' } }
    this.deletes.push(reply)
    return OK
  }

  async followUp(reply: ReplyHandle, message: Message): Promise<RestResult> {
    if (this.expiredTokens.has(reply.token)) return { ok: false, error: { code: 'token_expired' } }
    this.followUps.push({ reply, message })
    return OK
  }

  async postToChannel(channelId: string, message: Message): Promise<RestResult> {
    this.channelPosts.push({ channelId, message })
    return OK
  }

  private posted = 0
  async postMessage(channelId: string, message: Message) {
    const messageId = `9${String(++this.posted).padStart(17, '0')}`
    this.channelPosts.push({ channelId, message, messageId })
    return { ok: true as const, value: { messageId } }
  }

  async editChannelMessage(channelId: string, messageId: string, message: Message): Promise<RestResult> {
    if (this.goneMessages.has(messageId)) return { ok: false, error: { code: 'not_found' } }
    this.channelEdits.push({ channelId, messageId, message })
    return OK
  }

  async getGuild(guildId: string) {
    const name = this.guilds.get(guildId)
    return name === undefined ? null : { name }
  }

  async sendDm(userId: string, message: Message): Promise<RestResult> {
    if (this.closedDms.has(userId)) return { ok: false, error: { code: 'dm_closed' } }
    this.dms.push({ userId, message })
    return OK
  }

  async getMember(guildId: string, userId: string) {
    const m = this.members.get(`${guildId}:${userId}`)
    return m ? { roles: [...m.roles], joinedAt: m.joinedAt, name: m.name } : null
  }

  /** Removes someone from a guild (they left, or were kicked). */
  removeMember(guildId: string, userId: string) {
    this.members.delete(`${guildId}:${userId}`)
  }

  async getChannelMessages(channelId: string, query: { before?: string; limit: number }) {
    this.reads.push(`messages ${channelId} before=${query.before ?? ''} limit=${query.limit}`)
    if (this.forbiddenChannels.has(channelId)) return fail('forbidden')
    const before = query.before ? BigInt(query.before) : null
    const page = [...(this.history.get(channelId) ?? [])]
      .sort(byIdDesc)
      .filter((m) => before === null || BigInt(m.id) < before)
      .slice(0, Math.min(100, query.limit))
    return { ok: true as const, value: structuredClone(page) as unknown[] }
  }

  async getMessage(channelId: string, messageId: string) {
    this.reads.push(`message ${channelId} ${messageId}`)
    if (this.forbiddenChannels.has(channelId)) return fail('forbidden')
    const m = (this.history.get(channelId) ?? []).find((x) => x.id === messageId)
    if (!m) return fail('not_found')
    const reactions = [...(this.reacted.get(`${channelId}:${messageId}`) ?? new Map()).entries()].map(([emoji, users]) => {
      const custom = /^(\w+):(\d+)$/.exec(emoji)
      return { emoji: custom ? { id: custom[2], name: custom[1] } : { id: null, name: emoji }, count: users.length }
    })
    return { ok: true as const, value: structuredClone({ ...m, ...(reactions.length ? { reactions } : {}) }) as unknown }
  }

  async getReactions(channelId: string, messageId: string, emoji: string, query: { after?: string; limit: number }) {
    this.reads.push(`reactions ${channelId} ${messageId} ${emoji} after=${query.after ?? ''}`)
    if (this.forbiddenChannels.has(channelId)) return fail('forbidden')
    const users = this.reacted.get(`${channelId}:${messageId}`)?.get(decodeURIComponent(emoji)) ?? []
    const after = query.after ? BigInt(query.after) : null
    const page = [...users].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).filter((u) => after === null || BigInt(u.id) > after)
    return { ok: true as const, value: page.slice(0, Math.min(100, query.limit)).map((u) => ({ ...u, username: `user${u.id.slice(-3)}` })) as unknown[] }
  }

  async getGuildRoles(guildId: string) {
    return { ok: true as const, value: structuredClone(this.roles.get(guildId) ?? []) as unknown[] }
  }

  async getGuildChannels(guildId: string) {
    return { ok: true as const, value: structuredClone(this.channels.get(guildId) ?? []) as unknown[] }
  }

  async getActiveThreads(guildId: string) {
    return { ok: true as const, value: { threads: structuredClone(this.threads.get(guildId) ?? []) } as unknown }
  }
}

/** A queue that only records jobs, for handler tests that should not execute anything. */
export class RecordingQueue implements ExecutionQueue {
  readonly jobs: ExecutionJob[] = []
  async enqueue(job: ExecutionJob) {
    this.jobs.push(job)
  }
}

/** Role membership from a fixed map: `{ [roleId]: userIds }`. */
export class StaticMemberDirectory implements MemberDirectory {
  constructor(private readonly roles: Record<string, string[]>) {}
  async withRole(input: { guildId: string; roleId: string; userIds: string[] }) {
    const holders = new Set(this.roles[input.roleId] ?? [])
    return input.userIds.filter((u) => holders.has(u))
  }
}

/** RunNotices in memory. */
export class MemoryRunNotices implements RunNotices {
  private messages = new Map<string, RunMessageRef>()
  private receipts = new Set<string>()
  async rememberMessage(runId: string, ref: RunMessageRef) {
    this.messages.set(runId, { ...ref })
  }
  async message(runId: string) {
    const m = this.messages.get(runId)
    return m ? { ...m } : null
  }
  async claimReceipts(runId: string) {
    if (this.receipts.has(runId)) return false
    this.receipts.add(runId)
    return true
  }
}

/** InteractionLog in memory. */
export class MemoryInteractionLog implements InteractionLog {
  private ids = new Set<string>()
  async firstSeen(interactionId: string) {
    if (this.ids.has(interactionId)) return false
    this.ids.add(interactionId)
    return true
  }
}

/** PendingSources in memory. */
export class MemoryPendingSources implements PendingSources {
  private sources = new Map<string, SourceMessage>()
  async put(key: { userId: string; messageId: string }, message: SourceMessage) {
    this.sources.set(`${key.userId}:${key.messageId}`, structuredClone(message))
  }
  async take(key: { userId: string; messageId: string }) {
    const k = `${key.userId}:${key.messageId}`
    const m = this.sources.get(k)
    this.sources.delete(k)
    return m ?? null
  }
}
