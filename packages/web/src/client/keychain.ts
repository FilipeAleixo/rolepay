// The bot key's authorisation as one direct call to the Account Keychain precompile, made by the
// root (the treasurer's passkey). viem's accessKey.authorize instead signs a key authorization
// and then the transaction that carries it: two passkey prompts for one action. A root may call
// authorizeKey itself (docs/tempo/protocol_transactions_AccountKeychain.md), and the protocol
// runs the same function for a signed key authorization, so the result on chain is the same
// with one signature.
import { Abis, Addresses } from 'viem/tempo'
import { toFunctionSelector } from 'viem/utils'

/** The authorisation exactly as the server returned it (amounts as decimal strings). */
export type WireAuthorization = {
  expiry: number
  limits: { token: string; limit: string; period?: number }[]
  scopes: { address: string; selector: string; recipients?: string[] }[]
}

type Hex = `0x${string}`

/** IAccountKeychain.SignatureType: the bot's key is secp256k1. */
const SECP256K1 = 0

/** A selector as given (0x and 4 bytes) or a function signature, as ox's KeyAuthorization takes it. */
const selectorOf = (s: string) => (s.startsWith('0x') ? s : toFunctionSelector(s)) as Hex

/** Flat scopes grouped by contract, the shape authorizeKey takes (ox groups them the same way). */
function allowedCalls(scopes: WireAuthorization['scopes']) {
  const byTarget = new Map<string, { selector: Hex; recipients: Hex[] }[]>()
  for (const s of scopes) {
    const rules = byTarget.get(s.address) ?? []
    rules.push({ selector: selectorOf(s.selector), recipients: (s.recipients ?? []) as Hex[] })
    byTarget.set(s.address, rules)
  }
  return [...byTarget].map(([target, selectorRules]) => ({ target: target as Hex, selectorRules }))
}

/** `authorizeKey(keyId, signatureType, KeyRestrictions)` for writeContract, signed by the root. */
export function authorizeKeyCall(keyAddress: string, auth: WireAuthorization) {
  return {
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'authorizeKey',
    args: [
      keyAddress as Hex,
      SECP256K1,
      {
        expiry: BigInt(auth.expiry),
        enforceLimits: true,
        limits: auth.limits.map((l) => ({ token: l.token as Hex, amount: BigInt(l.limit), period: BigInt(l.period ?? 0) })),
        allowAnyCalls: false,
        allowedCalls: allowedCalls(auth.scopes),
      },
    ],
  } as const
}
