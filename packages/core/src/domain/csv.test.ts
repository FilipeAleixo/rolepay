import { describe, expect, it } from 'vitest'
import { csvCell, runToCsv } from './csv.js'
import { type Run, type RunEvent, newRun, transition } from './run.js'

const HASH = `0x${'ab'.repeat(32)}` as const

function paidRun(note: string | null): Run {
  const r = newRun({
    id: 'run_csv1',
    communityId: '1094309218049937418',
    token: '0x20c0000000000000000000000000000000000001',
    note,
    createdBy: '200000000000000001',
    lines: [
      { payeeDiscordId: '200000000000000001', address: '0x1111111111111111111111111111111111111111', amount: 1_500_000n },
      { payeeDiscordId: '200000000000000002', address: '0x2222222222222222222222222222222222222222', amount: 1n },
    ],
    now: new Date('2026-10-06T12:00:00Z'),
  })
  if (!r.ok) throw new Error('fixture')
  let run = r.value
  const at = new Date('2026-10-06T12:05:00Z')
  for (const e of [
    { type: 'submit', actor: '200000000000000001' },
    { type: 'approve', actor: '300000000000000001' },
    { type: 'start_attempt', fromBlock: 1n, validBefore: 1_800_000_000 },
    { type: 'mark_paid', txHash: HASH, blockNumber: 2n },
  ] satisfies RunEvent[]) {
    const n = transition(run, e, at)
    if (!n.ok) throw new Error('fixture')
    run = n.value
  }
  return run
}

const explorerTxUrl = (h: string) => `https://explore.testnet.tempo.xyz/tx/${h}`

describe('runToCsv', () => {
  it('writes a header and one row per line, amounts at fixed 6 decimals, CRLF endings', () => {
    const csv = runToCsv(paidRun('October mods'), { explorerTxUrl })
    const rows = csv.split('\r\n')
    expect(rows[0]).toBe(
      'run_id,line,discord_user_id,address,amount,token,memo,status,tx_hash,explorer_url,paid_at,approved_by,note,delivered_token',
    )
    expect(rows[1]).toBe(
      [
        'run_csv1',
        '1',
        '200000000000000001',
        '0x1111111111111111111111111111111111111111',
        '1.500000',
        '0x20c0000000000000000000000000000000000001',
        paidRun(null).lines[0]?.memo,
        'paid',
        HASH,
        `https://explore.testnet.tempo.xyz/tx/${HASH}`,
        '2026-10-06T12:05:00.000Z',
        '300000000000000001',
        'October mods',
        '0x20c0000000000000000000000000000000000001',
      ].join(','),
    )
    expect(rows[2]?.split(',')[4]).toBe('0.000001')
    expect(rows).toHaveLength(4) // header, 2 lines, trailing empty after final CRLF
    expect(rows[3]).toBe('')
  })

  it('a large amount stays machine-readable: no thousands separators (those are for display only)', () => {
    const r = newRun({ ...paidRunInput(), id: 'run_csv3', lines: [{ ...paidRunInput().lines[0], amount: 999_995_000_000n } as ReturnType<typeof paidRunInput>['lines'][number]] })
    if (!r.ok) throw new Error('fixture')
    const csv = runToCsv(r.value, { explorerTxUrl })
    expect(csv.split('\r\n')[1]?.split(',')[4]).toBe('999995.000000')
    expect(csv).not.toContain('999,995')
  })

  it('adds the delivered token last: the payout token, or the stablecoin a swapped line delivered (the existing columns stay as they were)', () => {
    const run = paidRun(null)
    const swapped = { ...run, lines: run.lines.map((l) => (l.line === 2 ? { ...l, swap: { token: '0x20c0000000000000000000000000000000000002' as const, maxIn: 2n } } : l)) }
    const rows = runToCsv(swapped, { explorerTxUrl }).split('\r\n').map((r) => r.split(','))
    expect(rows[1]?.[5]).toBe('0x20c0000000000000000000000000000000000001')
    expect(rows[1]?.[13]).toBe('0x20c0000000000000000000000000000000000001')
    expect(rows[2]?.[5]).toBe('0x20c0000000000000000000000000000000000001')
    expect(rows[2]?.[13]).toBe('0x20c0000000000000000000000000000000000002')
  })

  it('leaves chain columns empty for an unpaid run', () => {
    const r = newRun({ ...paidRunInput(), id: 'run_csv2' })
    if (!r.ok) throw new Error('fixture')
    const row = runToCsv(r.value, { explorerTxUrl }).split('\r\n')[1]?.split(',')
    expect(row?.slice(7, 12)).toEqual(['draft', '', '', '', ''])
  })
})

function paidRunInput() {
  return {
    communityId: '1094309218049937418',
    token: '0x20c0000000000000000000000000000000000001',
    note: null,
    createdBy: '200000000000000001',
    lines: [{ payeeDiscordId: '200000000000000001', address: '0x1111111111111111111111111111111111111111', amount: 1n }],
    now: new Date(),
  }
}

describe('csvCell (RFC 4180 quoting + spreadsheet formula injection guard)', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@sum', "'@sum"],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })
})
