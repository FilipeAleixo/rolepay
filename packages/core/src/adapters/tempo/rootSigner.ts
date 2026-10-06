import type { Account as ViemAccount, Hex } from 'viem'
import { Account } from 'viem/tempo'
import type { Address } from '../../domain/ids.js'
import type { RootSigner } from '../../ports/payoutChain.js'

const VIEM_ACCOUNT = Symbol('payrun.tempoRootAccount')

type TempoRootSigner = RootSigner & { [VIEM_ACCOUNT]: ViemAccount }

/**
 * A treasury root key held in-process. Dev, CLI and chain tests only: in production the
 * root is a passkey in the treasurer's browser and never reaches the server.
 */
export function rootSignerFromPrivateKey(privateKey: Hex): RootSigner {
  const account = Account.fromSecp256k1(privateKey)
  const signer: TempoRootSigner = { address: account.address.toLowerCase() as Address, kind: 'tempo_secp256k1', [VIEM_ACCOUNT]: account }
  return signer
}

export function unwrapRootSigner(signer: RootSigner): ViemAccount | null {
  return VIEM_ACCOUNT in signer ? (signer as TempoRootSigner)[VIEM_ACCOUNT] : null
}
