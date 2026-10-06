import type { MemberFacts } from '../../domain/proposal/criteria.js'
import type { NamedChannel, NamedRole, SourceMessage } from '../../domain/proposal/sources.js'
import { err, ok } from '../../domain/result.js'
import type { ActivityReader, ReadError } from '../../ports/activityReader.js'

const copy = <T>(v: T): T => structuredClone(v)

/** An in-memory server for proposal tests: roles, channels, members, messages and reactions. */
export class FakeActivityReader implements ActivityReader {
  roles: NamedRole[] = []
  channels: NamedChannel[] = []
  /** Channels the bot cannot read (View Channel or Read Message History missing). */
  readonly forbidden = new Set<string>()
  readonly reads = { history: 0, members: 0 }
  private readonly memberFacts = new Map<string, MemberFacts>()
  private readonly messages = new Map<string, SourceMessage[]>()
  private readonly reacted = new Map<string, { emoji: string; userIds: string[] }[]>()

  setMember(userId: string, facts: MemberFacts) {
    this.memberFacts.set(userId, copy(facts))
  }

  addMessages(...messages: SourceMessage[]) {
    for (const m of messages) this.messages.set(m.channelId, [...(this.messages.get(m.channelId) ?? []), copy(m)])
  }

  setReactions(channelId: string, messageId: string, emoji: string, userIds: string[]) {
    const key = `${channelId}:${messageId}`
    this.reacted.set(key, [...(this.reacted.get(key) ?? []).filter((r) => r.emoji !== emoji), { emoji, userIds: [...userIds] }])
  }

  async guildNames() {
    return { roles: copy(this.roles), channels: copy(this.channels) }
  }

  async members(_guildId: string, userIds: readonly string[]) {
    this.reads.members += userIds.length
    return Object.fromEntries(userIds.map((u) => [u, this.memberFacts.has(u) ? copy(this.memberFacts.get(u) as MemberFacts) : null]))
  }

  private refuse(channelId: string): ReadError | null {
    return this.forbidden.has(channelId) ? { code: 'cannot_read', channelId, reason: 'forbidden' } : null
  }

  async history(input: { channelId: string; since: Date; until: Date; limit: number }) {
    this.reads.history++
    const refused = this.refuse(input.channelId)
    if (refused) return err(refused)
    const inRange = (this.messages.get(input.channelId) ?? [])
      .filter((m) => m.at >= input.since && m.at <= input.until)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
    return ok({ messages: copy(inRange.slice(0, input.limit)), truncated: inRange.length > input.limit })
  }

  async message(input: { channelId: string; messageId: string }) {
    const refused = this.refuse(input.channelId)
    if (refused) return err(refused)
    const m = (this.messages.get(input.channelId) ?? []).find((x) => x.id === input.messageId)
    return m ? ok(copy(m)) : err<ReadError>({ code: 'cannot_read', channelId: input.channelId, reason: 'not_found' })
  }

  async reactions(input: { channelId: string; messageId: string; emoji: string | null; limit: number }) {
    const refused = this.refuse(input.channelId)
    if (refused) return err(refused)
    const all = (this.reacted.get(`${input.channelId}:${input.messageId}`) ?? []).filter((r) => input.emoji === null || r.emoji === input.emoji)
    const userIds = [...new Set(all.flatMap((r) => r.userIds))]
    return ok({ userIds: userIds.slice(0, input.limit), truncated: userIds.length > input.limit })
  }
}
