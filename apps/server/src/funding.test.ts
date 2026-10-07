import type { ScanReport } from '@rolepay/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startFundingWatcher } from './funding.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const deposit = { sourceId: 'fsrc_1', amount: 5_000_000n } as unknown as ScanReport['deposits'][number]

describe('startFundingWatcher', () => {
  it('scans at once and then every interval, reporting only ticks that found something, until stopped', async () => {
    let scans = 0
    const reports: ScanReport[] = []
    const loop = startFundingWatcher({
      scan: async () => {
        scans++
        return { deposits: scans === 2 ? [deposit] : [], errors: [] }
      },
      intervalMs: 30_000,
      onReport: (r) => reports.push(r),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(scans).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(scans).toBe(2)
    expect(reports).toEqual([{ deposits: [deposit], errors: [] }])
    await loop.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scans).toBe(2)
  })

  it('never runs two scans at once, reports a range it could not read, and keeps going after a failure', async () => {
    let running = 0
    let peak = 0
    let n = 0
    const reports: ScanReport[] = []
    const errors: unknown[] = []
    const loop = startFundingWatcher({
      scan: async () => {
        n++
        if (n === 1) throw new Error('database locked')
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 45_000))
        running--
        return { deposits: [], errors: [{ communityId: '1094309218049937418', error: 'fetch failed' }] }
      },
      intervalMs: 30_000,
      onReport: (r) => reports.push(r),
      onError: (e) => errors.push(e),
    })
    await vi.advanceTimersByTimeAsync(150_000)
    expect(errors).toHaveLength(1)
    expect(peak).toBe(1)
    expect(reports.length).toBeGreaterThan(0)
    const stopped = loop.stop()
    await vi.advanceTimersByTimeAsync(45_000)
    await stopped
  })
})
