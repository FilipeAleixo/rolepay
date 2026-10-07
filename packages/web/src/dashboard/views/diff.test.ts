import { describe, expect, it } from 'vitest'
import { lineDiff } from './diff.js'

describe('lineDiff', () => {
  it('keeps common lines and marks what was removed and added, in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { op: ' ', line: 'a' },
      { op: '-', line: 'b' },
      { op: '+', line: 'B' },
      { op: ' ', line: 'c' },
      { op: '+', line: 'd' },
    ])
  })

  it('an unchanged text has no changes; an empty one is all added', () => {
    expect(lineDiff('x\ny', 'x\ny').every((l) => l.op === ' ')).toBe(true)
    expect(lineDiff('', 'x')).toEqual([
      { op: '-', line: '' },
      { op: '+', line: 'x' },
    ])
  })
})
