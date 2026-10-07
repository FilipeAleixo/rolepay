import { esc } from './format.js'

/**
 * QR codes for deposit addresses, as inline SVG from a pure builder (the dashboard runs no
 * script). Byte mode, error correction level M, versions 1 to 6 (up to 106 bytes: an address is
 * 42), the mask with the lowest penalty. The algorithm follows ISO/IEC 18004 as Nayuki's reference
 * implementation lays it out; a deposit address's code was checked with an independent decoder.
 */

/** Error correction codewords per block and the number of blocks, level M, versions 1 to 6. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4]
const MAX_VERSION = 6

/** GF(256) multiplication, modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** The Reed-Solomon error correction codewords of `data` (`degree` of them). */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0)
  divisor[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMultiply(divisor[j] as number, root)
      if (j + 1 < degree) divisor[j] = (divisor[j] as number) ^ (divisor[j + 1] as number)
    }
    root = gfMultiply(root, 0x02)
  }
  const result = new Array<number>(degree).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    for (let i = 0; i < degree; i++) result[i] = (result[i] as number) ^ gfMultiply(divisor[i] as number, factor)
  }
  return result
}

/** The 15 format bits for level M (00) and `mask`: BCH(15,5) with generator 0x537, XOR 0x5412. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

const rawDataModules = (ver: number) => {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
  }
  return n
}
const dataCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK[ver] as number) * (BLOCKS[ver] as number)

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const out = [6]
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos)
  return out
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** The modules of a QR code for `text` (UTF-8, byte mode, level M), rows of booleans, dark = true. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let ver = 1
  while (ver <= MAX_VERSION && 4 + 8 + bytes.length * 8 > dataCodewords(ver) * 8) ver++
  if (ver > MAX_VERSION) throw new RangeError(`a QR code here holds at most ${dataCodewords(MAX_VERSION) - 2} bytes`)

  // The data bits: mode 0100 (byte), the count in 8 bits, the bytes, a terminator, then padding.
  const capacity = dataCodewords(ver) * 8
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Blocks with their error correction, interleaved.
  const blocks = BLOCKS[ver] as number
  const eccLen = ECC_PER_BLOCK[ver] as number
  const raw = Math.floor(rawDataModules(ver) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1))
    k += block.length
    const ecc = reedSolomon(block, eccLen)
    if (i < shortBlocks) block.push(0)
    all.push([...block, ...ecc])
  }
  const codewords: number[] = []
  for (let i = 0; i < (all[0] as number[]).length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(block[i] as number)
    })
  }

  // Function patterns: timing, finders, alignment, format (placeholder), the dark module.
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => {
    ;(modules[y] as boolean[])[x] = dark
    ;(fixed[y] as boolean[])[x] = true
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
      }
    }
  }
  const align = alignmentPositions(ver, size)
  const last = align.length - 1
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }),
  )
  const drawFormat = (mask: number) => {
    const f = formatBits(mask)
    const bit = (i: number) => ((f >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(0)

  // The codewords, in the zigzag from the bottom right, two columns at a time, skipping column 6.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!(fixed[y] as boolean[])[x] && i < codewords.length * 8) {
          ;(modules[y] as boolean[])[x] = (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) === 1
          i++
        }
      }
    }
  }

  // The mask with the lowest penalty.
  const masked = (mask: number) => {
    const out = modules.map((row, y) => row.map((dark, x) => (!(fixed[y] as boolean[])[x] && (MASKS[mask] as (x: number, y: number) => boolean)(x, y) ? !dark : dark)))
    return out
  }
  let best: boolean[][] = modules
  let bestMask = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask)
    const candidate = masked(mask)
    const score = penalty(candidate)
    if (score < bestScore) {
      best = candidate
      bestMask = mask
      bestScore = score
    }
  }
  drawFormat(bestMask)
  // The format bits are function modules: copy them onto the chosen masking.
  return best.map((row, y) => row.map((dark, x) => ((fixed[y] as boolean[])[x] ? ((modules[y] as boolean[])[x] as boolean) : dark)))
}

/** The four penalty rules of ISO/IEC 18004 (runs, 2x2 blocks, finder-like patterns, dark balance). */
function penalty(m: boolean[][]): number {
  const size = m.length
  let score = 0
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x] as boolean))]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    const s = line.map((b) => (b ? '1' : '0')).join('')
    for (const pattern of ['10111010000', '00001011101']) for (let k = s.indexOf(pattern); k !== -1; k = s.indexOf(pattern, k + 1)) score += 40
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = m[y]?.[x]
      if (c === m[y]?.[x + 1] && c === m[y + 1]?.[x] && c === m[y + 1]?.[x + 1]) score += 3
    }
  }
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return score
}

/** The QR code as an SVG: a light square with a 4-module quiet zone and one path of dark modules (classes `qr`, `qr-bg`, `qr-on`). */
export function qrSvg(text: string, opts: { label: string }): string {
  const m = qrMatrix(text)
  const n = m.length + 8
  let d = ''
  m.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      const start = x
      while (x < row.length && row[x]) x++
      d += `M${start + 4} ${y + 4}h${x - start}v1h-${x - start}z`
    }
  })
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label="${esc(opts.label)}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect class="qr-bg" width="${n}" height="${n}"/><path class="qr-on" d="${d}"/></svg>`
}
