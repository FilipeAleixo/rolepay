import { beforeEach, describe, expect, it } from 'vitest'
import * as f from '../../test/support/fixtures.js'
import { FakeFundingChain } from '../adapters/memory/fakeFundingChain.js'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { createMemoryRepositories } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import { TESTNET_TOKENS } from '../constants/tempo.js'
import { depositAddress, userTagFor } from '../domain/funding.js'
import type { Hex } from '../domain/hex.js'
import { createRolepay } from '../index.js'
import type { FundingRepository } from '../ports/repositories.js'

const APPROVER = '400000000000000001'
const MEMBER_ROLE = '400000000000000009'
const SALT = `0x${'00'.repeat(28)}58e21090` as Hex
const BAD_SALT = `0x${'ff'.repeat(32)}` as Hex
const ALPHA = TESTNET_TOKENS.alpha_usd
const PATH = TESTNET_TOKENS.path_usd
const BETA = TESTNET_TOKENS.beta_usd
const OUTSIDER_TOKEN = '0x20c0000000000000000000000000000000000009'
const treasurer = { guildId: f.GUILD, actor: f.TREASURER, actorRoleIds: [APPROVER] }

function world(opts: { chain?: boolean } = {}) {
  const repositories = createMemoryRepositories()
  const chain = new FakeFundingChain()
  const clock = new ManualClock(f.T0)
  const deps = {
    chain: new FakePayoutChain(),
    repositories,
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato' as const,
    ...(opts.chain === false ? {} : { fundingChain: chain }),
  }
  const rolepay = createRolepay(deps)
  /** The treasury registers on chain (as the setup page does) and Rolepay records it. */
  const setUp = async () => {
    const { txHash, masterId } = chain.register(f.TREASURY, SALT)
    const confirmed = await rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId, txHash })
    if (!confirmed.ok) throw new Error(confirmed.error.code)
    return confirmed.value
  }
  const source = async (name: string) => {
    const r = await rolepay.funding.createSource({ ...treasurer, name })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }
  const audit = async () => (await repositories.audit.query({ guildId: f.GUILD, types: [], actor: null, policyId: null, runId: null, since: null, until: null, before: null, limit: 500 })).reverse()
  return { repositories, chain, clock, deps, rolepay, setUp, source, audit }
}

let w: ReturnType<typeof world>
beforeEach(async () => {
  w = world()
  await w.repositories.communities.insert(f.community({ approverRoleId: APPROVER }))
})

describe('FundingService: off by default', () => {
  it('a community that never set up deposit addresses has no master and no sources, and the watcher reads nothing', async () => {
    expect(await w.rolepay.funding.status({ guildId: f.GUILD })).toEqual({ ok: true, value: { configured: true, master: null, sources: [] } })
    expect(await w.rolepay.funding.scan()).toEqual({ deposits: [], errors: [] })
    expect(w.chain.calls).toEqual({ head: 0, masterOf: 0, findRegistration: 0, forwardedTransfers: 0 })
  })

  it('a server without the funding chain says so and never scans', async () => {
    const bare = world({ chain: false })
    await bare.repositories.communities.insert(f.community({ approverRoleId: APPROVER }))
    expect((await bare.rolepay.funding.status({ guildId: f.GUILD })).ok && (await bare.rolepay.funding.status({ guildId: f.GUILD }))).toMatchObject({ value: { configured: false } })
    expect(await bare.rolepay.funding.planMaster({ guildId: f.GUILD, salt: SALT })).toEqual({ ok: false, error: { code: 'not_configured' } })
    expect(await bare.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId: '0x58e21090', txHash: null })).toEqual({ ok: false, error: { code: 'not_configured' } })
    expect(await bare.rolepay.funding.scan()).toEqual({ deposits: [], errors: [] })
  })

  it('an unknown community is community_not_found everywhere', async () => {
    const g = { guildId: f.OTHER_GUILD }
    expect(await w.rolepay.funding.status(g)).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect(await w.rolepay.funding.planMaster({ ...g, salt: SALT })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect(await w.rolepay.funding.createSource({ ...treasurer, ...g, name: 'x' })).toEqual({ ok: false, error: { code: 'community_not_found' } })
  })
})

