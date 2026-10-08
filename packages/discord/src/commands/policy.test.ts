import { emptyCriteria } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, BOB, CAROL, CHANNEL, GUILD, MODS_ROLE, TREASURER, TREASURER_ROLE, TREASURY } from '../../test/fixtures.js'
import { updatePolicyMessages } from '../app/treasury.js'
import { autocomplete, buttonClick, slashCommand } from '../testing/interactions.js'
import { wireMessage } from '../testing/messages.js'

const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }
const PROPOSERS = '400000000000000003'
const writer = { userId: '300000000000000003', roles: [PROPOSERS] }
const admin = { userId: ADMIN, manageGuild: true }
const HELP = '700000000000000002'
const INSTRUCTION = '1 per answered question in #help, max 50 a week each, for Mods'
const NEW = { instruction: INSTRUCTION, schedule: 'weekly', weekday: 'monday', hour: 18, name: 'Help desk' }

type Harness = Awaited<ReturnType<typeof appHarness>>

/** A community with a 1000 key, AI on, and a #help channel where Alice answered 3 questions and Bob 1 this week. */
async function ready(opts: Parameters<typeof appHarness>[0] = {}) {
  const a = await appHarness(opts)
  await a.setupCommunity({ limit: '1000' })
  await a.registerAll()
  await a.rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, proposerRoleId: PROPOSERS, actorRoleIds: [TREASURER_ROLE] })
  a.rest.roles.set(GUILD, [
    { id: TREASURER_ROLE, name: 'Treasurer' },
    { id: MODS_ROLE, name: 'Mods' },
  ])
  a.rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }])
  for (const id of [ALICE, BOB]) a.rest.setMember(GUILD, id, [MODS_ROLE])
  a.rest.setMember(GUILD, TREASURER, [TREASURER_ROLE])
  const now = a.clock.now().getTime()
  const answer = (author: string, minutes: number) => wireMessage({ channelId: HELP, authorId: author, at: new Date(now - minutes * 60_000), replyTo: { id: '820000000000000001', authorId: '200000000000000009' } })
  a.rest.addChannelMessages(answer(ALICE, 10), answer(ALICE, 20), answer(ALICE, 30), answer(BOB, 40))
  a.proposer.onCriteria = () =>
    emptyCriteria(
      { amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk' },
      { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C1'], since: '2026-09-30', until: '', min: 1 }] },
    )
  return a
}

/** Runs /rolepay policy new and returns the policy ID shown in the preview. */
async function newPolicy(a: Harness, over: Record<string, string | number | boolean> = {}) {
  const d = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', { ...NEW, ...over }, treasurer, 'tok-new'))
  expect(body(d)).toEqual({ type: 5, data: {} })
  const shown = text(a.rest.lastEdit('tok-new'))
  return { shown, policyId: /policy:approve:(pol_[A-Za-z0-9_]+):1/.exec(shown)?.[1] as string }
}

describe('/rolepay policy new', () => {
  it('compiles the instruction once and posts the preview publicly: the rule in plain words, who it applies to right now, Approve and Discard', async () => {
    const a = await ready()
    const { shown, policyId } = await newPolicy(a)
    expect(policyId).toMatch(/^pol_/)
    expect(shown).toContain('Policy draft: Help desk')
    expect(shown).toContain('1 per reply to other people, at most 50 each.')
    expect(shown).toContain(`Who: has <@&${MODS_ROLE}>`)
    expect(shown).toContain('every Monday at 18:00 (UTC)')
    expect(shown).toContain(`<@${ALICE}>  3 AlphaUSD  ·  has <@&${MODS_ROLE}>; 3 replies to other people in <#${HELP}> (at least 1)`)
    expect(shown).toContain(`<@${BOB}>  1 AlphaUSD`)
    expect(shown).toContain('4 AlphaUSD for 2 people so far')
    expect(shown).toContain(`Waiting for a member with <@&${TREASURER_ROLE}> to approve.`)
    expect(shown).toContain(`policy:discard:${policyId}:1`)
    expect(a.proposer.requests).toHaveLength(1)
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value).toMatchObject({ status: 'draft', channelId: CHANNEL, createdBy: TREASURER, instruction: INSTRUCTION })
  })

  it('a writer with the proposer role may draft; anyone else is refused; bad options never reach the model', async () => {
    const a = await ready()
    const outsider = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', NEW, admin))
    expect(isEphemeral(outsider)).toBe(true)
    expect(body(outsider).data?.content).toContain('can propose pay runs with AI')
    for (const [over, says] of [
      [{ weekday: undefined as unknown as string }, 'weekday'],
      [{ schedule: 'monthly' }, 'day'],
      [{ timezone: 'Mars/Base' }, 'timezone'],
      [{ max_per_run: '-5' }, 'max_per_run'],
    ] as const) {
      const d = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', { ...NEW, ...over }, treasurer))
      expect([says, isEphemeral(d)]).toEqual([says, true])
      expect(body(d).data?.content).toContain(says)
    }
    expect(a.proposer.requests).toHaveLength(0)
    const drafted = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', NEW, writer, 'tok-writer'))
    expect(body(drafted).type).toBe(5)
    expect(text(a.rest.lastEdit('tok-writer'))).toContain('Policy draft: Help desk')
  })

  it('minute names the time past the hour: the preview says 18:30 and the policy runs then; left out it is on the hour; past 59 never reaches the model', async () => {
    const a = await ready()
    const { shown, policyId } = await newPolicy(a, { minute: 30 })
    expect(shown).toContain('every Monday at 18:30 (UTC)')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.schedule).toEqual({ kind: 'weekly', weekday: 'monday', hour: 18, minute: 30, timezone: 'UTC' })
    const onTheHour = await newPolicy(a)
    const q = await a.rolepay.policies.get({ guildId: GUILD, policyId: onTheHour.policyId })
    expect(q.ok && q.value.schedule).toEqual({ kind: 'weekly', weekday: 'monday', hour: 18, minute: 0, timezone: 'UTC' })
    const asked = a.proposer.requests.length
    const late = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', { ...NEW, minute: 60 }, treasurer))
    expect(isEphemeral(late)).toBe(true)
    expect(body(late).data?.content).toContain('minute')
    expect(a.proposer.requests).toHaveLength(asked)
  })
})

