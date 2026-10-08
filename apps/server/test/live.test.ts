// The live pages in process: a run approved in Discord and paid on the fake chain reaches the
// dashboard's stream of that community and the payee's account stream, through the real wiring
// (interactions, the execution queue, core's audit trail and live feed, the web routes).
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { buttonClick, slashCommand } from '@rolepay/discord/testing'
import { FakeDiscordOAuth } from '@rolepay/web/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TREASURY, testServer } from './support.js'

const CHANNEL = '700000000000000001'
const SCOPE = { guildId: GUILD, channelId: CHANNEL }
const TREASURER_ROLE = '400000000000000001'
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE] }
const ADMIN = { userId: '300000000000000001', manageGuild: true, roles: [TREASURER_ROLE] }
const FELIX = '200000000000000005'
const ALICE = '200000000000000001'
const BOB = '200000000000000002'
const ADDR = { alice: '0x1111111111111111111111111111111111111111', bob: '0x2222222222222222222222222222222222222222' }

/** Reads a server-sent event stream until `until` holds (or two seconds pass), and the events in it. */
function sse(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ''
  return {
    async read(until: (t: string) => boolean) {
      const deadline = Date.now() + 2_000
      while (!until(text) && Date.now() < deadline) {
        const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 50))])
        if (next?.done) break
        if (next) text += decoder.decode(next.value, { stream: true })
      }
      return text
    },
    events: () =>
      text
        .split('\n\n')
        .filter((b) => b.startsWith('event: '))
        .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? 'null') as Record<string, unknown> })),
    cancel: () => reader.cancel(),
  }
}

describe('live pages, in process', () => {
  it('a run approved in Discord and paid reaches the dashboard stream and the payee account stream', async () => {
    const oauth = new FakeDiscordOAuth()
    const s = await testServer({ dashboard: { oauth } })
    s.rest.guilds.set(GUILD, 'Mods <guild>') // /rolepay setup reads the community's name from Discord
    await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { treasury: TREASURY, approver_role: TREASURER_ROLE }, ADMIN, 'tok-setup'))
    await s.drain()
    expect((await s.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: s.chain.rootSigner(TREASURY) })).ok).toBe(true)
    for (const [user, address] of [
      [ALICE, ADDR.alice],
      [BOB, ADDR.bob],
    ] as const) {
      const reply = (await (await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: user }))).json()) as { data: { content: string } }
      const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(reply.data.content)?.[1] as string
      expect((await s.browserPost(url, address)).status).toBe(200)
    }

    // Felix (a member, read only) watches the dashboard; Alice has her account page open.
    s.rest.setMember(GUILD, FELIX, [], null, 'Felix')
    oauth.signInAs({ user: { id: FELIX, name: 'felix_k' }, guilds: [{ id: GUILD, name: 'Test guild' }] })
    const start = await s.app.request('https://rolepay.test/auth/discord')
    const state = start.headers.getSetCookie()[0]?.split(';')[0] as string
    const back = new URL(start.headers.get('location') as string)
    const signedIn = await s.app.request(`https://rolepay.test${back.pathname}${back.search}`, { headers: { cookie: state } })
    const felix = signedIn.headers.getSetCookie().find((c) => c.startsWith('__Host-rolepay_session='))?.split(';')[0] as string
    const dashboard = sse(await s.app.request(`https://rolepay.test/dashboard/${GUILD}/live`, { headers: { cookie: felix } }))
    const alice = sse(await s.app.request('https://rolepay.test/account/live', { headers: { cookie: s.sessions.cookieFor(ADDR.alice) } }))
    await Promise.all([dashboard.read((t) => t.includes('retry:')), alice.read((t) => t.includes('retry:'))])

    await s.interact(slashCommand(SCOPE, 'rolepay', 'new', { amount: '1', users: `<@${ALICE}> <@${BOB}>=2`, note: 'October' }, ADMIN, 'tok-new'))
    await s.drain()
    const runId = /rolepay:approve:([^"]+)"/.exec(JSON.stringify(s.rest.lastEdit('tok-new')))?.[1] as string
    await s.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, TREASURER, 'tok-approve'))
    await s.drain()

    await dashboard.read((t) => t.includes('run.paid'))
    expect(dashboard.events().map((e) => [e.data.type, e.data.runId])).toEqual([
      ['run.created', runId],
      ['run.submitted', runId],
      ['run.approved', runId],
      ['run.executing', runId],
      ['run.paid', runId],
    ])
    await alice.read((t) => t.includes('event: payment'))
    expect(alice.events()).toEqual([
      {
        event: 'payment',
        data: expect.objectContaining({ runId, line: 1, amount: '1', token: 'AlphaUSD', communityName: 'Mods <guild>', txUrl: expect.stringMatching(/^https:\/\/explore\.testnet\.tempo\.xyz\/tx\/0x[0-9a-f]{64}$/) }),
      },
    ])
    expect(JSON.stringify(alice.events())).not.toContain(ADDR.bob)

    // The account's Received list shows it, rendered by the server.
    const received = await (await s.app.request('https://rolepay.test/account/received', { headers: { cookie: s.sessions.cookieFor(ADDR.alice) } })).text()
    expect(received).toContain(`<strong>+1 AlphaUSD</strong><span> · from Mods &lt;guild&gt; · pay run ${runId}, line 1`)
    expect(received).toContain(`pay run ${runId}, line 1`)
    await Promise.all([dashboard.cancel(), alice.cancel()])
  })

  it('over a real HTTP server: the stream arrives as it is written, and a client that hangs up is unsubscribed', async () => {
    const s = await testServer()
    const server = serve({ fetch: s.app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    try {
      const { port } = server.address() as AddressInfo
      const abort = new AbortController()
      const res = await fetch(`http://127.0.0.1:${port}/account/live`, { headers: { cookie: s.sessions.cookieFor(ADDR.alice) }, signal: abort.signal })
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
      const stream = sse(res)
      expect(await stream.read((t) => t.includes('retry:'))).toBe('retry: 5000\n\n') // not buffered until the end
      expect(s.feed.size).toBe(1)
      abort.abort()
      const deadline = Date.now() + 2_000
      while (s.feed.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(s.feed.size).toBe(0)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

