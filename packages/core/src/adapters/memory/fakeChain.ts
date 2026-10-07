import { STABLECOIN_DEX_ADDRESS, SWAP_EXACT_AMOUNT_OUT_SIGNATURE, TRANSFER_WITH_MEMO_SIGNATURE } from '../../constants/tempo.js'
import type { KeyAuthorization, KeyState } from '../../domain/community.js'
import { type SwapQuote, swapLegs } from '../../domain/delivery.js'
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
type Scope = { address: string; selector: string; recipients: string[] | null }
type KeyRecord = {
  address: Address
  secret: string
  account: Address | null
  expiry: number
  limits: Map<string, Limit>
  /** The calls the key may make: a target, a selector (the function signature) and, for a transfer, an optional recipient allowlist. */
  scopes: Scope[]
  revoked: boolean
}
/** A route on the fake stablecoin DEX: what one unit of output costs in input (basis points of par) and how much output it can deliver. */
type Route = { inPerOutBps: number; liquidity: bigint }
/** What a batch would do: what each token's limit is charged, and each swap's input and output. */
type Plan = { charges: Map<string, bigint>; legs: { token: string; amountOut: bigint; amountIn: bigint }[] }
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
  private routes = new Map<string, Route>()

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
  /** Sets (or with null removes) the DEX route from `tokenIn` to `tokenOut`. Without one, a swap has no route. */
  setSwapRoute(tokenIn: string, tokenOut: string, route: Route | null) {
    const key = `${lc(tokenIn)}>${lc(tokenOut)}`
    if (route) this.routes.set(key, { ...route })
    else this.routes.delete(key)
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
    this.keys.set(address, { address, secret, account: null, expiry: 0, limits: new Map(), scopes: [], revoked: false })
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
    k.scopes = a.scopes.map((s) => ({ address: lc(s.address), selector: s.selector, recipients: s.recipients ? s.recipients.map(lc) : null }))
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
    // Filling the tx simulates it: a batch that would revert is refused here, as the node does.
    const plan = this.plan(k, input.account, input.token, input.transfers)
    if ('refusal' in plan) return err({ code: 'rejected' as const, reason: plan.refusal, detail: `fake chain: ${plan.refusal}` })
    const payload: Payload = {
      n: ++this.counter,
      account: lc(input.account) as Address,
      key: (k as KeyRecord).address,
      token: lc(input.token) as Address,
      transfers: input.transfers.map((t) => ({ ...t, to: lc(t.to) as Address, ...(t.swap ? { swap: { token: lc(t.swap.token) as Address, maxIn: t.swap.maxIn } } : {}) })),
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

  async quoteSwap(input: { tokenIn: Address; tokenOut: Address; amountOut: bigint }): Promise<SwapQuote> {
    const amountIn = this.quote(input.tokenIn, input.tokenOut, input.amountOut)
    return amountIn === null ? { kind: 'no_route', detail: 'fake DEX: InsufficientLiquidity' } : { kind: 'quoted', amountIn }
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
    const plan = this.plan(k, payload.account, payload.token, payload.transfers)
    let landed: Landed
    if ('refusal' in plan) {
      landed = { txHash, blockNumber: this.blockNumber, status: 'reverted', transfers: [] }
    } else {
      for (const [token, amount] of plan.charges) (this.currentLimit(k, token) as Limit).remaining -= amount
      // The swaps first: the payout token goes to the DEX, the bought token lands in the treasury.
      for (const leg of plan.legs) {
        this.fund(payload.token, payload.account, -leg.amountIn)
        this.fund(payload.token, STABLECOIN_DEX_ADDRESS, leg.amountIn)
        this.fund(leg.token, payload.account, leg.amountOut)
        const route = this.routes.get(`${lc(payload.token)}>${leg.token}`) as Route
        route.liquidity -= leg.amountOut
      }
      const transfers = payload.transfers.map(({ swap, ...t }) => {
        const token = (swap ? lc(swap.token) : payload.token) as Address
        this.fund(token, payload.account, -t.amount)
        this.fund(token, t.to, t.amount)
        return { txHash, blockNumber: this.blockNumber, token, from: payload.account, ...t }
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

  /** Input for exactly `amountOut` on the route right now (rounded up), or null with no route or not enough liquidity. */
  private quote(tokenIn: string, tokenOut: string, amountOut: bigint): bigint | null {
    const route = this.routes.get(`${lc(tokenIn)}>${lc(tokenOut)}`)
    if (!route || route.liquidity < amountOut) return null
    return (amountOut * BigInt(route.inPerOutBps) + 9_999n) / 10_000n
  }

  private allowed(k: KeyRecord, target: string, selector: string, recipient: string | null): boolean {
    return k.scopes.some((s) => s.address === lc(target) && s.selector === selector && (recipient === null || s.recipients === null || s.recipients.includes(recipient)))
  }

  /**
   * What the batch would do, or why the chain refuses it. As on Tempo: every call must be in the
   * key's scope; a swap may not take more than its maximum; each token's limit is charged what
   * leaves the treasury in it (transfers, and a swap's actual input in the token it sells).
   */
  private plan(k: KeyRecord | undefined, account: string, token: string, transfers: BatchTransfer[]): Plan | { refusal: ChainRejectReason } {
    if (!k || k.account === null || k.account !== lc(account)) return { refusal: 'key_not_authorized' }
    if (k.revoked) return { refusal: 'key_revoked' }
    if (k.expiry <= this.time) return { refusal: 'key_expired' }
    const legs: Plan['legs'] = []
    for (const leg of swapLegs(transfers)) {
      if (!this.allowed(k, STABLECOIN_DEX_ADDRESS, SWAP_EXACT_AMOUNT_OUT_SIGNATURE, null)) return { refusal: 'call_not_allowed' }
      const amountIn = this.quote(token, leg.token, leg.amountOut)
      if (amountIn === null || amountIn > leg.maxIn) return { refusal: 'swap_failed' }
      legs.push({ token: lc(leg.token), amountOut: leg.amountOut, amountIn })
    }
    for (const t of transfers) if (!this.allowed(k, t.swap?.token ?? token, TRANSFER_WITH_MEMO_SIGNATURE, lc(t.to))) return { refusal: 'call_not_allowed' }
    const charges = new Map<string, bigint>()
    const charge = (t: string, amount: bigint) => charges.set(lc(t), (charges.get(lc(t)) ?? 0n) + amount)
    for (const leg of legs) charge(token, leg.amountIn)
    for (const t of transfers) charge(t.swap?.token ?? token, t.amount)
    for (const [t, amount] of charges) if ((this.currentLimit(k, t)?.remaining ?? 0n) < amount) return { refusal: 'spending_limit_exceeded' }
    // The payout token pays the plain lines and the swaps; what a swap buys covers its lines.
    const payoutOut = transfers.filter((t) => !t.swap).reduce((s, t) => s + t.amount, 0n) + legs.reduce((s, l) => s + l.amountIn, 0n)
    if (this.balance(token, account) < payoutOut) return { refusal: 'insufficient_balance' }
    return { charges, legs }
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
