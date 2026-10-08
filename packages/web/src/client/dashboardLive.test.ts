// The dashboard's live script on fakes: a run page re-reads itself from the server when an event
// about its run arrives (and only then), swaps its live region in, and stops when the session ends.
import { describe, expect, it } from 'vitest'
import { startDashboardLive } from './dashboardLive.js'
import { FakeEventSource } from '../../test/fakeEventSource.js'

type Region = { innerHTML: string; getAttribute(n: string): string | null; querySelectorAll(): { open: boolean }[] }

function page(regions: Record<string, string>, attrs: Record<string, string> = {}, body: Record<string, string> = { 'data-live': '/dashboard/1094309218049937418/live' }) {
  const els: Region[] = Object.entries(regions).map(([name, html]) => ({
    innerHTML: html,
    getAttribute: (n: string) => (n === 'data-live-region' ? name : (attrs[n] ?? null)),
    querySelectorAll: () => [],
  }))
  const fetched: string[] = []
  let answer: { status: number; html: string } = { status: 200, html: '' }
  const timers: (() => void)[] = []
  const source = startDashboardLive({
    document: { body: { getAttribute: (n) => body[n] ?? null }, querySelectorAll: () => els },
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
  })
  const flush = async () => {
    while (timers.length) timers.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { els, fetched, source, flush, answer: (a: typeof answer) => (answer = a), events: FakeEventSource.last as FakeEventSource }
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
})
