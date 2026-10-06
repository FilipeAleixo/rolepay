/**
 * Builders for raw interaction bodies, shaped like what Discord sends, for tests of
 * the router and of the HTTP endpoint end to end.
 */
import type { WireMessage } from './messages.js'

type OptionValue = string | number | boolean

/** `channels`: the caller's permissions in channels picked in options (Discord sends them as `resolved.channels`). */
export type Who = { userId: string; roles?: string[]; manageGuild?: boolean; channels?: Record<string, bigint> }

const APP = '500000000000000001'
let seq = 0
const nextId = () => `8${String(++seq).padStart(17, '0')}`

function member(who: Who) {
  return { user: { id: who.userId, username: `user${who.userId.slice(-3)}` }, roles: who.roles ?? [], permissions: who.manageGuild ? String(1n << 5n) : '0' }
}

function options(values: Record<string, OptionValue | undefined>, focused?: string) {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([name, value]) => ({
      name,
      type: typeof value === 'boolean' ? 5 : typeof value === 'number' ? 4 : 3,
      value,
      ...(name === focused ? { focused: true } : {}),
    }))
}

export type InteractionScope = { guildId: string | null; channelId?: string; applicationId?: string }

export function slashCommand(
  scope: InteractionScope,
  command: string,
  sub: string,
  values: Record<string, OptionValue | undefined>,
  who: Who,
  token = `tok-${command}-${sub}-${seq + 1}`,
) {
  return {
    id: nextId(),
    application_id: scope.applicationId ?? APP,
    type: 2,
    token,
    ...(scope.guildId ? { guild_id: scope.guildId, member: member(who) } : { user: { id: who.userId, username: 'dm' } }),
    ...(scope.channelId ? { channel_id: scope.channelId } : {}),
    data: {
      id: '900000000000000001',
      name: command,
      type: 1,
      options: [{ type: 1, name: sub, options: options(values) }],
      ...(who.channels ? { resolved: { channels: Object.fromEntries(Object.entries(who.channels).map(([id, p]) => [id, { id, type: 0, permissions: String(p) }])) } } : {}),
    },
  }
}

/** View Channel and Read Message History: what a member needs to read a channel's history. */
export const READ_HISTORY = (1n << 10n) | (1n << 16n)

export function autocomplete(scope: InteractionScope, command: string, sub: string, values: Record<string, OptionValue>, focused: string, who: Who) {
  return {
    ...slashCommand(scope, command, sub, {}, who),
    type: 4,
    data: { id: '900000000000000001', name: command, type: 1, options: [{ type: 1, name: sub, options: options(values, focused) }] },
  }
}

export function buttonClick(scope: InteractionScope, customId: string, who: Who, token = `tok-click-${seq + 1}`) {
  return {
    id: nextId(),
    application_id: scope.applicationId ?? APP,
    type: 3,
    token,
    guild_id: scope.guildId,
    channel_id: scope.channelId ?? '700000000000000001',
    member: member(who),
    message: { id: '810000000000000001' },
    data: { custom_id: customId, component_type: 2 },
  }
}

/** A right-click command on a message (type 3): Discord sends the target message in `resolved`. */
export function messageCommand(scope: InteractionScope, name: string, target: WireMessage, who: Who, token = `tok-msgcmd-${seq + 1}`) {
  return {
    id: nextId(),
    application_id: scope.applicationId ?? APP,
    type: 2,
    token,
    ...(scope.guildId ? { guild_id: scope.guildId, member: member(who) } : { user: { id: who.userId, username: 'dm' } }),
    channel_id: scope.channelId ?? target.channel_id,
    data: { id: '900000000000000002', name, type: 3, target_id: target.id, resolved: { messages: { [target.id]: target } } },
  }
}

/** A submitted modal (type 5), its text inputs in action rows. `messageId`: the message whose button opened it. */
export function modalSubmit(scope: InteractionScope, customId: string, fields: Record<string, string>, who: Who, opts: { messageId?: string; token?: string } = {}) {
  return {
    id: nextId(),
    application_id: scope.applicationId ?? APP,
    type: 5,
    token: opts.token ?? `tok-modal-${seq + 1}`,
    guild_id: scope.guildId,
    channel_id: scope.channelId ?? '700000000000000001',
    member: member(who),
    ...(opts.messageId ? { message: { id: opts.messageId } } : {}),
    data: { custom_id: customId, components: Object.entries(fields).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })) },
  }
}

export const ping = () => ({ id: nextId(), application_id: APP, type: 1, token: 'tok-ping', version: 1 })
