import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, OUTSIDER, ROLE, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'
import { mondayPolicy } from '../../test/policyFixtures.js'

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

async function setup() {
  const h = dashboardHarness()
  await h.community()
  const policyId = mondayPolicy(h)
  const base = `/dashboard/${GUILD}/policies/${policyId}`
  return { h, policyId, base }
}

const weekly = { name: 'Weekly helpers', instruction: 'Every Monday: 2 USDC per answered question in #help.', kind: 'weekly', weekday: '1', day: '1', hour: '18', timezone: 'UTC' }

describe('policy actions: the Treasurer role acts, everyone else reads', () => {
  it('the Treasurer pauses a policy: the port gets the actor as the bot sees them, and the page says it is done', async () => {
    const { h, policyId, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`${base}/pause`)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${base}?done=paused`)
    expect(h.policies.calls).toEqual([{ method: 'pause', guildId: GUILD, policyId, actor: { id: TREASURER.id, roleIds: [ROLE] } }])
    const t = text(await (await browser.get(res.headers.get('location') as string)).text())
    expect(t).toMatch(/Paused\./)
    expect(t).toMatch(/Resume/)
  })

  it('a member cannot act, whatever the form claims: 403 and the port is never called', async () => {
    const { h, base } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    for (const action of ['pause', 'resume', 'archive', 'approve', 'discard', 'mode', 'edit']) {
      const res = await browser.act(`${base}/${action}`, { roleIds: ROLE, roles: ROLE, canAct: 'true', version: '1', mode: 'autopilot', vetoWindowHours: '24', ...{ name: 'x', instruction: 'y' } })
      expect(res.status).toBe(403)
    }
    expect((await browser.act(`/dashboard/${GUILD}/policies`, { name: 'x', instruction: 'y', kind: 'weekly', weekday: '1', hour: '1', timezone: 'UTC' })).status).toBe(403)
    expect(h.policies.calls).toEqual([])
  })

  it('a non-member cannot act either', async () => {
    const { h, base } = await setup()
    const { browser } = await h.signIn(identity(OUTSIDER))
    expect((await browser.act(`${base}/pause`)).status).toBe(403)
    expect(h.policies.calls).toEqual([])
  })

  it('a role revoked mid-session stops the next action at once (roles are read fresh for every action), and pages turn read only within a minute', async () => {
    const { h, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    expect((await browser.get(base)).status).toBe(200)
    expect((await browser.act(`${base}/pause`)).status).toBe(303)
    h.members.set(GUILD, TREASURER.id, [], 'Tess')
    expect((await browser.act(`${base}/resume`)).status).toBe(403)
    expect(h.policies.calls.map((c) => c.method)).toEqual(['pause'])
    h.clock.advance(61)
    expect(text(await (await browser.get(base)).text())).toMatch(/Only the Treasurer role can change policies/)
  })

  it('every action needs this session’s CSRF token', async () => {
    const { h, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    expect((await browser.post(`${base}/pause`)).status).toBe(403)
    expect((await browser.post(`${base}/pause`, { csrf: 'nope' })).status).toBe(403)
    // Another person's token does not work in this session.
    const { browser: other } = await h.signIn(identity(MEMBER))
    expect((await browser.post(`${base}/pause`, { csrf: await other.csrf() })).status).toBe(403)
    expect(h.policies.calls).toEqual([])
  })

  it('a refusal from the policy services comes back as a plain message, never as raw input', async () => {
    const { h, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`${base}/resume`) // it is active, not paused
    expect(res.headers.get('location')).toBe(`${base}?error=illegal_state`)
    expect(text(await (await browser.get(`${base}?error=illegal_state`)).text())).toMatch(/not possible in the policy's current state/)
    const junk = await (await browser.get(`${base}?error=%3Cscript%3Ealert(1)%3C/script%3E&done=%3Cb%3E`)).text()
    expect(junk).not.toContain('<script>alert')
    expect(junk).not.toContain('<b>')
  })

  it('approves a pending version, and discards one', async () => {
    const { h, policyId, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    expect((await browser.act(`${base}/edit`, weekly)).headers.get('location')).toBe(`${base}?done=edited`)
    expect((await browser.act(`${base}/approve`, { version: '2' })).headers.get('location')).toBe(`${base}?done=approved`)
    expect((await h.policies.get({ guildId: GUILD, policyId })).ok && (await h.policies.versions({ guildId: GUILD, policyId })).map((v) => v.status)).toEqual(['superseded', 'approved'])
    await browser.act(`${base}/edit`, { ...weekly, instruction: 'third' })
    expect((await browser.act(`${base}/discard`, { version: '3' })).headers.get('location')).toBe(`${base}?done=discarded`)
    expect((await browser.act(`${base}/approve`, { version: 'x' })).status).toBe(400)
  })

  it('switches to autopilot with a veto window of at least one hour', async () => {
    const { h, policyId, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    expect((await browser.act(`${base}/mode`, { mode: 'autopilot', vetoWindowHours: '12' })).headers.get('location')).toBe(`${base}?done=mode_changed`)
    const p = await h.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && [p.value.mode, p.value.vetoWindowHours]).toEqual(['autopilot', 12])
    expect((await browser.act(`${base}/mode`, { mode: 'autopilot', vetoWindowHours: '0' })).status).toBe(400)
    expect((await browser.act(`${base}/mode`, { mode: 'yolo', vetoWindowHours: '24' })).status).toBe(400)
  })

  it('archives a policy', async () => {
    const { h, policyId, base } = await setup()
    const { browser } = await h.signIn(identity(TREASURER))
    expect((await browser.act(`${base}/archive`)).headers.get('location')).toBe(`${base}?done=archived`)
    const p = await h.policies.get({ guildId: GUILD, policyId })
    expect(p.ok && p.value.status).toBe('archived')
  })

  it('edit shows a form with the current values to the Treasurer, and recompiles into a new version', async () => {
    const { h, base } = await setup()
    const { browser: member } = await h.signIn(identity(MEMBER))
    expect((await member.get(`${base}/edit`)).status).toBe(403)
    const { browser } = await h.signIn(identity(TREASURER))
    const form = await (await browser.get(`${base}/edit`)).text()
    expect(form).toContain('Every Monday: 1 USDC per answered question in #help')
    expect(form).toMatch(/<option value="1" selected>Monday<\/option>/)
    const done = await browser.act(`${base}/edit`, weekly)
    expect(done.headers.get('location')).toBe(`${base}?done=edited`)
    expect(text(await (await browser.get(`${base}?done=edited`)).text())).toMatch(/Version 2 waits for approval/)
  })
})

describe('creating a policy from the web: the same compile, preview and approve flow as Discord', () => {
  it('compiles the instruction into a draft and lands on its page, ready for approval', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    const form = await (await browser.get(`/dashboard/${GUILD}/policies/new`)).text()
    expect(form).toContain(`action="/dashboard/${GUILD}/policies"`)
    expect(form).toContain('name="instruction"')
    const res = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, kind: 'monthly', day: '15', hour: '9', timezone: 'Europe/Lisbon' })
    expect(res.status).toBe(303)
    const location = res.headers.get('location') as string
    expect(location).toMatch(new RegExp(`^/dashboard/${GUILD}/policies/pol_\\d+\\?done=created$`))
    const page = text(await (await browser.get(location)).text())
    expect(page).toMatch(/Draft/)
    expect(page).toMatch(/Monthly on day 15 at 09:00 \(Europe\/Lisbon\)/)
    expect(page).toMatch(/Version 1 waits for approval/)
    expect(h.policies.calls.map((c) => [c.method, c.actor])).toEqual([['create', { id: TREASURER.id, roleIds: [ROLE] }]])
  })

  it('says what is wrong and keeps what was typed when the form is incomplete or the rule cannot be compiled', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    const empty = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, name: '' })
    expect(empty.status).toBe(400)
    expect(text(await empty.text())).toMatch(/Give the policy a name/)
    const badZone = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, timezone: 'Mars/Olympus' })
    expect(badZone.status).toBe(400)
    const unclear = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, instruction: 'pay the unclear <b>people</b>' })
    expect(unclear.status).toBe(422)
    const html = await unclear.text()
    expect(text(html)).toMatch(/could not be compiled/)
    expect(html).toContain('pay the unclear &lt;b&gt;people&lt;/b&gt;')
    expect(h.policies.calls.length).toBe(1)
  })

  it('a member does not get the form', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    expect((await browser.get(`/dashboard/${GUILD}/policies/new`)).status).toBe(403)
  })
})
