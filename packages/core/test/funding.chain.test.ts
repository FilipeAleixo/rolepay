// Opt-in, real chain: funding with attribution on Tempo's virtual addresses (TIP-1022), on the
// Moderato TESTNET (chain 42431). Run with `pnpm test:chain`. Never mainnet: the test refuses any
// other chain ID.
//
// A throwaway passkey-like treasury (a P256 key signing WebAuthn envelopes, as the treasurer's
// passkey does in the browser) mines a salt and registers as a virtual-address master with viem's
// virtualAddress actions. Rolepay records it from the chain, derives two deposit addresses off
// chain, and a faucet-funded account sends AlphaUSD to each. The treasury's balance rises by both
// amounts inside the deposit transactions themselves (no sweep: the treasury signs nothing after
// registering, and the deposit addresses never hold a balance), and the watcher attributes each
// deposit to its source, once.
import { availableParallelism } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Hex, parseEventLogs } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Abis, Account, Actions, P256, VirtualMaster, createClient, http, withRelay } from 'viem/tempo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlainKeyVault, RandomIds, SystemClock, TempoFundingChain, TempoPayoutChain, createTestnetTools, openSqliteDatabase } from '../src/adapters/index.js'
import { retryUnavailable } from '../src/adapters/tempo/index.js'
import { type FundingSource, NETWORKS, type Rolepay, TESTNET_TOKENS, VALID_BEFORE_SECONDS, createRolepay, parseAmount, parseVirtualAddress } from '../src/index.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RESULTS_DIR = join(REPO_ROOT, '.chain-results')
const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const APPROVER = '400000000000000001'
const TREASURER = '300000000000000001'
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)
const rpc = () => retryUnavailable(http(NET.rpcUrl, { retryCount: 6, retryDelay: 400 }))
const sponsored = () => withRelay(rpc(), retryUnavailable(http(NET.sponsorUrl, { retryCount: 0 })))
const fees = () => ({ feePayer: true, validBefore: Math.floor(Date.now() / 1000) + VALID_BEFORE_SECONDS }) as const
const txUrl = (hash: string) => `${NET.explorerUrl}/tx/${hash}`

const evidence: Record<string, unknown>[] = []
const record = (entry: Record<string, unknown>) => {
  evidence.push({ at: new Date().toISOString(), ...entry })
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'funding.chain.json'), JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

