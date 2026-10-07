import { describe, expect, it } from 'vitest'
import { CONFIG, SCOPE, appHarness, body, isEphemeral } from '../../test/app.js'
import { ADMIN, ALICE } from '../../test/fixtures.js'
import { buttonClick, ping, slashCommand } from '../testing/interactions.js'

describe('createDispatcher (the interaction router)', () => {
  it('answers PING with PONG', async () => {
    const a = await appHarness()
    expect(body(await a.send(ping()))).toEqual({ type: 1 })
  })

  it('reports shapes it cannot read as invalid (the endpoint answers 400)', async () => {
    const a = await appHarness()
    expect((await a.dispatch({ type: 42 })).kind).toBe('invalid')
  })

  it('outside a server it asks to be used in one', async () => {
    const a = await appHarness()
    const d = await a.send(slashCommand({ guildId: null }, 'payee', 'link', {}, { userId: ALICE }))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/inside a server/)
  })

  it('an unknown command or button gets a polite ephemeral answer', async () => {
    const a = await appHarness()
    const cmd = await a.send(slashCommand(SCOPE, 'payrun', 'teleport', {}, { userId: ADMIN, manageGuild: true }))
    expect(isEphemeral(cmd) && body(cmd).data?.content).toMatch(/do not know/)
    const btn = await a.send(buttonClick(SCOPE, 'something:else', { userId: ADMIN }))
    expect(isEphemeral(btn) && body(btn).data?.content).toMatch(/do not know/)
  })

  it('a handler that throws ends in an ephemeral apology, and the error is reported', async () => {
    const a = await appHarness()
    a.rolepay.payees.issueLink = async () => {
      throw new Error('database is down')
    }
    const d = await a.send(slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/went wrong/)
    expect(a.errors).toHaveLength(1)
  })

  it('routes /payee link to its handler (smoke: the claim URL comes back)', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const d = await a.send(slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }))
    expect(JSON.stringify(body(d))).toContain(CONFIG.claimBaseUrl)
  })
})
