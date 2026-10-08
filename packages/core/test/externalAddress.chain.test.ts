// Opt-in, real chain: a payee paid at a wallet they already have, on Tempo's Moderato TESTNET (chain
// 42431). Run with `pnpm test:chain`. Never mainnet: the test refuses any other chain ID.
//
// A fresh secp256k1 account (an EOA, as MetaMask holds one) registers through the external path: the
// server's challenge, the account's personal_sign over it, and registerExternal, which keeps the
// address it recovers from the signature. Then a normal run pays it, from a throwaway treasury, the
// bot key under its limit, sponsored: its balance rises by exactly the amount, and the line is found
// by its memo. Nothing in the payment path knows, or needs to know, that the address is not a passkey.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeAll, describe, expect, it } from 'vitest'
import { AesGcmKeyVault, RandomIds, SystemClock, TempoPayoutChain, ViemMessageSignatures, createMemoryRepositories, createTestnetTools, rootSignerFromPrivateKey } from '../src/adapters/index.js'
import { NETWORKS, type Rolepay, TESTNET_TOKENS, createRolepay, encodeMemo, parseAmount } from '../src/index.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
const NET = NETWORKS.moderato
const ALPHA = TESTNET_TOKENS.alpha_usd
const ORIGIN = 'https://demo.rolepay.app'
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const txUrl = (hash: string) => `${NET.explorerUrl}/tx/${hash}`

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'externalAddress.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

describe('a payee paid at a wallet they already have (Moderato)', () => {
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const rolepay: Rolepay = createRolepay({
    chain,
    repositories: createMemoryRepositories(),
    vault: new AesGcmKeyVault(generatePrivateKey().slice(2)),
    ids: new RandomIds(),
    clock: new SystemClock(),
    network: 'moderato',
    signatures: new ViemMessageSignatures(),
  })
  const guildId = snowflake()
  const payee = { id: '200000000000000401', wallet: privateKeyToAccount(generatePrivateKey()) }
  const address = payee.wallet.address.toLowerCase()

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, ALPHA, usd('10'))
    const reg = await rolepay.communities.register({ guildId, name: 'Own wallets on Moderato', treasuryAddress: root.address, payoutToken: ALPHA, feeMode: 'sponsor' })
    if (!reg.ok) throw new Error(json(reg.error))
    const p = await rolepay.communities.provisionBotKey({ guildId, limit: usd('5'), periodSeconds: 86_400, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
    if (!p.ok) throw new Error(json(p.error))
    const a = await rolepay.communities.authorizeBotKey({ guildId, root })
    if (!a.ok) throw new Error(json(a.error))
    record({ step: 'authorize', limit: '5 AlphaUSD a day, sponsored', tx: a.value.txHash, url: txUrl(a.value.txHash) })
  })

  it('registers the EOA through the external path: the address it recovers from the signature, as an external address', async () => {
    const link = await rolepay.payees.issueLink({ guildId, discordUserId: payee.id, discordUsername: 'own_wallet' })
    if (!link.ok) throw new Error(link.error.code)
    const challenge = await rolepay.payees.walletChallenge({ token: link.value.token, address, origin: ORIGIN })
    if (!challenge.ok) throw new Error(json(challenge.error))
    expect(challenge.value.message.split('\n')[0]).toBe(`Rolepay on demo.rolepay.app: pay me in Own wallets on Moderato at ${address} on Tempo (chain 42431).`)
    const signature = await payee.wallet.signMessage({ message: challenge.value.message })
    const r = await rolepay.payees.registerExternal({ token: link.value.token, message: challenge.value.message, signature, origin: ORIGIN })
    expect(r).toMatchObject({ ok: true, value: { address, addressKind: 'external' } })
    record({ step: 'registered', address, message: challenge.value.message })
  })

  it('a real run pays it: its balance rises by exactly the amount, and the line is found by its memo', async () => {
    const before = await testnet.balance(ALPHA, address)
    const created = await rolepay.payRuns.create({ guildId, createdBy: '300000000000000401', note: 'own wallet', lines: [{ discordUserId: payee.id, amount: usd('1.25') }] })
    if (!created.ok) throw new Error(json(created.error))
    expect(created.value.lines[0]?.address).toBe(address)
    const ref = { guildId, runId: created.value.id }
    await rolepay.payRuns.submit({ ...ref, actor: '300000000000000401' })
    await rolepay.payRuns.approve({ ...ref, actor: '300000000000000402', actorCanApprove: true })
    const paid = await rolepay.payRuns.execute(ref)
    if (!paid.ok) throw new Error(json(paid.error))
    expect(paid.value.status).toBe('paid')
    const tx = paid.value.run.paidTxHash as Hex
    console.log(`paid an own wallet (EOA) through Rolepay: ${txUrl(tx)}`)

    expect((await testnet.balance(ALPHA, address)) - before).toBe(usd('1.25'))
    const landed = await chain.lookupTx(tx)
    if (landed.kind !== 'confirmed') throw new Error(json(landed))
    expect(landed.transfers.map((t) => ({ token: t.token, to: t.to, amount: t.amount, memo: t.memo }))).toEqual([{ token: ALPHA, to: address, amount: usd('1.25'), memo: encodeMemo(ref.runId, 1) }])
    const head = await chain.head()
    expect(await chain.findMemoTransfers({ token: ALPHA, from: root.address, memos: [encodeMemo(ref.runId, 1)], fromBlock: head.number - 200n })).toHaveLength(1)
    record({ step: 'run paid', runId: ref.runId, tx, url: txUrl(tx), address, amount: '1.25 AlphaUSD', memo: encodeMemo(ref.runId, 1) })
  })
})
