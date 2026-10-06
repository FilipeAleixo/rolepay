import type { Message } from '../api.js'
import type { DiscordRest, ExecutionJob, ExecutionQueue, MemberDirectory, ReplyHandle, RestResult, RunMessageRef, RunNotices } from '../ports.js'

const OK: RestResult = { ok: true, value: undefined }

/**
 * An in-memory Discord: records every edit, follow-up, channel post and DM, and serves
 * guild members from a map. Faults (expired tokens, closed DMs) are set explicitly.
 */
export class FakeDiscordRest implements DiscordRest {
  readonly edits: { reply: ReplyHandle; message: Message }[] = []
  readonly deletes: ReplyHandle[] = []
  readonly followUps: { reply: ReplyHandle; message: Message }[] = []
  readonly channelPosts: { channelId: string; message: Message }[] = []
  readonly channelEdits: { channelId: string; messageId: string; message: Message }[] = []
  readonly goneMessages = new Set<string>()
  readonly guilds = new Map<string, string>()
  readonly dms: { userId: string; message: Message }[] = []
  readonly expiredTokens = new Set<string>()
  readonly closedDms = new Set<string>()
  private members = new Map<string, string[]>()

  setMember(guildId: string, userId: string, roles: string[]) {
    this.members.set(`${guildId}:${userId}`, roles)
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
    const roles = this.members.get(`${guildId}:${userId}`)
    return roles ? { roles: [...roles] } : null
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
