import type { MemberFacts } from '../domain/proposal/criteria.js'
import type { NamedChannel, NamedRole, SourceMessage } from '../domain/proposal/sources.js'
import type { Result } from '../domain/result.js'

/** `unsupported`: Discord refused the read itself (not a text channel or thread, or an unknown emoji). */
export type ReadError = { code: 'cannot_read'; channelId: string; reason: 'forbidden' | 'not_found' | 'unsupported' }

/**
 * What members of a community did, read from Discord (REST, no gateway). The implementation lives
 * in `@rolepay/discord`; core decides what to read and stays within the bounds (31 days, 10,000
 * messages, 5 channels). Channel history needs View Channel and Read Message History; author IDs
 * need no privileged intent, message text needs the Message Content intent. Bot accounts are
 * marked so code can leave them out.
 */
export interface ActivityReader {
  /** Role and channel names (plus active threads), so the model can match names typed as text. */
  guildNames(guildId: string): Promise<{ roles: NamedRole[]; channels: NamedChannel[] }>
  /** One member lookup each (no GUILD_MEMBERS intent). null = not a member. */
  members(guildId: string, userIds: readonly string[]): Promise<Record<string, MemberFacts | null>>
  /** Messages from `since` to `until`, newest first, at most `limit`. `truncated` = the limit stopped it before `since`. */
  history(input: { channelId: string; since: Date; until: Date; limit: number }): Promise<Result<{ messages: SourceMessage[]; truncated: boolean }, ReadError>>
  message(input: { channelId: string; messageId: string }): Promise<Result<SourceMessage, ReadError>>
  /** Who reacted to a message, with one emoji or (null) any. Bots are left out. */
  reactions(input: { channelId: string; messageId: string; emoji: string | null; limit: number }): Promise<Result<{ userIds: string[]; truncated: boolean }, ReadError>>
}
