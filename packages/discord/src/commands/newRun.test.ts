import type { Run } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, BOB, CAROL, GUILD, MODS_ROLE, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { usd } from '../../test/harness.js'
import { slashCommand } from '../testing/interactions.js'

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
