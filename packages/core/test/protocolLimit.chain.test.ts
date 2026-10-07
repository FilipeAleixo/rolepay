// Opt-in, real chain: Tempo itself refuses a batch over the bot key's spending limit, on the
// Moderato TESTNET (chain 42431). Run with `pnpm test:chain`. Never mainnet: the test refuses any
// other chain ID.
//
// Rolepay's own pre-flight (`checkKeyForRun`) refuses an over-limit run before anything is signed
// (rolepay.chain.test.ts). This test skips that pre-flight on purpose: it signs the batch with the
// bot's access key and sends it straight to the chain with no simulation, so the only thing left
// to stop it is the protocol. It shows the limit holds even if Rolepay's code did not check it.
//
// A throwaway treasury key is generated in memory. The bot pays its fees in pathUSD from a
// separate fee budget, so no sponsor or relay sits between the signed batch and the chain.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Hex, decodeErrorResult } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Account, createClient, http } from 'viem/tempo'
import { beforeAll, describe, expect, it } from 'vitest'
import { TempoPayoutChain, createTestnetTools, rootSignerFromPrivateKey } from '../src/adapters/index.js'
import { buildBatchCalls, retryUnavailable } from '../src/adapters/tempo/index.js'
import { NETWORKS, TESTNET_TOKENS, VALID_BEFORE_SECONDS, encodeMemo, keyAuthorization, parseAmount } from '../src/index.js'
import type { BatchTransfer } from '../src/ports/payoutChain.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const FEE_TOKEN = TESTNET_TOKENS.path_usd
/**
 * A fixed gas limit, so nothing is estimated or simulated. A 3-line batch to fresh addresses used
 * about 860k gas on Moderato; the within-limit batch below proves this limit is enough for the shape.
 */
const GAS = 2_000_000n
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const fresh = () => privateKeyToAddress(generatePrivateKey()).toLowerCase() as `0x${string}`
const nowSeconds = () => Math.floor(Date.now() / 1000)
const rpc = () => retryUnavailable(http(NET.rpcUrl, { retryCount: 6, retryDelay: 400 }))
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'protocolLimit.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

type CallFrame = { to: string; output?: Hex; error?: string; calls?: CallFrame[] }

