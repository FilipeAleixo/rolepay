import type { Run } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, BOB, CAROL, GUILD, MODS_ROLE, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { usd } from '../../test/harness.js'
import { buttonClick, slashCommand } from '../testing/interactions.js'

const admin = { userId: ADMIN, manageGuild: true }
const DAVE = '200000000000000004' // not registered

async function ready() {
  const a = await appHarness()
  await a.setupCommunity()
  await a.registerAll()
  return a
}

async function newRun(a: Awaited<ReturnType<typeof ready>>, values: Record<string, string | undefined>, who: { userId: string; roles?: string[]; manageGuild?: boolean } = admin) {
  const token = `tok-new-${Math.random()}`
  const d = await a.send(slashCommand(SCOPE, 'rolepay', 'new', values, who, token))
  return { d, token, final: a.rest.lastEdit(token) }
}

const latestRun = async (a: Awaited<ReturnType<typeof ready>>): Promise<Run | undefined> => (await a.rolepay.payRuns.list({ guildId: GUILD }))[0]
const linesOf = (r: Run | undefined) => r?.lines.map((l) => [l.payeeDiscordId, l.amount])

describe('/rolepay new', () => {
  it('needs Manage Server or the approver role', async () => {
    const a = await ready()
    const { d } = await newRun(a, { amount: '10', users: `<@${ALICE}>` }, { userId: CAROL })
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/Manage Server or the approver role/)
    expect(await latestRun(a)).toBeUndefined()
  })

  it('a treasurer without Manage Server may create runs', async () => {
    const a = await ready()
    await newRun(a, { amount: '10', users: `<@${ALICE}>` }, { userId: TREASURER, roles: [TREASURER_ROLE] })
    expect((await latestRun(a))?.createdBy).toBe(TREASURER)
  })

  it('in a server without setup, says so', async () => {
    const a = await appHarness()
    const { d } = await newRun(a, { amount: '10', users: `<@${ALICE}>` })
    expect(body(d).data?.content).toMatch(/\/rolepay setup/)
  })

  it('refuses a bad amount, or no recipients, at once and only to the caller', async () => {
    const a = await ready()
    for (const values of [{ amount: '1,5', users: `<@${ALICE}>` }, { amount: '0', users: `<@${ALICE}>` }, { amount: '10' }]) {
      const { d } = await newRun(a, values)
      expect(isEphemeral(d)).toBe(true)
      expect(body(d).data?.content).toMatch(/amount|who to pay/)
    }
    expect(await latestRun(a)).toBeUndefined()
  })

  it('creates a run for listed users, submits it, and posts the review publicly with Approve and Cancel', async () => {
    const a = await ready()
    const { d, final } = await newRun(a, { amount: '10', users: `<@${ALICE}> <@${BOB}>=40`, note: 'October mods' })
    expect(body(d)).toEqual({ type: 5, data: {} }) // public deferral
    const r = await latestRun(a)
    expect(r?.status).toBe('pending_approval')
    expect(r?.createdBy).toBe(ADMIN)
    expect(r?.note).toBe('October mods')
    expect(linesOf(r)).toEqual([
      [ALICE, usd('10')],
      [BOB, usd('40')],
    ])
    expect(text(final)).toContain(`rolepay:approve:${r?.id}`)
    expect(text(final)).toContain(`rolepay:cancel:${r?.id}`)
    expect(text(final)).toContain(`<@&${TREASURER_ROLE}>`) // who may approve
    expect(text(final)).toContain('50 AlphaUSD')
  })

  it('pays every registered payee holding the role (looked up through the member port)', async () => {
    const a = await ready()
    a.rest.setMember(GUILD, ALICE, [MODS_ROLE])
    a.rest.setMember(GUILD, BOB, [])
    a.rest.setMember(GUILD, CAROL, [MODS_ROLE])
    await newRun(a, { amount: '5', role: MODS_ROLE })
    expect(linesOf(await latestRun(a))).toEqual([
      [ALICE, usd('5')],
      [CAROL, usd('5')],
    ])
  })

  it('combines a role with listed users; a listed amount wins', async () => {
    const a = await ready()
    a.rest.setMember(GUILD, ALICE, [MODS_ROLE])
    a.rest.setMember(GUILD, CAROL, [MODS_ROLE])
    await newRun(a, { amount: '5', role: MODS_ROLE, users: `<@${CAROL}>=7 <@${BOB}>` })
    expect(linesOf(await latestRun(a))).toEqual([
      [CAROL, usd('7')],
      [BOB, usd('5')],
      [ALICE, usd('5')],
    ])
  })

  it('names the people who have not registered, privately, and removes the public placeholder', async () => {
    const a = await ready()
    const { token } = await newRun(a, { amount: '10', users: `<@${ALICE}> <@${DAVE}>` })
    expect(a.rest.deletes.map((r) => r.token)).toEqual([token])
    const followUp = a.rest.followUps.at(-1)?.message
    expect(followUp?.flags).toBe(64)
    expect(followUp?.content).toContain(`<@${DAVE}>`)
    expect(followUp?.content).toMatch(/\/payee link/)
    expect(await latestRun(a)).toBeUndefined()
  })

  it('a role nobody registered holds explains how to fix it', async () => {
    const a = await ready()
    await newRun(a, { amount: '10', role: MODS_ROLE })
    expect(a.rest.followUps.at(-1)?.message.content).toMatch(/No registered payee has/)
  })
})

