import { describe, expect, it } from 'vitest'
import { ALICE, APP_ID, BOB, CHANNEL, GUILD, TOKEN, TREASURY } from '../../test/fixtures.js'
import { type Harness, harness, usd } from '../../test/harness.js'
import { MemoryRunNotices } from '../testing/index.js'
import type { Message } from '../api.js'
import type { ExecutionJob } from '../ports.js'
import { type JobReport, createRunExecutor } from './runExecutor.js'

const text = (m: Message | undefined) => JSON.stringify(m ?? null)
const job = (runId: string, token = 'tok-approve'): ExecutionJob => ({
  kind: 'execute_run',
  guildId: GUILD,
  runId,
  reply: { applicationId: APP_ID, token },
  channelId: CHANNEL,
  messageId: '810000000000000001',
})

async function ready(opts: Parameters<Harness['setupCommunity']>[0] = {}) {
  const h = await harness()
  await h.setupCommunity(opts)
  await h.registerAll()
  const run = await h.approvedRun()
  const notices = new MemoryRunNotices()
  const execute = createRunExecutor({ rolepay: h.rolepay, rest: h.rest, notices, network: 'moderato', now: () => h.clock.now(), sleep: h.sleep })
  return { ...h, run, notices, execute }
}

describe('createRunExecutor', () => {
  it('pays an approved run, shows the transaction, then DMs every payee a receipt', async () => {
    const h = await ready()
    await h.execute(job(h.run.id))
    const final = h.rest.lastEdit('tok-approve')
    expect(text(final)).toMatch(/"title":"Paid"/)
    expect(text(final)).toContain('https://explore.testnet.tempo.xyz/tx/0x')
    expect(text(final)).toMatch(/to all 2 people/)
    expect(text(h.rest.edits[0]?.message)).toMatch(/Sending receipts/) // shown paid before the DMs go out
    expect(h.rest.dms.map((d) => d.userId)).toEqual([ALICE, BOB])
    expect(text(h.rest.dms[1]?.message)).toContain('25 AlphaUSD')
    expect((await h.rolepay.payRuns.get({ guildId: GUILD, runId: h.run.id })).ok && h.chain.landedTxCount).toBe(1)
  })

  it("each receipt's 'Your account' fits how the payee is paid: the account page for a passkey, the explorer for their own wallet", async () => {
    const h = await harness()
    await h.setupCommunity()
    await h.registerPayee(ALICE, '0x1111111111111111111111111111111111111111')
    await h.registerWallet(BOB, '0x2222222222222222222222222222222222222222')
    const run = await h.approvedRun()
    const execute = createRunExecutor({ rolepay: h.rolepay, rest: h.rest, notices: new MemoryRunNotices(), network: 'moderato', now: () => h.clock.now(), sleep: h.sleep, accountUrl: 'https://web.rolepay.app/account' })
    await execute(job(run.id))
    const account = (userId: string) =>
      (h.rest.dms.find((d) => d.userId === userId)?.message.components ?? [])
        .flatMap((row) => (row as { components: { label: string; url?: string }[] }).components)
        .find((b) => b.label === 'Your account')?.url
    expect(account(ALICE)).toBe('https://web.rolepay.app/account')
    expect(account(BOB)).toBe('https://explore.testnet.tempo.xyz/address/0x2222222222222222222222222222222222222222')
    // Paid where the run said, whatever the kind: the wallet line went to the wallet.
    const paid = await h.rolepay.payRuns.get({ guildId: GUILD, runId: run.id })
    expect(paid.ok && paid.value.lines.map((l) => [l.payeeDiscordId, l.address])).toEqual([
      [ALICE, '0x1111111111111111111111111111111111111111'],
      [BOB, '0x2222222222222222222222222222222222222222'],
    ])
  })

  it("a receipt for an address the payee has since moved from links the explorer: Rolepay no longer knows it is a passkey account", async () => {
    const h = await ready()
    await h.registerWallet(BOB, '0x4444444444444444444444444444444444444444') // re-claimed at a wallet after the run was made
    const execute = createRunExecutor({ rolepay: h.rolepay, rest: h.rest, notices: new MemoryRunNotices(), network: 'moderato', now: () => h.clock.now(), sleep: h.sleep, accountUrl: 'https://web.rolepay.app/account' })
    await execute(job(h.run.id))
    const bob = h.rest.dms.find((d) => d.userId === BOB)?.message
    const line = h.run.lines.find((l) => l.payeeDiscordId === BOB)
    expect(line?.address).toBe('0x2222222222222222222222222222222222222222')
    expect(text(bob)).toContain(`https://explore.testnet.tempo.xyz/address/${line?.address}`)
    expect(text(bob)).not.toContain('web.rolepay.app/account')
    expect(text(bob)).not.toMatch(/own wallet|passkey/) // it says nothing it does not know
    // Alice did not move: her passkey account page, as before.
    expect(text(h.rest.dms.find((d) => d.userId === ALICE)?.message)).toContain('web.rolepay.app/account')
  })

  it('remembers where the review message is, for an update after a restart', async () => {
    const h = await ready()
    await h.execute(job(h.run.id))
    expect(await h.notices.message(h.run.id)).toEqual({ channelId: CHANNEL, messageId: '810000000000000001' })
  })

  it('sends receipts at most once per run, whoever finishes it (here the recovery sweep got there first)', async () => {
    const h = await ready()
    expect(await h.notices.claimReceipts(h.run.id)).toBe(true)
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(h.rest.dms).toEqual([])
  })

  it('counts receipts that could not be delivered without failing the job', async () => {
    const h = await ready()
    h.rest.closedDms.add(BOB)
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/1 of 2 people/)
  })

  it('a run that cannot start (no active key) explains why and offers Retry; nothing is paid', async () => {
    const h = await ready()
    await h.rolepay.communities.revokeBotKey({ guildId: GUILD, root: h.chain.rootSigner(TREASURY) })
    await h.execute(job(h.run.id))
    const final = text(h.rest.lastEdit('tok-approve'))
    expect(final).toMatch(/no active key/)
    expect(final).toContain('rolepay:retry:')
    expect(h.rest.dms).toEqual([])
    expect(h.chain.landedTxCount).toBe(0)
  })

  it('a run over the key limit fails before signing, with the numbers', async () => {
    const h = await ready({ limit: '10' })
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/needs 26.5 AlphaUSD but the bot key has 10 AlphaUSD left/)
    expect(h.chain.broadcastCount).toBe(0)
  })

  it('an ambiguous broadcast that did land ends as paid after waiting and reconciling', async () => {
    const h = await ready()
    h.chain.faults.nextBroadcast = 'land_then_lose_response'
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(h.chain.landedTxCount).toBe(1)
  })

  it('a broadcast that never landed ends as a safe-to-retry failure after its deadline', async () => {
    const h = await ready()
    h.chain.faults.nextBroadcast = 'drop'
    await h.execute(job(h.run.id))
    const final = text(h.rest.lastEdit('tok-approve'))
    expect(final).toMatch(/did not land before its deadline/)
    expect(final).toContain('rolepay:retry:')
    expect(h.chain.landedTxCount).toBe(0)
  })

  it('a retry of a "rejected" run whose payment landed after all ends Paid, with no second payment and no "nothing was paid"', async () => {
    const h = await ready()
    h.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toContain('rolepay:retry:')
    await h.chain.mine() // the tx the node "rejected" lands
    await h.sleep(200_000)
    await h.execute(job(h.run.id, 'tok-retry'))
    const final = text(h.rest.lastEdit('tok-retry'))
    expect(final).toMatch(/"title":"Paid"/)
    expect(final).not.toMatch(/nothing was paid/i)
    expect(h.chain.landedTxCount).toBe(1)
    expect(h.rest.dms).toHaveLength(2)
  })

  it('Retry pressed right after a "rejected" failure waits out the old deadline, then finds that payment landed: paid once', async () => {
    const h = await ready()
    h.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await h.execute(job(h.run.id))
    // While the job waits, the "rejected" tx lands from the mempool inside its window.
    const execute = createRunExecutor({
      rolepay: h.rolepay,
      rest: h.rest,
      notices: h.notices,
      network: 'moderato',
      now: () => h.clock.now(),
      sleep: async (ms) => {
        await h.chain.mine()
        await h.sleep(ms)
      },
    })
    await execute(job(h.run.id, 'tok-retry'))
    expect(text(h.rest.lastEdit('tok-retry'))).toMatch(/"title":"Paid"/)
    expect(h.chain.landedTxCount).toBe(1)
    const r = await h.rolepay.payRuns.get({ guildId: GUILD, runId: h.run.id })
    expect(r.ok && r.value.attempts).toHaveLength(1) // no second attempt was ever signed
  })

  it('stops polling after a bounded number of checks and says Rolepay keeps checking', async () => {
    const h = await harness()
    await h.setupCommunity()
    await h.registerAll()
    const run = await h.approvedRun()
    // Every broadcast is dropped and time never advances: the outcome stays pending.
    h.chain.faults.nextBroadcast = 'drop'
    const execute = createRunExecutor({
      rolepay: h.rolepay,
      rest: h.rest,
      notices: new MemoryRunNotices(),
      network: 'moderato',
      now: () => h.clock.now(),
      sleep: async () => {
        h.chain.faults.nextBroadcast = 'drop'
      },
      maxChecks: 3,
    })
    await execute(job(run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/keeps checking/)
  })

  it('a second job for an already paid run updates the message but sends no second receipts', async () => {
    const h = await ready()
    await h.execute(job(h.run.id))
    await h.execute(job(h.run.id, 'tok-second'))
    expect(text(h.rest.lastEdit('tok-second'))).toMatch(/"title":"Paid"/)
    expect(h.rest.dms).toHaveLength(2)
    expect(h.chain.landedTxCount).toBe(1)
  })

  it('posts the result in the channel when the interaction token has expired', async () => {
    const h = await ready()
    h.rest.expiredTokens.add('tok-approve')
    await h.execute(job(h.run.id))
    expect(h.rest.channelPosts.at(-1)?.channelId).toBe(CHANNEL)
    expect(text(h.rest.channelPosts.at(-1)?.message)).toMatch(/"title":"Paid"/)
  })

  it('reports how long the job took and where: paying (chain and database) and telling Discord', async () => {
    const reports: JobReport[] = []
    const h = await ready()
    const execute = createRunExecutor({ rolepay: h.rolepay, rest: h.rest, notices: h.notices, network: 'moderato', now: () => h.clock.now(), sleep: h.sleep, onDone: (r) => reports.push(r) })
    await execute(job(h.run.id))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ runId: h.run.id, status: 'paid', checks: 0, contended: 0 })
    const r = reports[0] as JobReport
    expect(r.ms).toBeGreaterThanOrEqual(r.phases.pay)
    expect(r.phases.discord).toBeGreaterThanOrEqual(0)
  })

  it('an outage before signing leaves the run approved and offers Retry, without throwing', async () => {
    const h = await ready()
    const original = h.chain.keyState.bind(h.chain)
    h.chain.keyState = async () => {
      throw new Error('rpc: no healthy upstreams')
    }
    await expect(h.execute(job(h.run.id))).resolves.toBeUndefined()
    const final = text(h.rest.lastEdit('tok-approve'))
    expect(final).toMatch(/could not reach/i)
    expect(final).toContain('rolepay:retry:')
    h.chain.keyState = original
  })
})

