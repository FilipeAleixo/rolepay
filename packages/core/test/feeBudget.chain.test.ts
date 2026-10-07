// Opt-in, real chain: a pay run in fee_budget mode on Tempo's Moderato TESTNET (chain 42431).
// The bot key pays its own fee in pathUSD under a separate fee budget, so the payout limit
// in AlphaUSD stays exact. A throwaway treasury key is generated in memory; never mainnet.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlainKeyVault, RandomIds, SystemClock, TempoPayoutChain, createTestnetTools, openSqliteDatabase, rootSignerFromPrivateKey } from '../src/adapters/index.js'
import { NETWORKS, type Rolepay, TESTNET_TOKENS, createRolepay } from '../src/index.js'

const NET = NETWORKS.moderato
const TOKEN = TESTNET_TOKENS.alpha_usd
const FEE_TOKEN = TESTNET_TOKENS.path_usd
const snowflake = () => `1${Date.now()}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 19)

describe('fee_budget mode on Moderato: the bot pays its fee from a separate budget', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'payrun-feebudget-'))
  const guildId = snowflake()
  const payeeId = '200000000000000201'
  const payeeAddress = privateKeyToAddress(generatePrivateKey()).toLowerCase()
  const root = rootSignerFromPrivateKey(generatePrivateKey())
  const testnet = createTestnetTools({ rpcUrl: NET.rpcUrl })
  let db: Awaited<ReturnType<typeof openSqliteDatabase>>
  let rolepay: Rolepay

  beforeAll(async () => {
    expect(await testnet.chainId()).toBe(42431) // testnet only, never mainnet
    await testnet.ensureFunded(root.address, TOKEN, 1_000_000n) // the faucet funds every testnet stablecoin
    db = await openSqliteDatabase(join(dbDir, 'payrun.db'))
    const chain = new TempoPayoutChain({ network: 'moderato', rpcUrl: NET.rpcUrl, sponsorUrl: NET.sponsorUrl })
    rolepay = createRolepay({ chain, repositories: db.repositories, vault: new PlainKeyVault(), ids: new RandomIds(), clock: new SystemClock(), network: 'moderato' })
  })

  afterAll(async () => {
    await db?.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('pays a run with the fee taken from the fee budget, leaving the payout limit exact', async () => {
    const reg = await rolepay.communities.register({ guildId, treasuryAddress: root.address, payoutToken: TOKEN, feeMode: 'fee_budget', feeToken: FEE_TOKEN })
    expect(reg.ok).toBe(true)
    const p = await rolepay.communities.provisionBotKey({ guildId, limit: 5_000_000n, periodSeconds: 86_400, expiresAt: Math.floor(Date.now() / 1000) + 3600, feeBudget: 1_000_000n })
    if (!p.ok) throw new Error(JSON.stringify(p.error))
    expect(p.value.authorization.limits).toEqual([
      { token: TOKEN, limit: 5_000_000n, period: 86_400 },
      { token: FEE_TOKEN, limit: 1_000_000n, period: 86_400 },
    ])
    const a = await rolepay.communities.authorizeBotKey({ guildId, root })
    if (!a.ok) throw new Error(JSON.stringify(a.error))

    const link = await rolepay.payees.issueLink({ guildId, discordUserId: payeeId })
    if (!link.ok) throw new Error(link.error.code)
    expect((await rolepay.payees.register({ token: link.value.token, address: payeeAddress })).ok).toBe(true)

    const created = await rolepay.payRuns.create({ guildId, createdBy: payeeId, note: 'fee budget', lines: [{ discordUserId: payeeId, amount: 1_250_000n }] })
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const ref = { guildId, runId: created.value.id }
    await rolepay.payRuns.submit({ ...ref, actor: payeeId })
    await rolepay.payRuns.approve({ ...ref, actor: '300000000000000201', actorCanApprove: true })
    const feeBefore = await testnet.balance(FEE_TOKEN, root.address)

    const r = await rolepay.payRuns.execute(ref)
    if (!r.ok) throw new Error(JSON.stringify(r.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    expect(r.value.status).toBe('paid')
    console.log(`fee_budget run: ${NET.explorerUrl}/tx/${r.value.run.paidTxHash}`)

    expect(await testnet.balance(TOKEN, payeeAddress)).toBe(1_250_000n)
    const s = await rolepay.communities.keyStatus({ guildId })
    if (!s.ok) throw new Error()
    expect(s.value.state.remaining).toBe(5_000_000n - 1_250_000n) // the payout limit is exact: no fee came off it
    const feeSpent = feeBefore - (await testnet.balance(FEE_TOKEN, root.address))
    expect(feeSpent).toBeGreaterThan(0n) // the treasury paid the fee itself, in pathUSD
    expect(s.value.state.feeBudgetRemaining).toBe(1_000_000n - feeSpent)
  })
})