describe('/rolepay policy new schedule:daily (a demo control: the judge demo)', () => {
  it('with the demo controls on, a daily policy is drafted (no weekday or day needed) and its preview says every day at the hour', async () => {
    const a = await ready()
    const { shown, policyId } = await newPolicy(a, { schedule: 'daily', weekday: undefined as unknown as string })
    expect(shown).toContain('every day at 18:00 (UTC)')
    expect(shown).toContain('First run after approval')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.schedule).toEqual({ kind: 'daily', hour: 18, minute: 0, timezone: 'UTC' })
  })

  it('the judge rule: everyone who reacted ✅ to the welcome post and has never been paid; the preview says it for the rule and for each person', async () => {
    const a = await ready()
    const START = '700000000000000010'
    const WELCOME = '810000000000000123'
    a.rest.channels.set(GUILD, [
      { id: HELP, name: 'help', type: 0 },
      { id: START, name: 'start-here', type: 0 },
    ])
    a.rest.setReactions(START, WELCOME, '✅', [{ id: ALICE }, { id: BOB }, { id: CAROL }])
    // Alice and Bob are in a run approved by hand (about to be paid): they are not first-timers any more.
    await a.approvedRun()
    a.proposer.onCriteria = () =>
      emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' }, note: 'Judges' }, { anchors: [{ kind: 'reactedTo', message: 'M1', thread: '', emoji: '✅' }], neverPaid: true })
    const instruction = `Every day at 18:00 UTC: 1 AlphaUSD to every registered payee who reacted ✅ to https://discord.com/channels/${GUILD}/${START}/${WELCOME} and has never been paid`
    const { shown } = await newPolicy(a, { instruction, schedule: 'daily', weekday: undefined as unknown as string, name: 'Judges' })
    expect(shown).toContain(`Who: reacted ✅ to https://discord.com/channels/${GUILD}/${START}/${WELCOME}; has never been paid by this community.`)
    expect(shown).toContain(`<@${CAROL}>  1 AlphaUSD  ·  reacted to the message; never paid by this community`)
    expect(shown).not.toContain(`<@${ALICE}>  1 AlphaUSD`)
    expect(shown).not.toContain(`<@${BOB}>  1 AlphaUSD`)
    expect(shown).toContain('every day at 18:00 (UTC)')
  })

  it('run_now when nobody matches: the caller is told no run was made; a daily policy posts nothing, a weekly one says so in its channel', async () => {
    for (const [schedule, posts] of [
      ['daily', 0],
      ['weekly', 1],
    ] as const) {
      const a = await ready()
      // A rule nobody registered meets: the Treasurer role.
      a.proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' } }, { hasRole: ['R1'] })
      const { policyId } = await newPolicy(a, { instruction: '1 to every Treasurer', schedule })
      await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
      const before = a.rest.channelPosts.length
      await a.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: policyId }, treasurer, `tok-empty-${schedule}`))
      const said = text(a.rest.lastEdit(`tok-empty-${schedule}`))
      expect([schedule, said]).toEqual([schedule, expect.stringContaining('Nobody matched for the next period, so no run was made')])
      expect([schedule, a.rest.channelPosts.length - before]).toEqual([schedule, posts])
      if (schedule === 'daily') expect(said).toContain('a daily policy stays quiet on empty days')
    }
  })

  it('without them it is refused before the model is called, even with the dev shortcuts on; off Moderato too', async () => {
    for (const config of [{ devShortcuts: true, demoControls: false }, { network: 'mainnet' as const, demoControls: true }]) {
      const a = await ready({ config })
      const d = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', { ...NEW, schedule: 'daily' }, treasurer))
      expect(isEphemeral(d)).toBe(true)
      expect(body(d).data?.content).toContain('A daily `schedule` is a demo control (ROLEPAY_DEMO_CONTROLS=true on Moderato)')
      expect(a.proposer.requests).toHaveLength(0)
      expect(await a.rolepay.policies.list({ guildId: GUILD })).toEqual([])
    }
  })
})

