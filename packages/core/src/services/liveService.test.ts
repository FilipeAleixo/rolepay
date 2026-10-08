import { describe, expect, it } from 'vitest'
import { InProcessLiveFeed } from '../adapters/live/inProcessLiveFeed.js'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { createMemoryRepositories } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import { createRolepay } from '../index.js'
import type { LiveEvent, ReceivedPayment } from './liveService.js'

const GUILD = '1094309218049937418'
const OTHER_GUILD = '1094309218049937419'
const ALICE = '200000000000000001'
const BOB = '200000000000000002'
const TREASURER = '300000000000000001'
const TREASURY = '0x9999999999999999999999999999999999999999'
const OTHER_TREASURY = '0x9999999999999999999999999999999999999998'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const ADDR = { alice: '0x1111111111111111111111111111111111111111', bob: '0x2222222222222222222222222222222222222222' } as const

async function world(opts: { live?: boolean } = {}) {
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const repos = createMemoryRepositories()
  const feed = new InProcessLiveFeed()
  const rolepay = createRolepay({ chain, repositories: repos, vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato', ...(opts.live === false ? {} : { live: feed }) })
  for (const [guildId, name, treasury] of [
    [GUILD, 'Mods', TREASURY],
    [OTHER_GUILD, 'Other', OTHER_TREASURY],
  ] as const) {
    await rolepay.communities.register({ guildId, name, treasuryAddress: treasury, payoutToken: TOKEN, feeMode: 'sponsor' })
    await rolepay.communities.provisionBotKey({ guildId, limit: 100_000_000n, periodSeconds: 2_592_000, expiresAt: chain.time + 30 * 86_400 })
    const auth = await rolepay.communities.authorizeBotKey({ guildId, root: chain.rootSigner(treasury) })
    if (!auth.ok) throw new Error(auth.error.code)
    chain.fund(TOKEN, treasury, 100_000_000n)
    for (const [user, address] of [
      [ALICE, ADDR.alice],
      [BOB, ADDR.bob],
    ] as const) {
      const now = clock.now()
      await repos.payees.upsert({ communityId: guildId, discordUserId: user, address, addressKind: 'passkey', preferredToken: null, registeredAt: now, updatedAt: now })
    }
  }
  /** Creates, submits, approves and executes a run paying Alice 1.5 and Bob 2. */
  const payRun = async (guildId = GUILD) => {
    const created = await rolepay.payRuns.create({
      guildId,
      createdBy: ALICE,
      note: 'October',
      lines: [
        { discordUserId: ALICE, amount: 1_500_000n },
        { discordUserId: BOB, amount: 2_000_000n },
      ],
    })
    if (!created.ok) throw new Error(created.error.code)
    const runId = created.value.id
    await rolepay.payRuns.submit({ guildId, runId, actor: ALICE })
    await rolepay.payRuns.approve({ guildId, runId, actor: TREASURER, actorCanApprove: true })
    const paid = await rolepay.payRuns.execute({ guildId, runId })
    if (!paid.ok) throw new Error(paid.error.code)
    return runId
  }
  return { rolepay, feed, clock, payRun }
}

/** Lets the payment listener's reads (the run, the community) finish. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('LiveService: a community feed', () => {
  it('publishes every audit event as it is appended, content-free, to that community only', async () => {
    const w = await world()
    const mine: LiveEvent[] = []
    const theirs: LiveEvent[] = []
    w.rolepay.live.community({ guildId: GUILD }, (e) => mine.push(e))
    w.rolepay.live.community({ guildId: OTHER_GUILD }, (e) => theirs.push(e))
    const runId = await w.payRun()

    expect(mine.map((e) => e.type)).toEqual(['run.created', 'run.submitted', 'run.approved', 'run.executing', 'run.paid'])
    expect(mine.every((e) => e.communityId === GUILD && e.runId === runId)).toBe(true)
    expect(theirs).toEqual([])
    // Only the event's identity: what changed and where. No actor, no details, nobody's words.
    expect(Object.keys(mine[0] as object).sort()).toEqual(['at', 'communityId', 'policyId', 'policyRunId', 'runId', 'seq', 'type'])
    const seqs = mine.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it('stops at unsubscribe, and leaves nothing subscribed behind', async () => {
    const w = await world()
    const seen: LiveEvent[] = []
    const stop = w.rolepay.live.community({ guildId: GUILD }, (e) => seen.push(e))
    expect(w.feed.size).toBe(1)
    stop()
    await w.payRun()
    expect(seen).toEqual([])
    expect(w.feed.size).toBe(0)
  })

  it('replays what a reconnecting page missed after a sequence number, oldest first, from that community only', async () => {
    const w = await world()
    const seen: LiveEvent[] = []
    w.rolepay.live.community({ guildId: GUILD }, (e) => seen.push(e))
    await w.payRun()
    await w.payRun(OTHER_GUILD)
    const approved = seen.find((e) => e.type === 'run.approved')?.seq ?? 0
    const missed = await w.rolepay.live.since({ guildId: GUILD, after: approved })
    expect(missed.map((e) => e.type)).toEqual(['run.executing', 'run.paid'])
    expect(await w.rolepay.live.since({ guildId: 'not a guild', after: 0 })).toEqual([])
  })

  it('is off without a feed: subscribing is harmless and nothing arrives', async () => {
    const w = await world({ live: false })
    expect(w.rolepay.live.enabled).toBe(false)
    const seen: LiveEvent[] = []
    const stop = w.rolepay.live.community({ guildId: GUILD }, (e) => seen.push(e))
    await w.payRun()
    stop()
    expect(seen).toEqual([])
  })
})

describe('LiveService: payments to one address', () => {
  it('tells an address only about the lines that paid it: amount, token, run, line, transaction and community', async () => {
    const w = await world()
    const alice: ReceivedPayment[] = []
    const bob: ReceivedPayment[] = []
    const stranger: ReceivedPayment[] = []
    w.rolepay.live.payments({ address: ADDR.alice.toUpperCase().replace('0X', '0x') }, (p) => alice.push(p))
    w.rolepay.live.payments({ address: ADDR.bob }, (p) => bob.push(p))
    w.rolepay.live.payments({ address: '0x5555555555555555555555555555555555555555' }, (p) => stranger.push(p))
    const runId = await w.payRun()
    await settle()

    expect(alice).toEqual([{ seq: expect.any(Number), guildId: GUILD, communityName: 'Mods', runId, line: 1, amount: 1_500_000n, token: TOKEN, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), paidAt: expect.any(Date) }])
    expect(bob.map((p) => [p.line, p.amount])).toEqual([[2, 2_000_000n]])
    expect(stranger).toEqual([])
  })

  it('stops at unsubscribe and drops its feed subscription when nobody is listening', async () => {
    const w = await world()
    const seen: ReceivedPayment[] = []
    const stop = w.rolepay.live.payments({ address: ADDR.alice }, (p) => seen.push(p))
    const stopToo = w.rolepay.live.payments({ address: ADDR.alice }, () => {})
    expect(w.feed.size).toBe(1) // one shared subscription for every payment listener
    stop()
    stopToo()
    expect(w.feed.size).toBe(0)
    await w.payRun()
    await settle()
    expect(seen).toEqual([])
  })

  it('lists what an address received recently, newest first, across its communities', async () => {
    const w = await world()
    const first = await w.payRun()
    w.clock.advance(60)
    const second = await w.payRun(OTHER_GUILD)
    const received = await w.rolepay.live.received({ address: ADDR.alice })
    expect(received.map((r) => [r.communityName, r.runId, r.line, r.amount])).toEqual([
      ['Other', second, 1, 1_500_000n],
      ['Mods', first, 1, 1_500_000n],
    ])
    expect(await w.rolepay.live.received({ address: ADDR.alice, limit: 1 })).toHaveLength(1)
    expect(await w.rolepay.live.received({ address: '0x5555555555555555555555555555555555555555' })).toEqual([])
  })
})
