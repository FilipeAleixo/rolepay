import { emptyCriteria } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { text } from '../../test/app.js'
import { ALICE, BOB, CHANNEL, GUILD, MODS_ROLE, TOKEN, TREASURER, TREASURER_ROLE, TREASURY } from '../../test/fixtures.js'
import { harness } from '../../test/harness.js'
import { MemoryRunNotices } from '../testing/fakeDiscordRest.js'
import { wireMessage } from '../testing/messages.js'
import { createPolicyNotifier } from './policyNotifier.js'

const HELP = '700000000000000002'
const asTreasurer = { guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE] }
const MONDAY = new Date('2026-10-12T18:00:00Z')

/** A community whose help desk policy (1 per answer in #help, Mods) is approved; Alice answered 3 questions, Bob 1. */
async function world(opts: { limit?: string; autopilot?: boolean; channel?: string | null } = {}) {
  const h = await harness()
  await h.setupCommunity({ limit: opts.limit ?? '1000' })
  await h.registerAll()
  await h.rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [TREASURER_ROLE] })
  h.rest.roles.set(GUILD, [
    { id: TREASURER_ROLE, name: 'Treasurer' },
    { id: MODS_ROLE, name: 'Mods' },
  ])
  h.rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }])
  for (const id of [ALICE, BOB]) h.rest.setMember(GUILD, id, [MODS_ROLE])
  h.rest.setMember(GUILD, TREASURER, [TREASURER_ROLE])
  const at = (m: number) => new Date(h.clock.now().getTime() - m * 60_000)
  const answer = (author: string, m: number) => wireMessage({ channelId: HELP, authorId: author, at: at(m), replyTo: { id: '820000000000000001', authorId: '200000000000000009' } })
  h.rest.addChannelMessages(answer(ALICE, 10), answer(ALICE, 20), answer(ALICE, 30), answer(BOB, 40))
  h.proposer.onCriteria = () =>
    emptyCriteria({ amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk' }, { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C1'], since: '2026-09-30', until: '', min: 1 }] })
  const created = await h.rolepay.policies.create({
    ...asTreasurer,
    name: 'Help desk',
    instruction: '1 per answered question in #help, max 50 a week each, for Mods',
    schedule: { kind: 'weekly', weekday: 'monday', hour: 18 },
    channelId: opts.channel === undefined ? CHANNEL : opts.channel,
  })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  await h.rolepay.policies.approve({ ...asTreasurer, policyId: created.value.id, version: 1 })
  if (opts.autopilot) await h.rolepay.policies.setMode({ ...asTreasurer, policyId: created.value.id, mode: 'autopilot', vetoWindowMinutes: 60 })
  const notices = new MemoryRunNotices()
  const notifier = createPolicyNotifier({ rolepay: h.rolepay, rest: h.rest, notices, network: 'moderato' })
  const travelTo = (d: Date) => h.sleep(d.getTime() - h.clock.now().getTime())
  // The policy counts the week before Monday: move the answers into it.
  return { ...h, notices, notifier, travelTo, policyId: created.value.id }
}

describe('createPolicyNotifier: telling the channel what the scheduler did', () => {
  it('a propose-mode run is posted with the normal review embed (Approve and Cancel) and the policy it came from', async () => {
    const w = await world()
    await w.travelTo(MONDAY)
    const report = await w.rolepay.scheduler.tick()
    await w.notifier.announce(report.events)
    const post = w.rest.channelPosts.at(-1)
    expect(post?.channelId).toBe(CHANNEL)
    const shown = text(post?.message)
    expect(shown).toContain('Pay run awaiting approval')
    expect(shown).toContain('rolepay:approve:')
    expect(shown).toContain('**Help desk** (version 1)')
    const runId = report.events[0]?.run?.id as string
    expect(await w.notices.message(runId)).toEqual({ channelId: CHANNEL, messageId: post?.messageId })
  })

  it('an autopilot run says when it pays and carries Veto; when released and paid, the same message turns into Paid and receipts go out once', async () => {
    const w = await world({ autopilot: true })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    const post = w.rest.channelPosts.at(-1)
    expect(text(post?.message)).toMatch(/Autopilot: pays <t:\d+:t> unless vetoed/)
    expect(text(post?.message)).toContain('policy-run:veto:')
    expect(text(post?.message)).not.toContain('rolepay:approve:')

    await w.sleep(3600 * 1000)
    const released = await w.rolepay.scheduler.tick()
    await w.notifier.announce(released.events)
    const edit = w.rest.channelEdits.at(-1)
    expect(edit?.messageId).toBe(post?.messageId)
    expect(text(edit?.message)).toContain('"title":"Paid"')
    expect(text(edit?.message)).toContain(`Approved by <@${TREASURER}>`)
    expect(w.rest.dms.map((d) => d.userId).sort()).toEqual([ALICE, BOB])
    await w.notifier.announce(released.events)
    expect(w.rest.dms).toHaveLength(2)
    expect(w.chain.balance(TOKEN, TREASURY)).toBeLessThan(1000_000_000n)
  })

  it('a run vetoed elsewhere (on the web dashboard) is announced as cancelled: its message says who vetoed it and loses the Veto button', async () => {
    const w = await world({ autopilot: true })
    await w.travelTo(MONDAY)
    const made = (await w.rolepay.scheduler.tick()).events[0]
    await w.notifier.announce(made ? [made] : [])
    const post = w.rest.channelPosts.at(-1)
    const vetoed = await w.rolepay.policies.veto({ ...asTreasurer, policyRunId: made?.policyRun.id as string })
    if (!vetoed.ok || !made) throw new Error('not vetoed')
    await w.notifier.announce([{ kind: 'cancelled', policy: made.policy, policyRun: vetoed.value.policyRun, run: vetoed.value.run }])
    const edit = w.rest.channelEdits.at(-1)
    expect(edit?.messageId).toBe(post?.messageId)
    expect(text(edit?.message)).toContain('"title":"Vetoed"')
    expect(text(edit?.message)).toContain(`Vetoed by <@${TREASURER}>`)
    expect(text(edit?.message)).not.toContain('policy-run:veto:')
  })

  it('a run held over the key budget is posted with the numbers; nothing was paid', async () => {
    const w = await world({ limit: '2' })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    const shown = text(w.rest.channelPosts.at(-1)?.message)
    expect(shown).toContain('Held: Help desk')
    expect(shown).toContain('The run would pay 4 AlphaUSD, more than the bot key has left (2 AlphaUSD). Held whole: nothing was paid.')
  })

  it('autopilot stopped at release (the approver lost the role): the message turns into the normal review, with why', async () => {
    const w = await world({ autopilot: true })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    w.rest.setMember(GUILD, TREASURER, [])
    await w.sleep(3600 * 1000)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    const shown = text(w.rest.channelEdits.at(-1)?.message)
    expect(shown).toContain('Autopilot stopped')
    expect(shown).toContain('no longer holds the approver role')
    expect(shown).toContain('rolepay:approve:')
  })

  it('a period where nobody matched is one line, with no run', async () => {
    const w = await world()
    await w.travelTo(new Date(MONDAY.getTime() + 7 * 86_400_000))
    const report = await w.rolepay.scheduler.tick()
    expect(report.events.map((e) => e.policyRun.status)).toEqual(['empty'])
    await w.notifier.announce(report.events)
    expect(text(w.rest.channelPosts.at(-1)?.message)).toContain('nobody matched')
  })

  it('a policy with no channel posts nothing (the dashboard shows its runs)', async () => {
    const w = await world({ channel: null })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts).toEqual([])
  })
})
