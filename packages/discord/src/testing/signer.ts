/**
 * A throwaway Ed25519 keypair that signs requests the way Discord does, so tests can
 * send real signed interactions through the HTTP handler.
 */
export async function createTestSigner() {
  // Node's types return a union for generic algorithms; Ed25519 always yields a pair.
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey }
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    publicKeyHex: toHex(raw),
    async sign(message: string): Promise<string> {
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(message))
      return toHex(new Uint8Array(sig))
    },
  }
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
