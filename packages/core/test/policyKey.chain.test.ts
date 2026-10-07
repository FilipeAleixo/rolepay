// Opt-in, real chain: a standing policy with its own access key, next to the bot key, on one
// treasury on Tempo's Moderato TESTNET (chain 42431). Run with `pnpm test:chain`. Never mainnet:
// the test refuses any other chain ID.
//
// One throwaway root (generated in memory) authorises two keys, each with a small daily limit: the
// bot key (3 AlphaUSD) and the policy's own key (1.5 AlphaUSD), each with its own pathUSD fee
// budget, so no sponsor sits between a signed batch and the chain. It shows, on chain:
//   1. the policy's run is signed with the policy key and paid within that key's limit, through
//      Rolepay's services (SQLite, the AES vault, the Tempo adapter), and the bot key is untouched;
//   2. a batch over what the policy key has left, signed with that key and sent with no pre-flight
//      and no simulation (as protocolLimit.chain.test.ts does), lands and reverts whole with
//      SpendingLimitExceeded and pays nobody, while the bot key, with plenty left, pays a batch of
//      the same shape;
//   3. after the root revokes the policy key, a transfer it signs is refused at submit
//      (KeyAlreadyRevoked), and the bot key still pays a run made by hand.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Hex, decodeErrorResult } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { Abis, Account, createClient, http } from 'viem/tempo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AesGcmKeyVault,
  FakeActivityReader,
  FakeRunProposer,
  RandomIds,
  SystemClock,
  TempoPayoutChain,
  createTestnetTools,
  emptyCriteria,
  openSqliteDatabase,
  rootSignerFromPrivateKey,
} from '../src/adapters/index.js'
import { buildBatchCalls, retryUnavailable } from '../src/adapters/tempo/index.js'
import { NETWORKS, type Rolepay, TESTNET_TOKENS, VALID_BEFORE_SECONDS, botKeyContext, createRolepay, encodeMemo, parseAmount, policyKeyContext } from '../src/index.js'
import type { BatchTransfer } from '../src/ports/payoutChain.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const FEE_TOKEN = TESTNET_TOKENS.path_usd
const APPROVER = '400000000000000101'
const MODS = '400000000000000102'
const TREASURER = '300000000000000101'
/** A fixed gas limit, so nothing is estimated or simulated (a 3-line batch to fresh addresses uses about 860k). */
const GAS = 2_000_000n
const DAY = 86_400
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

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'policyKey.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  console.log(`${String(entry.step)}: ${String(entry.url ?? entry.outcome ?? '')}`)
}

type CallFrame = { to: string; output?: Hex; error?: string; calls?: CallFrame[] }

