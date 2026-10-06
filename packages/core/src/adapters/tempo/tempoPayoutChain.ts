import { type Account as ViemAccount, type Hex, type Log, type Transport, keccak256 } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Account, createClient, http, withRelay } from 'viem/tempo'
import { NETWORKS, type NetworkName, VALID_BEFORE_SECONDS } from '../../constants/tempo.js'
import type { KeyAuthorization, KeyState } from '../../domain/community.js'
import type { Address } from '../../domain/ids.js'
import type { MemoTransfer } from '../../domain/reconcile.js'
import { type Result, err, ok } from '../../domain/result.js'
import type {
  BatchTransfer,
  BroadcastOutcome,
  ChainRejectReason,
  ChainRejection,
  FeePayment,
  PayoutChain,
  RootSigner,
  SignedBatch,
  TxLookup,
} from '../../ports/payoutChain.js'
import { buildBatchCalls, classifyChainError, errorSummary, memoTransfersFromLogs } from './encoding.js'
import { idempotentSend } from './idempotentSend.js'
import { retryUnavailable } from './retryUnavailable.js'
import { unwrapRootSigner } from './rootSigner.js'

export type TempoPayoutChainOptions = {
  network: NetworkName
  rpcUrl: string
  /** Fee sponsor relay. null = no sponsorship (communities must use a fee budget). */
  sponsorUrl: string | null
  /** Max blocks per eth_getLogs call when searching memos. */
  maxLogRange?: bigint
}

const lc = <T extends string>(s: T) => s.toLowerCase() as T
const rejected = (reason: ChainRejectReason, detail: string): { ok: false; error: ChainRejection } =>
  err({ code: 'rejected', reason, detail })
const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * PayoutChain on Tempo through viem's built-in Tempo support (`viem/tempo`).
 * Read methods throw on infrastructure failure; write methods return results.
 * Lessons from the spike are encoded here: validBefore set explicitly (viem's 25 s
 * default goes stale on retries), the sponsor transport never retries (its errors are
 * slow and retryable by default), the keychain address is lowercase, and a lost
 * sync-send response is recovered by hash instead of re-signing.
 */
export class TempoPayoutChain implements PayoutChain {
  private readonly rpc: Transport
  private readonly testnet: boolean
  private readonly reader: ReturnType<typeof createClient>
  private readonly maxLogRange: bigint

  constructor(private readonly opts: TempoPayoutChainOptions) {
    this.testnet = NETWORKS[opts.network].testnet
    // The public RPC sometimes answers with an HTML error page under load: retry reads harder.
    this.rpc = idempotentSend(retryUnavailable(http(opts.rpcUrl, { retryCount: 6, retryDelay: 400 })))
    this.reader = createClient({ testnet: this.testnet, transport: this.rpc })
    this.maxLogRange = opts.maxLogRange ?? 10_000n
  }

  private client(account: ViemAccount, sponsored: boolean) {
    const transport =
      sponsored && this.opts.sponsorUrl ? withRelay(this.rpc, retryUnavailable(http(this.opts.sponsorUrl, { retryCount: 0 }))) : this.rpc
    return createClient({ account, testnet: this.testnet, transport })
  }

  async head() {
    const b = await this.reader.getBlock()
    return { number: b.number as bigint, timestamp: Number(b.timestamp) }
  }

  async newAccessKey() {
    const secret = generatePrivateKey()
    return { address: lc(privateKeyToAddress(secret)) as Address, secret }
  }

  async keyState(input: { account: Address; accessKey: Address; token: Address; feeToken: Address | null }): Promise<KeyState> {
    const [meta, block] = await Promise.all([
      this.reader.accessKey.getMetadata({ account: input.account, accessKey: input.accessKey }),
      this.reader.getBlock(),
    ])
    const chainTime = Number(block.timestamp)
    const expiry = Number(meta.expiry)
    // The keychain zeroes expiry on revoke; an unknown key reads as expiry 0, not revoked.
    const status: KeyState['status'] = meta.isRevoked ? 'revoked' : expiry === 0 ? 'not_authorized' : chainTime >= expiry ? 'expired' : 'active'
    if (status === 'revoked' || status === 'not_authorized') {
      return { status, expiry, remaining: 0n, periodEnd: null, chainTime, feeBudgetRemaining: null }
    }
    // Limit reads are not swallowed: an RPC failure must not read as "no budget left".
    const read = (token: Address) => this.reader.accessKey.getRemainingLimit({ account: input.account, accessKey: input.accessKey, token })
    const [spend, fee] = await Promise.all([read(input.token), input.feeToken ? read(input.feeToken) : Promise.resolve(null)])
    return {
      status,
      expiry,
      remaining: spend.remaining,
      periodEnd: spend.periodEnd ? Number(spend.periodEnd) || null : null,
      chainTime,
      feeBudgetRemaining: fee ? fee.remaining : null,
    }
  }

