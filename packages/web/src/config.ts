import type { NetworkName } from '@rolepay/core'

/** Operational settings for the web pages (the server builds these from env). */
export type WebConfig = {
  /** The public origin the pages are served from, for example https://pay.example.org. Passkeys are checked against it. */
  origin: string
  /** WebAuthn relying party ID: the host passkeys are bound to, for good. Usually the origin's hostname. */
  rpId: string
  network: NetworkName
  rpcUrl: string
  /** Fee sponsor relay the browser uses for the treasurer's transactions. null = the treasury pays its own fee. */
  sponsorUrl: string | null
  explorerUrl: string
  /** What the setup page suggests for a new bot key. */
  botKeyDefaults: { limit: bigint; periodSeconds: number; validitySeconds: number; feeBudget: bigint }
}
