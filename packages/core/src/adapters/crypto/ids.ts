import { randomBytes } from 'node:crypto'
import type { Clock } from '../../ports/clock.js'
import type { IdGenerator } from '../../ports/idGenerator.js'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/** run_ + 80 random bits (16 base32 chars): 20 chars, inside the 24-char memo budget. */
export class RandomIds implements IdGenerator {
  runId() {
    return `run_${base32(randomBytes(10))}`
  }
  linkToken() {
    return randomBytes(32).toString('base64url')
  }
}

export class SystemClock implements Clock {
  now() {
    return new Date()
  }
}
