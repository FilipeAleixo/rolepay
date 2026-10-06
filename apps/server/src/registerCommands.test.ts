import { COMMAND_DEFINITIONS } from '@payrun/discord'
import { describe, expect, it } from 'vitest'
import { registerCommands } from './registerCommands.js'

function fakeFetch(status = 200) {
  const calls: { url: string; method: string; body: string }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body) })
    return new Response(status === 200 ? '[]' : '{"code":0}', { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

const env = { DISCORD_APP_ID: '500000000000000001', DISCORD_BOT_TOKEN: 'secret-token' }

describe('registerCommands', () => {
  it('PUTs the command definitions for the dev guild when one is set (instant)', async () => {
    const { fetch, calls } = fakeFetch()
    const r = await registerCommands({ ...env, DISCORD_DEV_GUILD_ID: '1094309218049937418' }, fetch)
    expect(r).toEqual({ ok: true, value: { count: COMMAND_DEFINITIONS.length, scope: 'guild 1094309218049937418' } })
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toMatch(/\/applications\/500000000000000001\/guilds\/1094309218049937418\/commands$/)
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual(COMMAND_DEFINITIONS)
  })

  it('registers globally without a dev guild', async () => {
    const { fetch, calls } = fakeFetch()
    expect((await registerCommands(env, fetch)).ok).toBe(true)
    expect(calls[0]?.url).toMatch(/\/applications\/500000000000000001\/commands$/)
  })

  it('names missing variables and reports Discord errors without the token', async () => {
    expect(await registerCommands({}, fakeFetch().fetch)).toEqual({ ok: false, error: { code: 'missing_env', detail: 'DISCORD_APP_ID, DISCORD_BOT_TOKEN' } })
    const r = await registerCommands(env, fakeFetch(401).fetch)
    expect(r).toEqual({ ok: false, error: { code: 'discord_refused', detail: 'HTTP 401 (check DISCORD_APP_ID and DISCORD_BOT_TOKEN)' } })
  })
})
