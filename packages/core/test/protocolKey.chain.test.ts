// Opt-in, real chain: Tempo itself refuses what the bot's access key was never given, on the
// Moderato TESTNET (chain 42431). Run with `pnpm test:chain`. Never mainnet: the test refuses any
// other chain ID.
//
// The bot key may make one call, `transferWithMemo` on the payout token, and nothing once the
// treasury's root has revoked it. Rolepay never builds any other call, and its pre-flight
// (`checkKeyForRun`) stops a revoked key before anything is signed (rolepay.chain.test.ts). These
// tests skip Rolepay on purpose, in the style of protocolLimit.chain.test.ts: they sign with the
// bot's access key with every field set by hand (no eth_fillTransaction, no gas estimate, so the
// node never simulates the transaction first), pay fees from the key's own pathUSD fee budget (no
// sponsor or relay in between), and send the bytes straight to the chain. What refuses them is
// the protocol.
//
// A throwaway treasury key is generated in memory.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Hex, decodeErrorResult, encodeFunctionData } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Account, createClient, http } from 'viem/tempo'
import { beforeAll, describe, expect, it } from 'vitest'
import { TempoPayoutChain, createTestnetTools, rootSignerFromPrivateKey } from '../src/adapters/index.js'
import { buildBatchCalls, retryUnavailable } from '../src/adapters/tempo/index.js'
import { NETWORKS, TESTNET_TOKENS, VALID_BEFORE_SECONDS, encodeMemo, keyAuthorization, parseAmount } from '../src/index.js'
import type { BroadcastOutcome } from '../src/ports/payoutChain.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const FEE_TOKEN = TESTNET_TOKENS.path_usd
/** A fixed gas limit, so nothing is estimated or simulated (one call needs far less). */
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
const txUrl = (hash: string) => `${NET.explorerUrl}/tx/${hash}`

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'protocolKey.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

type Call = { to: `0x${string}`; data: Hex }
const KEYCHAIN_ERRORS = Abis.accountKeychain.filter((x) => x.type === 'error').map((x) => x.name)

/** How the chain refused a transaction: at submit (it never entered a block), or by reverting it, with the Account Keychain's error. */
type Refusal = { refused: 'submit'; error: string | null; detail: string } | { refused: 'revert'; error: string | null; txHash: Hex; gasUsed: bigint }

