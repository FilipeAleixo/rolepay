import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { formatBits, qrMatrix, qrSvg, reedSolomon } from './qr.js'

const ADDRESS = '0x58e21090fdfdfdfdfdfdfdfdfdfd000000000001'

describe('QR code (byte mode, error correction M), for deposit addresses', () => {
  it('computes Reed-Solomon codewords as the standard does (the published "HELLO WORLD" 1-M example)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })

  it('writes the format information for level M and each mask (BCH code, masked with 101010000010010)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((m) => formatBits(m).toString(2).padStart(15, '0'))).toEqual([
      '101010000010010',
      '101000100100101',
      '101111001111100',
      '101101101001011',
      '100010111111001',
      '100000011001110',
      '100111110010111',
      '100101010100000',
    ])
  })

  it('fits an address (42 bytes) in version 3, 29 modules a side, with the finder, timing and dark modules in place', () => {
    const m = qrMatrix(ADDRESS)
    expect(m.length).toBe(29)
    expect(m.every((row) => row.length === 29)).toBe(true)
    const finder = (r0: number, c0: number) =>
      Array.from({ length: 7 }, (_, r) => Array.from({ length: 7 }, (_, c) => (m[r0 + r]?.[c0 + c] ? 1 : 0)).join('')).join('/')
    const FINDER = '1111111/1000001/1011101/1011101/1011101/1000001/1111111'
    expect([finder(0, 0), finder(0, 22), finder(22, 0)]).toEqual([FINDER, FINDER, FINDER])
    for (let i = 8; i < 21; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0)
      expect(m[i]?.[6]).toBe(i % 2 === 0)
    }
    expect(m[21]?.[8]).toBe(true) // the dark module
    // The alignment pattern of version 3, centred on (22, 22).
    expect(finder(20, 20).slice(0, 5)).toBe('11111')
  })

  it('grows with the data and refuses what does not fit version 6', () => {
    expect(qrMatrix('x'.repeat(14)).length).toBe(21)
    expect(qrMatrix('x'.repeat(62)).length).toBe(33)
    expect(qrMatrix('x'.repeat(106)).length).toBe(41)
    expect(() => qrMatrix('x'.repeat(107))).toThrow()
  })

  it('is deterministic: the matrix CoreImage decoded back to the address on 2026-10-07 (macOS CIDetector, an independent decoder)', () => {
    const bits = qrMatrix(ADDRESS)
      .map((row) => row.map((b) => (b ? '1' : '0')).join(''))
      .join('\n')
    expect(createHash('sha256').update(bits).digest('hex')).toBe(GOLDEN_SHA256)
  })

  it('draws an SVG with a quiet zone, labelled for screen readers, classes only (no style attribute)', () => {
    const svg = qrSvg(ADDRESS, { label: `QR code of the deposit address ${ADDRESS}` })
    expect(svg).toMatch(/^<svg class="qr" viewBox="0 0 37 37" role="img" aria-label="QR code of the deposit address 0x58e21090fdfdfdfdfdfdfdfdfdfd000000000001"/)
    expect(svg).toContain('<rect class="qr-bg" width="37" height="37"/>')
    expect(svg).toContain('<path class="qr-on" d="M')
    expect(svg).not.toContain('style=')
    expect(qrSvg(ADDRESS, { label: '<b>"x"</b>' })).toContain('aria-label="&lt;b&gt;&quot;x&quot;&lt;/b&gt;"')
  })
})

const GOLDEN_SHA256 = '44e4271c728e09e407e525bcaddde5920f40ecda6ba831125782cd35b06e4311'
