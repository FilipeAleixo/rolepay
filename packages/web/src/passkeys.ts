import { createHash } from 'node:crypto'
import type { Address, KeyValueStore } from '@rolepay/core'
import { Handler, Kv } from 'accounts/server'
import { Account } from 'viem/tempo'
import type { PasskeySession, PasskeySessions } from './ports.js'

/** Keys the WebAuthn handler writes are namespaced, so the store can be shared. */
const PREFIX = 'webauthn:'

/** Core's KeyValueStore as the Accounts SDK's `Kv` (same shape), under a prefix. */
export function accountsKv(store: KeyValueStore): Kv.Kv {
  return Kv.from({
    get: (key) => store.get(PREFIX + key),
    set: (key, value, options) => store.set(PREFIX + key, value, options?.ttl ? { ttl: options.ttl } : undefined),
    delete: (key) => store.delete(PREFIX + key),
    create: (key, value, options) => store.create(PREFIX + key, value, options?.ttl ? { ttl: options.ttl } : undefined),
    take: (key) => store.take(PREFIX + key),
  })
}

/** The Accounts SDK's session cookie (its default name). */
const SESSION_COOKIE = 'accounts_webauthn'
/**
 * Rolepay's own record that a session came from a passkey login, keyed by a hash of its token.
 * The key prefix dates from before the rename and stays, so sessions in the store survive it.
 */
const LOGIN_PROOF = 'payrun:passkey-login:'
const SESSION_TTL_SECONDS = 60 * 60

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** The session token a request carries: `Authorization: Bearer`, else the SDK's cookie (as the SDK reads it). */
function requestToken(req: Request): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  if (bearer) return bearer
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join('='))
  }
  return undefined
}

/** The session tokens a ceremony response hands out: in Set-Cookie, or in the body with `returnToken`. */
async function issuedTokens(res: Response): Promise<string[]> {
  const fromCookies = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter((c) => c.startsWith(`${SESSION_COOKIE}=`))
    .map((c) => decodeURIComponent(c.slice(SESSION_COOKIE.length + 1)))
  const body = (await res.clone().json().catch(() => null)) as { token?: unknown } | null
  return [...fromCookies, ...(typeof body?.token === 'string' ? [body.token] : [])]
}

/**
 * Wraps the WebAuthn endpoints so every session a successful `/webauthn/login` issues is recorded
 * as a passkey login. A login is an assertion verified against the stored public key; a
 * registration with attestation "none" is not a signature at all, so its session proves nothing
 * about the passkey and is never recorded. The record holds a hash of the token only.
 */
export function withLoginProof(
  inner: { fetch: (req: Request) => Response | Promise<Response> },
  store: KeyValueStore,
  ttlSeconds: number,
): { fetch: (req: Request) => Promise<Response> } {
  return {
    async fetch(req) {
      const res = await inner.fetch(req)
      if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/webauthn/login') && res.ok) {
        for (const token of await issuedTokens(res)) await store.set(LOGIN_PROOF + tokenHash(token), true, { ttl: ttlSeconds })
      }
      return res
    },
  }
}

/** The Tempo account a passkey controls: derived from its P256 public key. */
export const passkeyAddress = (credential: { id: string; publicKey: `0x${string}` }) =>
  Account.fromWebAuthnP256(credential).address.toLowerCase() as Address

/**
 * The WebAuthn ceremonies (Accounts SDK `Handler.webAuthn`) under /webauthn, with credentials,
 * challenges and sessions in the given store (SQLite in production, so they survive restarts;
 * Postgres later behind the same port). Also the session reader the routes use.
 */
export function createPasskeys(opts: { kv: KeyValueStore; origin: string; rpId: string }): {
  handler: { fetch: (req: Request) => Response | Promise<Response> }
  sessions: PasskeySessions
} {
  const handler = Handler.webAuthn({
    kv: accountsKv(opts.kv),
    origin: opts.origin,
    rpId: opts.rpId,
    path: '/webauthn',
    // Same origin only: the pages and the ceremonies are served together.
    cors: false,
    ttl: { session: SESSION_TTL_SECONDS },
  })
  const sessions: PasskeySessions = {
    async current(req): Promise<PasskeySession | null> {
      const s = await handler.getSession(req)
      if (!s || s.expiresAt * 1000 <= Date.now()) return null
      const token = requestToken(req)
      const login = token !== undefined && (await opts.kv.get(LOGIN_PROOF + tokenHash(token))) === true
      return {
        address: passkeyAddress({ id: s.credentialId, publicKey: s.publicKey as `0x${string}` }),
        credentialId: s.credentialId,
        proof: login ? 'login' : 'registration',
        issuedAt: s.issuedAt,
      }
    },
  }
  return { handler: withLoginProof({ fetch: (req) => handler.fetch(req) }, opts.kv, SESSION_TTL_SECONDS), sessions }
}