describe('the preview buttons', () => {
  it('Approve: the approver role only; the preview turns into the active policy', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    const refused = await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, writer))
    expect(isEphemeral(refused)).toBe(true)
    expect(body(refused).data?.content).toContain(`<@&${TREASURER_ROLE}>`)
    const approved = await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    expect(body(approved).type).toBe(7)
    const shown = text(body(approved).data)
    expect(shown).toContain('Policy: Help desk')
    expect(shown).toContain(`Active. Approved by <@${TREASURER}>`)
    expect(shown).not.toContain('policy:approve')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.status).toBe('active')
  })

  it("after Approve, the approver alone is offered the policy's own budget: a private link to the treasury page for this policy", async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer, 'tok-approve'))
    const offer = a.rest.followUps.find((f) => f.reply.token === 'tok-approve')?.message
    expect(offer?.flags).toBe(64)
    expect(offer?.content).toContain('Give **Help desk** its own budget')
    expect(offer?.content).toContain('can never spend more than that, whatever the bot key has left')
    const button = offer?.components?.[0]?.components[0] as { style: number; label: string; url: string }
    expect(button).toMatchObject({ style: 5, label: 'Give this policy its own budget' })
    const m = new RegExp(`^https://rolepay\\.test/setup/([^/]+)/policies/${policyId}$`).exec(button.url)
    expect(m).not.toBeNull()
    const link = await a.rolepay.communities.describeSetupLink({ token: decodeURIComponent(m?.[1] ?? '') })
    expect(link).toMatchObject({ ok: true, value: { guildId: GUILD, discordUserId: TREASURER } })
    // Nothing went to the channel.
    expect(a.rest.channelPosts.map((p) => JSON.stringify(p.message))).not.toContain(expect.stringContaining('/setup/'))
  })

  it('an RPC failure while preparing the budget offer never turns the approval into an error: the policy is approved, no offer is sent', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    // A key of its own waiting for the passkey, and then the chain stops answering.
    await a.rolepay.policyKeys.provision({ guildId: GUILD, policyId, limit: 30_000_000n, periodSeconds: 86_400, expiresAt: Math.floor(a.clock.now().getTime() / 1000) + 86_400 })
    a.chain.keyState = async () => {
      throw new Error('HTTP request failed')
    }
    const approved = await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer, 'tok-approve-rpc'))
    expect(body(approved).type).toBe(7)
    expect(text(body(approved).data)).toContain('Policy: Help desk')
    expect(a.rest.followUps.filter((f) => f.reply.token === 'tok-approve-rpc')).toEqual([])
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.status).toBe('active')
  })

  it('an Approve from an outdated preview (the rule was edited since) is refused: nobody approves a version they did not see', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    await a.rolepay.policies.edit({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], policyId, name: 'Help desk, renamed' })
    const stale = await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    expect(isEphemeral(stale)).toBe(true)
    expect(body(stale).data?.content).toContain('version 2')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.status).toBe('draft')
  })

  it('Discard: the author or an approver', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    const d = await a.send(buttonClick(SCOPE, `policy:discard:${policyId}:1`, treasurer))
    expect(text(body(d).data)).toContain('Discarded')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.status).toBe('archived')
  })
})

