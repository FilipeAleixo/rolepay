import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'

const PAYOUTS = { id: '700000000000000001', name: 'payouts', everyoneCanView: true }
const PRIVATE = { id: '700000000000000005', name: 'money-team', everyoneCanView: false }
const TREASURY = { id: '700000000000000009', name: 'Treasury', everyoneCanView: false }
const OLD = { id: '700000000000000008', name: 'treasury-old', everyoneCanView: false }
const CONFIRMATION_ASK = 'Rolepay posts what needs a Treasurer in a channel of its own. Create a private #treasury channel, or choose one'
/** Visible text, roughly: tags dropped, whitespace collapsed, entities kept. */
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

async function seeded(channels = [PAYOUTS, PRIVATE, OLD]) {
  const h = dashboardHarness()
  await h.community()
  h.channels.set(GUILD, channels)
  return h
}

const setting = async (h: Awaited<ReturnType<typeof seeded>>) => {
  const c = await h.rolepay.communities.get(GUILD)
  return c.ok ? { channelId: c.value.treasuryChannelId, source: c.value.treasuryChannelSource } : null
}
const audit = async (h: Awaited<ReturnType<typeof seeded>>) => {
  const r = await h.rolepay.audit.list({ guildId: GUILD, types: ['community.treasury_channel_chosen', 'community.treasury_channel_found'] })
  return r.ok ? r.value.events.reverse().map((e) => [e.type, e.actor, e.details]) : []
}

