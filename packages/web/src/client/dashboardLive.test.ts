// The dashboard's live script on fakes: a run page re-reads itself from the server when an event
// about its run arrives (and only then), swaps its live region in, and stops when the session ends.
import { describe, expect, it } from 'vitest'
import { countdownWords, startDashboardLive } from './dashboardLive.js'
import { FakeEventSource } from '../../test/fakeEventSource.js'

type Region = { innerHTML: string; textContent: string | null; getAttribute(n: string): string | null; querySelectorAll(): { open: boolean }[] }

function page(
  regions: Record<string, string>,
  attrs: Record<string, string> = {},
  body: Record<string, string> = { 'data-live': '/dashboard/1094309218049937418/live' },
  countdowns: Region[] = [],
) {
  const els: Region[] = Object.entries(regions).map(([name, html]) => ({
    innerHTML: html,
    textContent: null,
    getAttribute: (n: string) => (n === 'data-live-region' ? name : (attrs[n] ?? null)),
    querySelectorAll: () => [],
  }))
  const fetched: string[] = []
  let answer: { status: number; html: string } = { status: 200, html: '' }
  const timers: (() => void)[] = []
  const clock = { now: Date.parse('2026-10-06T12:00:00Z'), tick: () => {} }
  const source = startDashboardLive({
    document: { body: { getAttribute: (n) => body[n] ?? null }, querySelectorAll: (s) => (s === '[data-countdown]' ? countdowns : els) },
    EventSource: FakeEventSource,
    fetch: async (url) => {
      fetched.push(url)
      return { ok: answer.status === 200, status: answer.status, text: async () => answer.html }
    },
    // The "parsed" fresh page: regions written as <div data-live-region="name">...</div> with no nesting.
    parse: (html) => ({
      querySelector: (s) => {
        const name = /\[data-live-region="(.+)"\]/.exec(s)?.[1]
        const m = name ? new RegExp(`<div data-live-region="${name}"[^>]*>(.*?)</div>`).exec(html) : null
        return m ? { innerHTML: m[1] ?? '' } : null
      },
    }),
    href: () => 'http://localhost/dashboard/1094309218049937418/runs/run_000003?done=approved',
    setTimeout: (fn) => timers.push(fn),
    setInterval: (fn) => {
      clock.tick = fn
    },
    now: () => clock.now,
  })
  const flush = async () => {
    while (timers.length) timers.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { els, fetched, source, flush, clock, answer: (a: typeof answer) => (answer = a), events: FakeEventSource.last as FakeEventSource }
}

describe('the dashboard live script', () => {
  it('on a run page, patches the status and timeline when that run moves: approved, executing, paid', async () => {
    const p = page({ run: '<h1>Run run_000003 <span class="pill">pending approval</span></h1>' }, { 'data-live-run': 'run_000003' })
    expect(p.events.url).toBe('/dashboard/1094309218049937418/live')
    p.answer({ status: 200, html: '<div data-live-region="run" data-live-run="run_000003"><h1>Run run_000003 <span class="pill">paid</span></h1><a href="https://explore/tx/0xabc">tx</a></div>' })
    p.events.emit('audit', { type: 'run.approved', runId: 'run_000003' })
    p.events.emit('audit', { type: 'run.executing', runId: 'run_000003' })
    p.events.emit('audit', { type: 'run.paid', runId: 'run_000003' })
    await p.flush()
    // One re-read for the burst, of the page's own URL (its query kept).
    expect(p.fetched).toEqual(['http://localhost/dashboard/1094309218049937418/runs/run_000003?done=approved'])
    expect(p.els[0]?.innerHTML).toBe('<h1>Run run_000003 <span class="pill">paid</span></h1><a href="https://explore/tx/0xabc">tx</a>')
  })

  it("ignores another run's events on a run page", async () => {
    const p = page({ run: 'pending' }, { 'data-live-run': 'run_000003' })
    p.events.emit('audit', { type: 'run.paid', runId: 'run_000009' })
    await p.flush()
    expect(p.fetched).toEqual([])
  })

  it("re-reads the Overview's panels on any event of the community, and after a reconnect", async () => {
    const p = page({ glance: 'old bar', cards: 'old cards' })
    p.answer({ status: 200, html: '<div data-live-region="glance">new bar</div><div data-live-region="cards">new cards</div>' })
    p.events.emit('open')
    p.events.emit('audit', { type: 'deposit.received', runId: null })
    await p.flush()
    expect(p.els.map((e) => e.innerHTML)).toEqual(['new bar', 'new cards'])
    p.events.emit('open') // the connection dropped and came back
    await p.flush()
    expect(p.fetched).toHaveLength(2)
  })

  it('stops listening once the session is over (the page answers 401 or 403), and leaves the page as it was', async () => {
    const p = page({ glance: 'bar' })
    p.answer({ status: 401, html: '<h1>Sign in</h1>' })
    p.events.emit('audit', { type: 'run.paid', runId: 'run_1' })
    await p.flush()
    expect(p.events.closed).toBe(true)
    expect(p.els[0]?.innerHTML).toBe('bar')
  })

  it('does nothing on a page with nothing live, or without a stream', () => {
    FakeEventSource.last = null
    expect(page({}).source).toBeNull()
    expect(page({ glance: 'x' }, {}, {}).source).toBeNull()
    expect(FakeEventSource.last).toBeNull()
  })

  it("counts an autopilot run's veto window down each second, and re-reads the page when it runs out", async () => {
    const countdown: Region = { innerHTML: '', textContent: 'pays at 2026-10-06 12:01 UTC unless vetoed', getAttribute: (n) => (n === 'data-countdown' ? '2026-10-06T12:00:42.000Z' : null), querySelectorAll: () => [] }
    const p = page({ 'latest-run': 'pending' }, {}, undefined, [countdown])
    expect(countdown.textContent).toBe('pays in 0:42 unless vetoed')
    p.clock.now += 41_000
    p.clock.tick()
    expect(countdown.textContent).toBe('pays in 0:01 unless vetoed')
    expect(p.fetched).toEqual([])
    p.answer({ status: 200, html: '<div data-live-region="latest-run">paid</div>' })
    p.clock.now += 1_000
    p.clock.tick()
    p.clock.tick() // once per window, not every second after
    expect(countdown.textContent).toBe('veto window over: paying now')
    await p.flush()
    expect(p.fetched).toHaveLength(1)
    expect(p.els[0]?.innerHTML).toBe('paid')
  })

  it('words a countdown in minutes, or hours for a long window', () => {
    expect(countdownWords(42_000)).toBe('pays in 0:42 unless vetoed')
    expect(countdownWords(41_001)).toBe('pays in 0:42 unless vetoed')
    expect(countdownWords(3_903_000)).toBe('pays in 1:05:03 unless vetoed')
    expect(countdownWords(0)).toBe('veto window over: paying now')
  })
})

