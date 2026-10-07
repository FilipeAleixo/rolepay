import { DiscordIdSchema, type Result } from '@rolepay/core'
import { z } from 'zod'
import type { DiscordIdentity, DiscordOAuth, OAuthError } from './ports.js'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const AUTHORIZE = 'https://discord.com/oauth2/authorize'
const API = 'https://discord.com/api/v10'
const SCOPES = 'identify guilds'

const TokenSchema = z.object({ access_token: z.string().min(1) })
const UserSchema = z.object({ id: DiscordIdSchema, username: z.string().min(1), global_name: z.string().min(1).nullish() })
const GuildsSchema = z.array(z.object({ id: DiscordIdSchema, name: z.string() }))

const failed = (status?: number): { ok: false; error: OAuthError } => ({ ok: false, error: status === undefined ? { code: 'oauth_failed' } : { code: 'oauth_failed', status } })

/**
 * Discord OAuth2 over fetch (the authorization code flow with PKCE, a confidential client).
 * The user's access token is used for two reads (who they are, which servers they are in) and
 * revoked straight away: Rolepay keeps no Discord token. Expected failures are results; a
 * network outage throws. Errors never carry the client secret.
 */
export class FetchDiscordOAuth implements DiscordOAuth {
  private readonly fetch: Fetch

  constructor(private readonly opts: { clientId: string; clientSecret: string; fetch?: Fetch }) {
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      scope: SCOPES,
      state: input.state,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    })
    return `${AUTHORIZE}?${params}`
  }

  async signIn(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<Result<DiscordIdentity, OAuthError>> {
    const exchanged = await this.post('/oauth2/token', {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    })
    if (!exchanged.ok) return failed(exchanged.status)
    const token = TokenSchema.safeParse(await exchanged.json().catch(() => null))
    if (!token.success) return failed()
    const accessToken = token.data.access_token
    try {
      const [me, guilds] = await Promise.all([this.read('/users/@me', accessToken), this.read('/users/@me/guilds', accessToken)])
      if (!me.ok || !guilds.ok) return failed(me.ok ? guilds.status : me.status)
      const user = UserSchema.safeParse(await me.json().catch(() => null))
      const list = GuildsSchema.safeParse(await guilds.json().catch(() => null))
      if (!user.success || !list.success) return failed()
      return {
        ok: true,
        value: { user: { id: user.data.id, name: user.data.global_name ?? user.data.username }, guilds: list.data.map((g) => ({ id: g.id, name: g.name })) },
      }
    } finally {
      // Best effort: a token that fails to revoke still expires on Discord's side.
      await this.post('/oauth2/token/revoke', { token: accessToken, token_type_hint: 'access_token' }).catch(() => undefined)
    }
  }

  private post(path: string, form: Record<string, string>) {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64')
    return this.fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: new URLSearchParams(form).toString(),
    })
  }

  private read(path: string, accessToken: string) {
    return this.fetch(`${API}${path}`, { headers: { authorization: `Bearer ${accessToken}` } })
  }
}