describe("Tempo refuses what the bot key was not given, with no Rolepay pre-flight (Moderato)", () => {
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const reader = createClient({ testnet: true, transport: rpc() })
  const state = (key: { address: `0x${string}` }) => chain.keyState({ account: root.address, accessKey: key.address, token: TOKEN, feeToken: FEE_TOKEN })
  const treasuryBalance = () => testnet.balance(TOKEN, root.address)
  const memoTransfer = (to: `0x${string}`, amount: bigint, runId: string): Call => buildBatchCalls(TOKEN, [{ to, amount, memo: encodeMemo(runId, 1) }])[0] as Call

  /** A fresh bot key with the restrictions production gives it (as on the setup page), authorised by the root. */
  async function authorizedKey(step: string) {
    const key = await chain.newAccessKey()
    // An expiry, a per-period limit on the payout token, a fee budget in pathUSD, and
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
    const a = await chain.authorizeKey({ root, accessKey: key.address, authorization })
    if (!a.ok) throw new Error(json(a.error))
    record({ step, limit: '3 AlphaUSD per day, fee budget 1 pathUSD, transferWithMemo on AlphaUSD only', tx: a.value.txHash, url: txUrl(a.value.txHash) })
    expect(await state(key)).toMatchObject({ status: 'active', remaining: usd('3') })
    return key
  }

  /**
   * Signs `calls` with the bot's access key, every field set by hand: no eth_fillTransaction and
   * no gas estimate, so the node never simulates it before it is broadcast. Fees come from the
   * key's pathUSD fee budget.
   */
  async function signUnsimulated(secret: string, calls: Call[]): Promise<Hex> {
    const account = Account.fromSecp256k1(secret as Hex, { access: root.address })
    const client = createClient({ account, testnet: true, transport: rpc() })
    const fees = await client.estimateFeesPerGas()
    const request = await client.prepareTransactionRequest({
      calls,
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

  /** Sends a signed transaction the chain must refuse, and says how it refused it. Fails if it lands. */
  async function refusal(out: BroadcastOutcome): Promise<Refusal> {
    if (out.kind === 'confirmed') throw new Error(`the chain accepted it: ${txUrl(out.txHash)}`)
    if (out.kind === 'rejected') return { refused: 'submit', error: KEYCHAIN_ERRORS.find((e) => out.detail.includes(e)) ?? null, detail: out.detail }
    if (out.kind === 'unknown') throw new Error(`no definite answer from the node: ${out.detail}`)
    // It was included in a block and reverted, and not for want of gas.
    const receipt = await reader.getTransactionReceipt({ hash: out.txHash })
    expect(receipt.status).toBe('reverted')
    expect(receipt.gasUsed).toBeLessThan(GAS)
    // The keychain refuses an out-of-scope call before it runs, so the call tracer shows no frame
    // for it; the default tracer's return value carries the Account Keychain's error.
    const trace = (await reader.request({ method: 'debug_traceTransaction', params: [out.txHash, { disableStack: true, disableStorage: true }] } as never)) as { failed: boolean; returnValue: string }
    expect(trace.failed).toBe(true)
    const data = (trace.returnValue.startsWith('0x') ? trace.returnValue : `0x${trace.returnValue}`) as Hex
    let error: string | null = null
    try {
      error = decodeErrorResult({ abi: Abis.accountKeychain, data }).errorName
    } catch {
      // not an Account Keychain error: `error` stays null and the test says so
    }
    return { refused: 'revert', error, txHash: out.txHash, gasUsed: receipt.gasUsed }
  }

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, TOKEN, usd('10')) // the faucet funds every testnet stablecoin, pathUSD included
  })

  describe('out of scope: the key may call transferWithMemo on the payout token, and nothing else', () => {
    let bot: Awaited<ReturnType<typeof authorizedKey>>
    beforeAll(async () => {
      bot = await authorizedKey('authorize (scope)')
    })

    it('control: transferWithMemo on the payout token, signed and sent the same way, lands', async () => {
      const to = fresh()
      const out = await chain.broadcast(await signUnsimulated(bot.secret, [memoTransfer(to, usd('0.5'), 'SCOPE-IN')]))
      if (out.kind !== 'confirmed') throw new Error(json(out))
      record({ step: 'in-scope', call: 'transferWithMemo(AlphaUSD)', amount: '0.5', tx: out.txHash, url: txUrl(out.txHash) })
      expect(out.transfers).toHaveLength(1)
      expect(await testnet.balance(TOKEN, to)).toBe(usd('0.5'))
      expect((await state(bot)).remaining).toBe(usd('2.5'))
    })

    // Every call below fits the key's limits (2.5 AlphaUSD left, and the pathUSD fee budget for
    // the pathUSD one), so a limit cannot be what stops it: only the scope can.
    const cases: { name: string; call: (to: `0x${string}`) => Call; moved: (to: `0x${string}`) => Promise<bigint>; limit: 'payout' | 'fee' }[] = [
      {
        name: 'a plain transfer (no memo) of the payout token',
        call: (to) => ({ to: TOKEN, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [to, usd('0.5')] }) }),
        moved: (to) => testnet.balance(TOKEN, to),
        limit: 'payout',
      },
      {
        name: 'transferWithMemo on another TIP-20 token (pathUSD, which the key may spend, but only on fees)',
        call: (to) => ({ to: FEE_TOKEN, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [to, usd('0.05'), encodeMemo('SCOPE-TOKEN', 1)] }) }),
        moved: (to) => testnet.balance(FEE_TOKEN, to),
        limit: 'fee',
      },
      {
        name: 'approve on the payout token',
        call: (spender) => ({ to: TOKEN, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'approve', args: [spender, usd('0.5')] }) }),
        moved: (spender) => reader.readContract({ address: TOKEN, abi: Abis.tip20, functionName: 'allowance', args: [root.address, spender] }) as Promise<bigint>,
        limit: 'payout',
      },
    ]

    for (const c of cases) {
      it(`out of scope, ${c.name}: the chain refuses it with CallNotAllowed and nothing moves`, async () => {
        const before = await state(bot)
        if (c.limit === 'fee') expect(before.feeBudgetRemaining).toBeGreaterThan(usd('0.05'))
        else expect(before.remaining).toBeGreaterThanOrEqual(usd('0.5'))
        const treasury = await treasuryBalance()
        const to = fresh()

        const r = await refusal(await chain.broadcast(await signUnsimulated(bot.secret, [c.call(to)])))
        if (r.refused === 'revert') console.log(`${c.name}, reverted by the protocol: ${txUrl(r.txHash)}`)
        record({ step: 'out-of-scope', call: c.name, ...r, ...(r.refused === 'revert' ? { url: txUrl(r.txHash) } : {}) })
        expect(r.error).toBe('CallNotAllowed')

        // Nothing moved: the recipient (or spender) holds nothing, the treasury's payout balance and the key's budget are untouched.
        expect(await c.moved(to)).toBe(0n)
        expect(await treasuryBalance()).toBe(treasury)
        expect((await state(bot)).remaining).toBe(before.remaining)
      })
    }
  })

  describe('revoked: once the root revokes the key, nothing it signs is accepted', () => {
    let bot: Awaited<ReturnType<typeof authorizedKey>>
    beforeAll(async () => {
      bot = await authorizedKey('authorize (revocation)')
    })

    it('control: before the revocation, a transfer it signs lands', async () => {
      const to = fresh()
      const out = await chain.broadcast(await signUnsimulated(bot.secret, [memoTransfer(to, usd('0.5'), 'REVOKE-BEFORE')]))
      if (out.kind !== 'confirmed') throw new Error(json(out))
      record({ step: 'before-revoke', amount: '0.5', tx: out.txHash, url: txUrl(out.txHash) })
      expect(await testnet.balance(TOKEN, to)).toBe(usd('0.5'))
    })

    it('after the root revokes it, the same transfer, signed by hand with the revoked key, is refused and moves nothing', async () => {
      const revoked = await chain.revokeKey({ root, accessKey: bot.address })
      if (!revoked.ok) throw new Error(json(revoked.error))
      record({ step: 'revoke', tx: revoked.value.txHash, url: txUrl(revoked.value.txHash) })
      expect((await state(bot)).status).toBe('revoked')

      const treasury = await treasuryBalance()
      const to = fresh()
      const call = memoTransfer(to, usd('0.5'), 'REVOKE-AFTER')
      const r = await refusal(await chain.broadcast(await signUnsimulated(bot.secret, [call])))
      if (r.refused === 'revert') console.log(`revoked key, reverted by the protocol: ${txUrl(r.txHash)}`)
      record({ step: 'after-revoke', ...r, ...(r.refused === 'revert' ? { url: txUrl(r.txHash) } : {}) })
      expect(r.error).toBe('KeyAlreadyRevoked')

      // Nothing moved: no memo transfer on chain, the recipient holds nothing, the treasury is untouched.
      const fromBlock = (await chain.head()).number - 50n
      expect(await chain.findMemoTransfers({ token: TOKEN, from: root.address, memos: [encodeMemo('REVOKE-AFTER', 1)], fromBlock })).toEqual([])
      expect(await testnet.balance(TOKEN, to)).toBe(0n)
      expect(await treasuryBalance()).toBe(treasury)
    })
  })
})
