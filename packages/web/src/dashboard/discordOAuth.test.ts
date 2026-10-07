import { describe, expect, it } from 'vitest'
import { FetchDiscordOAuth } from './discordOAuth.js'

const APP = '500000000000000001'
const SECRET = 'client-secret-value'
const REDIRECT = 'https://demo.rolepay.test/auth/discord/callback'

type Call = { url: string; method: string; headers: Headers; body: string }

function fakeFetch(...responses: { status: number; json?: unknown }[]) {
  const calls: Call[] = []
  const fetch = async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' })
    const r = responses.shift() ?? { status: 500 }
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

const TOKEN = { access_token: 'user-access-token', token_type: 'Bearer', expires_in: 604800, scope: 'identify guilds' }
const ME = { id: '200000000000000001', username: 'felix_k', global_name: 'Felix', avatar: null }
const GUILDS = [
  { id: '1094309218049937418', name: 'Mods guild', icon: null, owner: false, permissions: '0' },
  { id: '1094309218049937419', name: 'Other', icon: null, owner: true, permissions: '8' },
]

describe('FetchDiscordOAuth (Discord OAuth2 over fetch)', () => {
  it("builds Discord's consent URL: code flow, scopes identify and guilds, state, redirect and the S256 challenge", () => {
    const oauth = new FetchDiscordOAuth({ clientId: APP, clientSecret: SECRET, fetch: fakeFetch().fetch })
    const url = new URL(oauth.authorizeUrl({ state: 'st', codeChallenge: 'ch', redirectUri: REDIRECT }))
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: APP,
      scope: 'identify guilds',
      state: 'st',
      redirect_uri: REDIRECT,
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    })
  })

  it('exchanges the code with the PKCE verifier and the client credentials, reads the user and their guilds, then revokes the token', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, json: TOKEN }, { status: 200, json: ME }, { status: 200, json: GUILDS }, { status: 200, json: {} })
    const oauth = new FetchDiscordOAuth({ clientId: APP, clientSecret: SECRET, fetch })
    expect(await oauth.signIn({ code: 'the-code', codeVerifier: 'the-verifier', redirectUri: REDIRECT })).toEqual({
      ok: true,
      value: { user: { id: ME.id, name: 'Felix' }, guilds: [{ id: GUILDS[0]?.id, name: 'Mods guild' }, { id: GUILDS[1]?.id, name: 'Other' }] },
    })
    const [token, me, guilds, revoke] = calls
    expect(token?.url).toBe('https://discord.com/api/v10/oauth2/token')
    expect(token?.method).toBe('POST')
    expect(token?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(token?.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${APP}:${SECRET}`).toString('base64')}`)
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT, code_verifier: 'the-verifier' })
    expect(me?.url).toBe('https://discord.com/api/v10/users/@me')
    expect(me?.headers.get('authorization')).toBe('Bearer user-access-token')
    expect(guilds?.url).toBe('https://discord.com/api/v10/users/@me/guilds')
    expect(guilds?.headers.get('authorization')).toBe('Bearer user-access-token')
    // Rolepay keeps no Discord token: it is revoked as soon as the identity is read.
    expect(revoke?.url).toBe('https://discord.com/api/v10/oauth2/token/revoke')
    expect(Object.fromEntries(new URLSearchParams(revoke?.body))).toEqual({ token: 'user-access-token', token_type_hint: 'access_token' })
  })

  it('names the user by global name, else username', async () => {
    const { fetch } = fakeFetch({ status: 200, json: TOKEN }, { status: 200, json: { ...ME, global_name: null } }, { status: 200, json: [] }, { status: 200 })
    const r = await new FetchDiscordOAuth({ clientId: APP, clientSecret: SECRET, fetch }).signIn({ code: 'c', codeVerifier: 'v', redirectUri: REDIRECT })
    expect(r.ok && r.value.user.name).toBe('felix_k')
  })

  it('a refused code, a failed read or a malformed answer is oauth_failed, and never carries the secret', async () => {
    for (const responses of [
      [{ status: 400, json: { error: 'invalid_grant' } }],
      [{ status: 200, json: TOKEN }, { status: 401, json: {} }, { status: 200, json: {} }],
      [{ status: 200, json: TOKEN }, { status: 200, json: { id: 'not-a-snowflake' } }, { status: 200, json: [] }, { status: 200, json: {} }],
      [{ status: 200, json: { nope: true } }],
    ]) {
      const { fetch } = fakeFetch(...responses)
      const r = await new FetchDiscordOAuth({ clientId: APP, clientSecret: SECRET, fetch }).signIn({ code: 'c', codeVerifier: 'v', redirectUri: REDIRECT })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error.code).toBe('oauth_failed')
      expect(JSON.stringify(r)).not.toContain(SECRET)
    }
  })

  it('a failed revoke does not fail the sign-in', async () => {
    const { fetch } = fakeFetch({ status: 200, json: TOKEN }, { status: 200, json: ME }, { status: 200, json: GUILDS }, { status: 503 })
    const r = await new FetchDiscordOAuth({ clientId: APP, clientSecret: SECRET, fetch }).signIn({ code: 'c', codeVerifier: 'v', redirectUri: REDIRECT })
    expect(r.ok).toBe(true)
  })
})
