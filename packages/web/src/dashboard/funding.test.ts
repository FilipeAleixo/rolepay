import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'

const EXPLORER = 'https://explore.testnet.tempo.xyz'
const PATH_USD = '0x20c0000000000000000000000000000000000000'
const SPONSOR = '0x5555555555555555555555555555555555555555'
/** Visible text, roughly: tags dropped, whitespace collapsed, entities kept. */
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

async function seeded() {
  const h = dashboardHarness()
  await h.community()
  return h
}

describe('the Funding page', () => {
  it('is in the navigation, and says how to set deposit addresses up when a community has none (no form, nothing else)', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const overview = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(overview).toContain(`<a href="/dashboard/${GUILD}/funding">Funding</a>`)
    const res = await browser.get(`/dashboard/${GUILD}/funding`)
    expect(res.status).toBe(200)
    const t = text(await res.text())
    expect(t).toContain('Deposit addresses are not set up')
    expect(t).toContain('/rolepay setup')
    expect(t).not.toContain('New funding source')
  })

  it('lists each source with its full deposit address, a QR code, what it brought in, and every deposit with its transaction', async () => {
    const h = await seeded()
    await h.depositAddresses()
    const acme = await h.fundingSource('Q4 bounty sponsor: Acme DAO')
    const judges = await h.fundingSource('Judges pool')
    const first = await h.deposit(acme.depositAddress, '5')
    const second = await h.deposit(judges.depositAddress, '2.5', { token: PATH_USD })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/funding`)).text()
    const t = text(html)
    expect(t).toContain('Q4 bounty sponsor: Acme DAO')
    expect(t).toContain('Judges pool')
    expect(html).toContain(`<code>${acme.depositAddress}</code>`)
    expect(html).toContain(`<code>${judges.depositAddress}</code>`)
    expect(html).toContain(`aria-label="QR code of the deposit address ${acme.depositAddress}"`)
    expect(t).toMatch(/Received 5 AlphaUSD in 1 deposit/)
    expect(t).toMatch(/Received 2.5 pathUSD in 1 deposit/)
    expect(html).toContain(`href="${EXPLORER}/tx/${first.txHash}"`)
    expect(html).toContain(`href="${EXPLORER}/tx/${second.txHash}"`)
    expect(html).toContain(`href="${EXPLORER}/address/${SPONSOR}"`)
    expect(t).toMatch(/Funded this month 7.5 USD \(5 AlphaUSD, 2.5 pathUSD\) from 2 sources/)
    expect(t).toContain('Only TIP-20 stablecoins on Tempo')
    // A member reads; only the Treasurer role creates sources.
    expect(t).not.toContain('New funding source')
  })

  it('the Treasurer role creates a source from the page; the new address shows at once', async () => {
    const h = await seeded()
    await h.depositAddresses()
    const { browser } = await h.signIn(identity(TREASURER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}/funding`)).text())).toContain('New funding source')
    const res = await browser.act(`/dashboard/${GUILD}/funding/sources`, { name: 'Judges pool' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/dashboard/${GUILD}/funding?done=source_created`)
    const html = await (await browser.get(res.headers.get('location') as string)).text()
    expect(text(html)).toContain('Funding source created')
    expect(html).toContain('<code>0x58e21090fdfdfdfdfdfdfdfdfdfd000000000001</code>')
    const status = await h.rolepay.funding.status({ guildId: GUILD })
    expect(status.ok && status.value.sources.map((s) => [s.source.name, s.source.createdBy])).toEqual([['Judges pool', TREASURER.id]])
  })

  it('says why a source was not created: a name in use, an empty name, deposit addresses not set up', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const notSetUp = await browser.act(`/dashboard/${GUILD}/funding/sources`, { name: 'Judges pool' })
    expect(notSetUp.headers.get('location')).toBe(`/dashboard/${GUILD}/funding?error=not_set_up`)
    await h.depositAddresses()
    await h.fundingSource('Judges pool')
    const taken = await browser.act(`/dashboard/${GUILD}/funding/sources`, { name: 'judges POOL' })
    expect(taken.headers.get('location')).toBe(`/dashboard/${GUILD}/funding?error=name_taken`)
    expect(text(await (await browser.get(taken.headers.get('location') as string)).text())).toContain('A funding source already has that name')
    const empty = await browser.act(`/dashboard/${GUILD}/funding/sources`, { name: '  ' })
    expect(empty.headers.get('location')).toBe(`/dashboard/${GUILD}/funding?error=invalid_input`)
  })

  it('a member cannot create one, a form without the CSRF token does nothing, and roles are read fresh', async () => {
    const h = await seeded()
    await h.depositAddresses()
    const member = await h.signIn(identity(MEMBER))
    expect((await member.browser.act(`/dashboard/${GUILD}/funding/sources`, { name: 'Mine' })).status).toBe(403)
    const treasurer = await h.signIn(identity(TREASURER))
    expect((await treasurer.browser.post(`/dashboard/${GUILD}/funding/sources`, { name: 'No token' })).status).toBe(403)
    h.members.set(GUILD, TREASURER.id, [], 'Tess') // the role was removed in Discord
    expect((await treasurer.browser.act(`/dashboard/${GUILD}/funding/sources`, { name: 'Too late' })).status).toBe(403)
    const status = await h.rolepay.funding.status({ guildId: GUILD })
    expect(status.ok && status.value.sources).toEqual([])
  })
})

describe('the Overview: funded this month', () => {
  it('shows what came in this month and from how many sources, once deposit addresses are set up', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).not.toContain('Funded this month')
    await h.depositAddresses()
    const acme = await h.fundingSource('Acme DAO')
    const judges = await h.fundingSource('Judges pool')
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).toMatch(/Funded this month 0 AlphaUSD No deposits yet this month/)
    await h.deposit(acme.depositAddress, '5')
    await h.deposit(acme.depositAddress, '1')
    await h.deposit(judges.depositAddress, '4')
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(text(html)).toMatch(/Funded this month 10 AlphaUSD from 2 sources/)
    expect(html).toContain(`href="/dashboard/${GUILD}/funding"`)
  })
})