  async authorizeKey(input: { root: RootSigner; accessKey: Address; authorization: KeyAuthorization }): Promise<Result<{ txHash: Hex }, ChainRejection>> {
    const root = unwrapRootSigner(input.root)
    if (!root) return rejected('other', 'root signer was not created by the Tempo adapter')
    const sponsored = this.opts.sponsorUrl !== null
    try {
      const { receipt } = await this.client(root, sponsored).accessKey.authorizeSync({
        accessKey: { accessKeyAddress: input.accessKey, keyType: 'secp256k1' },
        expiry: input.authorization.expiry,
        limits: input.authorization.limits,
        scopes: input.authorization.scopes as never,
        ...(sponsored ? { feePayer: true, validBefore: nowSeconds() + VALID_BEFORE_SECONDS } : {}),
      })
      if (receipt.status !== 'success') return rejected('other', `authorize tx ${receipt.transactionHash} reverted`)
      return ok({ txHash: lc(receipt.transactionHash) })
    } catch (e) {
      const s = errorSummary(e)
      return rejected(classifyChainError(s) ?? 'other', s)
    }
  }

  async revokeKey(input: { root: RootSigner; accessKey: Address }): Promise<Result<{ txHash: Hex }, ChainRejection>> {
    const root = unwrapRootSigner(input.root)
    if (!root) return rejected('other', 'root signer was not created by the Tempo adapter')
    const sponsored = this.opts.sponsorUrl !== null
    try {
      const { receipt } = await this.client(root, sponsored).accessKey.revokeSync({
        accessKey: input.accessKey,
        ...(sponsored ? { feePayer: true, validBefore: nowSeconds() + VALID_BEFORE_SECONDS } : {}),
      })
      if (receipt.status !== 'success') return rejected('other', `revoke tx ${receipt.transactionHash} reverted`)
      return ok({ txHash: lc(receipt.transactionHash) })
    } catch (e) {
      const s = errorSummary(e)
      return rejected(classifyChainError(s) ?? 'other', s)
    }
  }

  async signBatch(input: {
    account: Address
    accessKeySecret: string
    token: Address
    transfers: BatchTransfer[]
    validBefore: number
    fee: FeePayment
  }): Promise<Result<SignedBatch, ChainRejection>> {
    const sponsored = input.fee.mode === 'sponsor'
    if (sponsored && !this.opts.sponsorUrl) return rejected('unavailable', 'fee mode is sponsor but no sponsor is configured')
    const bot = Account.fromSecp256k1(input.accessKeySecret as Hex, { access: input.account })
    const client = this.client(bot, sponsored)
    try {
      // Fill (simulation, fee-payer co-signature) and sign. Nothing is broadcast here.
      const request = await client.prepareTransactionRequest({
        calls: buildBatchCalls(input.token, input.transfers),
        validBefore: input.validBefore,
        ...(input.fee.mode === 'sponsor' ? { feePayer: true } : { feeToken: input.fee.feeToken, nonceKey: 'expiring' }),
      } as never)
      const rawTx = (await client.signTransaction(request as never)) as Hex
      return ok({ txHash: lc(keccak256(rawTx)), rawTx })
    } catch (e) {
      const s = errorSummary(e)
      return rejected(classifyChainError(s) ?? (/fetch failed|HTTP request failed|took too long/i.test(s) ? 'unavailable' : 'other'), s)
    }
  }

  async broadcast(rawTx: Hex): Promise<BroadcastOutcome> {
    try {
      const receipt = await this.reader.sendRawTransactionSync({ serializedTransaction: rawTx as never, throwOnReceiptRevert: false })
      const txHash = lc(receipt.transactionHash)
      if (receipt.status === 'success') {
        return { kind: 'confirmed', txHash, blockNumber: receipt.blockNumber, transfers: memoTransfersFromLogs(receipt.logs as Log[]) }
      }
      return { kind: 'reverted', txHash, blockNumber: receipt.blockNumber }
    } catch (e) {
      const s = errorSummary(e)
      const reason = classifyChainError(s)
      // Admission refusals are definitive: the tx never entered the pool.
      if (reason || /keychain validation failed|valid_before/i.test(s)) return { kind: 'rejected', reason: reason ?? 'other', detail: s }
      return { kind: 'unknown', detail: s }
    }
  }

  async lookupTx(txHash: Hex): Promise<TxLookup> {
    try {
      const r = await this.reader.getTransactionReceipt({ hash: txHash })
      return r.status === 'success'
        ? { kind: 'confirmed', blockNumber: r.blockNumber, transfers: memoTransfersFromLogs(r.logs as Log[]) }
        : { kind: 'reverted', blockNumber: r.blockNumber }
    } catch (e) {
      if (/could not be found|not found/i.test(errorSummary(e))) return { kind: 'not_found' }
      throw e
    }
  }

  async findMemoTransfers(input: { token: Address; from: Address; memos: Hex[]; fromBlock: bigint }): Promise<MemoTransfer[]> {
    if (input.memos.length === 0) return []
    const head = await this.reader.getBlockNumber()
    const out: MemoTransfer[] = []
    for (let start = input.fromBlock; start <= head; start += this.maxLogRange) {
      const end = start + this.maxLogRange - 1n < head ? start + this.maxLogRange - 1n : head
      const logs = await this.reader.getContractEvents({
        address: input.token,
        abi: Abis.tip20,
        eventName: 'TransferWithMemo',
        args: { from: input.from, memo: input.memos },
        fromBlock: start,
        toBlock: end,
      })
      out.push(...memoTransfersFromLogs(logs as unknown as Log[]))
    }
    return out
  }
}
