import { describe, expect, it } from 'vitest'
import { TokenBucketLimiter } from './rateLimit.js'

describe('TokenBucketLimiter (the in-memory RateLimiter)', () => {
  it('allows a burst up to its capacity per key, then refuses until tokens refill at the given rate', async () => {
    let now = 0
    const l = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, now: () => now })
    expect([await l.take('a'), await l.take('a'), await l.take('a'), await l.take('a')]).toEqual([true, true, true, false])
    expect(await l.take('b')).toBe(true)
    now += 1000
    expect([await l.take('a'), await l.take('a')]).toEqual([true, false])
    now += 60_000
    expect([await l.take('a'), await l.take('a'), await l.take('a'), await l.take('a')]).toEqual([true, true, true, false])
  })

  it('keeps its memory bounded: buckets that have refilled are forgotten when it grows', async () => {
    let now = 0
    const l = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, now: () => now, maxKeys: 10 })
    for (let i = 0; i < 10; i++) await l.take(`k${i}`)
    now += 5_000
    await l.take('new')
    expect(l.size).toBeLessThanOrEqual(2)
  })
})
