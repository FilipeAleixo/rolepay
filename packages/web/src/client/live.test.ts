// The live helpers on fakes: the count-up (and its reduced-motion path), following a stream through
// a reconnect, swapping regions, and merging bursts of events into one re-read.
import { describe, expect, it } from 'vitest'
import { FakeEventSource } from '../../test/fakeEventSource.js'
import { between, coalesce, countUp, follow, swapRegions } from './live.js'

const format = (m: bigint) => m.toString()

describe('countUp', () => {
  it('counts from the old value to the new one over the duration, frame by frame, ending exactly on the new value', async () => {
    const el = { textContent: '1000000' as string | null }
    const frames: ((now: number) => void)[] = []
    const done = countUp(el, 1_000_000n, 2_000_000n, { format, reducedMotion: false, frame: (f) => frames.push(f), durationMs: 1_000 })
    const seen: string[] = []
    for (const now of [0, 250, 500, 600, 1_000]) {
      frames.shift()?.(now)
      seen.push(el.textContent ?? '')
    }
    await done
    expect(seen[0]).toBe('1000000')
    expect(seen.map(BigInt)).toEqual([...seen.map(BigInt)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) // never goes back
    expect(BigInt(seen[1] ?? 0) > 1_000_000n && BigInt(seen[3] ?? 0) < 2_000_000n).toBe(true)
    expect(el.textContent).toBe('2000000')
    expect(frames).toEqual([])
  })

  it('with reduced motion, just shows the new value: no frames, no animation', async () => {
    const el = { textContent: '1' as string | null }
    const frames: unknown[] = []
    await countUp(el, 1n, 5_000_000n, { format, reducedMotion: true, frame: (f) => frames.push(f) })
    expect(el.textContent).toBe('5000000')
    expect(frames).toEqual([])
  })

  it('interpolates whole micro-units, never floats', () => {
    expect(between(0n, 999_995_000_000n, 0.5)).toBe(499_997_500_000n)
    expect(between(5n, 1n, 1)).toBe(1n)
    expect(between(1n, 3n, 2)).toBe(3n)
  })
})

describe('follow', () => {
  it('hands each named event its JSON, skips garbage, and re-reads after a reconnect but not on the first open', () => {
    const got: unknown[] = []
    let reconnects = 0
    follow('/x/live', { audit: (d) => got.push(d) }, { EventSource: FakeEventSource, onReconnect: () => reconnects++ })
    const source = FakeEventSource.last as FakeEventSource
    expect(source.url).toBe('/x/live')
    source.emit('open')
    source.emit('audit', { type: 'run.paid' })
    source.emit('audit', 'not json')
    source.emit('other', { type: 'nope' })
    expect(got).toEqual([{ type: 'run.paid' }])
    expect(reconnects).toBe(0)
    source.emit('open')
    expect(reconnects).toBe(1)
  })
})

describe('swapRegions', () => {
  const region = (name: string, html: string, details: { open: boolean }[] = []) => ({
    innerHTML: html,
    details,
    getAttribute: (n: string) => (n === 'data-live-region' ? name : null),
    querySelectorAll(this: { details: { open: boolean }[]; innerHTML: string }) {
      return this.details
    },
  })

  it('replaces each region with the same region of the fresh page, keeps opened disclosures open, and leaves the rest alone', () => {
    const glance = region('glance', 'old <details>', [{ open: true }])
    const cards = region('cards', 'same')
    const fresh = { querySelector: (s: string) => (s === '[data-live-region="glance"]' ? { innerHTML: 'new <details>' } : s === '[data-live-region="cards"]' ? { innerHTML: 'same' } : null) }
    // The fresh details are closed until the swap carries the open state over.
    glance.querySelectorAll = function () {
      return this.innerHTML.startsWith('new') ? (this.details = [{ open: false }]) : this.details
    }
    expect(swapRegions([glance, cards, region('gone', 'x')], fresh)).toBe(1)
    expect(glance.innerHTML).toBe('new <details>')
    expect(glance.details[0]?.open).toBe(true)
    expect(cards.innerHTML).toBe('same')
  })
})

describe('coalesce', () => {
  it('merges a burst into one run, and runs once more when asked during a run', async () => {
    const timers: (() => void)[] = []
    let runs = 0
    let release: () => void = () => {}
    const schedule = coalesce(
      () => {
        runs++
        return new Promise<void>((r) => {
          release = r
        })
      },
      250,
      (fn) => timers.push(fn),
    )
    schedule()
    schedule()
    schedule()
    expect(timers).toHaveLength(1)
    timers.shift()?.()
    expect(runs).toBe(1)
    schedule() // while the first run is in flight
    timers.shift()?.()
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(timers).toHaveLength(1)
    timers.shift()?.()
    expect(runs).toBe(2)
  })
})
