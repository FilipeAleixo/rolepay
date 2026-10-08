import { describe, expect, it } from 'vitest'
import { ALICE, GUILD, OTHER_PASSKEY, PASSKEY, claimLink, pageConfig, registeredCommunity, webHarness } from '../../test/harness.js'

describe('the recipient claim page', () => {
  it('a valid link renders the page with what the client needs, and never the token hash or anything secret', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const token = await claimLink(h)
    const res = await h.send(`/claim/${token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const config = await pageConfig(res)
    expect(config).toMatchObject({ page: 'claim', token, communityName: 'Mods guild', network: 'moderato', passkeyName: 'Rolepay: Mods guild (alice)' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it("names the passkey after the community and the person, so two payees in one browser never share an account (their Discord ID when the link kept no username)", async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const BOB = '200000000000000002'
    const alice = await pageConfig(await h.send(`/claim/${await claimLink(h, ALICE, 'alice')}`))
    const bob = await pageConfig(await h.send(`/claim/${await claimLink(h, BOB, 'bob')}`))
    const old = await pageConfig(await h.send(`/claim/${await claimLink(h, BOB, null)}`))
    expect([alice.passkeyName, bob.passkeyName, old.passkeyName]).toEqual(['Rolepay: Mods guild (alice)', 'Rolepay: Mods guild (bob)', `Rolepay: Mods guild (${BOB})`])
  })

  it('a hostile community name stays text in the passkey name, the page and its config, within 64 bytes', async () => {
    const h = webHarness()
    await registeredCommunity(h, PASSKEY, { name: '</script><img src=x onerror=alert(1)> very long name indeed' })
    const res = await h.send(`/claim/${await claimLink(h)}`)
    const html = await res.text()
    expect(html).not.toContain('<img src=x')
    const m = html.match(/<script type="application\/json" id="rolepay-config">([^<]*)<\/script>/)
    const config = JSON.parse((m?.[1] ?? '').replaceAll('\\u003c', '<')) as { passkeyName: string }
    expect(config.passkeyName.startsWith('Rolepay: </script><img')).toBe(true)
    expect(config.passkeyName.endsWith('… (alice)')).toBe(true)
    expect(new TextEncoder().encode(config.passkeyName).length).toBeLessThanOrEqual(64)
  })

  it('once registered, points to the account page, where the payee sees and moves what they are paid', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const html = await (await h.send(`/claim/${await claimLink(h)}`)).text()
    expect(html).toMatch(/<section data-step="done" hidden>[\s\S]*<a href="\/account">your Rolepay account<\/a>[\s\S]*<\/section>/)
  })

  it('an unknown, used or expired link says what to do, with no client code', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const unknown = await h.send('/claim/nope')
    expect(unknown.status).toBe(404)
    const html = await unknown.text()
    expect(html).toMatch(/\/payee link/)
    expect(html).not.toContain('rolepay.js')

    const token = await claimLink(h)
    h.clock.advance(1800)
    expect((await h.send(`/claim/${token}`)).status).toBe(410)
  })

  it('registers the address of the passkey signed in on this browser, never an address the page sends', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const token = await claimLink(h)
    const res = await h.post(`/claim/${token}`, { address: OTHER_PASSKEY }, PASSKEY)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, address: PASSKEY, communityName: 'Mods guild', preferredToken: null })
    expect(await h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: PASSKEY } })
  })

  it('without a passkey session it registers nothing', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const token = await claimLink(h)
    const res = await h.post(`/claim/${token}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'no_passkey_session' } })
    expect((await h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).ok).toBe(false)
  })

  it('the link works once', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const token = await claimLink(h)
    expect((await h.post(`/claim/${token}`, {}, PASSKEY)).status).toBe(200)
    const again = await h.post(`/claim/${token}`, {}, OTHER_PASSKEY)
    expect(again.status).toBe(410)
    expect(await again.json()).toEqual({ ok: false, error: { code: 'link_already_used' } })
    expect(await h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: PASSKEY } })
  })

  it('refuses a cross-site POST (CSRF): the Origin must be this server', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    const token = await claimLink(h)
    const res = await h.send(`/claim/${token}`, { method: 'POST', body: '{}', passkey: PASSKEY, headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect((await h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).ok).toBe(false)
  })
})
