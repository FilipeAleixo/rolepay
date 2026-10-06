/**
 * Builders for Discord messages as the API and interactions carry them, for tests of history
 * reads and message commands. IDs are snowflakes made from the time, as Discord's are, so paging
 * by time works in the fake as it does on Discord.
 */
export type WireUser = { id: string; username?: string; bot?: boolean }
export type WireMessage = {
  id: string
  channel_id: string
  author: WireUser
  content: string
  mentions: WireUser[]
  timestamp: string
  message_reference?: { message_id: string } | null
  referenced_message?: { id: string; author: WireUser } | null
}

const EPOCH = 1_420_070_400_000n
let seq = 0

export function wireMessage(m: {
  channelId: string
  authorId: string
  at: Date
  content?: string
  mentions?: string[]
  bot?: boolean
  id?: string
  replyTo?: { id: string; authorId: string }
}): WireMessage {
  const id = m.id ?? (((BigInt(m.at.getTime()) - EPOCH) << 22n) + BigInt(++seq % 4096)).toString()
  return {
    id,
    channel_id: m.channelId,
    author: { id: m.authorId, username: `user${m.authorId.slice(-3)}`, ...(m.bot ? { bot: true } : {}) },
    content: m.content ?? '',
    mentions: (m.mentions ?? []).map((u) => ({ id: u, username: `user${u.slice(-3)}` })),
    timestamp: m.at.toISOString(),
    ...(m.replyTo ? { message_reference: { message_id: m.replyTo.id }, referenced_message: { id: m.replyTo.id, author: { id: m.replyTo.authorId } } } : {}),
  }
}
