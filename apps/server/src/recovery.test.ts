import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRecovery } from './recovery.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('startRecovery', () => {
  it('sweeps at once, then every interval, until stopped', async () => {
    let sweeps = 0
    const loop = startRecovery({
      recover: async () => {
        sweeps++
        return []
      },
      intervalMs: 30_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sweeps).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sweeps).toBe(3)
    await loop.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sweeps).toBe(3)
  })

  it('never runs two sweeps at once', async () => {
    let running = 0
    let peak = 0
    const loop = startRecovery({
      recover: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 45_000)) // slower than the interval
        running--
        return []
      },
      intervalMs: 30_000,
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(peak).toBe(1)
    const stopped = loop.stop() // waits for the sweep in flight
    await vi.advanceTimersByTimeAsync(45_000)
    await stopped
  })

  it('reports what it reconciled and keeps going after an error', async () => {
    const results: unknown[] = []
    const errors: unknown[] = []
    let n = 0
    const loop = startRecovery({
      recover: async () => {
        n++
        if (n === 1) throw new Error('rpc down')
        return [{ runId: 'run_1', status: 'paid' as const }]
      },
      intervalMs: 30_000,
      onResult: (r) => results.push(...r),
      onError: (e) => errors.push(e),
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(errors).toHaveLength(1)
    expect(results).toEqual([{ runId: 'run_1', status: 'paid' }])
    await loop.stop()
  })
})
