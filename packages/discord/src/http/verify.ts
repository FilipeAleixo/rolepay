/**
 * Discord signs every interaction request with the application's Ed25519 key:
 * `X-Signature-Ed25519` is the signature over `X-Signature-Timestamp + rawBody`.
 * Uses WebCrypto, so it runs on Node 22+ and on edge runtimes alike.
 */
export type SignedRequest = { signature: string | null; timestamp: string | null; body: string }

const HEX32 = /^[0-9a-fA-F]{64}$/
const HEX64 = /^[0-9a-fA-F]{128}$/
const DEFAULT_MAX_AGE_SECONDS = 300

export function createSignatureVerifier(
  publicKeyHex: string,
  opts: { now?: () => Date; maxAgeSeconds?: number } = {},
): (req: SignedRequest) => Promise<boolean> {
  if (!HEX32.test(publicKeyHex)) throw new Error('Discord public key must be 32 bytes of hex (64 chars)')
  const now = opts.now ?? (() => new Date())
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  let key: Promise<CryptoKey> | null = null
  const getKey = () => (key ??= crypto.subtle.importKey('raw', fromHex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']))

  return async ({ signature, timestamp, body }) => {
    if (!signature || !timestamp || !HEX64.test(signature) || !/^\d{1,12}$/.test(timestamp)) return false
    // Replay window: Discord sends the current time; an old (or far future) request is refused.
    if (Math.abs(Math.floor(now().getTime() / 1000) - Number(timestamp)) > maxAge) return false
    try {
      return await crypto.subtle.verify({ name: 'Ed25519' }, await getKey(), fromHex(signature), new TextEncoder().encode(timestamp + body))
    } catch {
      return false
    }
  }
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
