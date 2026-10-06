import { describe, expect, it } from 'vitest'
import { createTestSigner } from '../testing/signer.js'
import { createSignatureVerifier } from './verify.js'

const NOW = new Date('2026-10-06T18:00:00.000Z')
const ts = (offsetSeconds = 0) => String(Math.floor(NOW.getTime() / 1000) + offsetSeconds)
const body = JSON.stringify({ type: 1 })

describe('createSignatureVerifier (Ed25519, X-Signature-Ed25519 over timestamp + body)', () => {
  it('accepts a request signed by the application key', async () => {
    const signer = await createTestSigner()
    const verify = createSignatureVerifier(signer.publicKeyHex, { now: () => NOW })
    const timestamp = ts()
    expect(await verify({ signature: await signer.sign(timestamp + body), timestamp, body })).toBe(true)
  })

  it('rejects a tampered body', async () => {
    const signer = await createTestSigner()
    const verify = createSignatureVerifier(signer.publicKeyHex, { now: () => NOW })
    const timestamp = ts()
    const signature = await signer.sign(timestamp + body)
    expect(await verify({ signature, timestamp, body: JSON.stringify({ type: 2 }) })).toBe(false)
  })

  it('rejects a signature made with another key', async () => {
    const signer = await createTestSigner()
    const other = await createTestSigner()
    const verify = createSignatureVerifier(signer.publicKeyHex, { now: () => NOW })
    const timestamp = ts()
    expect(await verify({ signature: await other.sign(timestamp + body), timestamp, body })).toBe(false)
  })

  it('rejects missing or malformed headers without throwing', async () => {
    const signer = await createTestSigner()
    const verify = createSignatureVerifier(signer.publicKeyHex, { now: () => NOW })
    const timestamp = ts()
    expect(await verify({ signature: null, timestamp, body })).toBe(false)
    expect(await verify({ signature: await signer.sign(timestamp + body), timestamp: null, body })).toBe(false)
    expect(await verify({ signature: 'zz-not-hex', timestamp, body })).toBe(false)
    expect(await verify({ signature: 'ab'.repeat(10), timestamp, body })).toBe(false)
  })

  it('rejects a stale or future timestamp (replay window, default 5 minutes)', async () => {
    const signer = await createTestSigner()
    const verify = createSignatureVerifier(signer.publicKeyHex, { now: () => NOW })
    for (const offset of [-301, 301]) {
      const timestamp = ts(offset)
      expect(await verify({ signature: await signer.sign(timestamp + body), timestamp, body })).toBe(false)
    }
    const fresh = ts(-299)
    expect(await verify({ signature: await signer.sign(fresh + body), timestamp: fresh, body })).toBe(true)
  })

  it('refuses to build with a public key that is not 32 bytes of hex', () => {
    expect(() => createSignatureVerifier('not-a-key')).toThrow(/public key/)
  })
})
