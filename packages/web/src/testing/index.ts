/**
 * @payrun/web/testing: in-memory fakes for the web ports, for this package's tests and the
 * server's. Production code never imports this.
 */
import type { Address } from '@payrun/core'
import type { Assets, PasskeySession, PasskeySessions } from '../ports.js'

const COOKIE = 'fake_passkey'

/** Pretends a browser is signed in with the passkey account named in a cookie. */
export class FakePasskeySessions implements PasskeySessions {
  cookieFor(address: string) {
    return `${COOKIE}=${address.toLowerCase()}`
  }
  async current(req: Request): Promise<PasskeySession | null> {
    const cookie = req.headers.get('cookie') ?? ''
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(0x[0-9a-f]{40})`))
    return m?.[1] ? { address: m[1] as Address, credentialId: `cred-${m[1].slice(2, 10)}` } : null
  }
}

export const staticAssets = (files: Record<string, string>): Assets => ({ get: async (name) => files[name] ?? null })
