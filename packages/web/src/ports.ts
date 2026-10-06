import type { Address } from '@payrun/core'

/**
 * Ports: what the web layer needs from outside. Each has a real implementation in this
 * package (passkeys.ts, assets.ts) and a fake in `@payrun/web/testing`.
 */

/**
 * The passkey signed in on this browser, from a WebAuthn ceremony with the server. `proof` says
 * which ceremony: `login` is an assertion, a signature over a server challenge with the stored
 * public key, so it proves the passkey; `registration` proves nothing (attestation "none" carries
 * no signature: anyone can register any public key). `issuedAt` is unix seconds.
 */
export type PasskeySession = { address: Address; credentialId: string; proof: 'login' | 'registration'; issuedAt: number }

export interface PasskeySessions {
  /** The session the request carries (cookie), or null. Never trusts an address the page sends. */
  current(req: Request): Promise<PasskeySession | null>
}

/** The client bundle(s), by file name. */
export interface Assets {
  get(name: string): Promise<string | null>
}
