export type DiffLine = { op: ' ' | '+' | '-'; line: string }

/** Lines beyond this are compared as one block (a policy's texts are far shorter). */
const MAX_LINES = 400

/**
 * A line diff (longest common subsequence) between two texts: what a new policy version
 * changed. Pure and small; the texts are an instruction, a rule in words and a filter as JSON.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return before === after ? a.map((line) => ({ op: ' ', line })) : [...a.map((line) => ({ op: '-' as const, line })), ...b.map((line) => ({ op: '+' as const, line }))]
  }
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] as string })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: '-', line: a[i++] as string })
    else out.push({ op: '+', line: b[j++] as string })
  }
  while (i < a.length) out.push({ op: '-', line: a[i++] as string })
  while (j < b.length) out.push({ op: '+', line: b[j++] as string })
  return out
}
