// Opt-in, real chain: paying each person in the stablecoin they prefer, on Tempo's Moderato TESTNET
// (chain 42431), through the enshrined stablecoin DEX. Run with `pnpm test:chain`. Never mainnet:
// the test refuses any other chain ID.
//
// 1. Which pairs of AlphaUSD, BetaUSD and ThetaUSD the DEX routes (read-only quotes).
// 2. A run paying one person in the payout token (AlphaUSD) and one in their preferred BetaUSD, in
//    ONE batched transaction: the swap, then each line's transferWithMemo with its memo.
// 3. A swap whose input would exceed its cap is refused whole: by Rolepay's pre-flight before
//    anything is signed, and by the chain itself (a batch signed by hand, no pre-flight, lands and
//    reverts with the DEX's MaxInputExceeded, paying nobody).
// 4. The key cannot move the preferred token outside a run except by transferWithMemo within its
//    BetaUSD limit: signed by hand with no pre-flight, in the style of protocolLimit.chain.test.ts.
//
// A throwaway treasury key is generated in memory. Fees come from a pathUSD fee budget, so nothing
// sits between the bot key and the chain (a sponsor would simulate the batches and refuse the bad ones).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Hex, decodeErrorResult, encodeFunctionData, toFunctionSelector } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Account, Addresses, createClient, http } from 'viem/tempo'
import { beforeAll, describe, expect, it } from 'vitest'
import { AesGcmKeyVault, RandomIds, SystemClock, TempoPayoutChain, createMemoryRepositories, createTestnetTools, rootSignerFromPrivateKey } from '../src/adapters/index.js'
import { retryUnavailable } from '../src/adapters/tempo/index.js'
import {
  NETWORKS,
  type Rolepay,
  STABLECOIN_DEX_ADDRESS,
  SWAP_EXACT_AMOUNT_OUT_SIGNATURE,
  TESTNET_TOKENS,
  TRANSFER_WITH_MEMO_SIGNATURE,
  VALID_BEFORE_SECONDS,
  botKeyContext,
  createRolepay,
  encodeMemo,
  parseAmount,
} from '../src/index.js'
import type { BroadcastOutcome } from '../src/ports/payoutChain.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
const NET = NETWORKS.moderato
const { alpha_usd: ALPHA, beta_usd: BETA, theta_usd: THETA, path_usd: PATH } = TESTNET_TOKENS
const OUSD = '0x20c0000000000000000000006a37da5c996874be'
const SYMBOL: Record<string, string> = { [ALPHA]: 'AlphaUSD', [BETA]: 'BetaUSD', [THETA]: 'ThetaUSD' }
/** A fixed gas limit, so nothing is estimated or simulated (a swap and two transfers need far less). */
const GAS = 3_000_000n
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)
const fresh = () => privateKeyToAddress(generatePrivateKey()).toLowerCase() as `0x${string}`
const nowSeconds = () => Math.floor(Date.now() / 1000)
const rpc = () => retryUnavailable(http(NET.rpcUrl, { retryCount: 6, retryDelay: 400 }))
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const txUrl = (hash: string) => `${NET.explorerUrl}/tx/${hash}`

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'preferredToken.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

type Call = { to: `0x${string}`; data: Hex }
const memoTransfer = (token: string, to: string, amount: bigint, runId: string, line = 1): Call => ({
  to: token as `0x${string}`,
  data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [to as `0x${string}`, amount, encodeMemo(runId, line)] }),
})
const swapCall = (tokenIn: string, tokenOut: string, amountOut: bigint, maxIn: bigint): Call => ({
  to: STABLECOIN_DEX_ADDRESS as `0x${string}`,
  data: encodeFunctionData({ abi: Abis.stablecoinDex, functionName: 'swapExactAmountOut', args: [tokenIn as `0x${string}`, tokenOut as `0x${string}`, amountOut, maxIn] }),
})
const ERRORS = [...Abis.accountKeychain, ...Abis.stablecoinDex].filter((x) => x.type === 'error')
const ERROR_NAMES = ERRORS.map((x) => x.name)

