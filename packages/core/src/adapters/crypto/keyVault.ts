import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { err, ok } from '../../domain/result.js'
import type { KeyVault } from '../../ports/keyVault.js'

const VERSION = 'v1'

/**
 * Local KeyVault: AES-256-GCM with the vault context as additional authenticated
 * data, so a sealed secret only opens for the community and key it was sealed for.
 * Encryption and fingerprint keys are derived separately from one 32-byte master
 * key (ROLEPAY_MASTER_KEY). Sealed form: v1.<iv>.<ciphertext>.<tag> (base64url).
 */
export class AesGcmKeyVault implements KeyVault {
  private readonly encKey: Buffer
  private readonly macKey: Buffer

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) throw new Error('master key must be 32 bytes of hex (64 chars)')
    const master = Buffer.from(masterKeyHex, 'hex')
    this.encKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'payrun:seal', 32))
    this.macKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'payrun:fingerprint', 32))
  }

  async seal(plaintext: string, context: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv)
    cipher.setAAD(Buffer.from(context, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [VERSION, iv, ct, cipher.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
  }

  async open(sealed: string, context: string) {
    const parts = sealed.split('.')
    if (parts.length !== 4 || parts[0] !== VERSION) return err({ code: 'unseal_failed' as const })
    try {
      const [iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'))
      const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv as Buffer)
      decipher.setAAD(Buffer.from(context, 'utf8'))
      decipher.setAuthTag(tag as Buffer)
      return ok(Buffer.concat([decipher.update(ct as Buffer), decipher.final()]).toString('utf8'))
    } catch {
      return err({ code: 'unseal_failed' as const })
    }
  }

  async fingerprint(value: string) {
    return createHmac('sha256', this.macKey).update(value, 'utf8').digest('hex')
  }
}
