import type { Result } from '@payrun/core'
import type { Message } from './api.js'

/**
 * Ports: everything the Discord layer needs from the outside world. Each has a real
 * implementation (in this package's adapters or apps/server) and an in-memory fake
 * (`@payrun/discord/testing`).
 */

/** The interaction's webhook: lets us edit the reply or follow up for 15 minutes. */
export type ReplyHandle = { applicationId: string; token: string }

export type RestError =
  | { code: 'token_expired' }
  | { code: 'dm_closed' }
  | { code: 'forbidden' }
  | { code: 'not_found' }
  | { code: 'http_error'; status: number }

export type RestResult = Result<void, RestError>

/** Discord's REST API, as payrun uses it. Expected failures are results; network outages throw. */
export interface DiscordRest {
  /** Edits the interaction's original reply (or, for a button, the message the button is on). */
  editOriginal(reply: ReplyHandle, message: Message): Promise<RestResult>
  deleteOriginal(reply: ReplyHandle): Promise<RestResult>
  followUp(reply: ReplyHandle, message: Message): Promise<RestResult>
  /** Posts as the bot (bot token). The fallback once an interaction token has expired. */
  postToChannel(channelId: string, message: Message): Promise<RestResult>
  /** Opens a DM with the user and posts. `dm_closed` when they do not accept DMs from the server. */
  sendDm(userId: string, message: Message): Promise<RestResult>
  /** One guild member's roles, or null if they are not a member. Needs no privileged intent. */
  getMember(guildId: string, userId: string): Promise<{ roles: string[] } | null>
}

export type ExecutionJob = {
  kind: 'execute_run'
  guildId: string
  runId: string
  /** Where to report: the message with the Approve button. */
  reply: ReplyHandle
  /** Fallback destination when the interaction token has expired. */
  channelId: string | null
}

/** Pays approved runs outside the 3-second interaction window. In-process today; durable later. */
export interface ExecutionQueue {
  enqueue(job: ExecutionJob): Promise<void>
}

/**
 * Who holds a role. Behind a port because the cheap way (one lookup per registered payee)
 * needs no privileged intent, while listing all members needs GUILD_MEMBERS.
 */
export interface MemberDirectory {
  /** Of `userIds`, those who currently hold `roleId` in the guild. Members who left are dropped. */
  withRole(input: { guildId: string; roleId: string; userIds: string[] }): Promise<string[]>
}
