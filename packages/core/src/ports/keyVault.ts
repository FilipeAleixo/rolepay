import type { Result } from '../domain/result.js'

/**
 * Secret handling. The vault encrypts; repositories store only what it returns.
 * Shaped like a KMS (encrypt/decrypt with context), so a cloud KMS can replace the
 * local AES-256-GCM implementation without touching services.
 */
export interface KeyVault {
  /** Encrypts `plaintext`, bound to `context` (e.g. "community:key"): opening it under another context fails. */
  seal(plaintext: string, context: string): Promise<string>
  open(sealed: string, context: string): Promise<Result<string, { code: 'unseal_failed' }>>
  /** Keyed one-way fingerprint, for looking up one-time tokens without storing them. */
  fingerprint(value: string): Promise<string>
}