describe('/rolepay policy new with a treasury channel', () => {
  const TREASURY_CHANNEL = '700000000000000009'
  const posts = (a: Harness, channelId: string) => a.rest.channelPosts.filter((p) => p.channelId === channelId)
  const setTreasury = (a: Harness, channelId: string) => a.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], channelId })

  /** /rolepay policy new from the proposer role with a treasury channel set: the preview's two messages and the policy. */
  async function routed(a: Harness) {
    await setTreasury(a, TREASURY_CHANNEL)
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', NEW, writer, 'tok-routed'))
    expect(body(d)).toEqual({ type: 5, data: {} }) // public deferral, as always
    const [there] = posts(a, TREASURY_CHANNEL)
    const [here] = posts(a, CHANNEL)
    return { there, here, policyId: /policy:approve:(pol_[A-Za-z0-9_]+):1/.exec(text(there?.message))?.[1] as string }
  }

  it('the preview with Approve policy and Discard goes to the treasury channel, this channel gets it without them and with its status, and only the author is told', async () => {
    const a = await ready()
    const { there, here, policyId } = await routed(a)
    expect(policyId).toMatch(/^pol_/)
    expect(text(there?.message)).toContain(`policy:discard:${policyId}:1`)
    expect(text(here?.message)).toContain('Policy draft: Help desk')
    expect(text(here?.message)).toContain(`<@${ALICE}>  3 AlphaUSD`)
    expect(text(here?.message)).toContain(`Waiting for a member with <@&${TREASURER_ROLE}> to approve.`)
    expect(here?.message.components).toEqual([])
    expect(text(here?.message)).not.toContain(TREASURY_CHANNEL)
    // The "thinking..." placeholder is removed; the author alone reads where it went.
    expect(a.rest.deletes.map((x) => x.token)).toEqual(['tok-routed'])
    const told = a.rest.followUps.at(-1)?.message
    expect(told?.content).toBe('Posted. A Treasurer approves it in the treasury channel; this channel shows the policy without its buttons.')
    expect((told?.flags ?? 0) & 64).toBe(64)
    expect(await a.notices.policyPreview(policyId)).toEqual({ version: 1, message: { channelId: TREASURY_CHANNEL, messageId: there?.messageId }, mirror: { channelId: CHANNEL, messageId: here?.messageId } })
  })

  it('approved in the treasury channel: the copy here says who approved it and when, at once, still without buttons', async () => {
    const a = await ready()
    const { there, here, policyId } = await routed(a)
    const refused = await a.send(buttonClick({ guildId: GUILD, channelId: TREASURY_CHANNEL, messageId: there?.messageId }, `policy:approve:${policyId}:1`, writer))
    expect(isEphemeral(refused)).toBe(true)
    expect(a.rest.channelEdits).toEqual([])
    const approved = await a.send(buttonClick({ guildId: GUILD, channelId: TREASURY_CHANNEL, messageId: there?.messageId }, `policy:approve:${policyId}:1`, treasurer))
    expect(body(approved).type).toBe(7)
    expect(text(body(approved).data)).toContain(`Active. Approved by <@${TREASURER}>`)
    // Only the copy is edited as the bot: the message pressed was updated by the answer itself.
    expect(a.rest.channelEdits.map((e) => [e.channelId, e.messageId])).toEqual([[CHANNEL, here?.messageId]])
    const copy = a.rest.channelEdits[0]?.message
    expect(text(copy)).toContain('Policy: Help desk')
    expect(text(copy)).toContain(`Active. Approved by <@${TREASURER}> <t:${Math.floor(a.clock.now().getTime() / 1000)}:R>, version 1.`)
    expect(copy?.components).toEqual([])
    // Still remembered: an edit on the dashboard later says it was replaced.
    expect((await a.notices.policyPreview(policyId))?.version).toBe(1)
  })

  it('discarded in the treasury channel: the copy here says who discarded it, and the preview is forgotten', async () => {
    const a = await ready()
    const { there, here, policyId } = await routed(a)
    await a.send(buttonClick({ guildId: GUILD, channelId: TREASURY_CHANNEL, messageId: there?.messageId }, `policy:discard:${policyId}:1`, treasurer))
    expect(a.rest.channelEdits.map((e) => [e.channelId, e.messageId])).toEqual([[CHANNEL, here?.messageId]])
    expect(text(a.rest.channelEdits[0]?.message)).toContain(`Discarded by <@${TREASURER}>.`)
    expect(await a.notices.policyPreview(policyId)).toBeNull()
  })

  it('approved from the private answer of /rolepay policy show: both of its messages say so', async () => {
    const a = await ready()
    const { there, here, policyId } = await routed(a)
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, treasurer, 'tok-show'))
    expect(text(a.rest.lastEdit('tok-show'))).toContain(`policy:approve:${policyId}:1`)
    await a.send(buttonClick({ guildId: GUILD, channelId: CHANNEL, messageId: '810000000000000077' }, `policy:approve:${policyId}:1`, treasurer))
    expect(a.rest.channelEdits.map((e) => [e.channelId, e.messageId])).toEqual([
      [TREASURY_CHANNEL, there?.messageId],
      [CHANNEL, here?.messageId],
    ])
    for (const e of a.rest.channelEdits) expect([e.channelId, text(e.message)]).toEqual([e.channelId, expect.stringContaining(`Active. Approved by <@${TREASURER}>`)])
    expect(text(a.rest.channelEdits[0]?.message)).not.toContain('policy:approve')
  })

  it('changed on the dashboard: approved, then edited (replaced by version 2), both messages follow; discarded or archived there too', async () => {
    const a = await ready()
    const { there, here, policyId } = await routed(a)
    const deps = { rolepay: a.rolepay, rest: a.rest, notices: a.notices, now: () => a.clock.now() }
    const actor = { guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE] }
    const edited = (messageId: string | undefined) => a.rest.channelEdits.filter((e) => e.messageId === messageId).at(-1)?.message

    expect((await a.rolepay.policies.approve({ ...actor, policyId, version: 1 })).ok).toBe(true)
    await updatePolicyMessages(deps, { guildId: GUILD, policyId, kind: 'approved', by: TREASURER })
    expect(text(edited(there?.messageId))).toContain(`Active. Approved by <@${TREASURER}>`)
    expect(text(edited(here?.messageId))).toContain(`Active. Approved by <@${TREASURER}>`)

    expect((await a.rolepay.policies.edit({ ...actor, policyId, name: 'Help desk, renamed' })).ok).toBe(true)
    await updatePolicyMessages(deps, { guildId: GUILD, policyId, kind: 'edited', by: TREASURER })
    for (const id of [there?.messageId, here?.messageId]) {
      expect(text(edited(id))).toContain('Replaced: Help desk, renamed')
      expect(text(edited(id))).toContain(`Version 1 was replaced by version 2, edited by <@${TREASURER}>.`)
      expect(edited(id)?.components).toEqual([])
    }
    // Settled: nothing later reaches these messages.
    expect(await a.notices.policyPreview(policyId)).toBeNull()
    const before = a.rest.channelEdits.length
    await a.rolepay.policies.archive({ ...actor, policyId })
    await updatePolicyMessages(deps, { guildId: GUILD, policyId, kind: 'archived', by: TREASURER })
    expect(a.rest.channelEdits).toHaveLength(before)

    for (const kind of ['discarded', 'archived'] as const) {
      const b = await ready()
      const two = await routed(b)
      const done = kind === 'discarded' ? await b.rolepay.policies.discard({ ...actor, policyId: two.policyId }) : await b.rolepay.policies.archive({ ...actor, policyId: two.policyId })
      expect(done.ok).toBe(true)
      await updatePolicyMessages({ ...deps, rolepay: b.rolepay, rest: b.rest, notices: b.notices }, { guildId: GUILD, policyId: two.policyId, kind, by: TREASURER })
      const says = kind === 'discarded' ? `Discarded by <@${TREASURER}>.` : 'Archived. It never runs again.'
      expect([kind, b.rest.channelEdits.map((e) => [e.messageId, text(e.message).includes(says), text(e.message).includes('policy:approve')])]).toEqual([
        kind,
        [
          [two.there?.messageId, true, false],
          [two.here?.messageId, true, false],
        ],
      ])
      expect(await b.notices.policyPreview(two.policyId)).toBeNull()
    }
  })

  it('without a treasury channel: the preview with Approve policy and Discard stays in this channel, as always, and nothing is remembered', async () => {
    const a = await ready()
    const { shown, policyId } = await newPolicy(a)
    expect(shown).toContain(`policy:approve:${policyId}:1`)
    expect(shown).toContain(`policy:discard:${policyId}:1`)
    expect(a.rest.channelPosts).toEqual([])
    expect(a.rest.followUps).toEqual([])
    expect(await a.notices.policyPreview(policyId)).toBeNull()
    // A change on the dashboard has nothing in Discord to update.
    await a.rolepay.policies.approve({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], policyId, version: 1 })
    await updatePolicyMessages({ rolepay: a.rolepay, rest: a.rest, notices: a.notices, now: () => a.clock.now() }, { guildId: GUILD, policyId, kind: 'approved', by: TREASURER })
    expect(a.rest.channelEdits).toEqual([])
  })

  it('typed in the treasury channel itself: one preview there, with its buttons, as always', async () => {
    const a = await ready()
    await setTreasury(a, CHANNEL)
    const { shown } = await newPolicy(a)
    expect(shown).toContain('policy:approve:')
    expect(a.rest.channelPosts).toEqual([])
  })

  it('Rolepay cannot post in the treasury channel: the preview with its buttons is the answer here, as without one, and that is reported', async () => {
    const a = await ready()
    await setTreasury(a, TREASURY_CHANNEL)
    a.rest.closedChannels.set(TREASURY_CHANNEL, 'forbidden')
    const { shown, policyId } = await newPolicy(a)
    expect(shown).toContain(`policy:approve:${policyId}:1`)
    expect(a.rest.channelPosts).toEqual([])
    expect(a.treasuryEvents).toEqual([{ kind: 'unavailable', guildId: GUILD, channelId: TREASURY_CHANNEL, reason: 'forbidden' }])
    expect(await a.notices.policyPreview(policyId)).toBeNull()
  })

  it('Rolepay cannot post its copy here: the answer is the copy, without buttons (they are in the treasury channel)', async () => {
    const a = await ready()
    await setTreasury(a, TREASURY_CHANNEL)
    a.rest.closedChannels.set(CHANNEL, 'forbidden')
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', NEW, writer, 'tok-nocopy'))
    expect(body(d).type).toBe(5)
    const there = posts(a, TREASURY_CHANNEL)[0]
    expect(text(there?.message)).toContain('policy:approve:')
    const answer = text(a.rest.lastEdit('tok-nocopy'))
    expect(answer).toContain('Policy draft: Help desk')
    expect(answer).not.toContain('policy:approve:')
    const policyId = /policy:approve:(pol_[A-Za-z0-9_]+):1/.exec(text(there?.message))?.[1] as string
    expect(await a.notices.policyPreview(policyId)).toEqual({ version: 1, message: { channelId: TREASURY_CHANNEL, messageId: there?.messageId }, mirror: null })
  })

  it('with none set, a channel named "treasury" is found, confirmed and used for the preview', async () => {
    const a = await ready()
    a.rest.channels.set(GUILD, [
      { id: HELP, name: 'help', type: 0 },
      { id: TREASURY_CHANNEL, name: 'treasury', type: 0 },
    ])
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy new', NEW, writer, 'tok-found'))
    expect(posts(a, TREASURY_CHANNEL).map((p) => p.message.content ?? (text(p.message).includes('policy:approve:') ? 'preview' : '?'))).toEqual([
      'Rolepay will post here what needs a Treasurer: policies and runs to approve, runs you can veto, and runs it holds.',
      'preview',
    ])
    expect(posts(a, CHANNEL)[0]?.message.components).toEqual([])
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { treasuryChannelId: TREASURY_CHANNEL, treasuryChannelSource: 'found' } })
  })
})

