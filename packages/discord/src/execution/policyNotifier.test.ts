import type { Schedule } from '@rolepay/core'
import { emptyCriteria } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { ALICE, BOB, CHANNEL, GUILD, MODS_ROLE, TOKEN, TREASURER, TREASURER_ROLE, TREASURY } from '../../test/fixtures.js'
import { harness } from '../../test/harness.js'
import { MemoryRunNotices } from '../testing/fakeDiscordRest.js'
import { wireMessage } from '../testing/messages.js'
import { CONFIG, text } from '../../test/app.js'
import { RestMemberDirectory } from '../adapters/restMemberDirectory.js'
import { createDispatcher } from '../app/router.js'
import { MemoryPendingSources } from '../testing/fakeDiscordRest.js'
import { buttonClick, slashCommand } from '../testing/interactions.js'
import { createPolicyNotifier } from './policyNotifier.js'
import { createRecoveryNotifier } from './recoveryNotifier.js'
import { createRunExecutor } from './runExecutor.js'

const HELP = '700000000000000002'
const asTreasurer = { guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE] }
const MONDAY = new Date('2026-10-12T18:00:00Z')

/** A community whose help desk policy (1 per answer in #help, Mods) is approved; Alice answered 3 questions, Bob 1. */
async function world(opts: { limit?: string; autopilot?: boolean; channel?: string | null; schedule?: Schedule } = {}) {
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
    schedule: opts.schedule ?? { kind: 'weekly', weekday: 'monday', hour: 18 },
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
    // Autopilot approved it, not a person: the status says so and who approved the rule.
    expect(text(edit?.message)).toMatch(new RegExp(`Paid on autopilot after the veto window <t:\\d+:R>; no veto\\. Policy approved by <@${TREASURER}> \\(version 1\\)\\.`))
    expect(text(edit?.message)).not.toContain('Approved by')
    expect(w.rest.dms.map((d) => d.userId).sort()).toEqual([ALICE, BOB])
    await w.notifier.announce(released.events)
    expect(w.rest.dms).toHaveLength(2)
    expect(w.chain.balance(TOKEN, TREASURY)).toBeLessThan(1000_000_000n)
  })

  it('released on autopilot, confirmed later by the recovery sweep; /rolepay status and a Retry say autopilot too, never "Approved by"', async () => {
    const w = await world({ autopilot: true })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    await w.sleep(3600 * 1000)
    // The transaction lands but the node's answer is lost: released, still confirming.
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    const released = await w.rolepay.scheduler.tick()
    await w.notifier.announce(released.events)
    expect(text(w.rest.channelEdits.at(-1)?.message)).toContain('Released on autopilot after the veto window; no veto. Paying…')
    const runId = released.events[0]?.run?.id as string

    const recover = createRecoveryNotifier({ rolepay: w.rolepay, rest: w.rest, notices: w.notices, network: 'moderato' })
    await recover(await w.rolepay.payRuns.recoverInFlight())
    const paid = text(w.rest.channelEdits.at(-1)?.message)
    expect(paid).toContain('"title":"Paid"')
    expect(paid).toMatch(new RegExp(`Paid on autopilot after the veto window <t:\\d+:R>; no veto\\. Policy approved by <@${TREASURER}> \\(version 1\\)\\.`))
    expect(paid).not.toContain('Approved by')

    const app = createDispatcher({ rolepay: w.rolepay, rest: w.rest, queue: w.queue, members: new RestMemberDirectory(w.rest), pendingSources: new MemoryPendingSources(), clock: w.clock, config: CONFIG })
    const status = await app(slashCommand({ guildId: GUILD, channelId: CHANNEL }, 'rolepay', 'status', { run: runId }, { userId: TREASURER, roles: [TREASURER_ROLE] }))
    expect(status.kind === 'respond' && text(status.body)).toContain('Paid on autopilot after the veto window')
    expect(status.kind === 'respond' && text(status.body)).not.toContain('Approved by')
  })

  it('a run autopilot released whose payment failed: Retry and the job that pays it keep the autopilot wording', async () => {
    const w = await world({ autopilot: true })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    await w.sleep(3600 * 1000)
    // The network refuses the transaction: released, failed, safe to retry.
    w.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    const released = await w.rolepay.scheduler.tick()
    const runId = released.events[0]?.run?.id as string
    expect((await w.rolepay.payRuns.get({ guildId: GUILD, runId })).ok).toBe(true)
    await w.sleep(300 * 1000)
    await w.chain.mine()
    const app = createDispatcher({ rolepay: w.rolepay, rest: w.rest, queue: w.queue, members: new RestMemberDirectory(w.rest), pendingSources: new MemoryPendingSources(), clock: w.clock, config: CONFIG })
    const retried = await app(buttonClick({ guildId: GUILD, channelId: CHANNEL }, `rolepay:retry:${runId}`, { userId: TREASURER, roles: [TREASURER_ROLE] }, 'tok-retry'))
    expect(retried.kind === 'respond' && text(retried.body)).toContain('Released on autopilot after the veto window; no veto. Paying…')
    const job = w.queue.jobs.at(-1)
    if (!job) throw new Error('no job')
    await createRunExecutor({ rolepay: w.rolepay, rest: w.rest, notices: w.notices, network: 'moderato', now: () => w.clock.now(), sleep: w.sleep })(job)
    const shown = text(w.rest.lastEdit('tok-retry'))
    expect(shown).toContain('"title":"Paid"')
    expect(shown).toContain('Paid on autopilot after the veto window')
    expect(shown).not.toContain('Approved by')
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

  it('a daily policy (the judge demo) says nothing on a day nobody matched: no run, no post; the audit log records it quietly', async () => {
    const w = await world({ schedule: { kind: 'daily', hour: 18, minute: 0, timezone: 'UTC' } })
    // The day to 7 October 18:00 has no answers in #help (they were on the 6th, before the 18:00 run).
    await w.travelTo(new Date('2026-10-07T18:00:00Z'))
    const report = await w.rolepay.scheduler.tick()
    expect(report.events.map((e) => [e.kind, e.policyRun.status, e.run])).toEqual([['generated', 'empty', null]])
    await w.notifier.announce(report.events)
    expect(w.rest.channelPosts).toEqual([])
    const audit = await w.rolepay.audit.list({ guildId: GUILD, types: ['policy_run.empty'] })
    expect(audit.ok && audit.value.events).toHaveLength(1)
  })

  it('a policy with no channel posts nothing (the dashboard shows its runs)', async () => {
    const w = await world({ channel: null })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts).toEqual([])
  })

  it('a policy with no channel still sends each payee their receipt when autopilot pays, once', async () => {
    const w = await world({ channel: null, autopilot: true })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    await w.sleep(3600 * 1000)
    const released = await w.rolepay.scheduler.tick()
    expect(released.events.map((e) => [e.kind, e.outcome])).toEqual([['released', 'paid']])
    await w.notifier.announce(released.events)
    await w.notifier.announce(released.events)
    expect(w.rest.dms.map((d) => d.userId).sort()).toEqual([ALICE, BOB])
    expect(w.rest.channelPosts).toEqual([])
    expect(w.rest.channelEdits).toEqual([])
  })
})

