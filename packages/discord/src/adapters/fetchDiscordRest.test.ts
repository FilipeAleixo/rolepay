import { describe, expect, it } from 'vitest'
import { FetchDiscordRest } from './fetchDiscordRest.js'

type Call = { method: string; url: string; headers: Headers; body: RequestInit['body'] }
type Scripted = { status: number; json?: unknown; headers?: Record<string, string> }

function fakeFetch(...responses: Scripted[]) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers: new Headers(init?.headers), body: init?.body })
    const r = responses.shift() ?? { status: 204 }
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    })
  }
  return { fetch, calls }
}

const API = 'https://discord.com/api/v10'
const REPLY = { applicationId: '500000000000000001', token: 'tok-abc' }
const BOT_TOKEN = 'bot-token-value'
const noSleep = async () => {}

describe('FetchDiscordRest', () => {
  it('edits the original reply through the interaction webhook, without the bot token', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: {} })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect(await rest.editOriginal(REPLY, { content: 'paid' })).toEqual({ ok: true, value: undefined })
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toBe(`${API}/webhooks/${REPLY.applicationId}/${REPLY.token}/messages/@original`)
    expect(calls[0]?.headers.get('authorization')).toBeNull()
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ content: 'paid' })
  })

  it('sends files as multipart on an edit', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: {} })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    await rest.editOriginal(REPLY, { content: 'csv', files: [{ name: 'a.csv', contentType: 'text/csv', data: 'x' }] })
    const form = calls[0]?.body as FormData
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({ content: 'csv', attachments: [{ id: 0, filename: 'a.csv' }] })
  })

  it('retries a 404 on the webhook (the edit raced the initial response), then succeeds', async () => {
    const { fetch, calls } = fakeFetch({ status: 404, json: { code: 10008 } }, { status: 200, json: {} })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect((await rest.editOriginal(REPLY, { content: 'x' })).ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('reports an expired interaction token (401 or still 404 after retries)', async () => {
    const expired = fakeFetch({ status: 401, json: { code: 50027 } })
    expect(await new FetchDiscordRest({ botToken: BOT_TOKEN, fetch: expired.fetch, sleep: noSleep }).editOriginal(REPLY, {})).toEqual({
      ok: false,
      error: { code: 'token_expired' },
    })
    const gone = fakeFetch({ status: 404 }, { status: 404 }, { status: 404 })
    expect(await new FetchDiscordRest({ botToken: BOT_TOKEN, fetch: gone.fetch, sleep: noSleep }).editOriginal(REPLY, {})).toEqual({
      ok: false,
      error: { code: 'token_expired' },
    })
  })

  it('waits out a 429 for retry_after and tries again', async () => {
    const slept: number[] = []
    const { fetch, calls } = fakeFetch({ status: 429, json: { retry_after: 1.5 } }, { status: 200, json: {} })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: async (ms) => void slept.push(ms) })
    expect((await rest.followUp(REPLY, { content: 'x' })).ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(slept).toEqual([1500])
  })

  it('DMs a user: opens the DM channel, then posts, with the bot token and a DiscordBot user agent', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: { id: '600000000000000001' } }, { status: 200, json: {} })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect((await rest.sendDm('200000000000000001', { content: 'receipt' })).ok).toBe(true)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${API}/users/@me/channels`, `POST ${API}/channels/600000000000000001/messages`])
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ recipient_id: '200000000000000001' })
    expect(calls[1]?.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`)
    expect(calls[1]?.headers.get('user-agent')).toMatch(/^DiscordBot \(/)
  })

  it('reports dm_closed when the user does not accept DMs (50007)', async () => {
    const { fetch } = fakeFetch({ status: 200, json: { id: '600000000000000001' } }, { status: 403, json: { code: 50007 } })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect(await rest.sendDm('200000000000000001', { content: 'receipt' })).toEqual({ ok: false, error: { code: 'dm_closed' } })
  })

  it('reads one guild member, null when they are not a member', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: { roles: ['400000000000000001'] } }, { status: 404, json: { code: 10007 } })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect(await rest.getMember('1094309218049937418', '200000000000000001')).toEqual({ roles: ['400000000000000001'] })
    expect(await rest.getMember('1094309218049937418', '200000000000000002')).toBeNull()
    expect(calls[0]?.url).toBe(`${API}/guilds/1094309218049937418/members/200000000000000001`)
  })

  it('reads the guild name with the bot token, null when the bot is not in it', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: { id: '1094309218049937418', name: 'Mods guild', roles: [] } }, { status: 404, json: { code: 10004 } })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect(await rest.getGuild('1094309218049937418')).toEqual({ name: 'Mods guild' })
    expect(calls[0]?.url).toBe(`${API}/guilds/1094309218049937418`)
    expect(calls[0]?.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`)
    expect(await rest.getGuild('1094309218049937419')).toBeNull()
  })

  it('edits a channel message as the bot (after the interaction token has expired), not_found when it is gone', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: {} }, { status: 404, json: { code: 10008 } })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect(await rest.editChannelMessage('700000000000000001', '900000000000000001', { content: 'paid' })).toEqual({ ok: true, value: undefined })
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toBe(`${API}/channels/700000000000000001/messages/900000000000000001`)
    expect(calls[0]?.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`)
    expect(await rest.editChannelMessage('700000000000000001', '900000000000000002', { content: 'x' })).toEqual({ ok: false, error: { code: 'not_found' } })
  })

  it('posts to a channel as the bot, and reports forbidden on 403', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: {} }, { status: 403, json: { code: 50013 } })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    expect((await rest.postToChannel('700000000000000001', { content: 'x' })).ok).toBe(true)
    expect(calls[0]?.url).toBe(`${API}/channels/700000000000000001/messages`)
    expect(await rest.postToChannel('700000000000000001', { content: 'x' })).toEqual({ ok: false, error: { code: 'forbidden' } })
  })

  it('registers commands with PUT, for one guild (instant) or globally', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: [] }, { status: 200, json: [] }, { status: 401, json: { code: 0 } })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    const commands = [{ name: 'payrun', description: 'x' }]
    expect((await rest.putCommands({ applicationId: REPLY.applicationId, guildId: '1094309218049937418', commands })).ok).toBe(true)
    expect((await rest.putCommands({ applicationId: REPLY.applicationId, commands })).ok).toBe(true)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${API}/applications/${REPLY.applicationId}/guilds/1094309218049937418/commands`,
      `PUT ${API}/applications/${REPLY.applicationId}/commands`,
    ])
    expect(JSON.parse(calls[0]?.body as string)).toEqual(commands)
    expect(calls[0]?.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`)
    expect(await rest.putCommands({ applicationId: REPLY.applicationId, commands })).toEqual({ ok: false, error: { code: 'http_error', status: 401 } })
  })

  it('throws (unexpected) on a 5xx so the caller can treat it as an outage', async () => {
    const { fetch } = fakeFetch({ status: 502 })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    await expect(rest.getMember('1094309218049937418', '200000000000000001')).rejects.toThrow(/502/)
  })

  it('never puts the bot token in an error message', async () => {
    const { fetch } = fakeFetch({ status: 500 })
    const rest = new FetchDiscordRest({ botToken: BOT_TOKEN, fetch, sleep: noSleep })
    await expect(rest.getMember('1094309218049937418', '200000000000000001')).rejects.not.toThrow(BOT_TOKEN)
  })
})