describe('the policy option typed by name instead of picked from autocomplete', () => {
  it('an exact name, in any case, resolves to the one policy with it, for mode, show, pause, resume and run_now', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a, { name: 'Test policy' })
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    const mode = await a.send(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: 'test POLICY', mode: 'autopilot', veto_minutes: 5 }, treasurer))
    expect(isEphemeral(mode)).toBe(false)
    expect(text(body(mode).data)).toContain('Autopilot is on')
    expect(text(body(await a.send(slashCommand(SCOPE, 'rolepay', 'policy pause', { policy: ' Test policy ' }, treasurer))).data)).toContain(`paused by <@${TREASURER}>`)
    expect(text(body(await a.send(slashCommand(SCOPE, 'rolepay', 'policy resume', { policy: 'test policy' }, treasurer))).data)).toContain(`resumed by <@${TREASURER}>`)
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: 'Test Policy' }, treasurer, 'tok-show-name'))
    expect(text(a.rest.lastEdit('tok-show-name'))).toContain(`Policy ${policyId}`)
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: 'TEST POLICY' }, treasurer, 'tok-now-name'))
    expect(text(a.rest.lastEdit('tok-now-name'))).toContain('posted')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && [p.value.status, p.value.mode, p.value.vetoWindowMinutes]).toEqual(['active', 'autopilot', 5])
    // The ID that autocomplete fills in still works as before.
    expect(text(body(await a.send(slashCommand(SCOPE, 'rolepay', 'policy pause', { policy: policyId }, treasurer))).data)).toContain('paused by')
  })

  it('a name two policies share lists both (archived ones do not count); no match says where to find them; nothing changes', async () => {
    const a = await ready()
    const one = await newPolicy(a, { name: 'Test policy' })
    const two = await newPolicy(a, { name: 'test policy' })
    await a.send(buttonClick(SCOPE, `policy:approve:${one.policyId}:1`, treasurer))
    const ambiguous = await a.send(slashCommand(SCOPE, 'rolepay', 'policy pause', { policy: 'Test policy' }, treasurer))
    expect(isEphemeral(ambiguous)).toBe(true)
    const said = body(ambiguous).data?.content as string
    expect(said).toContain('More than one policy here is called')
    expect(said).toContain(`\`${one.policyId}\` (active)`)
    expect(said).toContain(`\`${two.policyId}\` (draft)`)
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId: one.policyId })
    expect(p.ok && p.value.status).toBe('active')
    // Once one of them is archived, the name is the other's alone.
    await a.send(buttonClick(SCOPE, `policy:discard:${two.policyId}:1`, treasurer))
    expect(text(body(await a.send(slashCommand(SCOPE, 'rolepay', 'policy pause', { policy: 'test policy' }, treasurer))).data)).toContain('paused by')
    for (const sub of ['policy mode', 'policy show', 'policy pause', 'policy resume', 'policy run_now']) {
      const d = await a.send(slashCommand(SCOPE, 'rolepay', sub, { policy: 'No such policy', mode: 'propose' }, treasurer))
      expect([sub, isEphemeral(d), body(d).data?.content]).toEqual([sub, true, 'There is no policy with that ID in this server. `/rolepay policy list` shows them.'])
    }
  })
})

