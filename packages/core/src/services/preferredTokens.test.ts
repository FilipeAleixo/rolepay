// Paying each person in the stablecoin they prefer: the payee's choice, the community's switch, the
// key's swap scope, and runs whose lines are bought on the DEX in the same batch. On the fake chain,
// which charges a swap's input to the key's limit in the token it sells, as Moderato does.
import { beforeEach, describe, expect, it } from 'vitest'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { createMemoryRepositories } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import { STABLECOIN_DEX_ADDRESS, SWAP_EXACT_AMOUNT_OUT_SIGNATURE, TESTNET_TOKENS, TRANSFER_WITH_MEMO_SIGNATURE } from '../constants/tempo.js'
import { encodeMemo } from '../domain/memo.js'
import { CommunityService } from './communityService.js'
import { PayeeService } from './payeeService.js'
import { PayRunService } from './payRunService.js'

const GUILD = '1094309218049937418'
const OTHER_GUILD = '1094309218049937419'
const ANA = '200000000000000001'
const BO = '200000000000000002'
const CY = '200000000000000003'
const TREASURER = '300000000000000001'
const TREASURY = '0x9999999999999999999999999999999999999999'
const { alpha_usd: ALPHA, beta_usd: BETA, theta_usd: THETA, path_usd: PATH } = TESTNET_TOKENS
const ADDR = {
  ana: '0x1111111111111111111111111111111111111111',
  bo: '0x2222222222222222222222222222222222222222',
  cy: '0x3333333333333333333333333333333333333333',
} as const
const usd = (whole: number) => BigInt(Math.round(whole * 1_000_000))

async function world(opts: { limit?: bigint; preferredTokens?: boolean; capBps?: number; keyBeforeSwitch?: boolean } = {}) {
  const clock = new ManualClock(new Date('2026-10-07T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const repos = createMemoryRepositories()
  const vault = new PlainKeyVault()
  const ids = new SequentialIds()
  const communities = new CommunityService({ communities: repos.communities, chain, vault, clock, network: 'moderato', ids, setupLinkTtlSeconds: 1800 })
  const payees = new PayeeService({ communities: repos.communities, payees: repos.payees, vault, ids, clock, linkTtlSeconds: 1800, network: 'moderato' })
  const payRuns = new PayRunService({
    runs: repos.runs,
    payees: repos.payees,
    communities: repos.communities,
    policyRuns: repos.policyRuns,
    policyKeys: repos.policyKeys,
    chain,
    vault,
    ids,
    clock,
    network: 'moderato',
    ...(opts.capBps !== undefined ? { swapMaxSlippageBps: opts.capBps } : {}),
  })
  await communities.register({ guildId: GUILD, name: 'Mods', treasuryAddress: TREASURY, payoutToken: ALPHA, feeMode: 'sponsor' })
  const authorize = async () => {
    await communities.provisionBotKey({ guildId: GUILD, limit: opts.limit ?? usd(100), periodSeconds: 86_400, expiresAt: chain.time + 30 * 86_400 })
    const auth = await communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    if (!auth.ok) throw new Error(auth.error.code)
  }
  if (opts.keyBeforeSwitch) await authorize()
  if (opts.preferredTokens ?? true) await communities.setPreferredTokens({ guildId: GUILD, enabled: true })
  if (!opts.keyBeforeSwitch) await authorize()
  chain.fund(ALPHA, TREASURY, usd(1000))
  // Alpha trades a little above BetaUSD and ThetaUSD on Moderato: 5 BetaUSD cost about 4.98 AlphaUSD.
  chain.setSwapRoute(ALPHA, BETA, { inPerOutBps: 9_954, liquidity: usd(100_000) })
  chain.setSwapRoute(ALPHA, THETA, { inPerOutBps: 9_954, liquidity: usd(100_000) })
  const now = clock.now()
  for (const [id, address, preferredToken] of [
    [ANA, ADDR.ana, BETA],
    [BO, ADDR.bo, null],
    [CY, ADDR.cy, THETA],
  ] as const) {
    await repos.payees.upsert({ communityId: GUILD, discordUserId: id, address, addressKind: 'passkey', preferredToken, registeredAt: now, updatedAt: now })
  }
  return { clock, chain, repos, communities, payees, payRuns }
}
type World = Awaited<ReturnType<typeof world>>

async function approved(w: World, lines: { discordUserId: string; amount: bigint }[]) {
  const created = await w.payRuns.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines })
  if (!created.ok) throw new Error(created.error.code)
  await w.payRuns.submit({ guildId: GUILD, runId: created.value.id, actor: TREASURER })
  const a = await w.payRuns.approve({ guildId: GUILD, runId: created.value.id, actor: TREASURER, actorCanApprove: true })
  if (!a.ok) throw new Error(a.error.code)
  return a.value
}

