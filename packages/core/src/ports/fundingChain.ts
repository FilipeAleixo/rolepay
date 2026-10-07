import type { TransferLog } from '../domain/funding.js'
import type { Hex } from '../domain/hex.js'
import type { Address } from '../domain/ids.js'

/** The call that registers a master, as the registry precompile takes it. */
export type RegistrationCall = { to: Address; data: Hex }

/**
 * What funding with attribution needs from the chain (TIP-1022 virtual addresses). Read only: the
 * registration is signed by the treasury's passkey in the browser, and deposits are sent by
 * anyone. Separate from PayoutChain on purpose: nothing here touches the payment path.
 */
export interface FundingChain {
  head(): Promise<{ number: bigint; timestamp: number }>
  /**
   * The registration of `master` with `salt`, computed as the registry does (no RPC): the masterId,
   * whether the salt passes the 32-bit proof of work, and the call. null for an address that can
   * never be a master (zero, virtual, or a TIP-20 token).
   */
  registration(input: { master: Address; salt: Hex }): { masterId: Hex; proofOfWork: boolean; call: RegistrationCall } | null
  /** The address the registry maps `masterId` to, or null when it is not registered. */
  masterOf(masterId: Hex): Promise<Address | null>
  /**
   * The `MasterRegistered` event of a registration transaction, or null (no such transaction yet,
   * reverted, or not a registration).
   */
  findRegistration(txHash: Hex): Promise<{ masterId: Hex; master: Address; blockNumber: bigint } | null>
  /**
   * The TIP-20 `Transfer` events in `tokens` between `fromBlock` and `toBlock` (inclusive) that
   * forward deposits to `master`: the first hops (`to` is one of `addresses`) and the second hops
   * (`from` is one of `addresses`, `to` is `master`). `attributeDeposits` pairs them.
   */
  forwardedTransfers(input: { tokens: readonly Address[]; addresses: readonly Address[]; master: Address; fromBlock: bigint; toBlock: bigint }): Promise<TransferLog[]>
}