describe('/rolepay new with a treasury channel', () => {
  const TREASURY_CHANNEL = '700000000000000009'
  const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }
  const posts = (a: Awaited<ReturnType<typeof ready>>, channelId: string) => a.rest.channelPosts.filter((p) => p.channelId === channelId)

  it('the review with Approve and Cancel goes to the treasury channel, this channel gets it without buttons, and only the caller is told', async () => {
    const a = await ready()
    await a.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], channelId: TREASURY_CHANNEL })
    const { d, token } = await newRun(a, { amount: '10', users: `<@${ALICE}>`, note: 'October mods' })
    expect(body(d)).toEqual({ type: 5, data: {} }) // public deferral, as always
    const r = await latestRun(a)
    const [there] = posts(a, TREASURY_CHANNEL)
    const [here] = posts(a, SCOPE.channelId)
    expect(text(there?.message)).toContain(`rolepay:approve:${r?.id}`)
    expect(text(there?.message)).toContain(`rolepay:cancel:${r?.id}`)
    expect(text(here?.message)).toContain('Pay run awaiting approval')
    expect(text(here?.message)).toContain(`Waiting for a member with <@&${TREASURER_ROLE}> to approve.`)
    expect(here?.message.components).toEqual([])
    expect(text(here?.message)).not.toContain(TREASURY_CHANNEL)
    // The "thinking..." placeholder is removed; the caller alone reads where it went.
    expect(a.rest.deletes.map((x) => x.token)).toEqual([token])
    expect(text(a.rest.followUps.at(-1)?.message)).toContain('A Treasurer approves it in the treasury channel')
    expect((a.rest.followUps.at(-1)?.message.flags ?? 0) & 64).toBe(64)
    expect(await a.notices.message(r?.id as string)).toEqual({ channelId: TREASURY_CHANNEL, messageId: there?.messageId })
    expect(await a.notices.mirror(r?.id as string)).toEqual({ channelId: SCOPE.channelId, messageId: here?.messageId })

    // Approved in the treasury channel: the copy here says so at once.
    const approved = await a.send(buttonClick({ guildId: GUILD, channelId: TREASURY_CHANNEL }, `rolepay:approve:${r?.id}`, treasurer))
    expect(text(body(approved))).toContain('Approved, paying')
    const edit = a.rest.channelEdits.at(-1)
    expect(edit?.messageId).toBe(here?.messageId)
    expect(text(edit?.message)).toContain('Approved, paying')
  })

  it('cancelled in the treasury channel: the copy here says who cancelled it', async () => {
    const a = await ready()
    await a.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], channelId: TREASURY_CHANNEL })
    await newRun(a, { amount: '10', users: `<@${ALICE}>` })
    const r = await latestRun(a)
    await a.send(buttonClick({ guildId: GUILD, channelId: TREASURY_CHANNEL }, `rolepay:cancel:${r?.id}`, treasurer))
    expect(text(a.rest.channelEdits.at(-1)?.message)).toContain(`Cancelled by <@${TREASURER}>`)
  })

  it('the command run in the treasury channel itself: one review there, with its buttons, as always', async () => {
    const a = await ready()
    await a.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], channelId: SCOPE.channelId })
    const { final } = await newRun(a, { amount: '10', users: `<@${ALICE}>` })
    expect(a.rest.channelPosts).toEqual([])
    expect(text(final)).toContain('rolepay:approve:')
  })

  it('Rolepay cannot post in the treasury channel: the review with its buttons is the answer here, as without one, and that is reported', async () => {
    const a = await ready()
    await a.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], channelId: TREASURY_CHANNEL })
    a.rest.closedChannels.set(TREASURY_CHANNEL, 'forbidden')
    const { final } = await newRun(a, { amount: '10', users: `<@${ALICE}>` })
    expect(text(final)).toContain('rolepay:approve:')
    expect(a.rest.channelPosts).toEqual([])
    expect(a.treasuryEvents).toEqual([{ kind: 'unavailable', guildId: GUILD, channelId: TREASURY_CHANNEL, reason: 'forbidden' }])
  })

  it('Rolepay cannot post its copy here: the answer is the copy, without buttons (Approve is in the treasury channel)', async () => {
    const a = await ready()
    await a.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER, actorRoleIds: [TREASURER_ROLE], channelId: TREASURY_CHANNEL })
    a.rest.closedChannels.set(SCOPE.channelId, 'forbidden')
    const { final } = await newRun(a, { amount: '10', users: `<@${ALICE}>` })
    expect(text(posts(a, TREASURY_CHANNEL)[0]?.message)).toContain('rolepay:approve:')
    expect(text(final)).toContain('Pay run awaiting approval')
    expect(text(final)).not.toContain('rolepay:approve:')
  })

  it('with none set, a channel named "treasury" is found, confirmed and used for the first run', async () => {
    const a = await ready()
    a.rest.channels.set(GUILD, [{ id: TREASURY_CHANNEL, name: 'treasury', type: 0 }])
    await newRun(a, { amount: '10', users: `<@${ALICE}>` })
    expect(posts(a, TREASURY_CHANNEL).map((p) => p.message.content ?? 'run')).toEqual(['Rolepay will post here what needs a Treasurer: runs to approve, runs you can veto, and runs it holds.', 'run'])
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { treasuryChannelId: TREASURY_CHANNEL, treasuryChannelSource: 'found' } })
  })
})