const ANA_5_BO_2 = [
  { discordUserId: ANA, amount: usd(5) },
  { discordUserId: BO, amount: usd(2) },
]

describe('PayRunService.create: each line in the stablecoin its payee prefers', () => {
  it('with preferred tokens off (the default), everyone is paid in the payout token, whatever they chose: exactly as before', async () => {
    const w = await world({ preferredTokens: false })
    const r = await w.payRuns.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines: ANA_5_BO_2 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.lines.map((l) => l.swap)).toEqual([undefined, undefined])
  })

  it('on: a line for someone who prefers BetaUSD swaps into it, spending at most its amount plus the cap (1% by default)', async () => {
    const w = await world()
    const r = await w.payRuns.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines: ANA_5_BO_2 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.lines[0]).toMatchObject({ amount: usd(5), swap: { token: BETA, maxIn: usd(5.05) } })
    expect(r.value.lines[1]).not.toHaveProperty('swap')
    expect(r.value.total).toBe(usd(7))
  })

  it('the cap is configured (basis points)', async () => {
    const w = await world({ capBps: 50 })
    const r = await w.payRuns.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines: ANA_5_BO_2 })
    expect(r.ok && r.value.lines[0]?.swap).toEqual({ token: BETA, maxIn: usd(5.025) })
  })
})

