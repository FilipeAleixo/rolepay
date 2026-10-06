import { DiscordIdSchema, type SourceMessage } from '@payrun/core'
import { z } from 'zod'

/**
 * Messages as Discord sends them (the target of a message command, channel history over REST),
 * validated with Zod and turned into core's SourceMessage. Only what payrun reads: author,
 * text, mentions, time, reply target and reactions. Without the Message Content intent Discord
 * sends `content` as "" for other people's messages; everything else is still there.
 */
const UserSchema = z.object({ id: DiscordIdSchema, bot: z.boolean().optional(), username: z.string().optional(), global_name: z.string().nullable().optional() })

export const DiscordMessageSchema = z.object({
  id: DiscordIdSchema,
  channel_id: DiscordIdSchema,
  author: UserSchema,
  content: z.string().default(''),
  mentions: z.array(UserSchema).default([]),
  timestamp: z.string(),
  message_reference: z.object({ message_id: DiscordIdSchema.optional() }).nullable().optional(),
  referenced_message: z.object({ id: DiscordIdSchema, author: UserSchema }).nullable().optional(),
  reactions: z.array(z.object({ emoji: z.object({ id: DiscordIdSchema.nullable().optional(), name: z.string().nullable().optional() }), count: z.number().int() })).optional(),
})
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>

export function toSourceMessage(m: DiscordMessage): SourceMessage {
  const replyId = m.referenced_message?.id ?? m.message_reference?.message_id ?? null
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author.id,
    authorIsBot: m.author.bot === true,
    content: m.content.slice(0, 10_000),
    mentionIds: [...new Set(m.mentions.map((u) => u.id))].slice(0, 100),
    at: new Date(m.timestamp),
    replyTo: replyId ? { messageId: replyId, authorId: m.referenced_message?.author.id ?? null } : null,
  }
}

/** The Discord API's form of an emoji in a reactions URL: the character itself, or `name:id` for a custom one. */
export function emojiParam(emoji: string): string {
  const custom = /^<a?:(\w{1,32}):(\d{17,20})>$/.exec(emoji.trim())
  return encodeURIComponent(custom ? `${custom[1]}:${custom[2]}` : emoji.trim())
}

/** Every snowflake encodes its creation time: the smallest ID created at `at`, for paging history by time. */
export const snowflakeAt = (at: Date) => (BigInt(Math.max(0, at.getTime() - 1_420_070_400_000)) << 22n).toString()