describe('FundingService: registering the treasury as a master', () => {
  it('plans the registration for the treasury: the masterId and the exact call the page must build itself', async () => {
    const plan = await w.rolepay.funding.planMaster({ guildId: f.GUILD, salt: SALT })
    expect(plan).toEqual({ ok: true, value: { masterId: '0x58e21090', master: f.TREASURY, call: w.chain.registration({ master: f.TREASURY, salt: SALT })?.call } })
  })

  it('refuses a salt without the proof of work, and a masterId someone already holds (the page mines again)', async () => {
    expect(await w.rolepay.funding.planMaster({ guildId: f.GUILD, salt: BAD_SALT })).toEqual({ ok: false, error: { code: 'invalid_salt' } })
    expect(await w.rolepay.funding.planMaster({ guildId: f.GUILD, salt: 'not hex' as Hex })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    w.chain.register('0x7777777777777777777777777777777777777777', SALT)
    expect(await w.rolepay.funding.planMaster({ guildId: f.GUILD, salt: SALT })).toEqual({ ok: false, error: { code: 'master_id_taken' } })
  })

  it('records the master only once the registry maps it to the treasury, from the registration block', async () => {
    expect(await w.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId: '0x58e21090', txHash: null })).toEqual({ ok: false, error: { code: 'not_registered' } })
    const { txHash, masterId } = w.chain.register(f.TREASURY, SALT)
    w.chain.mine()
    const r = await w.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId, txHash })
    expect(r).toEqual({
      ok: true,
      value: { communityId: f.GUILD, masterId, masterAddress: f.TREASURY, txHash, registeredBlock: 1001n, registeredAt: f.T0, scannedTo: 1000n },
    })
    expect(await w.repositories.funding.getMaster(f.GUILD)).toEqual(r.ok && r.value)
  })

  it('is idempotent for the same masterId, and refuses another one once set up', async () => {
    const master = await w.setUp()
    expect(await w.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId: master.masterId, txHash: null })).toEqual({ ok: true, value: master })
    const other = w.chain.register(f.TREASURY, `0x${'00'.repeat(28)}0a0b0c0d`)
    expect(await w.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId: other.masterId, txHash: other.txHash })).toEqual({ ok: false, error: { code: 'already_set_up' } })
    expect(await w.rolepay.funding.planMaster({ guildId: f.GUILD, salt: SALT })).toEqual({ ok: false, error: { code: 'already_set_up' } })
  })

  it('refuses a masterId the registry maps to another address, whatever transaction the page names', async () => {
    const theirs = w.chain.register('0x7777777777777777777777777777777777777777', SALT)
    expect(await w.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId: theirs.masterId, txHash: theirs.txHash })).toEqual({ ok: false, error: { code: 'not_registered' } })
  })

  it('starts the watcher at the chain head when the named transaction is not a registration of this master', async () => {
    const { masterId } = w.chain.register(f.TREASURY, SALT)
    w.chain.mine()
    w.chain.mine()
    const r = await w.rolepay.funding.confirmMaster({ guildId: f.GUILD, masterId, txHash: `0x${'ab'.repeat(32)}` })
    expect(r).toMatchObject({ ok: true, value: { txHash: null, registeredBlock: 1003n, scannedTo: 1003n } })
  })
})

