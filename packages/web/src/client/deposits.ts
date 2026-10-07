// Deposit addresses (Tempo virtual addresses, TIP-1022): the registration the treasury's passkey
// signs. The page mines the salt and builds the call itself; the server's copy is only checked
// against it (`registrationMismatch`), never signed.
import { Actions, VirtualMaster } from 'viem/tempo'
import { encodeFunctionData } from 'viem/utils'

type Hex = `0x${string}`

/** The registration of a master: its masterId and the exact call that registers it. */
export type Registration = { masterId: string; master: string; call: { to: string; data: string } }

/**
 * `registerVirtualMaster(salt)` on Tempo's address registry, sent by the treasury: the masterId it
 * yields and the call, as this page computes them. null when the account can never be a master
 * (ox refuses the zero address, a virtual address and a token, as the registry does).
 */
export function buildRegistration(treasury: string, salt: string): Registration | null {
  try {
    const call = Actions.virtualAddress.registerMaster.call({ salt: salt as Hex })
    const masterId = VirtualMaster.getMasterId({ address: treasury as Hex, salt: salt as Hex })
    return { masterId: masterId.toLowerCase(), master: treasury.toLowerCase(), call: { to: call.address.toLowerCase(), data: encodeFunctionData(call as never).toLowerCase() } }
  } catch {
    return null
  }
}

/** What differs between the registration this page built and the server's copy, in words, or null when they are the same. */
export function registrationMismatch(mine: Registration, theirs: unknown): string | null {
  try {
    const t = theirs as Registration
    if (t.master.toLowerCase() !== mine.master) return 'another account as the master'
    if (t.masterId.toLowerCase() !== mine.masterId) return 'a different masterId'
    if (t.call.to.toLowerCase() !== mine.call.to) return 'a different contract to call'
    if (t.call.data.toLowerCase() !== mine.call.data) return 'a different call'
    return null
  } catch {
    return 'a shape this page cannot read'
  }
}

/** Exactly what the treasurer is about to sign, in plain words. */
export const describeRegistration = (r: Registration) =>
  `register this account as the owner of the deposit addresses that start with ${r.masterId} (one call, registerVirtualMaster, to Tempo's address registry ${r.call.to}). It moves no money.`

/**
 * Mines a salt that passes the registry's 32-bit proof of work for `treasury`, with WebAssembly in
 * Web Workers (all but one of this device's cores): about 4 billion tries on average, under a minute
 * to a few minutes. `start` resumes after an earlier salt whose masterId was taken.
 */
export async function mineSalt(treasury: string, onProgress: (tries: number) => void, start = 0n): Promise<{ salt: string; masterId: string } | null> {
  const found = await VirtualMaster.mineSaltAsync({ address: treasury as Hex, start, onProgress: (p) => onProgress(p.attempts) })
  return found ? { salt: found.salt, masterId: found.masterId.toLowerCase() } : null
}
