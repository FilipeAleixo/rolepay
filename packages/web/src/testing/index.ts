/**
 * @rolepay/web/testing: in-memory fakes for the web ports, for this package's tests and the
 * server's. Production code never imports this.
 */
import { createHash } from 'node:crypto'
import type { Address, Result } from '@rolepay/core'
import type { DiscordIdentity, DiscordOAuth, GuildMember, GuildMembers, OAuthError } from '../dashboard/ports.js'
import type { Assets, PasskeySession, PasskeySessions } from '../ports.js'

export { InMemoryPolicies } from './inMemoryPolicies.js'

const COOKIE = 'fake_passkey'

/** Pretends a browser is signed in with the passkey account named in a cookie. */
export class FakePasskeySessions implements PasskeySessions {
  /** A login session by default; `{ proof: 'registration', issuedAt }` for one a registration minted. */
  cookieFor(address: string, opts: { proof?: 'login' | 'registration'; issuedAt?: number } = {}) {
    return `${COOKIE}=${address.toLowerCase()}; ${COOKIE}_proof=${opts.proof ?? 'login'}; ${COOKIE}_issued=${opts.issuedAt ?? 0}`
  }
  async current(req: Request): Promise<PasskeySession | null> {
    const cookie = req.headers.get('cookie') ?? ''
    const read = (name: string, pattern: string) => cookie.match(new RegExp(`(?:^|;\\s*)${name}=(${pattern})`))?.[1]
    const address = read(COOKIE, '0x[0-9a-f]{40}')
    if (!address) return null
    const proof = read(`${COOKIE}_proof`, 'login|registration') === 'registration' ? 'registration' : 'login'
    return { address: address as Address, credentialId: `cred-${address.slice(2, 10)}`, proof, issuedAt: Number(read(`${COOKIE}_issued`, '\\d+') ?? 0) }
  }
}

export const staticAssets = (files: Record<string, string>): Assets => ({ get: async (name) => files[name] ?? null })

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/**
 * A Discord OAuth provider in memory. `signInAs` picks who is at the consent screen next. The
 * "consent screen" approves at once: `authorizeUrl` returns the callback URL with a one-time code
 * and the state, so a browser (or a test) that follows it lands straight back on Rolepay. The
 * code exchange checks PKCE for real: the verifier must hash (S256) to the challenge it was given.
 */
export class FakeDiscordOAuth implements DiscordOAuth {
  readonly authorizations: { state: string; codeChallenge: string; redirectUri: string }[] = []
  readonly exchanges: { code: string; verifierMatched: boolean }[] = []
  private next: DiscordIdentity | null = null
  private refuse = false
  private readonly codes = new Map<string, { identity: DiscordIdentity | null; challenge: string; redirectUri: string }>()

  signInAs(identity: DiscordIdentity) {
    this.next = structuredClone(identity)
  }

  /** Discord refuses the next code exchange (a revoked app, a server error). */
  refuseNext() {
    this.refuse = true
  }

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.authorizations.push(input)
    const code = `fake-code-${this.authorizations.length}`
    this.codes.set(code, { identity: this.next, challenge: input.codeChallenge, redirectUri: input.redirectUri })
    const url = new URL(input.redirectUri)
    url.searchParams.set('code', code)
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  async signIn(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<Result<DiscordIdentity, OAuthError>> {
    const issued = this.codes.get(input.code)
    this.codes.delete(input.code) // a code works once
    const verifierMatched = issued !== undefined && s256(input.codeVerifier) === issued.challenge && input.redirectUri === issued.redirectUri
    this.exchanges.push({ code: input.code, verifierMatched })
    const refused = this.refuse
    this.refuse = false
    if (!issued?.identity || !verifierMatched || refused) return { ok: false, error: { code: 'oauth_failed', status: 400 } }
    return { ok: true, value: structuredClone(issued.identity) }
  }
}

/** The bot's view of guild members, in memory. `lookups` counts reads (for the cache tests). */
export class FakeGuildMembers implements GuildMembers {
  lookups = 0
  private readonly members = new Map<string, GuildMember>()

  set(guildId: string, userId: string, roles: string[], name: string | null = null) {
    this.members.set(`${guildId}:${userId}`, { roles: [...roles], name })
  }

  remove(guildId: string, userId: string) {
    this.members.delete(`${guildId}:${userId}`)
  }

  async member(guildId: string, userId: string): Promise<GuildMember | null> {
    this.lookups++
    const m = this.members.get(`${guildId}:${userId}`)
    return m ? { roles: [...m.roles], name: m.name } : null
  }
}