describe('FundingService: funding sources', () => {
  it('only the approver role creates them, once deposit addresses are set up', async () => {
    expect(await w.rolepay.funding.createSource({ ...treasurer, name: 'Judges pool' })).toEqual({ ok: false, error: { code: 'not_set_up' } })
    await w.setUp()
    expect(await w.rolepay.funding.createSource({ ...treasurer, actorRoleIds: [MEMBER_ROLE], name: 'Judges pool' })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect(await w.rolepay.funding.createSource({ ...treasurer, name: '  ' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('numbers them 1, 2, 3 and derives each deposit address from the master, with an audit event that holds no name', async () => {
    const master = await w.setUp()
    const acme = await w.source('Q4 bounty sponsor: Acme DAO')
    const judges = await w.source('Judges pool')
    expect(acme).toEqual({
      id: 'fsrc_000001',
      communityId: f.GUILD,
      name: 'Q4 bounty sponsor: Acme DAO',
      userTag: userTagFor(1),
      depositAddress: depositAddress(master.masterId, userTagFor(1)),
      createdBy: f.TREASURER,
      createdAt: f.T0,
    })
    expect(judges.depositAddress).toBe('0x58e21090fdfdfdfdfdfdfdfdfdfd000000000002')
    const events = await w.audit()
    expect(events.map((e) => [e.type, e.actor, e.details])).toEqual([
      ['funding_source.created', f.TREASURER, { sourceId: acme.id, depositAddress: acme.depositAddress }],
      ['funding_source.created', f.TREASURER, { sourceId: judges.id, depositAddress: judges.depositAddress }],
    ])
    expect(JSON.stringify(events)).not.toContain('Acme')
  })

  it('refuses a name already in use (case and spacing aside) and says which source has it', async () => {
    await w.setUp()
    const judges = await w.source('Judges pool')
    expect(await w.rolepay.funding.createSource({ ...treasurer, name: ' judges POOL' })).toEqual({ ok: false, error: { code: 'name_taken', source: judges } })
  })

  it('takes the next tag when another instance took this one first', async () => {
    await w.setUp()
    const inner = w.repositories.funding
    let raced = false
    const racing: FundingRepository = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      insertSource: async (s: Parameters<FundingRepository['insertSource']>[0]) => {
        if (!raced) {
          raced = true
          await inner.insertSource({ ...s, id: 'fsrc_elsewhere', name: 'Made by the other instance' })
        }
        return inner.insertSource(s)
      },
    })
    const rolepay = createRolepay({ ...w.deps, repositories: { ...w.repositories, funding: racing } })
    const r = await rolepay.funding.createSource({ ...treasurer, name: 'Judges pool' })
    expect(r).toMatchObject({ ok: true, value: { userTag: userTagFor(2) } })
  })

  it('stops at the most sources a community may have', async () => {
    await w.setUp()
    for (let i = 1; i <= 200; i++) await w.repositories.funding.insertSource(f.fundingSource(i, { id: `fsrc_bulk${i}`, name: `Bulk ${i}` }))
    expect(await w.rolepay.funding.createSource({ ...treasurer, name: 'One too many' })).toEqual({ ok: false, error: { code: 'too_many_sources' } })
  })
})

describe('FundingService: the deposit watcher', () => {
  async function twoSources() {
    await w.setUp()
    return { acme: await w.source('Acme DAO'), judges: await w.source('Judges pool') }
  }

  it('attributes each deposit to its source, in the payout token and the other known USD stablecoins, landing in the treasury with no sweep', async () => {
    const { acme, judges } = await twoSources()
    const a = w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 5_000_000n })
    const b = w.chain.transfer({ token: PATH, from: f.SPONSOR, to: judges.depositAddress, amount: 2_500_000n, memo: true })
    w.chain.transfer({ token: OUTSIDER_TOKEN, from: f.SPONSOR, to: judges.depositAddress, amount: 1n })
    const report = await w.rolepay.funding.scan()
    expect(report.errors).toEqual([])
    expect(report.deposits.map((d) => [d.sourceId, d.token, d.amount, d.txHash, d.from])).toEqual([
      [acme.id, ALPHA, 5_000_000n, a.txHash, f.SPONSOR],
      [judges.id, PATH, 2_500_000n, b.txHash, f.SPONSOR],
    ])
    expect(w.chain.balanceOf(ALPHA, f.TREASURY)).toBe(5_000_000n)
    expect(w.chain.balanceOf(ALPHA, acme.depositAddress)).toBe(0n)
    const events = (await w.audit()).filter((e) => e.type === 'deposit.received')
    expect(events.map((e) => [e.actor, e.details])).toEqual([
      [null, { sourceId: acme.id, amount: '5', token: ALPHA, txHash: a.txHash, logIndex: 0 }],
      [null, { sourceId: judges.id, amount: '2.5', token: PATH, txHash: b.txHash, logIndex: 0 }],
    ])
    expect(await w.repositories.funding.listDeposits(f.GUILD)).toHaveLength(2)
  })

  it('records each deposit once: a second tick finds nothing new, and a rescan of the same blocks stores nothing twice', async () => {
    const { acme } = await twoSources()
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 1_000_000n })
    expect((await w.rolepay.funding.scan()).deposits).toHaveLength(1)
    expect((await w.rolepay.funding.scan()).deposits).toEqual([])
    // A restart that lost the cursor (or a second instance behind this one) reads the same blocks again.
    const fresh = createRolepay({ ...w.deps, repositories: { ...w.repositories, funding: rewound(w.repositories.funding, 1000n) } })
    expect((await fresh.funding.scan()).deposits).toEqual([])
    expect(await w.repositories.funding.listDeposits(f.GUILD)).toHaveLength(1)
    expect((await w.audit()).filter((e) => e.type === 'deposit.received')).toHaveLength(1)
  })

  it('is safe with two instances scanning at once: each deposit is stored and audited once', async () => {
    const { acme, judges } = await twoSources()
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 1_000_000n })
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: judges.depositAddress, amount: 2_000_000n })
    const [one, two] = await Promise.all([w.rolepay.funding.scan(), createRolepay(w.deps).funding.scan()])
    expect(one.deposits.length + two.deposits.length).toBe(2)
    expect(await w.repositories.funding.listDeposits(f.GUILD)).toHaveLength(2)
    expect((await w.audit()).filter((e) => e.type === 'deposit.received')).toHaveLength(2)
  })

  it('does not count the treasury paying its own deposit address', async () => {
    const { acme } = await twoSources()
    w.chain.transfer({ token: ALPHA, from: f.TREASURY, to: acme.depositAddress, amount: 9_000_000n })
    expect((await w.rolepay.funding.scan()).deposits).toEqual([])
  })

  it('reads at most maxBlocks per community per tick, and catches up on the next ones', async () => {
    const { acme } = await twoSources()
    for (let i = 0; i < 5; i++) w.chain.mine()
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 1_000_000n })
    expect((await w.rolepay.funding.scan({ maxBlocks: 3n })).deposits).toEqual([])
    expect((await w.repositories.funding.getMaster(f.GUILD))?.scannedTo).toBe(1003n)
    expect((await w.rolepay.funding.scan({ maxBlocks: 3n })).deposits).toEqual([])
    expect((await w.rolepay.funding.scan({ maxBlocks: 3n })).deposits).toHaveLength(1)
  })

  it('leaves the cursor where it was when the chain cannot be read, and reports it; the next tick catches up', async () => {
    const { acme } = await twoSources()
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 1_000_000n })
    w.chain.failReads = true
    expect(await w.rolepay.funding.scan()).toEqual({ deposits: [], errors: [{ communityId: null, error: 'fetch failed (fake RPC outage)' }] })
    w.chain.failReads = false
    expect((await w.repositories.funding.getMaster(f.GUILD))?.scannedTo).toBe(1000n)
    expect((await w.rolepay.funding.scan()).deposits).toHaveLength(1)
  })

  it('keeps going with the other communities when one fails', async () => {
    const { acme } = await twoSources()
    await w.repositories.communities.insert(f.community({ id: f.OTHER_GUILD, treasuryAddress: '0x8888888888888888888888888888888888888888' }))
    await w.repositories.funding.insertMaster(f.depositMaster({ communityId: f.OTHER_GUILD, masterId: '0x0a0b0c0d', masterAddress: '0x8888888888888888888888888888888888888888' }))
    await w.repositories.funding.insertSource(f.fundingSource(1, { id: 'fsrc_other', communityId: f.OTHER_GUILD, depositAddress: depositAddress('0x0a0b0c0d', userTagFor(1)) }))
    const original = w.chain.forwardedTransfers.bind(w.chain)
    w.chain.forwardedTransfers = async (input) => {
      if (input.master !== f.TREASURY) throw new Error('range too large')
      return original(input)
    }
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 1_000_000n })
    const report = await w.rolepay.funding.scan()
    expect(report.deposits).toHaveLength(1)
    expect(report.errors).toEqual([{ communityId: f.OTHER_GUILD, error: 'range too large' }])
  })

  it('advances past blocks with nothing to read when a community has no sources yet', async () => {
    await w.setUp()
    w.chain.mine()
    expect(await w.rolepay.funding.scan()).toEqual({ deposits: [], errors: [] })
    expect(w.chain.calls.forwardedTransfers).toBe(0)
    expect((await w.repositories.funding.getMaster(f.GUILD))?.scannedTo).toBe(1002n)
  })

  it('watches a payout token outside the known list too', async () => {
    await w.repositories.communities.update(f.community({ approverRoleId: APPROVER, payoutToken: OUTSIDER_TOKEN }))
    const { acme } = await twoSources()
    w.chain.transfer({ token: OUTSIDER_TOKEN, from: f.SPONSOR, to: acme.depositAddress, amount: 3n })
    w.chain.transfer({ token: BETA, from: f.SPONSOR, to: acme.depositAddress, amount: 4n })
    expect((await w.rolepay.funding.scan()).deposits.map((d) => d.token)).toEqual([OUTSIDER_TOKEN, BETA])
  })
})