describe('createRunExecutor: another worker on the same run (the recovery sweep, another instance)', () => {
  type Ready = Awaited<ReturnType<typeof ready>>
  const ref = (h: Ready) => ({ guildId: GUILD, runId: h.run.id })

  type Execute = Ready['rolepay']['payRuns']['execute']

  /**
   * The job's first execute loses to another worker: `meanwhile` is what that worker did to the run
   * first (given the real execute, as another instance would call it).
   */
  function contended(h: Ready, meanwhile: (execute: Execute) => Promise<unknown>) {
    const payRuns = h.rolepay.payRuns
    const real = payRuns.execute.bind(payRuns)
    let first = true
    payRuns.execute = async (input) => {
      if (!first) return real(input)
      first = false
      await meanwhile(real)
      return { ok: false, error: { code: 'concurrent_update' } }
    }
  }

  it('another worker paid it first: the job reads that and reports Paid at once (no wait), receipts sent once', async () => {
    const h = await ready()
    contended(h, (execute) => execute(ref(h)))
    const started = h.clock.now().getTime()
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(h.clock.now().getTime()).toBe(started)
    expect(h.rest.dms.map((d) => d.userId)).toEqual([ALICE, BOB])
    expect(h.chain.landedTxCount).toBe(1)
  })

  it('another worker is still paying it: the job waits, follows that payment and never sends a second transaction', async () => {
    const h = await ready()
    contended(h, async (execute) => {
      h.chain.faults.nextBroadcast = 'land_then_lose_response'
      await execute(ref(h))
    })
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(h.chain.broadcastCount).toBe(1)
    expect(h.chain.landedTxCount).toBe(1)
  })

  it('another worker recorded a failure: the job shows it with Retry at once and does not try again by itself', async () => {
    const h = await ready()
    h.chain.fund(TOKEN, TREASURY, -usd('1000')) // an empty treasury: the network refuses the payment
    contended(h, (execute) => execute(ref(h)))
    const started = h.clock.now().getTime()
    await h.execute(job(h.run.id))
    const final = text(h.rest.lastEdit('tok-approve'))
    expect(final).toMatch(/Payment failed/)
    expect(final).toContain('rolepay:retry:')
    expect(h.clock.now().getTime()).toBe(started)
    const run = await h.rolepay.payRuns.get(ref(h))
    expect(run.ok && run.value.attempts).toHaveLength(1)
  })

  it('the run is still approved (the other worker let go without starting it): the job pays it instead of dropping it', async () => {
    const h = await ready()
    contended(h, async () => {})
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(h.chain.landedTxCount).toBe(1)
    expect(h.rest.dms).toHaveLength(2)
  })

  it('reports the contention in its timing line', async () => {
    const reports: JobReport[] = []
    const h = await ready()
    contended(h, (execute) => execute(ref(h)))
    const execute = createRunExecutor({ rolepay: h.rolepay, rest: h.rest, notices: h.notices, network: 'moderato', now: () => h.clock.now(), sleep: h.sleep, onDone: (r) => reports.push(r) })
    await execute(job(h.run.id))
    expect(reports[0]).toMatchObject({ status: 'paid', contended: 1 })
  })
})

