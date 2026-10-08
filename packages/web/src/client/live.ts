// Live updates in the browser: follow a server-sent event stream from this origin, re-read a page's
// live regions from the server, and count a number up. Shared by the dashboard script
// (/assets/live.js) and the account page. Everything still works without it.

/** The part of EventSource this code uses (a fake in tests). */
export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void
  close(): void
}
export type EventSourceFactory = new (url: string) => EventSourceLike

/**
 * Follows `url`: each named event's JSON data goes to its handler. The browser reconnects by itself
 * (the server's `retry:`); after a reconnect `onReconnect` runs once, so a page re-reads what it may
 * have missed while the connection was down.
 */
export function follow(url: string, handlers: Record<string, (data: unknown) => void>, opts: { EventSource: EventSourceFactory; onReconnect?: () => void }): EventSourceLike {
  const source = new opts.EventSource(url)
  for (const [name, handle] of Object.entries(handlers)) {
    source.addEventListener(name, (e) => {
      let data: unknown = null
      try {
        data = JSON.parse(e.data ?? 'null')
      } catch {
        return
      }
      handle(data)
    })
  }
  let opened = false
  source.addEventListener('open', () => {
    if (opened) opts.onReconnect?.()
    opened = true
  })
  return source
}

/** A region of the page the server renders (`data-live-region`) and the page re-reads. */
export type RegionLike = {
  innerHTML: string
  getAttribute(name: string): string | null
  querySelectorAll(selector: string): ArrayLike<{ open: boolean }>
}

/**
 * Replaces each live region's content with the same region of a freshly rendered copy of the page
 * (all HTML comes from the server, escaped there). Disclosures a person opened stay open.
 */
export function swapRegions(regions: ArrayLike<RegionLike>, fresh: { querySelector(selector: string): { innerHTML: string } | null }): number {
  let swapped = 0
  for (const region of Array.from(regions)) {
    const name = region.getAttribute('data-live-region')
    const next = name ? fresh.querySelector(`[data-live-region="${name}"]`) : null
    if (!next || next.innerHTML === region.innerHTML) continue
    const open = Array.from(region.querySelectorAll('details')).map((d) => d.open)
    region.innerHTML = next.innerHTML
    Array.from(region.querySelectorAll('details')).forEach((d, i) => {
      if (open[i]) d.open = true
    })
    swapped++
  }
  return swapped
}

/** Runs `work` at most once at a time; a call while it runs schedules exactly one more run after it. Calls within `delayMs` are merged. */
export function coalesce(work: () => Promise<void>, delayMs: number, timer: (fn: () => void, ms: number) => unknown = setTimeout): () => void {
  let waiting = false
  let running = false
  let again = false
  const run = async () => {
    waiting = false
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await work()
    } catch {
      // the next event tries again
    } finally {
      running = false
      if (again) {
        again = false
        schedule()
      }
    }
  }
  function schedule() {
    if (waiting) return
    waiting = true
    timer(() => void run(), delayMs)
  }
  return schedule
}

/** `from` to `to` at `t` (0 to 1), in whole micro-units. */
export function between(from: bigint, to: bigint, t: number): bigint {
  const k = BigInt(Math.round(Math.min(1, Math.max(0, t)) * 1000))
  return from + ((to - from) * k) / 1000n
}

const easeOut = (t: number) => 1 - (1 - t) ** 3

/**
 * Counts `el`'s text from `from` to `to` over about a second, easing out. With reduced motion
 * (`prefers-reduced-motion`) it just shows the new value. Resolves when the final value shows.
 */
export function countUp(
  el: { textContent: string | null },
  from: bigint,
  to: bigint,
  opts: { format: (micros: bigint) => string; reducedMotion: boolean; frame: (step: (now: number) => void) => void; durationMs?: number },
): Promise<void> {
  if (opts.reducedMotion || from === to) {
    el.textContent = opts.format(to)
    return Promise.resolve()
  }
  const duration = opts.durationMs ?? 1_000
  return new Promise((resolve) => {
    let start: number | null = null
    const step = (now: number) => {
      start ??= now
      const t = Math.min(1, (now - start) / duration)
      el.textContent = opts.format(t >= 1 ? to : between(from, to, easeOut(t)))
      if (t < 1) opts.frame(step)
      else resolve()
    }
    opts.frame(step)
  })
}

/** Whether the person asked for less motion. */
export const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The next animation frame (a timer where there is none). */
export const nextFrame = (step: (now: number) => void) => {
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(step)
  else setTimeout(() => step(Date.now()), 16)
}
