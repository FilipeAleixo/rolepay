// The account page, live: GET /account/live (server-sent events, payments to the passkey session's
// own address only) and GET /account/received (the Received list, rendered on the server).
import { afterEach, describe, expect, it } from 'vitest'
import { ALICE, DEV_TREASURY, GUILD, OTHER_PASSKEY, PASSKEY, TOKEN, TREASURER, claimLink, registeredCommunity, webHarness } from '../../test/harness.js'
import { sseReader } from '../../test/sse.js'

const BOB = '200000000000000002'
const open: { cancel: () => Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.cancel().catch(() => {})))
})

/** A community paying from DEV_TREASURY, Alice registered with PASSKEY and Bob with OTHER_PASSKEY. */
async function world(opts: Parameters<typeof webHarness>[0] = {}) {
  const h = webHarness({ live: { heartbeatMs: 40 }, ...opts })
  await registeredCommunity(h, DEV_TREASURY, { name: 'Mods <guild>' })
  await h.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: 100_000_000n, periodSeconds: 2_592_000, expiresAt: h.chain.time + 30 * 86_400 })
  const auth = await h.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: h.chain.rootSigner(DEV_TREASURY) })
  if (!auth.ok) throw new Error(auth.error.code)
  h.chain.fund(TOKEN, DEV_TREASURY, 1_000_000_000n)
  for (const [user, address] of [
    [ALICE, PASSKEY],
    [BOB, OTHER_PASSKEY],
  ] as const) {
    const r = await h.rolepay.payees.register({ token: await claimLink(h, user), address })
    if (!r.ok) throw new Error(r.error.code)
  }
  const pay = async () => {
    const created = await h.rolepay.payRuns.create({
      guildId: GUILD,
      createdBy: TREASURER,
      note: null,
      lines: [
        { discordUserId: BOB, amount: 2_500_000n },
        { discordUserId: ALICE, amount: 1_000_000n },
      ],
    })
    if (!created.ok) throw new Error(created.error.code)
    await h.rolepay.payRuns.submit({ guildId: GUILD, runId: created.value.id, actor: TREASURER })
    await h.rolepay.payRuns.approve({ guildId: GUILD, runId: created.value.id, actor: TREASURER, actorCanApprove: true })
    const paid = await h.rolepay.payRuns.execute({ guildId: GUILD, runId: created.value.id })
    if (!paid.ok) throw new Error(paid.error.code)
    return created.value.id
  }
  return { ...h, pay }
}

const stream = async (res: Response) => {
  const r = sseReader(res)
  open.push(r)
  await r.read((t) => t.includes('retry:'))
  return r
}

describe('GET /account/live', () => {
  it('needs a passkey session', async () => {
    const h = await world()
    const res = await h.send('/account/live')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'no_passkey_session' } })
    expect(h.feed.size).toBe(0)
  })

  it("carries only the payments to the session's own address: amount, token, community, run, line and transaction", async () => {
    const h = await world()
    const alice = await stream(await h.send('/account/live', { passkey: PASSKEY }))
    const bob = await stream(await h.send('/account/live', { passkey: OTHER_PASSKEY }))
    const runId = await h.pay()
    await alice.read((t) => t.includes('event: payment'))
    await bob.read((t) => t.includes('event: payment'))

    const [mine] = alice.events()
    expect(alice.events()).toHaveLength(1)
    expect(mine).toMatchObject({
      event: 'payment',
      data: {
        key: `${runId}:2`,
        amount: '1',
        amountMicros: '1000000',
        token: 'AlphaUSD',
        tokenAddress: TOKEN,
        communityName: 'Mods <guild>',
        guildId: GUILD,
        runId,
        line: 2,
        txUrl: expect.stringMatching(/^https:\/\/explore\.testnet\.tempo\.xyz\/tx\/0x[0-9a-f]{64}$/),
      },
    })
    // Nothing about Bob's line on Alice's stream, and the reverse.
    expect(alice.text).not.toContain('2.5')
    expect(alice.text).not.toContain(OTHER_PASSKEY)
    expect(bob.events().map((e) => (e.data as { line: number }).line)).toEqual([1])
  })

  it('sends heartbeats, and ends once the session is gone', async () => {
    const h = await world()
    let signedIn = true
    const sessions = h.sessions
    const current = sessions.current.bind(sessions)
    sessions.current = async (req) => (signedIn ? current(req) : null)
    const r = await stream(await h.send('/account/live', { passkey: PASSKEY }))
    await r.read((t) => t.includes(': ping'), 1_000)
    expect(r.text).toContain(': ping\n\n')
    signedIn = false
    await r.read(() => false, 300)
    expect(r.done).toBe(true)
    expect(h.feed.size).toBe(0)
  })

  it('caps open streams per passkey session, and unsubscribes when the browser leaves', async () => {
    const h = await world({ live: { heartbeatMs: 40, perSession: 1 } })
    const first = await stream(await h.send('/account/live', { passkey: PASSKEY }))
    expect(h.feed.size).toBe(1)
    expect((await h.send('/account/live', { passkey: PASSKEY })).status).toBe(429)
    await first.cancel()
    expect(h.feed.size).toBe(0)
    expect((await h.send('/account/live', { passkey: PASSKEY })).status).toBe(200)
  })
})

describe('GET /account/received', () => {
  it("lists what the session's own address received, newest first, escaped, with the explorer link", async () => {
    const h = await world()
    const first = await h.pay()
    h.clock.advance(60)
    const second = await h.pay()
    const res = await h.send('/account/received', { passkey: PASSKEY })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html.indexOf(`data-key="${second}:2"`)).toBeLessThan(html.indexOf(`data-key="${first}:2"`))
    expect(html).toContain('<strong>+1 AlphaUSD</strong>')
    expect(html).toContain(`from Mods &lt;guild&gt; · pay run ${second}, line 2`)
    expect(html).not.toContain('<guild>')
    expect(html).toMatch(/href="https:\/\/explore\.testnet\.tempo\.xyz\/tx\/0x[0-9a-f]{64}" target="_blank" rel="noreferrer">View on explorer<\/a>/)
    expect(html).not.toContain(':1"') // Bob's lines are not Alice's business
  })

  it('needs a passkey session, and says so in words', async () => {
    const h = await world()
    await h.pay()
    const res = await h.send('/account/received')
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('<li class="none">Sign in with your passkey to see what you received.</li>')
  })

  it('says when nothing has arrived yet', async () => {
    const h = await world()
    expect(await (await h.send('/account/received', { passkey: PASSKEY })).text()).toContain('Nothing received yet')
  })
})
