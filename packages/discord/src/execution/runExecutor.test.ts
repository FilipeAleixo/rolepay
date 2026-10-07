import { describe, expect, it } from 'vitest'
import { ALICE, APP_ID, BOB, CHANNEL, GUILD, TREASURY } from '../../test/fixtures.js'
import { type Harness, harness } from '../../test/harness.js'
import { MemoryRunNotices } from '../testing/index.js'
import type { Message } from '../api.js'
import type { ExecutionJob } from '../ports.js'
import { createRunExecutor } from './runExecutor.js'

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
    expect(final).toContain('payrun:retry:')
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
    expect(final).toContain('payrun:retry:')
    expect(h.chain.landedTxCount).toBe(0)
  })

  it('a retry of a "rejected" run whose payment landed after all ends Paid, with no second payment and no "nothing was paid"', async () => {
    const h = await ready()
    h.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await h.execute(job(h.run.id))
    expect(text(h.rest.lastEdit('tok-approve'))).toContain('payrun:retry:')
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

  it('stops polling after a bounded number of checks and says payrun keeps checking', async () => {
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

  it('an outage before signing leaves the run approved and offers Retry, without throwing', async () => {
    const h = await ready()
    const original = h.chain.keyState.bind(h.chain)
    h.chain.keyState = async () => {
      throw new Error('rpc: no healthy upstreams')
    }
    await expect(h.execute(job(h.run.id))).resolves.toBeUndefined()
    const final = text(h.rest.lastEdit('tok-approve'))
    expect(final).toMatch(/could not reach/i)
    expect(final).toContain('payrun:retry:')
    h.chain.keyState = original
  })
})
