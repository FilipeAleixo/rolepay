import { TESTNET_TOKENS } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADDR, ALICE, BOB, GUILD } from '../../test/fixtures.js'
import { slashCommand } from '../testing/interactions.js'

const { alpha_usd: ALPHA, beta_usd: BETA, path_usd: PATH } = TESTNET_TOKENS
const prefer = (token: string, userId = ALICE) => slashCommand(SCOPE, 'payee', 'prefer', { token }, { userId })
const preferenceOf = async (a: Awaited<ReturnType<typeof appHarness>>, userId = ALICE) => {
  const p = await a.rolepay.payees.get({ guildId: GUILD, discordUserId: userId })
  return p.ok ? p.value.preferredToken : 'not registered'
}

describe('/payee prefer token:', () => {
  it('a registered payee picks BetaUSD: saved, and told only them that runs swap AlphaUSD into it on the DEX in the same transaction', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    await a.rolepay.communities.setPreferredTokens({ guildId: GUILD, enabled: true })
    await a.registerPayee(ALICE, ADDR.alice)
    const d = await a.send(prefer(BETA))
    expect(isEphemeral(d)).toBe(true)
    expect(await preferenceOf(a)).toBe(BETA)
    expect(text(body(d))).toContain('BetaUSD')
    expect(text(body(d))).toMatch(/swap/i)
  })

  it('with preferred stablecoins off in the server, the choice is kept and the reply says everyone is paid in AlphaUSD until a treasurer turns them on', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    await a.registerPayee(ALICE, ADDR.alice)
    const d = await a.send(prefer(BETA))
    expect(await preferenceOf(a)).toBe(BETA)
    expect(text(body(d))).toMatch(/AlphaUSD/)
    expect(text(body(d))).toMatch(/turn/i)
  })

  it('"default" goes back to the payout token', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    await a.registerPayee(ALICE, ADDR.alice)
    await a.send(prefer(BETA))
    const d = await a.send(prefer('default'))
    expect(await preferenceOf(a)).toBeNull()
    expect(text(body(d))).toContain('AlphaUSD')
  })

  it('someone not registered yet is pointed to /payee link; a token the server cannot pay in, or not an address, is refused with the choices', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    expect(text(body(await a.send(prefer(BETA, BOB))))).toContain('/payee link')
    await a.registerPayee(ALICE, ADDR.alice)
    const refused = await a.send(prefer(PATH))
    expect(isEphemeral(refused)).toBe(true)
    expect(text(body(refused))).toMatch(/AlphaUSD, BetaUSD, ThetaUSD/)
    expect(await preferenceOf(a)).toBeNull()
    expect(isEphemeral(await a.send(prefer('lots of money')))).toBe(true)
    expect(await preferenceOf(a)).toBeNull()
  })

  it('in a server that has not set up Rolepay, says so', async () => {
    const a = await appHarness()
    expect(text(body(await a.send(prefer(ALPHA))))).toMatch(/\/rolepay setup/)
  })
})
