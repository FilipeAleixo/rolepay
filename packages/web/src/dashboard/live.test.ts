// The dashboard's live stream (GET /dashboard/:guildId/live): who may open it, what it carries,
// heartbeats, the cap on open streams, and that a closed stream leaves nothing subscribed.
import { afterEach, describe, expect, it } from 'vitest'
import { GUILD, MEMBER, OTHER_GUILD, OUTSIDER, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'
import { sseReader } from '../../test/sse.js'

const ALICE = { id: '200000000000000011', address: '0x1111111111111111111111111111111111111111' }
const open: { cancel: () => Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.cancel().catch(() => {})))
})

async function seeded(live: Parameters<typeof dashboardHarness>[0] = {}) {
  const h = dashboardHarness({ live: { heartbeatMs: 40, ...live.live } })
  await h.community()
  h.members.set(GUILD, ALICE.id, [], 'Alice')
  await h.payee(ALICE.id, ALICE.address)
  await h.activeKey()
  return h
}

const stream = async (res: Response) => {
  const r = sseReader(res)
  open.push(r)
  await r.read((t) => t.includes('retry:'))
  return r
}

describe('GET /dashboard/:guildId/live', () => {
  it('needs a signed-in session: a browser without one gets the sign-in page, not a stream', async () => {
    const h = await seeded()
    const res = await h.browser().get(`/dashboard/${GUILD}/live`)
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(h.feed.size).toBe(0)
  })

  it('refuses a community the member is not in, and one that does not use Rolepay, the same way', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(OUTSIDER))
    expect((await browser.get(`/dashboard/${GUILD}/live`)).status).toBe(403)
    const member = (await h.signIn(identity(MEMBER))).browser
    expect((await member.get(`/dashboard/${OTHER_GUILD}/live`)).status).toBe(403)
    expect((await member.get('/dashboard/not-a-guild/live')).status).toBe(404)
    expect(h.feed.size).toBe(0)
  })

  it("streams that community's events as they happen: type and IDs only, with the audit sequence as the event ID", async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/live`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
    const r = await stream(res)
    expect(r.text.startsWith('retry: 5000\n\n')).toBe(true)

    const run = await h.run([[ALICE.id, '1']], { note: 'secret note <b>' })
    await r.read((t) => t.includes('run.paid'))
    const events = r.events()
    expect(events.map((e) => (e.data as { type: string }).type)).toEqual(['run.created', 'run.submitted', 'run.approved', 'run.executing', 'run.paid'])
    expect(events.every((e) => e.event === 'audit' && (e.data as { runId: string }).runId === run.id)).toBe(true)
    expect(events.map((e) => Number(e.id))).toEqual(events.map((e) => (e.data as { seq: number }).seq))
    // Nothing anyone wrote, nobody's ID, no amounts.
    expect(r.text).not.toContain('secret')
    expect(r.text).not.toContain(TREASURER.id)
    expect(Object.keys(events[0]?.data as object).sort()).toEqual(['policyId', 'policyRunId', 'runId', 'seq', 'type'])
  })

  it("carries no other community's events", async () => {
    const h = await seeded()
    await h.rolepay.communities.register({ guildId: OTHER_GUILD, name: 'Other', treasuryAddress: '0x9999999999999999999999999999999999999998', payoutToken: '0x20c0000000000000000000000000000000000001', feeMode: 'sponsor' })
    h.members.set(OTHER_GUILD, MEMBER.id, [], 'Felix')
    const { browser } = await h.signIn(identity(MEMBER))
    const r = await stream(await browser.get(`/dashboard/${OTHER_GUILD}/live`))
    await h.run([[ALICE.id, '1']])
    await r.read((t) => t.includes('event:'), 150)
    expect(r.events()).toEqual([])
  })

  it('replays what a reconnecting page missed after its Last-Event-ID', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    await h.run([[ALICE.id, '1']])
    const all = await h.rolepay.audit.list({ guildId: GUILD })
    const approved = all.ok ? (all.value.events.find((e) => e.type === 'run.approved')?.seq ?? 0) : 0
    const r = await stream(await browser.request(`/dashboard/${GUILD}/live`, { headers: { 'last-event-id': String(approved) } }))
    await r.read((t) => t.includes('run.paid'))
    expect(r.events().map((e) => (e.data as { type: string }).type)).toEqual(['run.executing', 'run.paid'])
  })

  it('sends a heartbeat comment so the proxy never sees an idle connection', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    const r = await stream(await browser.get(`/dashboard/${GUILD}/live`))
    await r.read((t) => (t.match(/^: ping$/gm) ?? []).length >= 2, 1_000)
    expect((r.text.match(/^: ping$/gm) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('ends the stream at the next heartbeat once the member has left the guild', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    const r = await stream(await browser.get(`/dashboard/${GUILD}/live`))
    h.members.remove(GUILD, MEMBER.id)
    h.clock.advance(120) // past the member cache
    await r.read(() => false, 500)
    expect(r.done).toBe(true)
    expect(h.feed.size).toBe(0)
  })

  it('caps open streams per signed-in person (429), and gives a slot back when a stream closes', async () => {
    const h = await seeded({ live: { perSession: 2 } })
    const { browser } = await h.signIn(identity(MEMBER))
    const first = await stream(await browser.get(`/dashboard/${GUILD}/live`))
    await stream(await browser.get(`/dashboard/${GUILD}/live`))
    const third = await browser.get(`/dashboard/${GUILD}/live`)
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({ ok: false, error: { code: 'too_many_streams' } })
    await first.cancel()
    expect((await browser.get(`/dashboard/${GUILD}/live`)).status).toBe(200)
  })

  it('caps open streams per client address, across people', async () => {
    const h = await seeded({ live: { perClient: 1 } })
    const member = (await h.signIn(identity(MEMBER))).browser
    const treasurer = (await h.signIn(identity(TREASURER))).browser
    await stream(await member.request(`/dashboard/${GUILD}/live`, { headers: { 'x-forwarded-for': '203.0.113.7' } }))
    expect((await treasurer.request(`/dashboard/${GUILD}/live`, { headers: { 'x-forwarded-for': '203.0.113.7' } })).status).toBe(429)
    expect((await treasurer.request(`/dashboard/${GUILD}/live`, { headers: { 'x-forwarded-for': '198.51.100.2' } })).status).toBe(200)
  })

  it('unsubscribes when the browser goes away', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    const r = await stream(await browser.get(`/dashboard/${GUILD}/live`))
    expect(h.feed.size).toBe(1)
    await r.cancel()
    expect(h.feed.size).toBe(0)
  })

  it('needs no change to the Content-Security-Policy: same origin, so connect-src self covers it', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    const page = await browser.get(`/dashboard/${GUILD}`)
    const res = await browser.get(`/dashboard/${GUILD}/live`)
    open.push(sseReader(res))
    expect(res.headers.get('content-security-policy')).toBe(page.headers.get('content-security-policy'))
  })
})
