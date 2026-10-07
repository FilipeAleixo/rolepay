import type { RateLimiter } from './ports.js'

type Bucket = { tokens: number; at: number }

/**
 * The in-memory RateLimiter: one token bucket per key. A bucket holds up to `capacity` tokens,
 * refills at `refillPerSecond`, and each request takes one. Per process and lost on restart,
 * which is fine for basic abuse control; a shared store can replace it behind the port.
 */
export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number
  private readonly maxKeys: number

  constructor(private readonly opts: { capacity: number; refillPerSecond: number; now?: () => number; maxKeys?: number }) {
    this.now = opts.now ?? Date.now
    this.maxKeys = opts.maxKeys ?? 10_000
  }

  get size() {
    return this.buckets.size
  }

  async take(key: string): Promise<boolean> {
    const now = this.now()
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) this.forgetFull(now)
    const b = this.buckets.get(key) ?? { tokens: this.opts.capacity, at: now }
    const tokens = Math.min(this.opts.capacity, b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSecond)
    const allowed = tokens >= 1
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now })
    return allowed
  }

  /** Whether `take` would allow a request from `key` now, without taking one or keeping anything for an unknown key. */
  async peek(key: string): Promise<boolean> {
    const b = this.buckets.get(key)
    if (!b) return this.opts.capacity >= 1
    return Math.min(this.opts.capacity, b.tokens + ((this.now() - b.at) / 1000) * this.opts.refillPerSecond) >= 1
  }

  /** A bucket that has refilled says nothing a fresh one would not: drop it. */
  private forgetFull(now: number) {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSecond >= this.opts.capacity) this.buckets.delete(key)
    }
  }
}
