import type { KeyAuthorization, KeyState } from '../domain/community.js'
import type { Hex } from '../domain/hex.js'
import type { Address } from '../domain/ids.js'
import type { Micros } from '../domain/money.js'
import type { MemoTransfer } from '../domain/reconcile.js'
import type { Result } from '../domain/result.js'

/** Why the chain (or the sponsor) definitively refused a transaction. */
export type ChainRejectReason =
  | 'spending_limit_exceeded'
  | 'key_not_authorized'
  | 'key_revoked'
  | 'key_expired'
  | 'call_not_allowed'
  | 'insufficient_balance'
  | 'unavailable'
  | 'other'

export type ChainRejection = { code: 'rejected'; reason: ChainRejectReason; detail: string }

export type FeePayment = { mode: 'sponsor' } | { mode: 'fee_budget'; feeToken: Address }

export type BatchTransfer = { to: Address; amount: Micros; memo: Hex }

export type SignedBatch = { txHash: Hex; rawTx: Hex }

export type BroadcastOutcome =
  | { kind: 'confirmed'; txHash: Hex; blockNumber: bigint; transfers: MemoTransfer[] }
  | { kind: 'reverted'; txHash: Hex; blockNumber: bigint }
  /** Definitive: the node refused it, it will never land. */
  | { kind: 'rejected'; reason: ChainRejectReason; detail: string }
  /** Ambiguous (timeout, network): it may still land before its validBefore. */
  | { kind: 'unknown'; detail: string }

export type TxLookup =
  | { kind: 'confirmed'; blockNumber: bigint; transfers: MemoTransfer[] }
  | { kind: 'reverted'; blockNumber: bigint }
  | { kind: 'not_found' }

/**
 * The treasury root key, held by whoever controls the community account. Opaque to
 * services: only the adapter that created it can use it. In production the root is a
 * passkey in the treasurer's browser and never reaches the server; this exists for
 * the CLI, dev setup and chain tests.
 */
export interface RootSigner {
  readonly address: Address
  readonly kind: string
}

/**
 * Everything Rolepay needs from a payments chain. Signing and broadcasting are separate
 * so the service can persist the signed tx (and its hash) before it is broadcast.
 */
export interface PayoutChain {
  head(): Promise<{ number: bigint; timestamp: number }>
  /** A fresh access-key pair. The secret goes straight into the KeyVault. */
  newAccessKey(): Promise<{ address: Address; secret: string }>
  keyState(input: { account: Address; accessKey: Address; token: Address; feeToken: Address | null }): Promise<KeyState>
  authorizeKey(input: { root: RootSigner; accessKey: Address; authorization: KeyAuthorization }): Promise<Result<{ txHash: Hex }, ChainRejection>>
  revokeKey(input: { root: RootSigner; accessKey: Address }): Promise<Result<{ txHash: Hex }, ChainRejection>>
  /**
   * Builds and signs ONE batched transaction (one transferWithMemo per line) with the
   * access key, sending as `account`. Never broadcasts, so any error is definitive.
   */
  signBatch(input: {
    account: Address
    accessKeySecret: string
    token: Address
    transfers: BatchTransfer[]
    validBefore: number
    fee: FeePayment
  }): Promise<Result<SignedBatch, ChainRejection>>
  /** Idempotent: re-broadcasting the same raw tx can land it at most once. */
  broadcast(rawTx: Hex): Promise<BroadcastOutcome>
  lookupTx(txHash: Hex): Promise<TxLookup>
  /**
   * `TransferWithMemo` events in `token` from `from` carrying any of `memos`, from `fromBlock` to
   * `toBlock` (default: the head). Pass the block of a head you already read, so the search and
   * a deadline check against that head's timestamp describe the same moment.
   */
  findMemoTransfers(input: { token: Address; from: Address; memos: Hex[]; fromBlock: bigint; toBlock?: bigint }): Promise<MemoTransfer[]>
}