describe('createRunExecutor: a run with a line in a preferred stablecoin', () => {
  const BETA = '0x20c0000000000000000000000000000000000002'

  async function preferring(route: { inPerOutBps: number } | null) {
    const h = await harness()
    await h.rolepay.communities.register({ guildId: GUILD, name: 'Test guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
    await h.rolepay.communities.setPreferredTokens({ guildId: GUILD, enabled: true })
    await h.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 2_592_000, expiresAt: h.chain.time + 86_400 * 30 })
    await h.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: h.chain.rootSigner(TREASURY) })
    await h.registerAll()
    await h.rolepay.payees.setPreferredToken({ guildId: GUILD, discordUserId: ALICE, token: BETA })
    if (route) h.chain.setSwapRoute(TOKEN, BETA, { ...route, liquidity: usd('1000') })
    const run = await h.approvedRun()
    const execute = createRunExecutor({ rolepay: h.rolepay, rest: h.rest, notices: new MemoryRunNotices(), network: 'moderato', now: () => h.clock.now(), sleep: h.sleep })
    return { ...h, run, execute }
  }

  it('pays it in one transaction; the message shows the swap and Alice\'s receipt says she received BetaUSD', async () => {
    const h = await preferring({ inPerOutBps: 9_954 })
    expect(h.run.lines[0]?.swap).toEqual({ token: BETA, maxIn: usd('1.515') })
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(text(h.rest.lastEdit('tok-approve'))).toContain('1.5 AlphaUSD → 1.5 BetaUSD (swapped)')
    expect(h.chain.landedTxCount).toBe(1)
    expect(text(h.rest.dms[0]?.message)).toContain('You were paid 1.5 BetaUSD')
    expect(text(h.rest.dms[1]?.message)).toContain('You were paid 25 AlphaUSD')
  })

  it('with no route on the exchange, holds the run whole, says why and offers Retry; nothing is sent', async () => {
    const h = await preferring(null)
    await h.execute(job(h.run.id))
    const shown = text(h.rest.lastEdit('tok-approve'))
    expect(shown).toMatch(/Approved, not paid yet/)
    expect(shown).toContain('cannot buy BetaUSD right now')
    expect(shown).toMatch(/"label":"Retry"/)
    expect(h.chain.broadcastCount).toBe(0)
    expect(h.rest.dms).toEqual([])
  })
})
