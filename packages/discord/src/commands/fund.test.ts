import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, BOB, GUILD, MODS_ROLE, TOKEN, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { slashCommand } from '../testing/interactions.js'

const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }
const ADDRESS_1 = '0x58e21090fdfdfdfdfdfdfdfdfdfd000000000001'
const ADDRESS_2 = '0x58e21090fdfdfdfdfdfdfdfdfdfd000000000002'

async function ready() {
  const a = await appHarness()
  await a.setupCommunity()
  await a.setUpDepositAddresses()
  return a
}
const sources = async (a: Awaited<ReturnType<typeof appHarness>>) => {
  const s = await a.rolepay.funding.status({ guildId: GUILD })
  return s.ok ? s.value.sources.map((x) => x.source) : []
}

describe('/rolepay fund new', () => {
  it('the approver role creates a named funding source and gets its deposit address, posted for the channel to share', async () => {
    const a = await ready()
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Q4 bounty sponsor: Acme DAO' }, treasurer))
    expect(isEphemeral(d)).toBe(false)
    const message = body(d).data
    expect(message?.content).toContain('**Q4 bounty sponsor\\: Acme DAO**')
    expect(message?.content).toContain(`\`${ADDRESS_1}\``)
    expect(message?.content).toMatch(/TIP-20 stablecoins on Tempo/)
    expect(text(message?.components)).toContain(`https://rolepay.test/dashboard/${GUILD}/funding`)
    expect(text(message?.components)).toContain(`https://explore.testnet.tempo.xyz/address/${ADDRESS_1}`)
    expect(message?.allowed_mentions).toEqual({ parse: [] })
    expect((await sources(a)).map((s) => [s.name, s.createdBy, s.depositAddress])).toEqual([['Q4 bounty sponsor: Acme DAO', TREASURER, ADDRESS_1]])
  })

  it('refuses anyone without the approver role (Manage Server is not enough), and creates nothing', async () => {
    const a = await ready()
    for (const who of [{ userId: BOB, roles: [MODS_ROLE] }, { userId: ADMIN, manageGuild: true }]) {
      const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Mine' }, who))
      expect(isEphemeral(d)).toBe(true)
      expect(body(d).data?.content).toContain(`<@&${TREASURER_ROLE}>`)
    }
    expect(await sources(a)).toEqual([])
  })

  it('says deposit addresses are not set up yet, and where to do it', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Judges pool' }, treasurer))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/not set up.*\/rolepay setup/s)
  })

  it('a name already in use answers with that source and its address, privately', async () => {
    const a = await ready()
    await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Judges pool' }, treasurer))
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'judges pool' }, treasurer))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toContain(ADDRESS_1)
    expect(await sources(a)).toHaveLength(1)
  })

  it('escapes a hostile name and pings nobody', async () => {
    const a = await ready()
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: '@everyone **[win](https://evil.example)**' }, treasurer))
    const content = body(d).data?.content ?? ''
    expect(content).toContain('\\@everyone \\*\\*\\[win\\]\\(https\\://evil.example\\)\\*\\*')
    expect(body(d).data?.allowed_mentions).toEqual({ parse: [] })
  })

  it('refuses a name with a line break', async () => {
    const a = await ready()
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'two\nlines' }, treasurer))
    expect(isEphemeral(d)).toBe(true)
    expect(await sources(a)).toEqual([])
  })
})

describe('/rolepay fund list', () => {
  it('lists each source with its address and what it received, for admins and treasurers, privately', async () => {
    const a = await ready()
    await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Acme DAO' }, treasurer))
    await a.send(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Judges pool' }, treasurer))
    a.fundingChain.transfer({ token: TOKEN, from: '0x5555555555555555555555555555555555555555', to: ADDRESS_2, amount: 2_500_000n })
    await a.rolepay.funding.scan()
    for (const who of [treasurer, { userId: ADMIN, manageGuild: true }]) {
      const d = await a.send(slashCommand(SCOPE, 'rolepay', 'fund list', {}, who))
      expect(isEphemeral(d)).toBe(true)
      const content = body(d).data?.content ?? ''
      expect(content).toContain('**Acme DAO**')
      expect(content).toContain(ADDRESS_1)
      expect(content).toContain('nothing yet')
      expect(content).toContain('**Judges pool**')
      expect(content).toContain('2.5 AlphaUSD in 1 deposit')
    }
    const nobody = await a.send(slashCommand(SCOPE, 'rolepay', 'fund list', {}, { userId: BOB, roles: [MODS_ROLE] }))
    expect(body(nobody).data?.content).toMatch(/Manage Server or the approver role/)
  })

  it('says when there are no sources yet, and when deposit addresses are not set up', async () => {
    const a = await ready()
    expect(body(await a.send(slashCommand(SCOPE, 'rolepay', 'fund list', {}, treasurer))).data?.content).toMatch(/No funding sources yet.*\/rolepay fund new/s)
    const b = await appHarness()
    await b.setupCommunity()
    expect(body(await b.send(slashCommand(SCOPE, 'rolepay', 'fund list', {}, treasurer))).data?.content).toMatch(/not set up/)
  })
})
