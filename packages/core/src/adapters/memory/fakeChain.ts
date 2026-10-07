import type { KeyAuthorization, KeyState } from '../../domain/community.js'
import { type Hex, bytesToHex, hexToBytes } from '../../domain/hex.js'
import type { Address } from '../../domain/ids.js'
import type { MemoTransfer } from '../../domain/reconcile.js'
import { err, ok } from '../../domain/result.js'
import type {
  BatchTransfer,
  BroadcastOutcome,
  ChainRejectReason,
  FeePayment,
  PayoutChain,
  RootSigner,
  TxLookup,
} from '../../ports/payoutChain.js'

type Limit = { limit: bigint; remaining: bigint; period: number | null; periodEnd: number | null }
type KeyRecord = {
  address: Address
  secret: string
  account: Address | null
  expiry: number
  limits: Map<string, Limit>
  recipients: string[] | null
  scopeToken: string | null
  revoked: boolean
}
type Payload = { n: number; account: Address; key: Address; token: Address; transfers: BatchTransfer[]; validBefore: number }
type Landed = { txHash: Hex; blockNumber: bigint; status: 'success' | 'reverted'; transfers: MemoTransfer[] }

const lc = (a: string) => a.toLowerCase()
const hex32 = (prefix: number, n: number) => `0x${prefix.toString(16).padStart(2, '0')}${n.toString(16).padStart(62, '0')}` as Hex
const FAKE_ROOT = Symbol('fakeRoot')

/**
 * A deterministic stand-in for Tempo that enforces the rules Rolepay depends on:
 * atomic batches, cumulative spend limits, call scopes, revocation, expiry, expiring
 * nonces (validBefore) and idempotent re-broadcast. Faults are injected explicitly.
 */
export class FakePayoutChain implements PayoutChain {
  time: number
  blockNumber = 1n
  landedTxCount = 0
  broadcastCount = 0
  /**
   * `reject_but_keep_pending`: the node answers "rejected" but the tx sits in a mempool and lands on
   * the next `mine()` if its validBefore has not passed (an error string misread as definitive).
   */
  readonly faults: { nextBroadcast: 'land_then_lose_response' | 'drop' | 'reject_but_keep_pending' | null } = { nextBroadcast: null }

  private balances = new Map<string, bigint>()
  private keys = new Map<string, KeyRecord>()
  private signed = new Map<Hex, Payload>()
  private landed = new Map<Hex, Landed>()
  private events: MemoTransfer[] = []
  private pending: Hex[] = []
  private counter = 0

  constructor(opts: { startTime?: number } = {}) {
    this.time = opts.startTime ?? 1_700_000_000
  }

  // ---- test controls -------------------------------------------------------
  fund(token: string, address: string, amount: bigint) {
    this.balances.set(`${lc(token)}:${lc(address)}`, this.balance(token, address) + amount)
  }
  balance(token: string, address: string) {
    return this.balances.get(`${lc(token)}:${lc(address)}`) ?? 0n
  }
  advance(seconds: number) {
    this.time += seconds
    this.blockNumber += BigInt(Math.max(1, seconds))
  }
  rootSigner(address: Address): RootSigner {
    return { address: lc(address) as Address, kind: 'fake', [FAKE_ROOT]: true } as RootSigner
  }
  /** Lands every pending tx (see `reject_but_keep_pending`) that is still valid; drops the rest. */
  async mine() {
    const queued = this.pending
    this.pending = []
    for (const raw of queued) {
      const payload = this.signed.get(raw) ?? decodePayload(raw)
      if (!payload || this.landed.has(hex32(0x7e, payload.n)) || this.refuse(payload)) continue
      this.land(payload)
    }
  }

  // ---- PayoutChain ---------------------------------------------------------
  async head() {
    return { number: this.blockNumber, timestamp: this.time }
  }

  async newAccessKey() {
    const n = ++this.counter
    const address = `0x${'ac'.repeat(10)}${n.toString(16).padStart(20, '0')}` as Address
    const secret = `fake-secret-${n}`
    this.keys.set(address, { address, secret, account: null, expiry: 0, limits: new Map(), recipients: null, scopeToken: null, revoked: false })
    return { address, secret }
  }

  async balanceOf(input: { token: Address; account: Address }) {
    return this.balance(input.token, input.account)
  }

