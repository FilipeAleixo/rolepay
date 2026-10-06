/** Minimal hex helpers so the domain stays free of chain libraries. */
export type Hex = `0x${string}`

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out as Hex
}

/** Returns null for anything that is not 0x-prefixed, even-length hex. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null
  const out = new Uint8Array((hex.length - 2) / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16)
  return out
}
