import { describe, expect, it } from 'vitest'
import { ADDR, GUILD, advance, run } from '../../test/support/fixtures.js'
import { linesPaidTo } from './received.js'

const HASH = `0x${'ab'.repeat(32)}` as const
const paidRun = () =>
  advance(
    run(),
    { type: 'submit', actor: '200000000000000001' },
    { type: 'approve', actor: '300000000000000001' },
    { type: 'start_attempt', fromBlock: 1n, validBefore: 2_000_000_000 },
    { type: 'mark_paid', txHash: HASH, blockNumber: 7n },
  )

describe('linesPaidTo', () => {
  it('lists only the lines of a paid run that paid this address, whatever its case', () => {
    const r = paidRun()
    expect(linesPaidTo(r, ADDR.bob.toUpperCase().replace('0X', '0x'))).toEqual([
      { guildId: GUILD, runId: r.id, line: 2, amount: 2_000_000n, token: r.token, txHash: HASH, paidAt: r.paidAt },
    ])
    expect(linesPaidTo(r, '0x5555555555555555555555555555555555555555')).toEqual([])
  })

  it('says nothing about a run that is not paid yet', () => {
    expect(linesPaidTo(run(), ADDR.alice)).toEqual([])
  })

  it('names the token a swapped line delivered, not the run token', () => {
    const r = paidRun()
    const swapped = { ...r, lines: r.lines.map((l) => (l.line === 1 ? { ...l, swap: { token: '0x20c0000000000000000000000000000000000002' as const, maxIn: 1_600_000n } } : l)) }
    expect(linesPaidTo(swapped, ADDR.alice)[0]?.token).toBe('0x20c0000000000000000000000000000000000002')
  })
})