describe('/rolepay policy list, show, pause, resume, mode', () => {
  it('list and show answer only the caller; show reads who it applies to right now', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    const list = await a.send(slashCommand(SCOPE, 'rolepay', 'policy list', {}, treasurer))
    expect(isEphemeral(list)).toBe(true)
    expect(text(body(list).data)).toContain(`Help desk`)
    expect(text(body(list).data)).toContain(policyId)
    const show = await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, treasurer, 'tok-show'))
    expect(body(show)).toEqual({ type: 5, data: { flags: 64 } })
    expect(text(a.rest.lastEdit('tok-show'))).toContain(`<@${ALICE}>  3 AlphaUSD`)
    const nobody = await a.send(slashCommand(SCOPE, 'rolepay', 'policy list', {}, { userId: BOB, roles: [MODS_ROLE] }))
    expect(isEphemeral(nobody)).toBe(true)
    expect(text(body(nobody).data)).not.toContain(policyId)
  })

  it("show says whose budget pays the policy: the bot key's, shared; then its own, read from the chain (chain-enforced)", async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, treasurer, 'tok-shared'))
    const shared = a.rest.lastEdit('tok-shared')
    expect(text(shared)).toContain("Shared: it pays from the bot key's budget, with manual runs, AI-proposed runs and other policies.")
    // The approver gets the treasury page link in this private answer.
    expect(text(shared)).toContain('Give this policy its own budget')
    expect(text(shared)).toMatch(new RegExp(`https://rolepay\\.test/setup/[^/"]+/policies/${policyId}`))

    // The treasury gives it 30 a week; 10 is spent.
    const ref = { guildId: GUILD, policyId }
    await a.rolepay.policyKeys.provision({ ...ref, limit: 30_000_000n, periodSeconds: 7 * 86_400, expiresAt: Math.floor(a.clock.now().getTime() / 1000) + 30 * 86_400 })
    const auth = await a.rolepay.policyKeys.authorize({ ...ref, root: a.chain.rootSigner(TREASURY) })
    if (!auth.ok) throw new Error(JSON.stringify(auth.error))
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, treasurer, 'tok-own'))
    const own = text(a.rest.lastEdit('tok-own'))
    expect(own).toContain('Own budget: 30 of 30 AlphaUSD left this period (chain-enforced)')
    expect(own).toContain('Manage its budget')
    // A reader without the approver role sees the budget, never a treasury link.
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, writer, 'tok-reader'))
    const read = text(a.rest.lastEdit('tok-reader'))
    expect(read).toContain('Own budget: 30 of 30 AlphaUSD left this period (chain-enforced)')
    expect(read).not.toContain('/setup/')

    await a.rolepay.policyKeys.revoke({ ...ref, root: a.chain.rootSigner(TREASURY), actor: TREASURER })
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, treasurer, 'tok-revoked'))
    expect(text(a.rest.lastEdit('tok-revoked'))).toContain('Own budget: its key is revoked, so it pays nothing until a treasurer gives it a new one. It never falls back to the bot key.')
  })

  it('autocomplete offers the policies by name', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    const d = await a.send(autocomplete(SCOPE, 'rolepay', 'policy show', { policy: 'help' }, 'policy', treasurer))
    expect(body(d)).toEqual({ type: 8, data: { choices: [{ name: 'Help desk (draft)', value: policyId }] } })
  })

  it('pause, resume and mode: the approver role only, answered publicly so everyone sees the change', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    for (const sub of ['policy pause', 'policy resume', 'policy mode']) {
      const d = await a.send(slashCommand(SCOPE, 'rolepay', sub, { policy: policyId, mode: 'autopilot' }, writer))
      expect([sub, isEphemeral(d)]).toEqual([sub, true])
    }
    const paused = await a.send(slashCommand(SCOPE, 'rolepay', 'policy pause', { policy: policyId }, treasurer))
    expect(isEphemeral(paused)).toBe(false)
    expect(text(body(paused).data)).toContain(`paused by <@${TREASURER}>`)
    const resumed = await a.send(slashCommand(SCOPE, 'rolepay', 'policy resume', { policy: policyId }, treasurer))
    expect(text(body(resumed).data)).toContain(`resumed by <@${TREASURER}>`)
    const auto = await a.send(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_hours: 2 }, treasurer))
    expect(isEphemeral(auto)).toBe(false)
    expect(text(body(auto).data)).toContain('Autopilot is on')
    expect(text(body(auto).data)).toContain('2 hours')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value).toMatchObject({ mode: 'autopilot', vetoWindowMinutes: 120, autopilot: { enabledBy: TREASURER } })
  })

  it('veto_minutes and run_now are demo controls: refused without ROLEPAY_DEMO_CONTROLS, even with the dev shortcuts on', async () => {
    const a = await ready({ config: { devShortcuts: true, demoControls: false } })
    const { policyId } = await newPolicy(a)
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    const minutes = await a.send(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 2 }, treasurer))
    expect(isEphemeral(minutes)).toBe(true)
    expect(body(minutes).data?.content).toContain('demo control')
    expect(body(minutes).data?.content).toContain('ROLEPAY_DEMO_CONTROLS')
    const now = await a.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: policyId }, treasurer))
    expect(body(now).data?.content).toContain('demo control')
    expect((await a.rolepay.policies.listRuns({ guildId: GUILD, policyId })).length).toBe(0)
    // Off the Moderato testnet they do not exist, whatever the flag says.
    const m = await ready({ config: { network: 'mainnet', demoControls: true } })
    const mainnet = await newPolicy(m)
    expect(body(await m.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: mainnet.policyId }, treasurer))).data?.content).toContain('demo control')
  })

  it('with only the demo controls on: run_now and veto_minutes work for the approver role, never for anyone else, and the dev shortcuts stay off', async () => {
    const a = await ready({ config: { devShortcuts: false, demoControls: true } })
    const { policyId } = await newPolicy(a)
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    const notApprover = await a.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: policyId }, writer))
    expect(isEphemeral(notApprover)).toBe(true)
    expect(body(notApprover).data?.content).toMatch(/Only members with/)
    expect(text(await a.send(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 1 }, writer)))).toMatch(/Only members with/)
    const minutes = await a.send(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 1 }, treasurer))
    expect(isEphemeral(minutes)).toBe(false)
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.vetoWindowMinutes).toBe(1)
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: policyId }, treasurer, 'tok-demo-now'))
    expect(text(a.rest.lastEdit('tok-demo-now'))).toContain('posted')
    expect((await a.rolepay.policies.listRuns({ guildId: GUILD, policyId })).map((r) => r.status)).toEqual(['scheduled'])
    const treasury = await a.send(slashCommand(SCOPE, 'rolepay', 'setup', { treasury: '0x9999999999999999999999999999999999999999' }, { ...treasurer, manageGuild: true }))
    expect(body(treasury).data?.content).toMatch(/dev shortcut/i)
  })
})