describe('Tempo enforces the bot key limit inside a batch, with no Rolepay pre-flight (Moderato)', () => {
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const reader = createClient({ testnet: true, transport: rpc() })
  let bot: Awaited<ReturnType<TempoPayoutChain['newAccessKey']>>
  const remaining = async () => (await chain.keyState({ account: root.address, accessKey: bot.address, token: TOKEN, feeToken: FEE_TOKEN })).remaining
  /** Three lines of `amount` each, to fresh addresses, with Rolepay's memos. */
  const batch = (runId: string, amount: bigint) => [1, 2, 3].map((line): BatchTransfer => ({ to: fresh(), amount, memo: encodeMemo(runId, line) }))

  /**
   * Signs a batch with the bot's access key, every field set by hand: no eth_fillTransaction and no
   * gas estimate, so the node never simulates it before it is broadcast. Rolepay's adapter
   * (`signBatch`) fills through the node instead, which is checked separately below.
   */
  async function signUnsimulated(transfers: BatchTransfer[]): Promise<Hex> {
    const account = Account.fromSecp256k1(bot.secret as Hex, { access: root.address })
    const client = createClient({ account, testnet: true, transport: rpc() })
    const fees = await client.estimateFeesPerGas()
    const request = await client.prepareTransactionRequest({
      calls: buildBatchCalls(TOKEN, transfers),
      chainId: NET.chainId,
      gas: GAS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      feeToken: FEE_TOKEN,
      nonceKey: 'expiring',
      validBefore: nowSeconds() + VALID_BEFORE_SECONDS,
    } as never)
    return (await client.signTransaction(request as never)) as Hex
  }

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, TOKEN, usd('10')) // the faucet funds every testnet stablecoin, pathUSD included
    bot = await chain.newAccessKey()
    // The restrictions production gives the bot (keyAuthorization, as on the setup page): an
    // expiry, a per-period limit on the payout token, a fee budget in pathUSD, and
    // transferWithMemo on the payout token as the only call allowed.
    const authorization = keyAuthorization({
      token: TOKEN,
      limit: usd('3'),
      periodSeconds: 86_400,
      expiresAt: nowSeconds() + 3600,
      recipients: null,
      feeToken: FEE_TOKEN,
      feeBudget: usd('1'),
    })
    const a = await chain.authorizeKey({ root, accessKey: bot.address, authorization })
    if (!a.ok) throw new Error(json(a.error))
    record({ step: 'authorize', limit: '3 AlphaUSD per day', tx: a.value.txHash, url: `${NET.explorerUrl}/tx/${a.value.txHash}` })
    expect(await remaining()).toBe(usd('3'))
  })

  it('control: a 3-line batch within the limit, signed and sent the same way, lands', async () => {
    const transfers = batch('LIMIT-WITHIN', usd('0.5'))
    const out = await chain.broadcast(await signUnsimulated(transfers))
    if (out.kind !== 'confirmed') throw new Error(json(out))
    record({ step: 'within-limit', total: '1.5', tx: out.txHash, url: `${NET.explorerUrl}/tx/${out.txHash}` })
    expect(out.transfers).toHaveLength(3)
    for (const t of transfers) expect(await testnet.balance(TOKEN, t.to)).toBe(usd('0.5'))
    expect(await remaining()).toBe(usd('1.5'))
  })

  it('over the limit: each line fits what is left, the batch does not; it lands, reverts whole with SpendingLimitExceeded and pays nobody', async () => {
    // 1.5 left. Lines of 0.6: the first two (1.2) would fit, the third takes the total to 1.8.
    const transfers = batch('LIMIT-OVER', usd('0.6'))
    const out = await chain.broadcast(await signUnsimulated(transfers))
    if (out.kind !== 'reverted') throw new Error(`expected the chain to revert the batch, got ${json(out)}`)
    const url = `${NET.explorerUrl}/tx/${out.txHash}`
    console.log(`over-limit batch, reverted by the protocol: ${url}`)

    // It was included in a block and reverted, and not for want of gas.
    const receipt = await reader.getTransactionReceipt({ hash: out.txHash })
    expect(receipt.status).toBe('reverted')
    expect(receipt.gasUsed).toBeLessThan(GAS)

    // The call trace: transfers 1 and 2 ran, transfer 3 hit the Account Keychain's limit, and the
    // whole transaction was undone.
    const trace = (await reader.request({ method: 'debug_traceTransaction', params: [out.txHash, { tracer: 'callTracer' }] } as never)) as CallFrame
    const calls = trace.calls ?? []
    expect(calls.map((c) => c.to.toLowerCase())).toEqual([TOKEN, TOKEN, TOKEN])
    expect(calls.slice(0, 2).map((c) => c.error)).toEqual([undefined, undefined])
    expect(calls[2]?.error).toBe('execution reverted')
    expect(decodeErrorResult({ abi: Abis.accountKeychain, data: calls[2]?.output as Hex }).errorName).toBe('SpendingLimitExceeded')

    // Nothing moved: no memo transfer on chain, no recipient paid, the key's budget untouched.
    expect(await chain.findMemoTransfers({ token: TOKEN, from: root.address, memos: transfers.map((t) => t.memo), fromBlock: out.blockNumber })).toEqual([])
    for (const t of transfers) expect(await testnet.balance(TOKEN, t.to)).toBe(0n)
    expect(await remaining()).toBe(usd('1.5'))
    record({ step: 'over-limit', total: '1.8', left: '1.5', outcome: 'reverted', revert: 'SpendingLimitExceeded (call 3 of 3)', gasUsed: receipt.gasUsed, tx: out.txHash, url })
  })

  it("through Rolepay's own Tempo adapter (still no pre-flight), the node refuses to fill the same batch", async () => {
    const transfers = batch('LIMIT-ADAPTER', usd('0.6'))
    const signed = await chain.signBatch({
      account: root.address,
      accessKeySecret: bot.secret,
      token: TOKEN,
      transfers,
      validBefore: nowSeconds() + VALID_BEFORE_SECONDS,
      fee: { mode: 'fee_budget', feeToken: FEE_TOKEN },
    })
    expect(signed).toMatchObject({ ok: false, error: { code: 'rejected', reason: 'spending_limit_exceeded' } })
    for (const t of transfers) expect(await testnet.balance(TOKEN, t.to)).toBe(0n)
    expect(await remaining()).toBe(usd('1.5'))
    record({ step: 'adapter-refused', reason: signed.ok ? null : signed.error.reason })
  })
})
