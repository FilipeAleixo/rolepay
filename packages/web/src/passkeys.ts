import type { Address, KeyValueStore } from '@payrun/core'
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
    ttl: { session: 60 * 60 },
  })
  const sessions: PasskeySessions = {
    async current(req): Promise<PasskeySession | null> {
      const s = await handler.getSession(req)
      if (!s || s.expiresAt * 1000 <= Date.now()) return null
      return { address: passkeyAddress({ id: s.credentialId, publicKey: s.publicKey as `0x${string}` }), credentialId: s.credentialId }
    },
  }
  return { handler: { fetch: (req) => handler.fetch(req) }, sessions }
}