describe('FundingService: reading it back', () => {
  it('lists sources with what each brought in, and deposits newest first, per source', async () => {
    await w.setUp()
    const acme = await w.source('Acme DAO')
    const judges = await w.source('Judges pool')
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 5_000_000n })
    w.chain.transfer({ token: ALPHA, from: f.SPONSOR, to: acme.depositAddress, amount: 1_000_000n })
    await w.rolepay.funding.scan()
    const status = await w.rolepay.funding.status({ guildId: f.GUILD })
    expect(status.ok && status.value.sources.map((s) => [s.source.id, s.received.total, s.received.deposits])).toEqual([
      [acme.id, 6_000_000n, 2],
      [judges.id, 0n, 0],
    ])
    const deposits = await w.rolepay.funding.deposits({ guildId: f.GUILD })
    expect(deposits.map((d) => d.amount)).toEqual([1_000_000n, 5_000_000n])
    expect(await w.rolepay.funding.deposits({ guildId: f.GUILD, sourceId: judges.id })).toEqual([])
  })

  it("sums this UTC month's deposits for the Overview: the total and how many sources it came from", async () => {
    await w.setUp()
    const acme = await w.source('Acme DAO')
    const judges = await w.source('Judges pool')
    await w.repositories.funding.insertDeposit(f.deposit({ sourceId: acme.id, amount: 7_000_000n, blockTime: new Date('2026-09-30T23:59:59Z'), txHash: `0x${'01'.repeat(32)}` }))
    await w.repositories.funding.insertDeposit(f.deposit({ sourceId: acme.id, amount: 5_000_000n, blockTime: new Date('2026-10-01T00:00:00Z'), txHash: `0x${'02'.repeat(32)}` }))
    await w.repositories.funding.insertDeposit(f.deposit({ sourceId: judges.id, amount: 2_000_000n, token: PATH, blockTime: new Date('2026-10-05T00:00:00Z'), txHash: `0x${'03'.repeat(32)}` }))
    expect(await w.rolepay.funding.month({ guildId: f.GUILD })).toEqual({
      since: new Date('2026-10-01T00:00:00Z'),
      setUp: true,
      total: 7_000_000n,
      byToken: [
        { token: ALPHA, amount: 5_000_000n },
        { token: PATH, amount: 2_000_000n },
      ],
      sources: 2,
      deposits: 2,
    })
  })

  it('says a community has not set up deposit addresses, for the Overview to leave the line out', async () => {
    expect(await w.rolepay.funding.month({ guildId: f.GUILD })).toMatchObject({ setUp: false, total: 0n, sources: 0 })
  })
})

/** The same repository, with the watcher's cursor read as `block` (a restart that lost it, or a lagging instance). */
function rewound(inner: FundingRepository, block: bigint): FundingRepository {
  return Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
    listMasters: async () => (await inner.listMasters()).map((m) => ({ ...m, scannedTo: block })),
    getMaster: async (id: string) => {
      const m = await inner.getMaster(id)
      return m && { ...m, scannedTo: block }
    },
  })
}