describe('createPolicyNotifier with a treasury channel: the buttons go there, the policy channel gets the run without them', () => {
  const TREASURY_CHANNEL = '700000000000000009'
  const OLD = '700000000000000008'
  const SOMEONE = '200000000000000007'

  /** The world above, the notifier logging what it does with the treasury channel, and buttons dispatched as Discord would. */
  async function treasuryWorld(opts: Parameters<typeof world>[0] & { channels?: { id: string; name: string; type: number }[] } = {}) {
    const w = await world(opts)
    w.rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }, ...(opts.channels ?? [])])
    const events: unknown[] = []
    const notifier = createPolicyNotifier({ rolepay: w.rolepay, rest: w.rest, notices: w.notices, network: 'moderato', onTreasury: (e) => events.push(e) })
    const app = createDispatcher({
      rolepay: w.rolepay,
      rest: w.rest,
      queue: w.queue,
      members: new RestMemberDirectory(w.rest),
      pendingSources: new MemoryPendingSources(),
      clock: w.clock,
      config: CONFIG,
      notices: w.notices,
    })
    const click = async (customId: string, who = { userId: TREASURER, roles: [TREASURER_ROLE] }, token = 'tok-treasury-click') => {
      const d = await app(buttonClick({ guildId: GUILD, channelId: TREASURY_CHANNEL }, customId, who, token))
      if (d.kind === 'respond') await d.background?.()
      return d
    }
    const pay = async () => {
      const job = w.queue.jobs.at(-1)
      if (!job) throw new Error('no job')
      await createRunExecutor({ rolepay: w.rolepay, rest: w.rest, notices: w.notices, network: 'moderato', now: () => w.clock.now(), sleep: w.sleep })(job)
    }
    const choose = (channelId: string | null) => w.rolepay.communities.setTreasuryChannel({ ...asTreasurer, channelId })
    const postsIn = (channelId: string) => w.rest.channelPosts.filter((p) => p.channelId === channelId)
    const editsIn = (channelId: string) => w.rest.channelEdits.filter((e) => e.channelId === channelId)
    return { ...w, notifier, events, click, pay, choose, postsIn, editsIn }
  }

  it('with no treasury channel (none set, none named "treasury"; #treasury-old is not it), the run and its Approve button stay in the policy channel, as always', async () => {
    const w = await treasuryWorld({ channels: [{ id: OLD, name: 'treasury-old', type: 0 }] })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([CHANNEL])
    expect(text(w.postsIn(CHANNEL)[0]?.message)).toContain('rolepay:approve:')
    expect(w.events).toEqual([])
    expect(await w.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { treasuryChannelId: null, treasuryChannelSource: 'unset' } })
  })

  it('an autopilot run: Veto in the treasury channel; the policy channel says when it pays and who can veto, with no button; paid, both turn into Paid, receipts once', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    const made = await w.rolepay.scheduler.tick()
    await w.notifier.announce(made.events)
    const runId = made.events[0]?.run?.id as string
    const [treasury] = w.postsIn(TREASURY_CHANNEL)
    const [copy] = w.postsIn(CHANNEL)
    expect(text(treasury?.message)).toContain('policy-run:veto:')
    expect(text(treasury?.message)).toMatch(/Autopilot: pays <t:\d+:t> unless vetoed/)
    expect(text(copy?.message)).toMatch(/Autopilot: pays <t:\d+:t> unless vetoed/)
    expect(text(copy?.message)).toContain(`unless a member with <@&${TREASURER_ROLE}> vetoes it`)
    expect(copy?.message.components).toEqual([])
    // The public post never names the private channel.
    expect(text(copy?.message)).not.toContain(TREASURY_CHANNEL)
    expect(await w.notices.message(runId)).toEqual({ channelId: TREASURY_CHANNEL, messageId: treasury?.messageId })
    expect(await w.notices.mirror(runId)).toEqual({ channelId: CHANNEL, messageId: copy?.messageId })

    await w.sleep(3600 * 1000)
    const released = await w.rolepay.scheduler.tick()
    await w.notifier.announce(released.events)
    await w.notifier.announce(released.events)
    const paidThere = w.editsIn(TREASURY_CHANNEL).at(-1)
    const paidHere = w.editsIn(CHANNEL).at(-1)
    expect(paidThere?.messageId).toBe(treasury?.messageId)
    expect(paidHere?.messageId).toBe(copy?.messageId)
    for (const m of [paidThere?.message, paidHere?.message]) {
      expect(text(m)).toContain('"title":"Paid"')
      expect(text(m)).toContain('Paid on autopilot after the veto window')
      expect(text(m)).toContain('View transaction')
    }
    expect(w.rest.dms.map((d) => d.userId).sort()).toEqual([ALICE, BOB])
    expect(w.rest.channelPosts).toHaveLength(2)
  })

  it('vetoed with the button in the treasury channel: both messages say who vetoed it, neither keeps a button; a non-Treasurer is refused', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    const made = await w.rolepay.scheduler.tick()
    await w.notifier.announce(made.events)
    const veto = `policy-run:veto:${made.events[0]?.policyRun.id}`
    // A channel left visible to everyone by mistake: the button still checks who presses it.
    const refused = await w.click(veto, { userId: SOMEONE, roles: [] })
    expect(text(refused.kind === 'respond' && refused.body)).toContain(`Only members with <@&${TREASURER_ROLE}>`)
    const vetoed = await w.click(veto)
    expect(text(vetoed.kind === 'respond' && vetoed.body)).toContain(`Vetoed by <@${TREASURER}>`)
    const here = w.editsIn(CHANNEL).at(-1)
    expect(here?.messageId).toBe(w.postsIn(CHANNEL)[0]?.messageId)
    expect(text(here?.message)).toContain('"title":"Vetoed"')
    expect(here?.message.components).toEqual([])
  })

  it('vetoed on the dashboard (announced as cancelled): both messages turn into Vetoed', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    const made = (await w.rolepay.scheduler.tick()).events[0]
    if (!made) throw new Error('no run')
    await w.notifier.announce([made])
    const vetoed = await w.rolepay.policies.veto({ ...asTreasurer, policyRunId: made.policyRun.id })
    if (!vetoed.ok) throw new Error('not vetoed')
    await w.notifier.announce([{ kind: 'cancelled', policy: made.policy, policyRun: vetoed.value.policyRun, run: vetoed.value.run }])
    expect(text(w.editsIn(TREASURY_CHANNEL).at(-1)?.message)).toContain(`Vetoed by <@${TREASURER}>`)
    expect(text(w.editsIn(CHANNEL).at(-1)?.message)).toContain(`Vetoed by <@${TREASURER}>`)
  })

  it('a propose-mode run: Approve and pay in the treasury channel only; approved there, both say paying, then both say Paid', async () => {
    const w = await treasuryWorld()
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    const made = await w.rolepay.scheduler.tick()
    await w.notifier.announce(made.events)
    const runId = made.events[0]?.run?.id as string
    expect(text(w.postsIn(TREASURY_CHANNEL)[0]?.message)).toContain(`rolepay:approve:${runId}`)
    const copy = w.postsIn(CHANNEL)[0]
    expect(text(copy?.message)).toContain(`Waiting for a member with <@&${TREASURER_ROLE}> to approve.`)
    expect(copy?.message.components).toEqual([])

    const approved = await w.click(`rolepay:approve:${runId}`)
    expect(text(approved.kind === 'respond' && approved.body)).toContain('Approved, paying')
    expect(text(w.editsIn(CHANNEL).at(-1)?.message)).toContain('Approved, paying')
    await w.pay()
    expect(text(w.rest.lastEdit('tok-treasury-click'))).toContain('"title":"Paid"')
    const paidHere = w.editsIn(CHANNEL).at(-1)
    expect(paidHere?.messageId).toBe(copy?.messageId)
    expect(text(paidHere?.message)).toContain('"title":"Paid"')
    expect(text(paidHere?.message)).not.toContain('rolepay:')
  })

  it('autopilot stopped at release: the treasury message offers Approve, the copy says why with no button', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    w.rest.setMember(GUILD, TREASURER, [])
    await w.sleep(3600 * 1000)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    const there = text(w.editsIn(TREASURY_CHANNEL).at(-1)?.message)
    const here = w.editsIn(CHANNEL).at(-1)
    expect(there).toContain('Autopilot stopped')
    expect(there).toContain('rolepay:approve:')
    expect(text(here?.message)).toContain('no longer holds the approver role')
    expect(here?.message.components).toEqual([])
  })

  it('a run held whole (no pay run) is posted in the treasury channel and in the policy channel', async () => {
    const w = await treasuryWorld({ limit: '2' })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    for (const channel of [TREASURY_CHANNEL, CHANNEL]) expect(text(w.postsIn(channel)[0]?.message)).toContain('Held: Help desk')
  })

  it('a period nobody matched stays in the policy channel only (nothing for a Treasurer to do)', async () => {
    const w = await treasuryWorld()
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(new Date(MONDAY.getTime() + 7 * 86_400_000))
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([CHANNEL])
  })

  it('a policy with no channel of its own posts its runs in the treasury channel (only there)', async () => {
    const w = await treasuryWorld({ channel: null })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([TREASURY_CHANNEL])
    expect(text(w.rest.channelPosts[0]?.message)).toContain('rolepay:approve:')
  })

  it('with none set, a text channel named "Treasury" is found and used: the confirmation first, once, audited as picked by Rolepay', async () => {
    const w = await treasuryWorld({ channels: [{ id: OLD, name: 'treasury-old', type: 0 }, { id: TREASURY_CHANNEL, name: 'Treasury', type: 0 }] })
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([TREASURY_CHANNEL, TREASURY_CHANNEL, CHANNEL])
    expect(w.rest.channelPosts[0]?.message.content).toBe('Rolepay will post here what needs a Treasurer: policies and runs to approve, runs you can veto, and runs it holds.')
    expect(text(w.rest.channelPosts[1]?.message)).toContain('rolepay:approve:')
    expect(w.rest.channelPosts[2]?.message.components).toEqual([])
    expect(await w.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { treasuryChannelId: TREASURY_CHANNEL, treasuryChannelSource: 'found' } })
    const audit = await w.rolepay.audit.list({ guildId: GUILD, types: ['community.treasury_channel_found'] })
    expect(audit.ok && audit.value.events.map((e) => [e.actor, e.details])).toEqual([[null, { channelId: TREASURY_CHANNEL, replaced: null }]])
    expect(w.events).toEqual([{ kind: 'found', guildId: GUILD, channelId: TREASURY_CHANNEL, replaced: null }])
    // The next week: no second confirmation, no second pick.
    await w.travelTo(new Date(MONDAY.getTime() + 7 * 86_400_000))
    w.rest.addChannelMessages(wireMessage({ channelId: HELP, authorId: ALICE, at: new Date(w.clock.now().getTime() - 60_000), replyTo: { id: '820000000000000001', authorId: '200000000000000009' } }))
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.filter((p) => p.message.content?.startsWith('Rolepay will post here'))).toHaveLength(1)
  })

  it('a channel named "treasury" Rolepay cannot post in is not used: the run stays in the policy channel with its buttons, and nothing is picked', async () => {
    const w = await treasuryWorld({ channels: [{ id: TREASURY_CHANNEL, name: 'treasury', type: 0 }] })
    w.rest.closedChannels.set(TREASURY_CHANNEL, 'forbidden')
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([CHANNEL])
    expect(text(w.rest.channelPosts[0]?.message)).toContain('rolepay:approve:')
    expect(await w.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { treasuryChannelId: null, treasuryChannelSource: 'unset' } })
  })

  it('a Treasurer who chose none stops the lookup: #treasury is never used, the buttons stay in the policy channel', async () => {
    const w = await treasuryWorld({ channels: [{ id: TREASURY_CHANNEL, name: 'treasury', type: 0 }] })
    await w.choose(null)
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([CHANNEL])
    expect(text(w.rest.channelPosts[0]?.message)).toContain('rolepay:approve:')
  })

  it('the treasury channel was deleted: the run goes to the policy channel with its buttons, logged, never lost; a #treasury that exists takes over', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(OLD)
    w.rest.closedChannels.set(OLD, 'not_found')
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelPosts.map((p) => p.channelId)).toEqual([CHANNEL])
    expect(text(w.rest.channelPosts[0]?.message)).toContain('policy-run:veto:')
    expect(w.events).toEqual([{ kind: 'unavailable', guildId: GUILD, channelId: OLD, reason: 'not_found' }])

    // A #treasury exists by the next run: the lookup tries again, in place of the deleted channel.
    w.rest.channels.set(GUILD, [{ id: TREASURY_CHANNEL, name: 'treasury', type: 0 }])
    await w.sleep(3600 * 1000)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    await w.travelTo(new Date(MONDAY.getTime() + 7 * 86_400_000))
    w.rest.addChannelMessages(wireMessage({ channelId: HELP, authorId: ALICE, at: new Date(w.clock.now().getTime() - 60_000), replyTo: { id: '820000000000000001', authorId: '200000000000000009' } }))
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(await w.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { treasuryChannelId: TREASURY_CHANNEL, treasuryChannelSource: 'found' } })
    expect(w.events.at(-1)).toEqual({ kind: 'found', guildId: GUILD, channelId: TREASURY_CHANNEL, replaced: OLD })
    expect(text(w.postsIn(TREASURY_CHANNEL).at(-1)?.message)).toContain('policy-run:veto:')
  })

  it('the treasury channel went away after the run was posted: the copy in the policy channel takes the buttons over', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    const copy = w.postsIn(CHANNEL)[0]
    w.rest.closedChannels.set(TREASURY_CHANNEL, 'forbidden')
    w.rest.setMember(GUILD, TREASURER, [])
    await w.sleep(3600 * 1000)
    const held = await w.rolepay.scheduler.tick()
    await w.notifier.announce(held.events)
    const here = w.editsIn(CHANNEL).at(-1)
    expect(here?.messageId).toBe(copy?.messageId)
    expect(text(here?.message)).toContain('rolepay:approve:')
    const runId = held.events[0]?.run?.id as string
    expect(await w.notices.message(runId)).toEqual({ channelId: CHANNEL, messageId: copy?.messageId })
    expect(await w.notices.mirror(runId)).toBeNull()
    expect(w.events).toContainEqual({ kind: 'unavailable', guildId: GUILD, channelId: TREASURY_CHANNEL, reason: 'forbidden' })
  })

  it('a run the recovery sweep settles is reported on both messages', async () => {
    const w = await treasuryWorld({ autopilot: true })
    await w.choose(TREASURY_CHANNEL)
    await w.travelTo(MONDAY)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    await w.sleep(3600 * 1000)
    w.chain.faults.nextBroadcast = 'land_then_lose_response'
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    const recover = createRecoveryNotifier({ rolepay: w.rolepay, rest: w.rest, notices: w.notices, network: 'moderato' })
    await recover(await w.rolepay.payRuns.recoverInFlight())
    expect(text(w.editsIn(TREASURY_CHANNEL).at(-1)?.message)).toContain('"title":"Paid"')
    expect(text(w.editsIn(CHANNEL).at(-1)?.message)).toContain('"title":"Paid"')
    expect(w.editsIn(CHANNEL).at(-1)?.message.components?.flatMap((r) => r.components.map((b) => b.label))).toEqual(['View transaction'])
  })
})