describe('PayRunService.execute: one batch, swaps then transfers, never more than the cap', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('pays Ana 5 BetaUSD and Bo 2 AlphaUSD in one transaction, each line with its memo; the run reconciles as paid', async () => {
    const run = await approved(w, ANA_5_BO_2)
    const out = await w.payRuns.execute({ guildId: GUILD, runId: run.id })
    expect(out).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(w.chain.balance(BETA, ADDR.ana)).toBe(usd(5))
    expect(w.chain.balance(ALPHA, ADDR.ana)).toBe(0n)
    expect(w.chain.balance(ALPHA, ADDR.bo)).toBe(usd(2))
    // The treasury paid Bo 2 and the DEX 4.977 for Ana's 5 BetaUSD, and keeps no BetaUSD.
    expect(w.chain.balance(ALPHA, TREASURY)).toBe(usd(1000) - usd(2) - usd(4.977))
    expect(w.chain.balance(BETA, TREASURY)).toBe(0n)
    const memos = await w.chain.findMemoTransfers({ token: BETA, from: TREASURY, memos: [encodeMemo(run.id, 1)], fromBlock: 0n })
    expect(memos).toEqual([expect.objectContaining({ to: ADDR.ana, amount: usd(5), token: BETA })])
    // Executing again sends nothing: the run is paid.
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
  })

  it('the key limits charge what moved: the swap input on the payout token, the delivery on the preferred token', async () => {
    const run = await approved(w, ANA_5_BO_2)
    await w.payRuns.execute({ guildId: GUILD, runId: run.id })
    const status = await w.communities.keyStatus({ guildId: GUILD })
    if (!status.ok) throw new Error(status.error.code)
    expect(status.value.state.remaining).toBe(usd(100) - usd(2) - usd(4.977))
    expect((await w.chain.keyState({ account: TREASURY, accessKey: status.value.key.address, token: BETA, feeToken: null })).remaining).toBe(usd(95))
  })

  it('the pre-flight counts a swapped line at its maximum input against the payout limit, and refuses before signing', async () => {
    w = await world({ limit: usd(7.04) })
    const run = await approved(w, ANA_5_BO_2)
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({
      ok: false,
      error: { code: 'insufficient_limit', remaining: usd(7.04), needed: usd(7.05), periodEnd: expect.any(Number) },
    })
    expect(w.chain.broadcastCount).toBe(0)
    expect(await w.payRuns.get({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'approved', attempts: [] } })
  })

  it('holds the run whole, before signing, when the DEX has no route to a preferred token', async () => {
    const run = await approved(w, [...ANA_5_BO_2, { discordUserId: CY, amount: usd(1) }])
    w.chain.setSwapRoute(ALPHA, THETA, null)
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'swap_no_route', token: THETA } })
    expect(w.chain.broadcastCount).toBe(0)
    expect(w.chain.balance(BETA, ADDR.ana)).toBe(0n)
    expect(w.chain.balance(ALPHA, ADDR.bo)).toBe(0n)
  })

  it('holds the run whole when buying the token now costs more than the cap, with the numbers', async () => {
    const run = await approved(w, ANA_5_BO_2)
    w.chain.setSwapRoute(ALPHA, BETA, { inPerOutBps: 10_150, liquidity: usd(100_000) })
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({
      ok: false,
      error: { code: 'swap_over_cap', token: BETA, quoted: usd(5.075), max: usd(5.05) },
    })
    expect(w.chain.broadcastCount).toBe(0)
  })

  it('a price that moves past the cap after signing reverts the whole batch: nobody is paid, a retry after the deadline pays once', async () => {
    const run = await approved(w, ANA_5_BO_2)
    const realBroadcast = w.chain.broadcast.bind(w.chain)
    let moved = false
    w.chain.broadcast = async (raw) => {
      if (!moved) {
        moved = true
        w.chain.setSwapRoute(ALPHA, BETA, { inPerOutBps: 10_150, liquidity: usd(100_000) })
      }
      return realBroadcast(raw)
    }
    const first = await w.payRuns.execute({ guildId: GUILD, runId: run.id })
    expect(first).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'reverted', retryable: true } } })
    expect(w.chain.balance(BETA, ADDR.ana)).toBe(0n)
    expect(w.chain.balance(ALPHA, ADDR.bo)).toBe(0n)

    w.chain.setSwapRoute(ALPHA, BETA, { inPerOutBps: 9_954, liquidity: usd(100_000) })
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    w.clock.advance(140)
    w.chain.advance(140)
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.balance(BETA, ADDR.ana)).toBe(usd(5))
    expect(w.chain.balance(ALPHA, ADDR.bo)).toBe(usd(2))
  })

  it('crash recovery: a lost response is settled by the recovery sweep from the recorded transaction; nothing is signed again', async () => {
    const run = await approved(w, ANA_5_BO_2)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    const [swept] = await w.payRuns.recoverInFlight()
    expect(swept).toMatchObject({ runId: run.id, status: 'paid' })
    expect(w.chain.landedTxCount).toBe(1)
    expect(w.chain.balance(BETA, ADDR.ana)).toBe(usd(5))
  })

  it('never pays twice: a broadcast misread as refused that lands after all is found by its memos (the swapped line in BetaUSD), and the retry sends nothing', async () => {
    const run = await approved(w, ANA_5_BO_2)
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'failed', failure: { reason: 'rejected' } } })
    await w.chain.mine()
    w.clock.advance(140)
    w.chain.advance(140)
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(w.chain.landedTxCount).toBe(1)
    expect(w.chain.balance(BETA, ADDR.ana)).toBe(usd(5))
    expect(w.chain.balance(ALPHA, ADDR.bo)).toBe(usd(2))
  })

  it("holds the run when the key was authorised before the switch, without the swap scope (the chain would refuse it)", async () => {
    w = await world({ keyBeforeSwitch: true })
    const run = await approved(w, ANA_5_BO_2)
    expect(await w.payRuns.execute({ guildId: GUILD, runId: run.id })).toEqual({ ok: false, error: { code: 'swap_not_authorized', tokens: [BETA] } })
    expect(w.chain.broadcastCount).toBe(0)
  })

  it("holds the run when the key's limit in the preferred token is lower than what the run delivers in it", async () => {
    w = await world({ limit: usd(10) })
    // BetaUSD 1% under par: a first run delivers 9.8 BetaUSD for 9.702 AlphaUSD, leaving 0.2 of the BetaUSD limit and 0.298 of the AlphaUSD one.
    const first = await approved(w, [{ discordUserId: ANA, amount: usd(9.8) }])
    w.chain.setSwapRoute(ALPHA, BETA, { inPerOutBps: 9_900, liquidity: usd(100_000) })
    expect(await w.payRuns.execute({ guildId: GUILD, runId: first.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    const second = await approved(w, [{ discordUserId: ANA, amount: usd(0.24) }])
    expect(await w.payRuns.execute({ guildId: GUILD, runId: second.id })).toEqual({
      ok: false,
      error: { code: 'swap_limit_low', token: BETA, remaining: usd(0.2), needed: usd(0.24) },
    })
  })
})

describe('CommunityService: the switch, and the swap scope it puts in the next key', () => {
  it('off by default; on, the next key is authorised with exactly the DEX swap and transferWithMemo on BetaUSD and ThetaUSD, each limited like the payout token', async () => {
    const w = await world({ preferredTokens: false })
    expect((await w.communities.get(GUILD)).ok && (await w.communities.get(GUILD))).toMatchObject({ value: { preferredTokens: false } })
    const off = await w.communities.provisionBotKey({ guildId: GUILD, limit: usd(50), periodSeconds: 86_400, expiresAt: w.chain.time + 3600 })
    expect(off.ok && off.value.authorization.scopes).toEqual([{ address: ALPHA, selector: TRANSFER_WITH_MEMO_SIGNATURE }])

    expect(await w.communities.setPreferredTokens({ guildId: GUILD, enabled: true })).toMatchObject({ ok: true, value: { community: { preferredTokens: true }, keyNeedsSwapScope: true } })
    const on = await w.communities.provisionBotKey({ guildId: GUILD, limit: usd(50), periodSeconds: 86_400, expiresAt: w.chain.time + 3600 })
    if (!on.ok) throw new Error(on.error.code)
    expect(on.value.authorization.scopes).toEqual([
      { address: ALPHA, selector: TRANSFER_WITH_MEMO_SIGNATURE },
      { address: STABLECOIN_DEX_ADDRESS, selector: SWAP_EXACT_AMOUNT_OUT_SIGNATURE },
      { address: BETA, selector: TRANSFER_WITH_MEMO_SIGNATURE },
      { address: THETA, selector: TRANSFER_WITH_MEMO_SIGNATURE },
    ])
    expect(on.value.authorization.limits).toEqual([
      { token: ALPHA, limit: usd(50), period: 86_400 },
      { token: BETA, limit: usd(50), period: 86_400 },
      { token: THETA, limit: usd(50), period: 86_400 },
    ])
    await w.communities.authorizeBotKey({ guildId: GUILD, root: w.chain.rootSigner(TREASURY) })
    expect(await w.communities.setPreferredTokens({ guildId: GUILD, enabled: true })).toMatchObject({ ok: true, value: { keyNeedsSwapScope: false } })
    expect(await w.communities.setPreferredTokens({ guildId: GUILD, enabled: false })).toMatchObject({ ok: true, value: { community: { preferredTokens: false }, keyNeedsSwapScope: false } })
    expect(await w.communities.setPreferredTokens({ guildId: OTHER_GUILD, enabled: true })).toEqual({ ok: false, error: { code: 'community_not_found' } })
  })
})

describe("PayeeService: a payee's choice", () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('sets, changes and clears it (the payout token means no preference); refuses tokens the community cannot deliver', async () => {
    expect(await w.payees.setPreferredToken({ guildId: GUILD, discordUserId: BO, token: THETA })).toMatchObject({ ok: true, value: { preferredToken: THETA } })
    expect(await w.payees.setPreferredToken({ guildId: GUILD, discordUserId: BO, token: ALPHA })).toMatchObject({ ok: true, value: { preferredToken: null } })
    expect(await w.payees.setPreferredToken({ guildId: GUILD, discordUserId: ANA, token: null })).toMatchObject({ ok: true, value: { preferredToken: null } })
    expect(await w.payees.setPreferredToken({ guildId: GUILD, discordUserId: BO, token: PATH })).toEqual({ ok: false, error: { code: 'token_not_allowed', choices: [ALPHA, BETA, THETA] } })
    expect(await w.payees.setPreferredToken({ guildId: GUILD, discordUserId: '200000000000000009', token: BETA })).toEqual({ ok: false, error: { code: 'payee_not_found' } })
    expect(await w.payees.setPreferredToken({ guildId: OTHER_GUILD, discordUserId: BO, token: BETA })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect(await w.payees.setPreferredToken({ guildId: GUILD, discordUserId: BO, token: 'not an address' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('from a passkey session: only the registrations of that address in that community', async () => {
    expect(await w.payees.setPreferredTokenByAddress({ guildId: GUILD, address: ADDR.bo, token: BETA })).toMatchObject({ ok: true, value: [{ discordUserId: BO, preferredToken: BETA }] })
    expect((await w.payees.get({ guildId: GUILD, discordUserId: ANA })).ok && (await w.payees.get({ guildId: GUILD, discordUserId: ANA }))).toMatchObject({ value: { preferredToken: BETA } })
    expect(await w.payees.setPreferredTokenByAddress({ guildId: GUILD, address: '0x7777777777777777777777777777777777777777', token: BETA })).toEqual({ ok: false, error: { code: 'payee_not_found' } })
  })

  it('lists where an address is paid, with each community\'s choices, whether it is on, and the current choice', async () => {
    await w.communities.register({ guildId: OTHER_GUILD, name: 'Other', treasuryAddress: TREASURY, payoutToken: BETA, feeMode: 'sponsor' })
    await w.repos.payees.upsert({ communityId: OTHER_GUILD, discordUserId: ANA, address: ADDR.ana, addressKind: 'passkey', preferredToken: null, registeredAt: w.clock.now(), updatedAt: w.clock.now() })
    expect(await w.payees.registrations({ address: ADDR.ana.toUpperCase().replace('0X', '0x') })).toEqual([
      { guildId: GUILD, communityName: 'Mods', discordUserId: ANA, payoutToken: ALPHA, preferredToken: BETA, choices: [ALPHA, BETA, THETA], enabled: true },
      { guildId: OTHER_GUILD, communityName: 'Other', discordUserId: ANA, payoutToken: BETA, preferredToken: null, choices: [BETA, ALPHA, THETA], enabled: false },
    ])
    expect(await w.payees.registrations({ address: '0x7777777777777777777777777777777777777777' })).toEqual([])
  })

  it('the options a page shows for one community: its payout token, the choices, and whether it is on', async () => {
    expect(await w.payees.preferenceOptions({ guildId: GUILD })).toEqual({ ok: true, value: { payoutToken: ALPHA, choices: [ALPHA, BETA, THETA], enabled: true } })
    expect(await w.payees.preferenceOptions({ guildId: OTHER_GUILD })).toEqual({ ok: false, error: { code: 'community_not_found' } })
  })

  it('a new registration through a link keeps the stablecoin they chose', async () => {
    const link = await w.payees.issueLink({ guildId: GUILD, discordUserId: ANA })
    if (!link.ok) throw new Error(link.error.code)
    expect(await w.payees.register({ token: link.value.token, address: '0x4444444444444444444444444444444444444444' })).toMatchObject({ ok: true, value: { preferredToken: BETA } })
  })
})