describe('a policy with its own access key, next to the bot key, on one treasury (Moderato)', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'rolepay-policykey-chain-'))
  const guildId = snowflake()
  const mods = ['200000000000000301', '200000000000000302']
  const addresses = mods.map(() => fresh())
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  const vault = new AesGcmKeyVault(generatePrivateKey().slice(2))
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const reader = createClient({ testnet: true, transport: rpc() })
  const activity = new FakeActivityReader()
  const proposer = new FakeRunProposer()
  const who = { guildId, actor: TREASURER, actorRoleIds: [APPROVER] }
  let db: Awaited<ReturnType<typeof openSqliteDatabase>>
  let rolepay: Rolepay
  let policyId: string
  let botKey: `0x${string}`
  let policyKey: { address: `0x${string}`; secret: Hex }

  const left = async (accessKey: `0x${string}`) => (await chain.keyState({ account: root.address, accessKey, token: TOKEN, feeToken: FEE_TOKEN })).remaining
  const batch = (runId: string, amount: bigint) => [1, 2, 3].map((line): BatchTransfer => ({ to: fresh(), amount, memo: encodeMemo(runId, line) }))

  /** Signs a batch with an access key, every field set by hand: no fill and no gas estimate, so the node never simulates it. */
  async function signUnsimulated(secret: Hex, transfers: BatchTransfer[]): Promise<Hex> {
    const account = Account.fromSecp256k1(secret, { access: root.address })
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
    db = await openSqliteDatabase(join(dbDir, 'rolepay.db'))
    rolepay = createRolepay({ chain, repositories: db.repositories, vault, ids: new RandomIds(), clock: new SystemClock(), network: 'moderato', proposer, activity, demoControls: true })
    activity.roles = [{ id: MODS, name: 'Mods' }]
    for (const m of mods) activity.setMember(m, { roleIds: [MODS], joinedAt: null })
    activity.setMember(TREASURER, { roleIds: [APPROVER], joinedAt: null })
    proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '0.5', per: '', cap: '', total: '', splitBy: '' }, note: 'Policy key chain test' }, { hasRole: ['R1'] })

    expect((await rolepay.communities.register({ guildId, name: 'Rolepay policy key chain test', treasuryAddress: root.address, payoutToken: TOKEN, feeMode: 'fee_budget', feeToken: FEE_TOKEN, approverRoleId: APPROVER })).ok).toBe(true)
    await rolepay.communities.setAiProposals({ guildId, enabled: true, actorRoleIds: [APPROVER] })
    for (const [i, user] of mods.entries()) {
      const link = await rolepay.payees.issueLink({ guildId, discordUserId: user })
      if (!link.ok) throw new Error(link.error.code)
      expect((await rolepay.payees.register({ token: link.value.token, address: addresses[i] as string })).ok).toBe(true)
    }

    // The bot key: 3 AlphaUSD a day (and 1 pathUSD for fees), as the setup page authorises it.
    const bot = await rolepay.communities.provisionBotKey({ guildId, limit: usd('3'), periodSeconds: DAY, expiresAt: nowSeconds() + 3600, feeBudget: usd('1') })
    if (!bot.ok) throw new Error(json(bot.error))
    const botAuth = await rolepay.communities.authorizeBotKey({ guildId, root })
    if (!botAuth.ok) throw new Error(json(botAuth.error))
    botKey = botAuth.value.key.address
    record({ step: 'bot key authorised', limit: '3 AlphaUSD per day', key: botKey, tx: botAuth.value.txHash, url: `${NET.explorerUrl}/tx/${botAuth.value.txHash}` })

    // The policy: 0.5 to every Mod (2 of them), each run 1 AlphaUSD; approved, in propose mode.
    const created = await rolepay.policies.create({ ...who, name: 'Mods stipend', instruction: '0.5 AlphaUSD to every Mod each day', schedule: { kind: 'daily', hour: 18 } })
    if (!created.ok) throw new Error(json(created.error))
    policyId = created.value.id
    expect((await rolepay.policies.approve({ ...who, policyId, version: 1 })).ok).toBe(true)

    // Its own key: 1.5 AlphaUSD a day (and 0.5 pathUSD for fees), signed by the same root.
    const own = await rolepay.policyKeys.provision({ guildId, policyId, limit: usd('1.5'), periodSeconds: DAY, expiresAt: nowSeconds() + 3600, feeBudget: usd('0.5') })
    if (!own.ok) throw new Error(json(own.error))
    const ownAuth = await rolepay.policyKeys.authorize({ guildId, policyId, root })
    if (!ownAuth.ok) throw new Error(json(ownAuth.error))
    const stored = await db.repositories.policyKeys.get(ownAuth.value.key.address)
    const secret = await vault.open(stored?.sealedSecret ?? '', policyKeyContext(guildId, policyId, ownAuth.value.key.address))
    if (!secret.ok) throw new Error('the policy key did not unseal')
    policyKey = { address: ownAuth.value.key.address, secret: secret.value as Hex }
    record({ step: 'policy key authorised', limit: '1.5 AlphaUSD per day', key: policyKey.address, tx: ownAuth.value.txHash, url: `${NET.explorerUrl}/tx/${ownAuth.value.txHash}` })
    expect(await left(botKey)).toBe(usd('3'))
    expect(await left(policyKey.address)).toBe(usd('1.5'))
  })

  afterAll(async () => {
    await db?.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it("1. the policy's run is signed with the policy key and paid within its limit; the bot key is untouched", async () => {
    const made = await rolepay.scheduler.runNow({ ...who, policyId })
    if (!made.ok) throw new Error(json(made.error))
    expect(made.value.policyRun).toMatchObject({ status: 'proposed', total: usd('1'), remaining: usd('1.5') })
    const runId = made.value.run?.id as string
    expect((await rolepay.payRuns.approve({ guildId, runId, actor: TREASURER, actorCanApprove: true })).ok).toBe(true)
    let r = await rolepay.payRuns.execute({ guildId, runId })
    for (let i = 0; r.ok && r.value.status === 'pending' && i < 12; i++) {
      await new Promise((ok) => setTimeout(ok, 5000))
      r = await rolepay.payRuns.reconcile({ guildId, runId })
    }
    if (!r.ok || r.value.status !== 'paid') throw new Error(json(r))
    const tx = r.value.run.paidTxHash as string
    for (const a of addresses) expect(await testnet.balance(TOKEN, a)).toBe(usd('0.5'))
    expect(await left(policyKey.address)).toBe(usd('0.5'))
    expect(await left(botKey)).toBe(usd('3'))
    record({ step: 'policy run paid with the policy key', total: '1', policyKeyLeft: '0.5', botKeyLeft: '3', tx, url: `${NET.explorerUrl}/tx/${tx}` })
  })

  it('2. a batch over the policy key\'s remaining limit (no pre-flight, no simulation) reverts whole with SpendingLimitExceeded; the bot key, with plenty left, pays the same batch', async () => {
    // 0.5 left on the policy key. Lines of 0.2: each fits, the first two (0.4) fit, the third takes it to 0.6.
    const transfers = batch('PKEY-OVER', usd('0.2'))
    const out = await chain.broadcast(await signUnsimulated(policyKey.secret, transfers))
    if (out.kind !== 'reverted') throw new Error(`expected the chain to revert the batch, got ${json(out)}`)
    const receipt = await reader.getTransactionReceipt({ hash: out.txHash })
    expect(receipt.status).toBe('reverted')
    expect(receipt.gasUsed).toBeLessThan(GAS)
    const trace = (await reader.request({ method: 'debug_traceTransaction', params: [out.txHash, { tracer: 'callTracer' }] } as never)) as CallFrame
    const calls = trace.calls ?? []
    expect(calls.map((c) => c.to.toLowerCase())).toEqual([TOKEN, TOKEN, TOKEN])
    expect(calls.slice(0, 2).map((c) => c.error)).toEqual([undefined, undefined])
    expect(calls[2]?.error).toBe('execution reverted')
    expect(decodeErrorResult({ abi: Abis.accountKeychain, data: calls[2]?.output as Hex }).errorName).toBe('SpendingLimitExceeded')
    for (const t of transfers) expect(await testnet.balance(TOKEN, t.to)).toBe(0n)
    expect(await left(policyKey.address)).toBe(usd('0.5'))
    expect(await left(botKey)).toBe(usd('3'))
    record({ step: 'policy key over its limit: reverted by the protocol', total: '0.6', left: '0.5', botKeyLeft: '3', revert: 'SpendingLimitExceeded (call 3 of 3)', gasUsed: receipt.gasUsed, tx: out.txHash, url: `${NET.explorerUrl}/tx/${out.txHash}` })

    // The bot key's secret from the vault, as the server would use it: the same batch shape lands.
    const botRow = (await db.repositories.communities.getBotKey(botKey)) as NonNullable<Awaited<ReturnType<typeof db.repositories.communities.getBotKey>>>
    const botSecret = await vault.open(botRow.sealedSecret ?? '', botKeyContext(guildId, botKey))
    if (!botSecret.ok) throw new Error('the bot key did not unseal')
    const control = batch('PKEY-BOT', usd('0.2'))
    const landed = await chain.broadcast(await signUnsimulated(botSecret.value as Hex, control))
    if (landed.kind !== 'confirmed') throw new Error(json(landed))
    for (const t of control) expect(await testnet.balance(TOKEN, t.to)).toBe(usd('0.2'))
    expect(await left(botKey)).toBe(usd('2.4'))
    record({ step: 'the bot key pays the same batch', total: '0.6', botKeyLeft: '2.4', tx: landed.txHash, url: `${NET.explorerUrl}/tx/${landed.txHash}` })
  })

  it('3. revoking the policy key stops it on chain (KeyAlreadyRevoked at submit) and leaves the bot key working', async () => {
    const revoked = await rolepay.policyKeys.revoke({ guildId, policyId, root, actor: TREASURER })
    if (!revoked.ok) throw new Error(json(revoked.error))
    record({ step: 'policy key revoked', key: policyKey.address, tx: revoked.value.txHash, url: `${NET.explorerUrl}/tx/${revoked.value.txHash}` })
    expect((await chain.keyState({ account: root.address, accessKey: policyKey.address, token: TOKEN, feeToken: FEE_TOKEN })).status).toBe('revoked')

    // Signed by hand with the revoked key, within its old limit: refused at submit, nothing moved.
    const transfers = [{ to: fresh(), amount: usd('0.1'), memo: encodeMemo('PKEY-REVOKED', 1) }]
    const out = await chain.broadcast(await signUnsimulated(policyKey.secret, transfers))
    expect(out).toMatchObject({ kind: 'rejected' })
    expect(out.kind === 'rejected' && out.detail).toMatch(/KeyAlreadyRevoked/)
    expect(await testnet.balance(TOKEN, transfers[0]?.to as string)).toBe(0n)
    record({ step: 'revoked policy key refused at submit', outcome: out.kind === 'rejected' ? out.detail.slice(0, 160) : out.kind })

    // Rolepay never falls back to the bot key for this policy: its next run is refused before signing.
    expect(await rolepay.policyKeys.budget({ guildId, policyId })).toEqual({ key: 'policy', remaining: null })

    // The bot key still pays a run made by hand.
    const created = await rolepay.payRuns.create({ guildId, createdBy: TREASURER, note: 'by hand, after the revoke', lines: [{ discordUserId: mods[0] as string, amount: usd('0.25') }] })
    if (!created.ok) throw new Error(json(created.error))
    const ref = { guildId, runId: created.value.id }
    await rolepay.payRuns.submit({ ...ref, actor: TREASURER })
    await rolepay.payRuns.approve({ ...ref, actor: TREASURER, actorCanApprove: true })
    let r = await rolepay.payRuns.execute(ref)
    for (let i = 0; r.ok && r.value.status === 'pending' && i < 12; i++) {
      await new Promise((ok) => setTimeout(ok, 5000))
      r = await rolepay.payRuns.reconcile(ref)
    }
    if (!r.ok || r.value.status !== 'paid') throw new Error(json(r))
    expect(await testnet.balance(TOKEN, addresses[0] as string)).toBe(usd('0.75'))
    expect(await left(botKey)).toBe(usd('2.15'))
    record({ step: 'the bot key pays a run made by hand after the revoke', total: '0.25', botKeyLeft: '2.15', tx: r.value.run.paidTxHash, url: `${NET.explorerUrl}/tx/${r.value.run.paidTxHash}` })
    await rolepay.communities.revokeBotKey({ guildId, root })
  })
})