describe('autopilot runs in Discord', () => {
  it('run_now (a demo control) posts the run with its veto window and a Veto button; Veto is for the approver role and cancels it', async () => {
    const a = await ready()
    const { policyId } = await newPolicy(a)
    await a.send(buttonClick(SCOPE, `policy:approve:${policyId}:1`, treasurer))
    await a.send(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 5 }, treasurer))
    const now = await a.send(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: policyId }, treasurer, 'tok-now'))
    expect(body(now)).toEqual({ type: 5, data: { flags: 64 } })
    expect(text(a.rest.lastEdit('tok-now'))).toContain('posted')
    const posted = a.rest.channelPosts.at(-1)
    expect(posted?.channelId).toBe(CHANNEL)
    const shown = text(posted?.message)
    expect(shown).toContain('unless vetoed')
    expect(shown).toContain('Help desk')
    const veto = /policy-run:veto:(prun_[A-Za-z0-9_]+)/.exec(shown)?.[1] as string
    expect(veto).toMatch(/^prun_/)

    const refused = await a.send(buttonClick(SCOPE, `policy-run:veto:${veto}`, writer))
    expect(isEphemeral(refused)).toBe(true)
    const vetoed = await a.send(buttonClick(SCOPE, `policy-run:veto:${veto}`, treasurer))
    expect(body(vetoed).type).toBe(7)
    expect(text(body(vetoed).data)).toContain(`Vetoed by <@${TREASURER}>`)
    const run = await a.rolepay.policies.getRun({ guildId: GUILD, policyRunId: veto })
    expect(run.ok && run.value.status).toBe('vetoed')
  })
})
