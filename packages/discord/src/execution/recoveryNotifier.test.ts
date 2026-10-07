import { describe, expect, it } from 'vitest'
import { ALICE, BOB, CHANNEL, GUILD } from '../../test/fixtures.js'
import { harness } from '../../test/harness.js'
import { MemoryRunNotices } from '../testing/index.js'
import { createRecoveryNotifier } from './recoveryNotifier.js'

const MESSAGE = '810000000000000001'
const text = (v: unknown) => JSON.stringify(v ?? null)

/** A run the recovery sweep has just finished: paid on chain, nobody told yet. */
async function recovered(opts: { remembered?: boolean } = {}) {
  const h = await harness()
  await h.setupCommunity()
  await h.registerAll()
  const run = await h.approvedRun()
  const paid = await h.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })
  if (!paid.ok || paid.value.status !== 'paid') throw new Error('not paid')
  const notices = new MemoryRunNotices()
  if (opts.remembered !== false) await notices.rememberMessage(run.id, { channelId: CHANNEL, messageId: MESSAGE })
  const errors: unknown[] = []
  const notify = createRecoveryNotifier({ rolepay: h.rolepay, rest: h.rest, notices, network: 'moderato', onError: (e) => errors.push(e) })
  return { ...h, run, notices, notify, errors }
}

describe('createRecoveryNotifier (a run the sweep finished after a restart)', () => {
  it('DMs the receipts and updates the review message in its channel', async () => {
    const h = await recovered()
    await h.notify([{ guildId: GUILD, runId: h.run.id, status: 'paid' }])
    expect(h.rest.dms.map((d) => d.userId)).toEqual([ALICE, BOB])
    expect(h.rest.channelEdits).toHaveLength(1)
    expect(h.rest.channelEdits[0]).toMatchObject({ channelId: CHANNEL, messageId: MESSAGE })
    expect(text(h.rest.channelEdits[0]?.message)).toMatch(/"title":"Paid"/)
    expect(text(h.rest.channelEdits[0]?.message)).toMatch(/to all 2 people/)
    expect(h.rest.channelPosts).toEqual([])
  })

  it('posts in the channel when the review message cannot be edited', async () => {
    const h = await recovered()
    h.rest.goneMessages.add(MESSAGE)
    await h.notify([{ guildId: GUILD, runId: h.run.id, status: 'paid' }])
    expect(h.rest.channelPosts).toHaveLength(1)
    expect(h.rest.channelPosts[0]?.channelId).toBe(CHANNEL)
    expect(text(h.rest.channelPosts[0]?.message)).toMatch(/"title":"Paid"/)
  })

  it('never sends receipts twice: if they already went out, it tells nobody again', async () => {
    const h = await recovered()
    await h.notify([{ guildId: GUILD, runId: h.run.id, status: 'paid' }])
    await h.notify([{ guildId: GUILD, runId: h.run.id, status: 'paid' }])
    expect(h.rest.dms).toHaveLength(2)
    expect(h.rest.channelEdits).toHaveLength(1)
  })

  it('still sends receipts when it does not know where the review message is', async () => {
    const h = await recovered({ remembered: false })
    await h.notify([{ guildId: GUILD, runId: h.run.id, status: 'paid' }])
    expect(h.rest.dms).toHaveLength(2)
    expect(h.rest.channelEdits).toEqual([])
    expect(h.rest.channelPosts).toEqual([])
  })

  it('a failed run updates the message (with Retry if retryable) and sends no receipts; pending and errors are left alone', async () => {
    const h = await recovered()
    await h.notify([
      { guildId: GUILD, runId: h.run.id, status: 'pending' },
      { guildId: GUILD, runId: 'run_missing', status: 'error', error: 'run_not_found' },
    ])
    expect(h.rest.channelEdits).toEqual([])
    expect(h.rest.dms).toEqual([])
    await h.notify([{ guildId: GUILD, runId: 'run_missing', status: 'failed' }])
    expect(h.errors).toEqual([])
    expect(h.rest.channelEdits).toEqual([])
  })

  it('a run that never landed is shown failed with a Retry button, and nobody gets a receipt', async () => {
    const h = await harness()
    await h.setupCommunity()
    await h.registerAll()
    const run = await h.approvedRun()
    h.chain.faults.nextBroadcast = 'drop'
    expect(await h.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'pending' } })
    await h.sleep(200_000)
    expect(await h.rolepay.payRuns.reconcile({ guildId: GUILD, runId: run.id })).toMatchObject({ ok: true, value: { status: 'failed' } })
    const notices = new MemoryRunNotices()
    await notices.rememberMessage(run.id, { channelId: CHANNEL, messageId: MESSAGE })
    await createRecoveryNotifier({ rolepay: h.rolepay, rest: h.rest, notices, network: 'moderato' })([{ guildId: GUILD, runId: run.id, status: 'failed' }])
    expect(text(h.rest.channelEdits[0]?.message)).toContain(`payrun:retry:${run.id}`)
    expect(h.rest.dms).toEqual([])
  })
})
