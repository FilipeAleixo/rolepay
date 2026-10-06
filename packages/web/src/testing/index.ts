/**
 * @payrun/web/testing: in-memory fakes for the web ports, for this package's tests and the
 * server's. Production code never imports this.
 */
import type { Address } from '@payrun/core'
import type { Assets, PasskeySession, PasskeySessions } from '../ports.js'

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