  async keyState(input: { account: Address; accessKey: Address; token: Address; feeToken: Address | null }): Promise<KeyState> {
    const k = this.keys.get(lc(input.accessKey))
    const base = { chainTime: this.time, feeBudgetRemaining: null }
    if (!k || k.account !== lc(input.account)) return { ...base, status: 'not_authorized', expiry: 0, remaining: 0n, periodEnd: null }
    const limit = this.currentLimit(k, input.token)
    const fee = input.feeToken ? this.currentLimit(k, input.feeToken) : undefined
    return {
      status: k.revoked ? 'revoked' : k.expiry <= this.time ? 'expired' : 'active',
      expiry: k.expiry,
      remaining: limit?.remaining ?? 0n,
      periodEnd: limit?.periodEnd ?? null,
      chainTime: this.time,
      feeBudgetRemaining: fee ? fee.remaining : null,
    }
  }

  async authorizeKey(input: { root: RootSigner; accessKey: Address; authorization: KeyAuthorization }) {
    if (!(FAKE_ROOT in input.root)) return err({ code: 'rejected' as const, reason: 'other' as const, detail: 'not a fake root signer' })
    const k = this.keys.get(lc(input.accessKey))
    if (!k) return err({ code: 'rejected' as const, reason: 'other' as const, detail: 'unknown key' })
    if (k.revoked) return err({ code: 'rejected' as const, reason: 'key_revoked' as const, detail: 'a revoked key ID can never be re-authorised' })
    const a = input.authorization
    k.account = lc(input.root.address) as Address
    k.expiry = a.expiry
    k.limits = new Map(
      a.limits.map((l) => [
        lc(l.token),
        { limit: l.limit, remaining: l.limit, period: l.period ?? null, periodEnd: l.period ? this.time + l.period : null },
      ]),
    )
    const scope = a.scopes[0]
    k.scopeToken = scope ? lc(scope.address) : null
    k.recipients = scope?.recipients ? scope.recipients.map(lc) : null
    return ok({ txHash: this.nextHash(0xa0) })
  }

  async revokeKey(input: { root: RootSigner; accessKey: Address }) {
    const k = this.keys.get(lc(input.accessKey))
    if (!k || k.account !== lc(input.root.address)) return err({ code: 'rejected' as const, reason: 'other' as const, detail: 'unknown key' })
    k.revoked = true
    return ok({ txHash: this.nextHash(0xa1) })
  }

  async signBatch(input: {
    account: Address
    accessKeySecret: string
    token: Address
    transfers: BatchTransfer[]
    validBefore: number
    fee: FeePayment
  }) {
    const k = [...this.keys.values()].find((x) => x.secret === input.accessKeySecret)
    const refusal = this.check(k, input.account, input.token, input.transfers)
    if (refusal) return err({ code: 'rejected' as const, reason: refusal, detail: `fake chain: ${refusal}` })
    const payload: Payload = {
      n: ++this.counter,
      account: lc(input.account) as Address,
      key: (k as KeyRecord).address,
      token: lc(input.token) as Address,
      transfers: input.transfers.map((t) => ({ ...t, to: lc(t.to) as Address })),
      validBefore: input.validBefore,
    }
    const rawTx = encodePayload(payload)
    const txHash = hex32(0x7e, payload.n)
    this.signed.set(rawTx, payload)
    return ok({ txHash, rawTx })
  }

  async broadcast(rawTx: Hex): Promise<BroadcastOutcome> {
    this.broadcastCount++
    const fault = this.faults.nextBroadcast
    this.faults.nextBroadcast = null
    const payload = this.signed.get(rawTx) ?? decodePayload(rawTx)
    if (!payload) return { kind: 'rejected', reason: 'other', detail: 'malformed tx' }
    const txHash = hex32(0x7e, payload.n)
    const already = this.landed.get(txHash)
    if (already) return this.outcome(already)
    if (fault === 'drop') return { kind: 'unknown', detail: 'fake: dropped, response timed out' }
    if (fault === 'reject_but_keep_pending') {
      this.pending.push(rawTx)
      return { kind: 'rejected', reason: 'other', detail: 'fake: keychain validation failed (misread: the tx is still pending)' }
    }
    const refused = this.refuse(payload)
    if (refused) return refused
    const landed = this.land(payload)
    if (fault === 'land_then_lose_response') return { kind: 'unknown', detail: 'fake: landed, response lost' }
    return this.outcome(landed)
  }