describe('createPolicyNotifier: a policy with no channel and a treasury channel', () => {
  it('its run is updated where it was posted (the treasury channel), and a run never posted there is never posted anywhere', async () => {
    const TREASURY_CHANNEL = '700000000000000009'
    const STATUS_CHANNEL = '700000000000000004'
    const w = await world({ channel: null, autopilot: true })
    await w.rolepay.communities.setTreasuryChannel({ ...asTreasurer, channelId: TREASURY_CHANNEL })
    await w.travelTo(MONDAY)
    const made = await w.rolepay.scheduler.tick()
    await w.notifier.announce(made.events)
    const posted = w.rest.channelPosts.at(-1)
    expect(posted?.channelId).toBe(TREASURY_CHANNEL)
    await w.sleep(3600 * 1000)
    await w.notifier.announce((await w.rolepay.scheduler.tick()).events)
    expect(w.rest.channelEdits.map((e) => [e.channelId, e.messageId])).toEqual([[TREASURY_CHANNEL, posted?.messageId]])

    // A run whose only message is someone's private /rolepay status answer: nothing is posted for it.
    const other = await world({ channel: null, autopilot: true })
    await other.travelTo(MONDAY)
    const run = (await other.rolepay.scheduler.tick()).events[0]
    if (!run?.run) throw new Error('no run')
    await other.notices.rememberMessage(run.run.id, { channelId: STATUS_CHANNEL, messageId: '810000000000000042' })
    await other.notifier.announce([{ kind: 'cancelled', policy: run.policy, policyRun: run.policyRun, run: run.run }])
    expect(other.rest.channelPosts).toEqual([])
    expect(other.rest.channelEdits).toEqual([])
  })
})
