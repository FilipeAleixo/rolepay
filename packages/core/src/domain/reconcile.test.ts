import { describe, expect, it } from 'vitest'
import { encodeMemo } from './memo.js'
import { type MemoTransfer, matchTransfers, runTokens } from './reconcile.js'
import { type Run, newRun } from './run.js'

const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const OTHER_TOKEN = '0x20c0000000000000000000000000000000000002'
const A1 = '0x1111111111111111111111111111111111111111'
const A2 = '0x2222222222222222222222222222222222222222'
const TX1 = `0x${'01'.repeat(32)}` as const
const TX2 = `0x${'02'.repeat(32)}` as const

function run(): Run {
  const r = newRun({
    id: 'run_rec1',
    communityId: '1094309218049937418',
    token: TOKEN,
    note: null,
    createdBy: '200000000000000001',
    lines: [
      { payeeDiscordId: '200000000000000001', address: A1, amount: 1_000_000n },
      { payeeDiscordId: '200000000000000002', address: A2, amount: 2_000_000n },
    ],
    now: new Date(),
  })
  if (!r.ok) throw new Error(r.error.code)
  return r.value
}

const transfer = (line: number, over: Partial<MemoTransfer> = {}): MemoTransfer => ({
  txHash: TX1,
  blockNumber: 50n,
  token: TOKEN,
  from: TREASURY,
  to: line === 1 ? A1 : A2,
  amount: line === 1 ? 1_000_000n : 2_000_000n,
  memo: encodeMemo('run_rec1', line),
  ...over,
})

describe('matchTransfers (is this run paid, according to the chain?)', () => {
  it('none: no transfers carry the run memos', () => {
    expect(matchTransfers(run(), TREASURY, [])).toEqual({ kind: 'none' })
  })

  it('all_paid: every line paid exactly once, as expected, in one tx', () => {
    expect(matchTransfers(run(), TREASURY, [transfer(1), transfer(2)])).toEqual({
      kind: 'all_paid',
      txHash: TX1,
      blockNumber: 50n,
    })
  })

  it('partial: only some lines found (cannot happen with one atomic batch: a human must look)', () => {
    expect(matchTransfers(run(), TREASURY, [transfer(2)])).toEqual({ kind: 'partial', paidLines: [2], missingLines: [1] })
  })

  it('mismatch: a line paid with the wrong amount or recipient', () => {
    expect(matchTransfers(run(), TREASURY, [transfer(1, { amount: 5n }), transfer(2)])).toMatchObject({ kind: 'mismatch' })
    expect(matchTransfers(run(), TREASURY, [transfer(1, { to: A2 }), transfer(2)])).toMatchObject({ kind: 'mismatch' })
  })

  it('mismatch: a line paid twice', () => {
    const r = matchTransfers(run(), TREASURY, [transfer(1), transfer(1, { txHash: TX2, blockNumber: 60n }), transfer(2)])
    expect(r).toMatchObject({ kind: 'mismatch' })
  })

  it('ignores lookalikes: memos are public, so only the treasury paying in the run token counts', () => {
    const spoofs = [transfer(1, { from: A2 }), transfer(2, { token: OTHER_TOKEN })]
    expect(matchTransfers(run(), TREASURY, spoofs)).toEqual({ kind: 'none' })
  })

  it('compares addresses case-insensitively (RPC logs come back checksummed)', () => {
    const upper = transfer(1, { from: TREASURY.toUpperCase().replace('0X', '0x') as MemoTransfer['from'] })
    expect(matchTransfers(run(), TREASURY, [upper, transfer(2)])).toMatchObject({ kind: 'all_paid' })
  })

  describe('a line paid in the payee\'s preferred stablecoin', () => {
    const swapped = (): Run => {
      const r = run()
      return { ...r, lines: r.lines.map((l) => (l.line === 2 ? { ...l, swap: { token: OTHER_TOKEN, maxIn: 2_020_000n } } : l)) }
    }

    it('all_paid: found by its memo, as a transfer from the treasury in the token it delivers', () => {
      expect(matchTransfers(swapped(), TREASURY, [transfer(1), transfer(2, { token: OTHER_TOKEN })])).toEqual({ kind: 'all_paid', txHash: TX1, blockNumber: 50n })
      expect(runTokens(swapped())).toEqual([TOKEN, OTHER_TOKEN])
      expect(runTokens(run())).toEqual([TOKEN])
    })

    it('mismatch: its memo paid in the run token instead (money moved, but not as the run said)', () => {
      expect(matchTransfers(swapped(), TREASURY, [transfer(1), transfer(2)])).toMatchObject({ kind: 'mismatch', detail: expect.stringContaining('line 2') })
    })

    it('a plain line paid in the other token is a mismatch too; the swap itself emits no memo and is never counted', () => {
      expect(matchTransfers(swapped(), TREASURY, [transfer(1, { token: OTHER_TOKEN }), transfer(2, { token: OTHER_TOKEN })])).toMatchObject({ kind: 'mismatch' })
    })
  })

  it('reports the latest block when lines landed in different txs', () => {
    const r = matchTransfers(run(), TREASURY, [transfer(1), transfer(2, { txHash: TX2, blockNumber: 70n })])
    expect(r).toEqual({ kind: 'all_paid', txHash: TX2, blockNumber: 70n })
  })
})