  async lookupTx(txHash: Hex): Promise<TxLookup> {
    const l = this.landed.get(lc(txHash) as Hex)
    if (!l) return { kind: 'not_found' }
    return l.status === 'success'
      ? { kind: 'confirmed', blockNumber: l.blockNumber, transfers: l.transfers }
      : { kind: 'reverted', blockNumber: l.blockNumber }
  }

  async findMemoTransfers(input: { token: Address; from: Address; memos: Hex[]; fromBlock: bigint; toBlock?: bigint }) {
    const memos = new Set(input.memos.map(lc))
    const toBlock = input.toBlock ?? this.blockNumber
    return this.events.filter(
      (e) =>
        lc(e.token) === lc(input.token) &&
        lc(e.from) === lc(input.from) &&
        memos.has(lc(e.memo)) &&
        e.blockNumber >= input.fromBlock &&
        e.blockNumber <= toBlock,
    )
  }

  // ---- internals -----------------------------------------------------------
  /** Admission: why the node would refuse this tx right now, or null. */
  private refuse(payload: Payload): BroadcastOutcome | null {
    if (this.time > payload.validBefore) return { kind: 'rejected', reason: 'other', detail: 'validBefore has passed' }
    const k = this.keys.get(payload.key)
    if (!k || k.revoked) return { kind: 'rejected', reason: 'key_revoked', detail: 'keychain validation failed' }
    if (k.expiry <= this.time) return { kind: 'rejected', reason: 'key_expired', detail: 'keychain validation failed' }
    return null
  }

  /** Puts an admitted tx in a new block: the whole batch, or a revert that moves nothing. */
  private land(payload: Payload): Landed {
    const txHash = hex32(0x7e, payload.n)
    const k = this.keys.get(payload.key) as KeyRecord
    this.blockNumber += 1n
    const refusal = this.check(k, payload.account, payload.token, payload.transfers)
    let landed: Landed
    if (refusal) {
      landed = { txHash, blockNumber: this.blockNumber, status: 'reverted', transfers: [] }
    } else {
      const total = payload.transfers.reduce((s, t) => s + t.amount, 0n)
      const limit = this.currentLimit(k, payload.token) as Limit
      limit.remaining -= total
      this.fund(payload.token, payload.account, -total)
      const transfers = payload.transfers.map((t) => {
        this.fund(payload.token, t.to, t.amount)
        return { txHash, blockNumber: this.blockNumber, token: payload.token, from: payload.account, ...t }
      })
      this.events.push(...transfers)
      landed = { txHash, blockNumber: this.blockNumber, status: 'success', transfers }
    }
    this.landed.set(txHash, landed)
    this.landedTxCount++
    return landed
  }

  private outcome(l: Landed): BroadcastOutcome {
    return l.status === 'success'
      ? { kind: 'confirmed', txHash: l.txHash, blockNumber: l.blockNumber, transfers: l.transfers }
      : { kind: 'reverted', txHash: l.txHash, blockNumber: l.blockNumber }
  }

  private currentLimit(k: KeyRecord, token: string): Limit | undefined {
    const l = k.limits.get(lc(token))
    if (l && l.period && l.periodEnd !== null && this.time >= l.periodEnd) {
      l.remaining = l.limit
      while (l.periodEnd !== null && this.time >= l.periodEnd) l.periodEnd += l.period
    }
    return l
  }

  private check(k: KeyRecord | undefined, account: string, token: string, transfers: BatchTransfer[]): ChainRejectReason | null {
    if (!k || k.account === null || k.account !== lc(account)) return 'key_not_authorized'
    if (k.revoked) return 'key_revoked'
    if (k.expiry <= this.time) return 'key_expired'
    if (k.scopeToken !== lc(token)) return 'call_not_allowed'
    if (k.recipients && transfers.some((t) => !k.recipients?.includes(lc(t.to)))) return 'call_not_allowed'
    const total = transfers.reduce((s, t) => s + t.amount, 0n)
    if ((this.currentLimit(k, token)?.remaining ?? 0n) < total) return 'spending_limit_exceeded'
    if (this.balance(token, account) < total) return 'insufficient_balance'
    return null
  }

  private nextHash(prefix: number) {
    return hex32(prefix, ++this.counter)
  }
}

function encodePayload(p: Payload): Hex {
  const json = JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
  return bytesToHex(new TextEncoder().encode(json))
}

function decodePayload(raw: Hex): Payload | null {
  const bytes = hexToBytes(raw)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes), (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v))
  } catch {
    return null
  }
}
