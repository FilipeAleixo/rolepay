import type { Address } from '../domain/ids.js'
import type { Result } from '../domain/result.js'

/**
 * Why a signature names no signer: not a signature at all (`malformed_signature`), or one this
 * server cannot check yet (`unsupported_signature`: a smart-contract account's ERC-1271 or ERC-6492
 * signature, or a Tempo passkey, P256 or access-key signature envelope, all longer than 65 bytes).
 */
export type SignatureProblem = { code: 'malformed_signature' } | { code: 'unsupported_signature' }

/**
 * Who signed a personal message (EIP-191 `personal_sign`). v1 recovers secp256k1 accounts (EOAs)
 * only, from the signature alone, offline: the signer is whatever the signature and the message
 * say, never an address the caller claims.
 */
export interface MessageSignatures {
  recover(message: string, signature: string): Promise<Result<Address, SignatureProblem>>
}