describe('the treasury channel on the Overview', () => {
  it('a Treasurer with none set and no channel named "treasury" (#treasury-old is not it) is asked, at the top and in the setting, with the server\'s text channels to choose from', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    const t = text(html)
    expect(t).toContain('Treasury channel')
    expect(t.split(CONFIRMATION_ASK).length - 1).toBe(2)
    expect(html).toContain('<a href="#treasury-channel">choose one</a>')
    expect(html).toContain(`<form method="post" action="/dashboard/${GUILD}/treasury-channel">`)
    expect(html).toContain('<option value="" disabled selected>Choose a channel</option>')
    expect(html).toContain('<option value="none">None: post in each policy&#39;s own channel</option>')
    expect(html).toContain(`<option value="${PAYOUTS.id}">#payouts (everyone can see it)</option>`)
    expect(html).toContain(`<option value="${PRIVATE.id}">#money-team</option>`)
    expect(t).toContain('policies and runs to approve, runs you can veto, and runs it holds')
    expect(t).toContain('Make it visible only to the Treasurer role and Rolepay')
    expect(h.channels.posts).toEqual([])
    expect(await setting(h)).toEqual({ channelId: null, source: 'unset' })
  })

  it('a member sees the setting read only (no form, no question at the top), and their visit reads nothing from Discord', async () => {
    const h = await seeded([PAYOUTS, TREASURY])
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(text(html)).toContain('Not set yet. A Treasurer chooses it here, or creates a private #treasury channel in Discord')
    expect(html).not.toContain('/treasury-channel"')
    expect(text(html)).not.toContain(CONFIRMATION_ASK)
    expect(h.channels.reads).toBe(0)
    // A member's visit never picks #treasury: that waits for a Treasurer, or for Discord's first such message.
    expect(await setting(h)).toEqual({ channelId: null, source: 'unset' })
  })

  it('a Treasurer opening the page while a channel named "Treasury" exists: Rolepay posts its confirmation there and takes it, once, audited as its own pick', async () => {
    const h = await seeded([PAYOUTS, OLD, TREASURY])
    const { browser } = await h.signIn(identity(TREASURER))
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(text(html)).toContain('Rolepay found #Treasury and posts there what needs a Treasurer from now on')
    expect(text(html)).toMatch(/Treasury channel #Treasury Found by its name\./)
    expect(html).toContain(`<option value="${TREASURY.id}" selected>#Treasury</option>`)
    expect(h.channels.posts).toEqual([TREASURY.id])
    expect(await setting(h)).toEqual({ channelId: TREASURY.id, source: 'found' })
    expect(await audit(h)).toEqual([['community.treasury_channel_found', null, { channelId: TREASURY.id, replaced: null }]])
    // Again: nothing more is posted or picked.
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).not.toContain('Rolepay found')
    expect(h.channels.posts).toEqual([TREASURY.id])
    // A member now sees which channel it is.
    const member = await h.signIn(identity(MEMBER))
    expect(text(await (await member.browser.get(`/dashboard/${GUILD}`)).text())).toMatch(/Treasury channel #Treasury Found by its name\./)
  })

  it('a channel named "treasury" Rolepay cannot post in is not taken: the Treasurer is asked instead', async () => {
    const h = await seeded([PAYOUTS, TREASURY])
    h.channels.closed.add(TREASURY.id)
    const { browser } = await h.signIn(identity(TREASURER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).toContain(CONFIRMATION_ASK)
    expect(await setting(h)).toEqual({ channelId: null, source: 'unset' })
  })

  it('a Treasurer chooses a private channel: Rolepay posts there first, then saves; audited; the page names it', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/dashboard/${GUILD}?done=treasury_set#treasury-channel`)
    expect(h.channels.posts).toEqual([PRIVATE.id])
    expect(await setting(h)).toEqual({ channelId: PRIVATE.id, source: 'chosen' })
    expect(await audit(h)).toEqual([['community.treasury_channel_chosen', TREASURER.id, { channelId: PRIVATE.id, previous: null }]])
    const html = await (await browser.get(`/dashboard/${GUILD}?done=treasury_set`)).text()
    expect(text(html)).toContain('Saved. Rolepay posted a message there to show it works')
    expect(text(html)).toMatch(/Treasury channel #money-team Chosen by a Treasurer\./)
    expect(html).toContain(`<option value="${PRIVATE.id}" selected>#money-team</option>`)
    expect(text(html)).not.toContain(CONFIRMATION_ASK)
  })

  it('a channel everyone can see is saved, with a warning that stays on the setting until it is private', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PAYOUTS.id })
    expect(res.headers.get('location')).toBe(`/dashboard/${GUILD}?done=treasury_set_public#treasury-channel`)
    expect(await setting(h)).toEqual({ channelId: PAYOUTS.id, source: 'chosen' })
    const t = text(await (await browser.get(`/dashboard/${GUILD}?done=treasury_set_public`)).text())
    expect(t).toContain('Saved, but everyone in the server can see that channel')
    expect(t).toContain('Everyone in the server can see #payouts. Make it visible only to the Treasurer role and Rolepay')
    h.channels.set(GUILD, [{ ...PAYOUTS, everyoneCanView: false }, PRIVATE])
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).not.toContain('Everyone in the server can see #payouts')
  })

  it('Rolepay cannot post there: nothing is saved, and the page says what to fix', async () => {
    const h = await seeded()
    h.channels.closed.add(PRIVATE.id)
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })
    expect(res.headers.get('location')).toBe(`/dashboard/${GUILD}?error=cannot_post#treasury-channel`)
    expect(await setting(h)).toEqual({ channelId: null, source: 'unset' })
    expect(await audit(h)).toEqual([])
    expect(text(await (await browser.get(`/dashboard/${GUILD}?error=cannot_post`)).text())).toContain(
      'Rolepay could not post in that channel, so nothing was saved. Add Rolepay to the channel, with permission to send messages.',
    )
  })

  it('a channel that is not one of this server\'s text channels is refused before anything is posted; so is a malformed one', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const foreign = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: '700000000000000077' })
    expect(foreign.headers.get('location')).toBe(`/dashboard/${GUILD}?error=unknown_channel#treasury-channel`)
    const junk = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: 'general' })
    expect(junk.headers.get('location')).toBe(`/dashboard/${GUILD}?error=invalid_input#treasury-channel`)
    expect(h.channels.posts).toEqual([])
    h.channels.down = true
    const down = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })
    expect(down.headers.get('location')).toBe(`/dashboard/${GUILD}?error=unavailable#treasury-channel`)
    expect(await setting(h)).toEqual({ channelId: null, source: 'unset' })
  })

  it('None: saved and audited, and Rolepay stops looking for a channel named "treasury"', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: 'none' })
    expect(res.headers.get('location')).toBe(`/dashboard/${GUILD}?done=treasury_none#treasury-channel`)
    expect(await setting(h)).toEqual({ channelId: null, source: 'chosen' })
    // A #Treasury made later is not taken: the Treasurer's choice stands.
    h.channels.set(GUILD, [PAYOUTS, TREASURY])
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(text(html)).toContain("None: each run is posted in its policy's channel (or where it was made), with its buttons.")
    expect(html).toContain('<option value="none" selected>')
    expect(text(html)).not.toContain(CONFIRMATION_ASK)
    expect(h.channels.posts).toEqual([])
    expect(await audit(h)).toEqual([['community.treasury_channel_chosen', TREASURER.id, { channelId: null, previous: null }]])
  })

  it('the channel set was deleted: the page says so, and for a Treasurer a channel named "treasury" takes its place', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(TREASURER))
    await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })
    h.channels.set(GUILD, [PAYOUTS])
    const member = await h.signIn(identity(MEMBER))
    expect(text(await (await member.browser.get(`/dashboard/${GUILD}`)).text())).toContain('A channel that is no longer in this server')
    h.channels.set(GUILD, [PAYOUTS, TREASURY])
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).toContain('Rolepay found #Treasury')
    expect(await setting(h)).toEqual({ channelId: TREASURY.id, source: 'found' })
    expect((await audit(h)).at(-1)).toEqual(['community.treasury_channel_found', null, { channelId: TREASURY.id, replaced: PRIVATE.id }])
  })

  it('only the Treasurer role chooses: a member, a form without the CSRF token and a role removed in Discord are refused', async () => {
    const h = await seeded()
    const member = await h.signIn(identity(MEMBER))
    expect((await member.browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })).status).toBe(403)
    const treasurer = await h.signIn(identity(TREASURER))
    expect((await treasurer.browser.post(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })).status).toBe(403)
    h.members.set(GUILD, TREASURER.id, [], 'Tess')
    expect((await treasurer.browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: 'none' })).status).toBe(403)
    expect(h.channels.posts).toEqual([])
    expect(await setting(h)).toEqual({ channelId: null, source: 'unset' })
  })

  it('escapes channel names from Discord', async () => {
    const h = await seeded([{ id: PRIVATE.id, name: '<script>alert(1)</script>', everyoneCanView: true }])
    const { browser } = await h.signIn(identity(TREASURER))
    await browser.act(`/dashboard/${GUILD}/treasury-channel`, { channel: PRIVATE.id })
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('#&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('a server that cannot list channels shows the setting read only, even to a Treasurer', async () => {
    const h = dashboardHarness({ channels: false })
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    expect(text(html)).toContain('Treasury channel')
    expect(html).not.toContain('/treasury-channel"')
    expect(text(html)).not.toContain('Rolepay found')
  })
})
