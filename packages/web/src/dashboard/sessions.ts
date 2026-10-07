import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { KeyValueStore } from '@rolepay/core'
import type { DiscordIdentity } from './ports.js'

/** A signed-in dashboard visitor. Kept on the server (KeyValueStore); the browser holds only a random token. */
export type DashboardSession = {
  userId: string
  userName: string
  /** The servers Discord said they are in at sign-in (only used to list them; access is checked live). */
  guilds: { id: string; name: string }[]
  /** Sent back with every form; a POST without it is refused (CSRF). */
  csrf: string
  createdAt: number
}

/** What a sign-in in progress keeps between leaving for Discord and coming back. */
type PendingSignIn = { verifier: string; next: string }

const SESSION = 'dashboard:session:'
const SIGN_IN = 'dashboard:oauth:'
/** A session lasts this long from sign-in, however active (then sign in again). */
export const SESSION_TTL_SECONDS = 8 * 3600
/** A sign-in must come back from Discord within this. */
export const SIGN_IN_TTL_SECONDS = 600

/** 256 random bits, base64url (43 characters). */
export const randomToken = () => randomBytes(32).toString('base64url')
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
/** The PKCE S256 challenge of a verifier (RFC 7636). */
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/** Constant-time string equality (CSRF tokens, OAuth state). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Dashboard sessions and pending sign-ins over core's KeyValueStore (the SQLite file in
 * production, so a restart keeps people signed in; Postgres later with the store). Only a SHA-256
 * of each token is a key, so a database reader cannot take over a session or a sign-in.
 */
export class DashboardSessionStore {
  constructor(private readonly kv: KeyValueStore) {}

  /** Remembers a sign-in about to leave for Discord. Returns the state and the PKCE challenge to send. */
  async beginSignIn(next: string): Promise<{ state: string; codeChallenge: string }> {
    const state = randomToken()
    const verifier = randomToken()
    await this.kv.set(SIGN_IN + hash(state), { verifier, next } satisfies PendingSignIn, { ttl: SIGN_IN_TTL_SECONDS })
    return { state, codeChallenge: pkceChallenge(verifier) }
  }

  /** The sign-in this state belongs to, at most once. */
  async finishSignIn(state: string): Promise<PendingSignIn | null> {
    return (await this.kv.take<PendingSignIn>(SIGN_IN + hash(state))) ?? null
  }

  /** A brand-new session (never one the browser brought: no session fixation). Returns its token. */
  async create(who: DiscordIdentity, now: Date): Promise<{ token: string; session: DashboardSession }> {
    const token = randomToken()
    const session: DashboardSession = { userId: who.user.id, userName: who.user.name, guilds: who.guilds, csrf: randomToken(), createdAt: now.getTime() }
    await this.kv.set(SESSION + hash(token), session, { ttl: SESSION_TTL_SECONDS })
    return { token, session }
  }

  async read(token: string): Promise<DashboardSession | null> {
    return (await this.kv.get<DashboardSession>(SESSION + hash(token))) ?? null
  }

  async destroy(token: string): Promise<void> {
    await this.kv.delete(SESSION + hash(token))
  }
}
