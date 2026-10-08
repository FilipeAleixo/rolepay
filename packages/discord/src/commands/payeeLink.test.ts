import { describe, expect, it } from 'vitest'
import { CONFIG, SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADDR, ALICE, GUILD } from '../../test/fixtures.js'
import { slashCommand } from '../testing/interactions.js'

const tokenIn = (s: string) => new RegExp(`${CONFIG.claimBaseUrl}/([A-Za-z0-9_-]+)`).exec(s)?.[1]

describe('/payee link', () => {
  it('in a server that has not set up rolepay, says so', async () => {
    const a = await appHarness()
    const d = await a.send(slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/\/rolepay setup/)
  })

  it('replies only to the caller with a one-time claim link that is really theirs', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const d = await a.send(slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }))
    expect(isEphemeral(d)).toBe(true)
    const token = tokenIn(text(body(d)))
    expect(token).toBeDefined()
    const described = await a.rolepay.payees.describeLink({ token: token as string })
    expect(described).toMatchObject({ ok: true, value: { guildId: GUILD, discordUserId: ALICE } })
    // The username Discord signed into the interaction names their passkey on the claim page.
    expect(described).toMatchObject({ ok: true, value: { discordUsername: 'user001' } })
    expect(text(body(d))).toMatch(/<t:\d+:R>/) // when it expires
    expect(text(body(d))).toMatch(/once/)
    expect(text(body(d))).toContain('/payee prefer') // where to choose the stablecoin they are paid in
  })

  it('tells an already registered payee which address they are paid at', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    await a.registerPayee(ALICE, ADDR.alice)
    const d = await a.send(slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }))
    expect(text(body(d))).toContain('0x1111…1111')
  })
})
