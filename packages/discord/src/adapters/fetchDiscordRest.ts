import { type Message, attachmentMeta, multipartBody, splitFiles } from '../api.js'
import type { Result } from '@rolepay/core'
import type { DiscordRest, ReplyHandle, RestError, RestResult } from '../ports.js'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type FetchDiscordRestOptions = {
  botToken: string
  fetch?: Fetch
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
}

const API = 'https://discord.com/api/v10'
const USER_AGENT = 'DiscordBot (https://rolepay.app, 0.1.0)'
const MAX_RATE_LIMIT_RETRIES = 3
/** An edit can race Discord registering our deferred response; give it a moment before calling the token dead. */
const WEBHOOK_404_RETRY_MS = [500, 1500]
const ERR = (error: RestError): RestResult => ({ ok: false, error })
const OK: RestResult = { ok: true, value: undefined }

/** Discord REST over fetch. Expected failures are results; 5xx and network errors throw. */
export class FetchDiscordRest implements DiscordRest {
  private readonly fetch: Fetch
  private readonly baseUrl: string
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: FetchDiscordRestOptions) {
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.baseUrl = opts.baseUrl ?? API
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  editOriginal(reply: ReplyHandle, message: Message) {
    return this.webhook('PATCH', `${hook(reply)}/messages/@original`, message)
  }

  deleteOriginal(reply: ReplyHandle) {
    return this.webhook('DELETE', `${hook(reply)}/messages/@original`)
  }

  followUp(reply: ReplyHandle, message: Message) {
    return this.webhook('POST', hook(reply), message)
  }

  async postToChannel(channelId: string, message: Message): Promise<RestResult> {
    const res = await this.request('POST', `/channels/${channelId}/messages`, { message, bot: true })
    return this.result(res)
  }

  async editChannelMessage(channelId: string, messageId: string, message: Message): Promise<RestResult> {
    return this.result(await this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { message, bot: true }))
  }

  async getGuild(guildId: string): Promise<{ name: string } | null> {
    const res = await this.request('GET', `/guilds/${guildId}`, { bot: true })
    if (res.status === 403 || res.status === 404) return null
    if (!res.ok) throw new Error(`Discord GET guild failed: HTTP ${res.status}`)
    const guild = (await res.json()) as { name?: string }
    return typeof guild.name === 'string' ? { name: guild.name } : null
  }

  async sendDm(userId: string, message: Message): Promise<RestResult> {
    const open = await this.request('POST', '/users/@me/channels', { json: { recipient_id: userId }, bot: true })
    if (!open.ok) return (await code(open)) === 50007 ? ERR({ code: 'dm_closed' }) : this.result(open)
    const channel = (await open.json()) as { id: string }
    const sent = await this.request('POST', `/channels/${channel.id}/messages`, { message, bot: true })
    if (sent.status === 403 && (await code(sent)) === 50007) return ERR({ code: 'dm_closed' })
    return this.result(sent)
  }

  async getMember(guildId: string, userId: string): Promise<{ roles: string[]; joinedAt: Date | null } | null> {
    const res = await this.request('GET', `/guilds/${guildId}/members/${userId}`, { bot: true })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Discord GET guild member failed: HTTP ${res.status}`)
    const member = (await res.json()) as { roles?: string[]; joined_at?: string | null }
    const joined = member.joined_at ? new Date(member.joined_at) : null
    return { roles: member.roles ?? [], joinedAt: joined && !Number.isNaN(joined.getTime()) ? joined : null }
  }

  getChannelMessages(channelId: string, query: { before?: string; limit: number }) {
    return this.read<unknown[]>(`/channels/${channelId}/messages?${page({ limit: query.limit, before: query.before })}`)
  }

  getMessage(channelId: string, messageId: string) {
    return this.read<unknown>(`/channels/${channelId}/messages/${messageId}`)
  }

  getReactions(channelId: string, messageId: string, emoji: string, query: { after?: string; limit: number }) {
    return this.read<unknown[]>(`/channels/${channelId}/messages/${messageId}/reactions/${emoji}?${page({ limit: query.limit, after: query.after })}`)
  }

  getGuildRoles(guildId: string) {
    return this.read<unknown[]>(`/guilds/${guildId}/roles`)
  }

  getGuildChannels(guildId: string) {
    return this.read<unknown[]>(`/guilds/${guildId}/channels`)
  }

  getActiveThreads(guildId: string) {
    return this.read<unknown>(`/guilds/${guildId}/threads/active`)
  }

  /** Registers (overwrites) the application's slash commands, globally or for one guild (instant). */
  async putCommands(input: { applicationId: string; guildId?: string; commands: unknown[] }): Promise<RestResult> {
    const path = input.guildId
      ? `/applications/${input.applicationId}/guilds/${input.guildId}/commands`
      : `/applications/${input.applicationId}/commands`
    return this.result(await this.request('PUT', path, { json: input.commands, bot: true }))
  }

  // ---- internals -------------------------------------------------------------

  /** A GET as the bot. The JSON is returned as Discord sent it: the caller validates the shape. */
  private async read<T>(path: string): Promise<Result<T, RestError>> {
    const res = await this.request('GET', path, { bot: true })
    if (!res.ok) {
      const failed = this.result(res)
      return failed.ok ? { ok: false, error: { code: 'http_error', status: res.status } } : failed
    }
    return { ok: true, value: (await res.json()) as T }
  }

  private async webhook(method: string, path: string, message?: Message): Promise<RestResult> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(method, path, message ? { message } : {})
      if (res.status === 404 && attempt < WEBHOOK_404_RETRY_MS.length) {
        await this.sleep(WEBHOOK_404_RETRY_MS[attempt] as number)
        continue
      }
      if (res.status === 401 || res.status === 404) return ERR({ code: 'token_expired' })
      return this.result(res)
    }
  }

  private async request(method: string, path: string, body: { message?: Message; json?: unknown; bot?: boolean }): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT }
    if (body.bot) headers.authorization = `Bot ${this.opts.botToken}`
    let payload: RequestInit['body']
    if (body.message) {
      const { json, files } = splitFiles(body.message)
      if (files.length) payload = multipartBody({ ...json, attachments: attachmentMeta(files) }, files)
      else payload = JSON.stringify(json)
    } else if (body.json !== undefined) {
      payload = JSON.stringify(body.json)
    }
    if (typeof payload === 'string') headers['content-type'] = 'application/json'

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body: payload })
      if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) {
        if (res.status >= 500) throw new Error(`Discord ${method} ${path.split('/')[1]} failed: HTTP ${res.status}`)
        // Paging through history: when this bucket is empty, wait for it to refill instead of earning a 429.
        if (method === 'GET' && res.headers.get('x-ratelimit-remaining') === '0') {
          const resetAfter = Number(res.headers.get('x-ratelimit-reset-after') ?? 0)
          if (resetAfter > 0) await this.sleep(Math.ceil(Math.min(resetAfter, 60) * 1000))
        }
        return res
      }
      const retryAfter = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? res.headers.get('retry-after') ?? 1)
      await this.sleep(Math.ceil(retryAfter * 1000))
    }
  }

  private result(res: Response): RestResult {
    if (res.ok) return OK
    if (res.status === 403) return ERR({ code: 'forbidden' })
    if (res.status === 404) return ERR({ code: 'not_found' })
    return ERR({ code: 'http_error', status: res.status })
  }
}

const hook = (reply: ReplyHandle) => `/webhooks/${reply.applicationId}/${reply.token}`

/** Query string for a page: limit 1-100, and a cursor if given. */
function page(q: { limit: number; before?: string | undefined; after?: string | undefined }) {
  const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Math.floor(q.limit)))) })
  if (q.before) params.set('before', q.before)
  if (q.after) params.set('after', q.after)
  return params.toString()
}

async function code(res: Response): Promise<number | null> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: number } | null
  return body?.code ?? null
}
