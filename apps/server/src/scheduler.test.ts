import type { SchedulerEvent, TickReport } from '@rolepay/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from './scheduler.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const event = { kind: 'generated' } as unknown as SchedulerEvent

describe('startScheduler', () => {
  it('ticks at once and then every interval, announcing what each tick did, until stopped', async () => {
    let ticks = 0
    const announced: SchedulerEvent[][] = []
    const loop = startScheduler({
      tick: async (): Promise<TickReport> => {
        ticks++
        return { events: ticks === 2 ? [event] : [], errors: [] }
      },
      announce: async (events) => void announced.push([...events]),
      intervalMs: 30_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(ticks).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ticks).toBe(2)
    expect(announced).toEqual([[], [event]])
    await loop.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ticks).toBe(2)
  })

  it('never runs two ticks at once, and reports what failed without stopping', async () => {
    let running = 0
    let peak = 0
    const reports: TickReport[] = []
    const errors: unknown[] = []
    let n = 0
    const loop = startScheduler({
      tick: async () => {
        n++
        if (n === 1) throw new Error('database locked')
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 45_000))
        running--
        return { events: [], errors: [{ policyId: 'pol_1', policyRunId: null, error: 'cannot_read' }] }
      },
      announce: async () => {},
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
