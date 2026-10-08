import { type Hex, recoverMessageAddress } from 'viem'
import type { Address } from '../../domain/ids.js'
import { type Result, err, ok } from '../../domain/result.js'
import type { MessageSignatures, SignatureProblem } from '../../ports/messageSignatures.js'

/** An EOA's personal_sign signature: r, s and v, 65 bytes. */
const EOA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/

/**
 * `MessageSignatures` with viem's `recoverMessageAddress`: secp256k1 only, offline (no RPC). A
 * longer signature is a smart-contract account's (ERC-1271, ERC-6492) or a Tempo signature envelope
 * (passkey, P256, access key): not supported yet, said so rather than called malformed.
 */
export class ViemMessageSignatures implements MessageSignatures {
  async recover(message: string, signature: string): Promise<Result<Address, SignatureProblem>> {
    if (!HEX.test(signature)) return err({ code: 'malformed_signature' })
    if (!EOA_SIGNATURE.test(signature)) return err({ code: signature.length > 132 ? 'unsupported_signature' : 'malformed_signature' })
    const v = Number.parseInt(signature.slice(130), 16)
    if (![0, 1, 27, 28].includes(v)) return err({ code: 'malformed_signature' })
    try {
      return ok((await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase() as Address)
    } catch {
      return err({ code: 'malformed_signature' })
    }
  }
}