/** How the chain refused a transaction: at submit (it never entered a block), or by reverting it, with the error. */
type Refusal = { refused: 'submit'; error: string | null; detail: string } | { refused: 'revert'; error: string | null; txHash: Hex; gasUsed: bigint }

describe('paying each person in the stablecoin they prefer (Moderato, the enshrined stablecoin DEX)', () => {
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const reader = createClient({ testnet: true, transport: rpc() })
  const repositories = createMemoryRepositories()
  const deps = { chain, repositories, vault: new AesGcmKeyVault(generatePrivateKey().slice(2)), ids: new RandomIds(), clock: new SystemClock(), network: 'moderato' as const }
  const rolepay: Rolepay = createRolepay(deps)
  const guildId = snowflake()
  const ana = { id: '200000000000000301', address: fresh() }
  const bo = { id: '200000000000000302', address: fresh() }
  let botKey: { address: `0x${string}`; secret: string }
  const limitLeft = async (token: string) => (await chain.keyState({ account: root.address, accessKey: botKey.address, token: token as `0x${string}`, feeToken: null })).remaining

  /** Signs `calls` with the bot's access key, every field set by hand (no fill, no gas estimate, no simulation); fees from the pathUSD fee budget. */
  async function signUnsimulated(calls: Call[]): Promise<Hex> {
    const account = Account.fromSecp256k1(botKey.secret as Hex, { access: root.address })
    const client = createClient({ account, testnet: true, transport: rpc() })
    const fees = await client.estimateFeesPerGas()
    const request = await client.prepareTransactionRequest({
      calls,
      chainId: NET.chainId,
      gas: GAS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      feeToken: PATH,
      nonceKey: 'expiring',
      validBefore: nowSeconds() + VALID_BEFORE_SECONDS,
    } as never)
    return (await client.signTransaction(request as never)) as Hex
  }

  /** Sends a signed transaction the chain must refuse, and says how. Fails if it lands. */
  async function refusal(out: BroadcastOutcome): Promise<Refusal> {
    if (out.kind === 'confirmed') throw new Error(`the chain accepted it: ${txUrl(out.txHash)}`)
    if (out.kind === 'rejected') return { refused: 'submit', error: ERROR_NAMES.find((e) => out.detail.includes(e)) ?? null, detail: out.detail }
    if (out.kind === 'unknown') throw new Error(`no definite answer from the node: ${out.detail}`)
    const receipt = await reader.getTransactionReceipt({ hash: out.txHash })
    expect(receipt.status).toBe('reverted')
    expect(receipt.gasUsed).toBeLessThan(GAS)
    const trace = (await reader.request({ method: 'debug_traceTransaction', params: [out.txHash, { disableStack: true, disableStorage: true }] } as never)) as { failed: boolean; returnValue: string }
    expect(trace.failed).toBe(true)
    const data = (trace.returnValue.startsWith('0x') ? trace.returnValue : `0x${trace.returnValue}`) as Hex
    let error: string | null = null
    try {
      error = decodeErrorResult({ abi: ERRORS, data }).errorName
    } catch {
      // not a keychain or DEX error: `error` stays null and the test says so
    }
    return { refused: 'revert', error, txHash: out.txHash, gasUsed: receipt.gasUsed }
  }

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, ALPHA, usd('100')) // the faucet funds every testnet stablecoin, BetaUSD and pathUSD included
    const reg = await rolepay.communities.register({ guildId, name: 'Preferred tokens on Moderato', treasuryAddress: root.address, payoutToken: ALPHA, feeMode: 'fee_budget', feeToken: PATH })
    if (!reg.ok) throw new Error(json(reg.error))
    expect(await rolepay.communities.setPreferredTokens({ guildId, enabled: true })).toMatchObject({ ok: true, value: { keyNeedsSwapScope: true } })
    const p = await rolepay.communities.provisionBotKey({ guildId, limit: usd('20'), periodSeconds: 86_400, expiresAt: nowSeconds() + 3600, feeBudget: usd('2') })
    if (!p.ok) throw new Error(json(p.error))
    const a = await rolepay.communities.authorizeBotKey({ guildId, root })
    if (!a.ok) throw new Error(json(a.error))
    record({ step: 'authorize', limits: '20 AlphaUSD, 20 BetaUSD, 20 ThetaUSD a day; fee budget 2 pathUSD', tx: a.value.txHash, url: txUrl(a.value.txHash) })
    // The secret, for the hand-signed transactions below (the services never hand it out).
    const key = (await repositories.communities.listBotKeys(guildId)).find((k) => k.status === 'active')
    if (!key?.sealedSecret) throw new Error('no active key')
    const opened = await deps.vault.open(key.sealedSecret, botKeyContext(guildId, key.address))
    if (!opened.ok) throw new Error('unseal')
    botKey = { address: key.address, secret: opened.value }
    for (const [payee, prefers] of [
      [ana, BETA],
      [bo, null],
    ] as const) {
      const link = await rolepay.payees.issueLink({ guildId, discordUserId: payee.id })
      if (!link.ok) throw new Error(link.error.code)
      expect((await rolepay.payees.register({ token: link.value.token, address: payee.address })).ok).toBe(true)
      expect((await rolepay.payees.setPreferredToken({ guildId, discordUserId: payee.id, token: prefers })).ok).toBe(true)
    }
  })

  it('the key on chain has exactly the call scope Rolepay built: transferWithMemo on AlphaUSD, the exact-output swap on the DEX, transferWithMemo on BetaUSD and ThetaUSD', async () => {
    const [isScoped, scopes] = (await reader.readContract({
      address: Addresses.accountKeychain,
      abi: Abis.accountKeychain,
      functionName: 'getAllowedCalls',
      args: [root.address, botKey.address],
    })) as readonly [boolean, readonly { target: string; selectorRules: readonly { selector: string; recipients: readonly string[] }[] }[]]
    expect(isScoped).toBe(true)
    const rule = (sig: string) => [{ selector: toFunctionSelector(sig), recipients: [] }]
    expect(scopes.map((s) => ({ target: s.target.toLowerCase(), selectorRules: s.selectorRules.map((r) => ({ selector: r.selector, recipients: [...r.recipients] })) }))).toEqual([
      { target: ALPHA, selectorRules: rule(TRANSFER_WITH_MEMO_SIGNATURE) },
      { target: STABLECOIN_DEX_ADDRESS, selectorRules: rule(SWAP_EXACT_AMOUNT_OUT_SIGNATURE) },
      { target: BETA, selectorRules: rule(TRANSFER_WITH_MEMO_SIGNATURE) },
      { target: THETA, selectorRules: rule(TRANSFER_WITH_MEMO_SIGNATURE) },
    ])
    for (const token of [ALPHA, BETA, THETA]) expect(await limitLeft(token)).toBe(usd('20'))
  })

  it('the DEX routes every pair of AlphaUSD, BetaUSD and ThetaUSD (read-only quotes for 1 unit out), and refuses an amount past its liquidity', async () => {
    const routes: Record<string, string> = {}
    for (const tokenIn of [ALPHA, BETA, THETA]) {
      for (const tokenOut of [ALPHA, BETA, THETA]) {
        if (tokenIn === tokenOut) continue
        const q = await chain.quoteSwap({ tokenIn, tokenOut, amountOut: usd('1') })
        routes[`${SYMBOL[tokenIn]} -> ${SYMBOL[tokenOut]}`] = q.kind === 'quoted' ? `1 costs ${Number(q.amountIn) / 1e6}` : `no route: ${q.detail.slice(0, 80)}`
        expect(q.kind).toBe('quoted')
        // The DEX's prices stay within 2% of par per hop, and a pair routes through pathUSD in at most two hops.
        if (q.kind === 'quoted') expect(q.amountIn).toBeLessThanOrEqual(usd('1.0405'))
      }
    }
    record({ step: 'routes', routes })
    console.log('DEX routes on Moderato:', routes)
    expect(await chain.quoteSwap({ tokenIn: ALPHA, tokenOut: BETA, amountOut: usd('10000000000') })).toMatchObject({ kind: 'no_route' })
  })

  let paidTx: Hex
  it('pays Ana in BetaUSD (her choice) and Bo in AlphaUSD in ONE batched transaction, each line found by its memo', async () => {
    const before = { alpha: await limitLeft(ALPHA), beta: await limitLeft(BETA), treasuryBeta: await testnet.balance(BETA, root.address) }
    const created = await rolepay.payRuns.create({
      guildId,
      createdBy: bo.id,
      note: 'preferred tokens',
      lines: [
        { discordUserId: ana.id, amount: usd('1.5') },
        { discordUserId: bo.id, amount: usd('1') },
      ],
    })
    if (!created.ok) throw new Error(json(created.error))
    expect(created.value.lines[0]?.swap).toEqual({ token: BETA, maxIn: usd('1.515') })
    expect(created.value.lines[1]?.swap).toBeUndefined()
    const ref = { guildId, runId: created.value.id }
    await rolepay.payRuns.submit({ ...ref, actor: bo.id })
    await rolepay.payRuns.approve({ ...ref, actor: '300000000000000301', actorCanApprove: true })
    const paid = await rolepay.payRuns.execute(ref)
    if (!paid.ok) throw new Error(json(paid.error))
    expect(paid.value.status).toBe('paid')
    paidTx = paid.value.run.paidTxHash as Hex
    console.log(`one batch, swap + two memo transfers: ${txUrl(paidTx)}`)

    // Balances: Ana holds BetaUSD and no AlphaUSD; Bo holds AlphaUSD; the treasury kept no extra BetaUSD.
    expect(await testnet.balance(BETA, ana.address)).toBe(usd('1.5'))
    expect(await testnet.balance(ALPHA, ana.address)).toBe(0n)
    expect(await testnet.balance(ALPHA, bo.address)).toBe(usd('1'))
    expect(await testnet.balance(BETA, root.address)).toBe(before.treasuryBeta)

    // Memos: exactly one TransferWithMemo per line in the transaction, each in the token its line delivers.
    const tx = await chain.lookupTx(paidTx)
    if (tx.kind !== 'confirmed') throw new Error(json(tx))
    expect(tx.transfers.map((t) => ({ token: t.token, to: t.to, amount: t.amount, memo: t.memo }))).toEqual([
      { token: BETA, to: ana.address, amount: usd('1.5'), memo: encodeMemo(ref.runId, 1) },
      { token: ALPHA, to: bo.address, amount: usd('1'), memo: encodeMemo(ref.runId, 2) },
    ])
    const head = await chain.head()
    const fromBlock = head.number - 200n
    expect(await chain.findMemoTransfers({ token: BETA, from: root.address, memos: [encodeMemo(ref.runId, 1)], fromBlock })).toHaveLength(1)
    expect(await chain.findMemoTransfers({ token: ALPHA, from: root.address, memos: [encodeMemo(ref.runId, 2)], fromBlock })).toHaveLength(1)
    // Executing again sends nothing.
    expect(await rolepay.payRuns.execute(ref)).toMatchObject({ ok: true, value: { status: 'paid', run: { paidTxHash: paidTx } } })

    // Limits: the payout limit paid Bo plus what the swap actually took (never past its maximum), the BetaUSD limit what Ana got.
    const spentAlpha = before.alpha - (await limitLeft(ALPHA))
    const swapIn = spentAlpha - usd('1')
    expect(swapIn).toBeGreaterThan(0n)
    expect(swapIn).toBeLessThanOrEqual(usd('1.515'))
    expect(before.beta - (await limitLeft(BETA))).toBe(usd('1.5'))
    record({ step: 'run paid', runId: ref.runId, tx: paidTx, url: txUrl(paidTx), anaBeta: '1.5', boAlpha: '1', swapInAlpha: Number(swapIn) / 1e6 })
  })

  it("Rolepay holds a run whose swap would cost more than the cap, before signing anything", async () => {
    // A cap of 0 basis points: BetaUSD trades below AlphaUSD here, so this community (paying in BetaUSD)
    // cannot buy 1 AlphaUSD for 1 BetaUSD. Same repositories, a second service with that cap.
    const strict = createRolepay({ ...deps, swapMaxSlippageBps: 0 })
    const other = snowflake()
    await strict.communities.register({ guildId: other, name: 'Pays in BetaUSD', treasuryAddress: root.address, payoutToken: BETA, feeMode: 'fee_budget', feeToken: PATH })
    await strict.communities.setPreferredTokens({ guildId: other, enabled: true })
    await strict.communities.provisionBotKey({ guildId: other, limit: usd('5'), periodSeconds: 86_400, expiresAt: nowSeconds() + 3600, feeBudget: usd('1') })
    const a = await strict.communities.authorizeBotKey({ guildId: other, root })
    if (!a.ok) throw new Error(json(a.error))
    const cy = { id: '200000000000000303', address: fresh() }
    const link = await strict.payees.issueLink({ guildId: other, discordUserId: cy.id })
    if (!link.ok) throw new Error(link.error.code)
    await strict.payees.register({ token: link.value.token, address: cy.address })
    await strict.payees.setPreferredToken({ guildId: other, discordUserId: cy.id, token: ALPHA })
    const created = await strict.payRuns.create({ guildId: other, createdBy: cy.id, note: null, lines: [{ discordUserId: cy.id, amount: usd('1') }] })
    if (!created.ok) throw new Error(json(created.error))
    const ref = { guildId: other, runId: created.value.id }
    await strict.payRuns.submit({ ...ref, actor: cy.id })
    await strict.payRuns.approve({ ...ref, actor: '300000000000000301', actorCanApprove: true })
    const held = await strict.payRuns.execute(ref)
    expect(held).toMatchObject({ ok: false, error: { code: 'swap_over_cap', token: ALPHA, max: usd('1') } })
    if (held.ok || held.error.code !== 'swap_over_cap') throw new Error('expected swap_over_cap')
    expect(held.error.quoted).toBeGreaterThan(usd('1'))
    expect(await strict.payRuns.get(ref)).toMatchObject({ ok: true, value: { status: 'approved', attempts: [] } })
    expect(await testnet.balance(ALPHA, cy.address)).toBe(0n)
    record({ step: 'held before signing', code: 'swap_over_cap', quoted: Number(held.error.quoted) / 1e6, max: 1 })
  })

  it('the chain itself refuses a swap over its maximum, whole: a batch signed by hand with no pre-flight lands and reverts with MaxInputExceeded, paying nobody', async () => {
    const before = { alpha: await limitLeft(ALPHA), beta: await limitLeft(BETA), treasury: await testnet.balance(ALPHA, root.address) }
    const [to1, to2] = [fresh(), fresh()]
    // The same shape Rolepay sends (swap, then a memo transfer per line), but the swap may spend only 0.5 AlphaUSD for 1 BetaUSD.
    const calls = [swapCall(ALPHA, BETA, usd('1'), usd('0.5')), memoTransfer(BETA, to1, usd('1'), 'CAP-REFUSED', 1), memoTransfer(ALPHA, to2, usd('0.5'), 'CAP-REFUSED', 2)]
    const r = await refusal(await chain.broadcast(await signUnsimulated(calls)))
    if (r.refused === 'revert') console.log(`over its maximum, reverted by the protocol: ${txUrl(r.txHash)}`)
    record({ step: 'swap over its maximum', ...r, ...(r.refused === 'revert' ? { url: txUrl(r.txHash) } : {}) })
    expect(r).toMatchObject({ refused: 'revert', error: 'MaxInputExceeded' })
    // Nobody paid, nothing charged: the whole batch reverted.
    expect(await testnet.balance(BETA, to1)).toBe(0n)
    expect(await testnet.balance(ALPHA, to2)).toBe(0n)
    expect(await limitLeft(ALPHA)).toBe(before.alpha)
    expect(await limitLeft(BETA)).toBe(before.beta)
    expect(await testnet.balance(ALPHA, root.address)).toBe(before.treasury)
  })

  describe('outside a run, the key moves BetaUSD only by transferWithMemo, within its BetaUSD limit (signed by hand, no pre-flight)', () => {
    // The treasury holds BetaUSD of its own here (the faucet funded it): exactly the case the BetaUSD limit is for.
    const cases: { name: string; call: (to: `0x${string}`, left: bigint) => Call; error: string; moved: (to: `0x${string}`) => Promise<bigint> }[] = [
      {
        name: 'a plain transfer of BetaUSD',
        call: (to) => ({ to: BETA, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [to, usd('0.1')] }) }),
        error: 'CallNotAllowed',
        moved: (to) => testnet.balance(BETA, to),
      },
      {
        name: 'approve on BetaUSD',
        call: (spender) => ({ to: BETA, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'approve', args: [spender, usd('0.1')] }) }),
        error: 'CallNotAllowed',
        moved: (spender) => reader.readContract({ address: BETA, abi: Abis.tip20, functionName: 'allowance', args: [root.address, spender] }) as Promise<bigint>,
      },
      {
        name: 'swapExactAmountIn on the DEX (only the exact-output swap is in scope)',
        call: () => ({ to: STABLECOIN_DEX_ADDRESS as `0x${string}`, data: encodeFunctionData({ abi: Abis.stablecoinDex, functionName: 'swapExactAmountIn', args: [BETA, ALPHA, usd('0.1'), 0n] }) }),
        error: 'CallNotAllowed',
        moved: () => Promise.resolve(0n),
      },
      {
        name: 'transferWithMemo of BetaUSD for more than the key has left of its BetaUSD limit',
        call: (to, left) => memoTransfer(BETA, to, left + 1n, 'OVER-BETA'),
        error: 'SpendingLimitExceeded',
        moved: (to) => testnet.balance(BETA, to),
      },
      {
        name: 'a swap selling a token the key has no limit for (OUSD, which the treasury holds)',
        call: () => swapCall(OUSD, BETA, usd('0.1'), usd('0.2')),
        error: 'SpendingLimitExceeded',
        moved: () => Promise.resolve(0n),
      },
    ]

    for (const c of cases) {
      it(`${c.name}: refused, nothing moves`, async () => {
        const before = { beta: await limitLeft(BETA), treasuryBeta: await testnet.balance(BETA, root.address) }
        const to = fresh()
        const r = await refusal(await chain.broadcast(await signUnsimulated([c.call(to, before.beta)])))
        if (r.refused === 'revert') console.log(`${c.name}, reverted by the protocol: ${txUrl(r.txHash)}`)
        record({ step: 'outside a run', call: c.name, ...r, ...(r.refused === 'revert' ? { url: txUrl(r.txHash) } : {}) })
        expect(r.error).toBe(c.error)
        expect(await c.moved(to)).toBe(0n)
        expect(await testnet.balance(BETA, root.address)).toBe(before.treasuryBeta)
        expect(await limitLeft(BETA)).toBe(before.beta)
      })
    }

    it('the residual, shown: a transferWithMemo of BetaUSD the treasury holds, within the BetaUSD limit, lands and is charged to that limit', async () => {
      const before = await limitLeft(BETA)
      const to = fresh()
      const out = await chain.broadcast(await signUnsimulated([memoTransfer(BETA, to, usd('0.1'), 'RESIDUAL')]))
      if (out.kind !== 'confirmed') throw new Error(json(out))
      record({ step: 'residual (within the BetaUSD limit)', tx: out.txHash, url: txUrl(out.txHash) })
      expect(await testnet.balance(BETA, to)).toBe(usd('0.1'))
      expect(await limitLeft(BETA)).toBe(before - usd('0.1'))
    })
  })
})
