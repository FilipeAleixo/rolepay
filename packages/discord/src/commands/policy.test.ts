import { emptyCriteria } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, BOB, CAROL, CHANNEL, GUILD, MODS_ROLE, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
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
})

describe('/rolepay policy new schedule:daily (a demo control: the judge demo)', () => {
  it('with the demo controls on, a daily policy is drafted (no weekday or day needed) and its preview says every day at the hour', async () => {
    const a = await ready()
    const { shown, policyId } = await newPolicy(a, { schedule: 'daily', weekday: undefined as unknown as string })
    expect(shown).toContain('every day at 18:00 (UTC)')
    expect(shown).toContain('First run after approval')
    const p = await a.rolepay.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.schedule).toEqual({ kind: 'daily', hour: 18, timezone: 'UTC' })
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
