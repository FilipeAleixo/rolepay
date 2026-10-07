import { describe, expect, it } from 'vitest'
import {
  type Deposit,
  type FundingSource,
  type TransferLog,
  attributeDeposits,
  canManageFunding,
  depositAddress,
  fundingSummary,
  parseVirtualAddress,
  SourceNameSchema,
  userTagFor,
} from './funding.js'

const MASTER_ID = '0x58e21090'
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const PATH_USD = '0x20c0000000000000000000000000000000000000'
const SPONSOR = '0x5555555555555555555555555555555555555555' as const
const T0 = new Date('2026-10-06T12:00:00.000Z')
const TX1 = `0x${'a1'.repeat(32)}` as const
const TX2 = `0x${'b2'.repeat(32)}` as const

const source = (n: number, over: Partial<FundingSource> = {}): FundingSource => ({
  id: `fsrc_${n}`,
  communityId: '1094309218049937418',
  name: `Source ${n}`,
  userTag: userTagFor(n),
  depositAddress: depositAddress(MASTER_ID, userTagFor(n)),
  createdBy: '300000000000000001',
  createdAt: T0,
  ...over,
})

/** The two-hop pair TIP-1022 emits for one forwarded transfer, at log indexes i and i+1. */
const hops = (tx: `0x${string}`, i: number, from: string, to: string, amount: bigint, token = TOKEN): TransferLog[] => [
  { token, from, to, amount, txHash: tx, logIndex: i, blockNumber: 100n, blockTime: T0 },
  { token, from: to, to: TREASURY, amount, txHash: tx, logIndex: i + 1, blockNumber: 100n, blockTime: T0 },
]

describe('deposit addresses (TIP-1022 layout)', () => {
  it('builds [masterId][10 magic bytes][userTag], lowercase', () => {
    expect(depositAddress('0x58E21090', '0x010203040506')).toBe('0x58e21090fdfdfdfdfdfdfdfdfdfd010203040506')
  })

  it('numbers sources 1, 2, 3 as 6-byte big-endian user tags', () => {
    expect(userTagFor(1)).toBe('0x000000000001')
    expect(userTagFor(258)).toBe('0x000000000102')
    expect(() => userTagFor(0)).toThrow()
    expect(() => userTagFor(2 ** 48)).toThrow()
  })

  it('parses a virtual address into its masterId and userTag, and refuses anything else', () => {
    expect(parseVirtualAddress('0x58e21090FDFDFDFDFDFDFDFDFDFD010203040506')).toEqual({ masterId: '0x58e21090', userTag: '0x010203040506' })
    expect(parseVirtualAddress(TREASURY)).toBeNull()
    expect(parseVirtualAddress('0x58e21090fdfdfdfdfdfdfdfdfdfd0102030405')).toBeNull()
    expect(parseVirtualAddress('not an address')).toBeNull()
  })
})

describe('source names', () => {
  it('trims, and refuses empty, over-long and control characters', () => {
    expect(SourceNameSchema.parse('  Q4 bounty sponsor: Acme DAO ')).toBe('Q4 bounty sponsor: Acme DAO')
    expect(SourceNameSchema.safeParse('   ').success).toBe(false)
    expect(SourceNameSchema.safeParse('x'.repeat(81)).success).toBe(false)
    expect(SourceNameSchema.safeParse('a\nb').success).toBe(false)
  })
})

describe('who manages funding sources', () => {
  it('is the approver role only, and nobody when none is set', () => {
    expect(canManageFunding({ approverRoleId: '400000000000000001' }, ['400000000000000001'])).toBe(true)
    expect(canManageFunding({ approverRoleId: '400000000000000001' }, ['400000000000000002'])).toBe(false)
    expect(canManageFunding({ approverRoleId: null }, ['400000000000000001'])).toBe(false)
  })
})