describe('deposit addresses on Moderato: registered by a passkey-like treasury, deposits land with no sweep and are attributed', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'rolepay-funding-chain-'))
  const guildId = snowflake()
  // The treasury: a P256 key that signs WebAuthn envelopes, as a passkey does.
  const treasury = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: 'localhost', origin: 'http://localhost' })
  const treasuryAddress = treasury.address.toLowerCase() as Hex
  // Whoever funds the community: a faucet-funded account that knows nothing about Rolepay.
  const funder = Account.fromSecp256k1(generatePrivateKey())
  const reader = createClient({ testnet: true, transport: rpc() })
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  const balance = (address: Hex, blockNumber?: bigint) =>
    reader.readContract({ address: TOKEN, abi: Abis.tip20, functionName: 'balanceOf', args: [address], ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<bigint>
  let db: Awaited<ReturnType<typeof openSqliteDatabase>>
  let rolepay: Rolepay
  let registration: { txHash: Hex; masterId: Hex; blockNumber: bigint }
  let acme: FundingSource
  let judges: FundingSource

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(NET.chainId)
    db = await openSqliteDatabase(join(dbDir, 'funding.db'))
    rolepay = createRolepay({
      chain: new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl }),
      fundingChain: new TempoFundingChain({ network: 'moderato', rpcUrl: NET.rpcUrl }),
      repositories: db.repositories,
      vault: new PlainKeyVault(),
      ids: new RandomIds(),
      clock: new SystemClock(),
      network: 'moderato',
    })
    const registered = await rolepay.communities.register({ guildId, name: 'Funding chain test', treasuryAddress, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: APPROVER })
    if (!registered.ok) throw new Error(registered.error.code)

    // 1. Mine a salt with the 32-bit proof of work for this treasury (as the setup page does in the browser).
    const started = Date.now()
    const mined = await VirtualMaster.mineSaltAsync({ address: treasuryAddress, workers: Math.max(2, availableParallelism() - 1) })
    if (!mined) throw new Error('no salt found in the range')
    record({ step: 'mined', seconds: (Date.now() - started) / 1000, masterId: mined.masterId })

    // 2. Rolepay plans it (checks the proof of work and that the masterId is free) and returns the call.
    const plan = await rolepay.funding.planMaster({ guildId, salt: mined.salt })
    if (!plan.ok) throw new Error(plan.error.code)
    expect(plan.value.masterId).toBe(mined.masterId.toLowerCase())

    // 3. The treasury registers with viem's virtualAddress action, sponsored, one signature.
    const client = createClient({ account: treasury, testnet: true, transport: sponsored() })
    const { receipt, masterId, masterAddress } = await Actions.virtualAddress.registerMasterSync(client, { salt: mined.salt, ...fees() } as never)
    expect(receipt.status).toBe('success')
    expect(masterAddress?.toLowerCase()).toBe(treasuryAddress)
    expect(plan.value.call).toEqual({ to: '0xfdc0000000000000000000000000000000000000', data: expect.stringMatching(new RegExp(`${mined.salt.slice(2)}$`)) })
    registration = { txHash: receipt.transactionHash.toLowerCase() as Hex, masterId: (masterId as Hex).toLowerCase() as Hex, blockNumber: receipt.blockNumber }
    record({ step: 'registered', txHash: registration.txHash, url: txUrl(registration.txHash), masterId: registration.masterId, treasury: treasuryAddress })

    // 4. Rolepay records it from the chain, and the approver role creates two sources.
    const confirmed = await rolepay.funding.confirmMaster({ guildId, masterId: registration.masterId, txHash: registration.txHash })
    if (!confirmed.ok) throw new Error(confirmed.error.code)
    expect(confirmed.value).toMatchObject({ masterAddress: treasuryAddress, registeredBlock: registration.blockNumber, txHash: registration.txHash })
    const make = async (name: string) => {
      const r = await rolepay.funding.createSource({ guildId, actor: TREASURER, actorRoleIds: [APPROVER], name })
      if (!r.ok) throw new Error(r.error.code)
      return r.value
    }
    acme = await make('Q4 bounty sponsor: Acme DAO')
    judges = await make('Judges pool')
    expect(parseVirtualAddress(acme.depositAddress)).toEqual({ masterId: registration.masterId, userTag: '0x000000000001' })
    expect(parseVirtualAddress(judges.depositAddress)).toEqual({ masterId: registration.masterId, userTag: '0x000000000002' })
    // The registry resolves both to the treasury.
    for (const s of [acme, judges]) expect((await Actions.virtualAddress.resolve(reader, { address: s.depositAddress }))?.toLowerCase()).toBe(treasuryAddress)
    record({ step: 'sources', acme: acme.depositAddress, judges: judges.depositAddress })

    await testnet.ensureFunded(funder.address, TOKEN, usd('10'))
  }, 900_000)

  afterAll(async () => {
    await db?.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('sends AlphaUSD to each deposit address: the treasury rises by both amounts with no sweep, and Rolepay attributes each deposit to its source', async () => {
    const before = await balance(treasuryAddress)
    const nonceBefore = await reader.getTransactionCount({ address: treasuryAddress })
    const client = createClient({ account: funder, testnet: true, transport: sponsored() })
    const send = async (to: Hex, amount: bigint) => {
      const receipt = await client.writeContractSync({ address: TOKEN, abi: Abis.tip20, functionName: 'transfer', args: [to, amount], throwOnReceiptRevert: true, ...fees() } as never)
      return receipt as { status: string; transactionHash: Hex; blockNumber: bigint; logs: Parameters<typeof parseEventLogs>[0]['logs'] }
    }
    const deposits = [
      { source: acme, amount: usd('1.25') },
      { source: judges, amount: usd('2.5') },
    ]
    const landed = []
    for (const d of deposits) {
      const receipt = await send(d.source.depositAddress, d.amount)
      expect(receipt.status).toBe('success')
      // The deposit transaction itself credits the treasury: its balance moves by exactly the amount in that block.
      const [after, previous] = await Promise.all([balance(treasuryAddress, receipt.blockNumber), balance(treasuryAddress, receipt.blockNumber - 1n)])
      expect(after - previous).toBe(d.amount)
      // The two hops TIP-1022 emits: sender to the deposit address, then the deposit address to the
      // treasury (the receipt also carries the sponsor's fee transfer, which touches neither).
      const transfers = parseEventLogs({ abi: Abis.tip20, logs: receipt.logs, eventName: 'Transfer' })
        .map((l) => [l.args.from.toLowerCase(), l.args.to.toLowerCase(), l.args.amount])
        .filter(([from, to]) => from === d.source.depositAddress || to === d.source.depositAddress)
      expect(transfers).toEqual([
        [funder.address.toLowerCase(), d.source.depositAddress, d.amount],
        [d.source.depositAddress, treasuryAddress, d.amount],
      ])
      landed.push({ ...d, txHash: receipt.transactionHash.toLowerCase() as Hex, blockNumber: receipt.blockNumber })
      record({ step: 'deposit', source: d.source.name, to: d.source.depositAddress, amount: d.amount, txHash: receipt.transactionHash, url: txUrl(receipt.transactionHash) })
    }

    // In all: up by both amounts; the deposit addresses hold nothing; the treasury sent nothing (no sweep).
    expect((await balance(treasuryAddress)) - before).toBe(usd('3.75'))
    for (const d of deposits) expect(await balance(d.source.depositAddress)).toBe(0n)
    expect(await reader.getTransactionCount({ address: treasuryAddress })).toBe(nonceBefore)

    // The watcher attributes each deposit to its source, and a second tick stores nothing twice.
    const report = await rolepay.funding.scan()
    expect(report.errors).toEqual([])
    expect(report.deposits.map((d) => [d.sourceId, d.amount, d.token, d.txHash, d.from])).toEqual(
      landed.map((l) => [l.source.id, l.amount, TOKEN, l.txHash, funder.address.toLowerCase()]),
    )
    expect((await rolepay.funding.scan()).deposits).toEqual([])
    const status = await rolepay.funding.status({ guildId })
    expect(status.ok && status.value.sources.map((s) => [s.source.name, s.received.total])).toEqual([
      ['Q4 bounty sponsor: Acme DAO', usd('1.25')],
      ['Judges pool', usd('2.5')],
    ])
    expect(await rolepay.funding.month({ guildId })).toMatchObject({ setUp: true, total: usd('3.75'), sources: 2, deposits: 2 })
    const audited = await rolepay.audit.list({ guildId, types: ['deposit.received'] })
    expect(audited.ok && audited.value.events.length).toBe(2)
    record({ step: 'attributed', deposits: report.deposits.map((d) => ({ sourceId: d.sourceId, amount: d.amount, txHash: d.txHash, logIndex: d.logIndex, block: d.blockNumber })) })
    console.log(`funding chain test: registration ${txUrl(registration.txHash)}; deposits ${landed.map((l) => txUrl(l.txHash)).join(' ')}`)
  })
})
