import { MAX_RUN_ID_LENGTH, MEMO_BYTES, MEMO_MAGIC, MEMO_VERSION } from '../constants/memo.js'
import { type Hex, bytesToHex, hexToBytes } from './hex.js'

const RUN_ID = new RegExp(`^[\\x21-\\x7e]{1,${MAX_RUN_ID_LENGTH}}$`)

export function isMemoSafeRunId(runId: string): boolean {
  return RUN_ID.test(runId)
}

/** Throws on input that cannot be encoded: run IDs are validated long before this point. */
export function encodeMemo(runId: string, line: number): Hex {
  if (!isMemoSafeRunId(runId)) throw new Error(`runId must be 1-${MAX_RUN_ID_LENGTH} printable ASCII chars, no spaces`)
  if (!Number.isInteger(line) || line < 0 || line > 0xffffffff) throw new Error('line must be a uint32')
  const out = new Uint8Array(MEMO_BYTES)
  out[0] = MEMO_MAGIC[0]
  out[1] = MEMO_MAGIC[1]
  out[2] = MEMO_VERSION
  out[3] = 0
  for (let i = 0; i < runId.length; i++) out[4 + i] = runId.charCodeAt(i)
  new DataView(out.buffer).setUint32(28, line, false)
  return bytesToHex(out)
}

/** Decodes a pay-run memo, or returns null for anything else (other apps' memos, garbage). */
export function decodeMemo(memo: string): { runId: string; line: number } | null {
  const b = hexToBytes(memo)
  if (!b || b.length !== MEMO_BYTES || b[0] !== MEMO_MAGIC[0] || b[1] !== MEMO_MAGIC[1] || b[2] !== MEMO_VERSION) return null
  let end = 4
  while (end < 28 && b[end] !== 0) end++
  const runId = String.fromCharCode(...b.slice(4, end))
  if (!isMemoSafeRunId(runId)) return null
  const line = new DataView(b.buffer, b.byteOffset).getUint32(28, false)
  return { runId, line }
}