describe('attributeDeposits: pairs of Transfer events, as TIP-1022 describes', () => {
  const sources = [source(1), source(2)]
  const a = sources[0] as FundingSource
  const b = sources[1] as FundingSource

  it('turns each first hop (sender to deposit address) with its second hop (to the treasury) into one deposit', () => {
    const transfers = [...hops(TX1, 3, SPONSOR, a.depositAddress, 5_000_000n), ...hops(TX2, 0, SPONSOR, b.depositAddress, 7_000_000n, PATH_USD)]
    const r = attributeDeposits({ communityId: a.communityId, treasury: TREASURY, sources, transfers })
    expect(r.deposits).toEqual([
      { communityId: a.communityId, sourceId: a.id, token: TOKEN, amount: 5_000_000n, from: SPONSOR, txHash: TX1, logIndex: 3, blockNumber: 100n, blockTime: T0 },
      { communityId: a.communityId, sourceId: b.id, token: PATH_USD, amount: 7_000_000n, from: SPONSOR, txHash: TX2, logIndex: 0, blockNumber: 100n, blockTime: T0 },
    ])
    expect(r.selfTransfers).toBe(0)
    expect(r.unpaired).toBe(0)
  })

  it('finds the second hop after a TransferWithMemo between them, and keeps two deposits in one transaction apart', () => {
    const [first, second] = hops(TX1, 0, SPONSOR, a.depositAddress, 1_000_000n) as [TransferLog, TransferLog]
    const transfers = [first, { ...second, logIndex: 2 }, ...hops(TX1, 3, SPONSOR, a.depositAddress, 1_000_000n)]
    const r = attributeDeposits({ communityId: a.communityId, treasury: TREASURY, sources, transfers })
    expect(r.deposits.map((d) => d.logIndex)).toEqual([0, 3])
  })

  it('does not count the treasury paying its own deposit address (self-forwarding: no money came in)', () => {
    const r = attributeDeposits({ communityId: a.communityId, treasury: TREASURY, sources, transfers: hops(TX1, 0, TREASURY, a.depositAddress, 9_000_000n) })
    expect(r.deposits).toEqual([])
    expect(r.selfTransfers).toBe(1)
  })

  it('records a mint to a deposit address as a deposit from the zero address', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    const r = attributeDeposits({ communityId: a.communityId, treasury: TREASURY, sources, transfers: hops(TX1, 0, zero, a.depositAddress, 2_000_000n) })
    expect(r.deposits[0]?.from).toBe(zero)
  })

  it('ignores a first hop with no matching forward to the treasury (another master, another amount or token), and unknown addresses', () => {
    const [first] = hops(TX1, 0, SPONSOR, a.depositAddress, 1_000_000n) as [TransferLog]
    const transfers: TransferLog[] = [
      first,
      { ...first, from: a.depositAddress, to: SPONSOR, logIndex: 1 },
      { ...first, from: a.depositAddress, to: TREASURY, amount: 2n, logIndex: 2 },
      { ...first, from: a.depositAddress, to: TREASURY, token: PATH_USD, logIndex: 3 },
      ...hops(TX2, 0, SPONSOR, depositAddress(MASTER_ID, userTagFor(99)), 1_000_000n),
    ]
    const r = attributeDeposits({ communityId: a.communityId, treasury: TREASURY, sources, transfers })
    expect(r.deposits).toEqual([])
    expect(r.unpaired).toBe(1)
  })

  it('never pairs a second hop that comes before the first, nor one from another transaction', () => {
    const [first, second] = hops(TX1, 5, SPONSOR, a.depositAddress, 1_000_000n) as [TransferLog, TransferLog]
    const transfers = [first, { ...second, logIndex: 4 }, { ...second, txHash: TX2 }]
    expect(attributeDeposits({ communityId: a.communityId, treasury: TREASURY, sources, transfers }).deposits).toEqual([])
  })

  it('matches addresses whatever their case', () => {
    const transfers = hops(TX1, 0, SPONSOR.toUpperCase().replace('0X', '0x'), a.depositAddress.toUpperCase().replace('0X', '0x'), 1n)
    expect(attributeDeposits({ communityId: a.communityId, treasury: TREASURY.toUpperCase().replace('0X', '0x'), sources, transfers }).deposits).toHaveLength(1)
  })
})

describe('fundingSummary', () => {
  const d = (sourceId: string, amount: bigint, token: `0x${string}` = TOKEN): Deposit => ({
    communityId: '1094309218049937418',
    sourceId,
    token,
    amount,
    from: SPONSOR,
    txHash: TX1,
    logIndex: 0,
    blockNumber: 1n,
    blockTime: T0,
  })

  it('totals what came in, by token, and counts the sources it came from', () => {
    expect(fundingSummary([d('fsrc_1', 5_000_000n), d('fsrc_2', 2_000_000n), d('fsrc_1', 1_000_000n, PATH_USD)])).toEqual({
      total: 8_000_000n,
      byToken: [
        { token: TOKEN, amount: 7_000_000n },
        { token: PATH_USD, amount: 1_000_000n },
      ],
      sources: 2,
      deposits: 3,
    })
  })

  it('is zero for nothing', () => {
    expect(fundingSummary([])).toEqual({ total: 0n, byToken: [], sources: 0, deposits: 0 })
  })
})
