import { describe, expect, it } from 'vitest'
import { decodeMemo, encodeMemo, isMemoSafeRunId } from './memo.js'

describe('memo scheme (bytes32: "PR", version, reserved, run ID, uint32 line)', () => {
  it('matches the byte layout tested on chain in the spike', () => {
    const expected = `0x50520100${'7231'}${'00'.repeat(22)}00000001`
    expect(encodeMemo('r1', 1)).toBe(expected)
  })

  it('round-trips run ID and line', () => {
    const memo = encodeMemo('run-2026-10-06-a', 3)
    expect(memo).toHaveLength(66)
    expect(decodeMemo(memo)).toEqual({ runId: 'run-2026-10-06-a', line: 3 })
  })

  it('is distinct per line and per run', () => {
    expect(encodeMemo('r1', 1)).not.toBe(encodeMemo('r1', 2))
    expect(encodeMemo('r1', 1)).not.toBe(encodeMemo('r2', 1))
  })

  it('handles the max run ID length and max line', () => {
    const id = 'x'.repeat(24)
    expect(decodeMemo(encodeMemo(id, 0xffffffff))).toEqual({ runId: id, line: 0xffffffff })
  })

  it('rejects run IDs that cannot be encoded', () => {
    expect(() => encodeMemo('x'.repeat(25), 1)).toThrow()
    expect(() => encodeMemo('has space', 1)).toThrow()
    expect(() => encodeMemo('', 1)).toThrow()
    expect(() => encodeMemo('é', 1)).toThrow()
  })

  it('rejects lines that are not uint32', () => {
    expect(() => encodeMemo('ok', -1)).toThrow()
    expect(() => encodeMemo('ok', 1.5)).toThrow()
    expect(() => encodeMemo('ok', 2 ** 32)).toThrow()
  })

  it('decodes foreign or malformed memos to null', () => {
    expect(decodeMemo(`0x${'00'.repeat(32)}`)).toBeNull()
    expect(decodeMemo('0x5052')).toBeNull()
    expect(decodeMemo(`0x5052ff00${'00'.repeat(28)}`)).toBeNull() // unknown version
    expect(decodeMemo(`0x${'zz'.repeat(32)}`)).toBeNull()
    expect(decodeMemo(`0x50520100${'00'.repeat(28)}`)).toBeNull() // empty run ID
  })

  it('accepts uppercase hex from RPC responses', () => {
    expect(decodeMemo(encodeMemo('Ab1', 7).toUpperCase().replace('0X', '0x'))).toEqual({ runId: 'Ab1', line: 7 })
  })

  it('isMemoSafeRunId mirrors the encoder rules', () => {
    expect(isMemoSafeRunId('run_abc')).toBe(true)
    expect(isMemoSafeRunId('x'.repeat(24))).toBe(true)
    expect(isMemoSafeRunId('x'.repeat(25))).toBe(false)
    expect(isMemoSafeRunId('a b')).toBe(false)
    expect(isMemoSafeRunId('')).toBe(false)
  })
})
