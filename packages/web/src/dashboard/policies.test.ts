import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, ROLE, TREASURER, dashboardHarness, identity, usd } from '../../test/dashboardHarness.js'
import { CAROL, MONDAY_RULE, mondayPolicy, preview } from '../../test/policyFixtures.js'

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const actor = { id: TREASURER.id, roleIds: [ROLE] }

async function setup() {
  const h = dashboardHarness()
  await h.community()
  const policyId = mondayPolicy(h)
  return { h, policyId }
}

describe('Policies list', () => {
  it('lists each policy with its schedule in words, mode, status, next run and how many people it matches now', async () => {
    const { h, policyId } = await setup()
    h.policies.seed(GUILD, { name: 'Monthly bounties', instruction: 'x', status: 'paused', mode: 'autopilot', schedule: { kind: 'monthly', day: 1, hour: 9, timezone: 'Europe/Lisbon' } })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/policies`)).text()
    const t = text(html)
    expect(html).toContain(`href="/dashboard/${GUILD}/policies/${policyId}"`)
    expect(t).toContain('Weekly helpers')
    expect(t).toContain('Every Monday at 18:00 (UTC)')
    expect(t).toContain('Monthly on day 1 at 09:00 (Europe/Lisbon)')
    expect(t).toMatch(/Needs approval/)
    expect(t).toMatch(/Autopilot/)
    expect(t).toMatch(/Active/)
    expect(t).toMatch(/Paused/)
    expect(t).toContain('2026-10-12 18:00 UTC')
    expect(t).toMatch(/\b3\b/)
  })

  it('offers New policy to the Treasurer role only', async () => {
    const { h } = await setup()
    const { browser: member } = await h.signIn(identity(MEMBER))
    expect(await (await member.get(`/dashboard/${GUILD}/policies`)).text()).not.toContain(`/policies/new`)
    const { browser: treasurer } = await h.signIn(identity(TREASURER))
    expect(await (await treasurer.get(`/dashboard/${GUILD}/policies`)).text()).toContain(`href="/dashboard/${GUILD}/policies/new"`)
  })

  it('without the policy services, says they are not available on this server', async () => {
    const h = dashboardHarness({ policies: false })
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/policies`)
    expect(res.status).toBe(200)
    expect(text(await res.text())).toMatch(/not available on this server yet/)
    expect((await browser.get(`/dashboard/${GUILD}/policies/pol_1`)).status).toBe(404)
  })
})

describe('Policy detail', () => {
  it('shows the original instruction, the rule in plain words and the exact compiled filter (expandable)', async () => {
    const { h, policyId } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    expect(text(html)).toContain(MONDAY_RULE)
    expect(text(html)).toContain('Pays 1 AlphaUSD per reply in #help since the last run, at most 50 each.')
    const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'))
    expect(details).toContain('Exact filter')
    expect(details).toContain('&quot;repliesIn&quot;')
    expect(details).toContain('&quot;cap&quot;: &quot;50&quot;')
  })

  it('shows who it applies to right now, with metrics, reasons and amounts, who is not registered, and the near-misses', async () => {
    const { h, policyId } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    const t = text(html)
    const applies = t.slice(t.indexOf('Applies to right now'), t.indexOf('Just below the line'))
    expect(applies).toContain('Alice')
    expect(applies).toContain('12 replies, 4 active days')
    expect(applies).toContain('12 replies in #help (at least 1)')
    expect(applies).toContain('12 AlphaUSD')
    expect(applies).toContain('Bob')
    expect(applies).toContain('capped at 50')
    expect(applies).toContain(`user ${CAROL.id}`)
    expect(applies).toMatch(/not registered/)
    const near = t.slice(t.indexOf('Just below the line'))
    expect(near).toContain('no replies in #help this week')
    expect(near).toContain('9 messages')
  })

  it("previews the next run's total against the key's remaining budget, and says when it would be held", async () => {
    const { h, policyId } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    const t = text(await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())
    expect(t).toContain('2026-10-12 18:00 UTC')
    expect(t).toContain('62 AlphaUSD')
    expect(t).toContain('87.5 AlphaUSD')
    h.policies.setPreview(GUILD, policyId, preview({ total: usd('120'), remainingBudget: usd('87.5'), held: 'The run (120) is more than the bot key has left (87.5): it would be held, not partly paid.' }))
    const held = text(await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())
    expect(held).toMatch(/would be held, not partly paid/)
  })

  it('when the preview cannot be worked out, the rest of the page still shows', async () => {
    const h = dashboardHarness()
    await h.community()
    const policyId = h.policies.seed(GUILD, { name: 'No preview', instruction: 'x' }, null)
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)
    expect(res.status).toBe(200)
    expect(text(await res.text())).toMatch(/could not be worked out just now/)
  })

  it('shows the version history with approvals and what changed between versions', async () => {
    const { h, policyId } = await setup()
    await h.policies.edit({ guildId: GUILD, policyId, actor, draft: { name: 'Weekly helpers', instruction: 'Every Monday: 2 USDC per answered question in #help, max 50 a week each.', schedule: { kind: 'weekly', weekday: 1, hour: 18, timezone: 'UTC' } } })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    const versions = html.slice(html.indexOf('Version history'))
    const t = text(versions)
    expect(t).toMatch(/Version 1.*approved by Tess/)
    expect(t).toMatch(/Version 2.*waiting for approval/)
    expect(versions).toContain('<span class="del">- Every Monday: 1 USDC')
    expect(versions).toContain('<span class="add">+ Every Monday: 2 USDC')
  })

  it('shows actions to the Treasurer role only: approve a pending version, edit, pause, switch mode, archive', async () => {
    const { h, policyId } = await setup()
    await h.policies.edit({ guildId: GUILD, policyId, actor, draft: { name: 'Weekly helpers', instruction: 'changed', schedule: { kind: 'weekly', weekday: 1, hour: 18, timezone: 'UTC' } } })
    const { browser: member } = await h.signIn(identity(MEMBER))
    const readOnly = await (await member.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    expect(readOnly).not.toMatch(/<form method="post"[^>]*\/policies\//)
    expect(text(readOnly)).toMatch(/Only the Treasurer role can change policies/)
    const { browser: treasurer } = await h.signIn(identity(TREASURER))
    const html = await (await treasurer.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    for (const action of ['approve', 'discard', 'pause', 'mode', 'archive']) expect(html).toContain(`action="/dashboard/${GUILD}/policies/${policyId}/${action}"`)
    expect(html).toContain(`href="/dashboard/${GUILD}/policies/${policyId}/edit"`)
    expect(html).toContain('name="version" value="2"')
    expect(html).not.toContain(`/${policyId}/resume"`)
  })

  it('an unknown policy is not found', async () => {
    const { h } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    expect((await browser.get(`/dashboard/${GUILD}/policies/pol_nope`)).status).toBe(404)
  })
})
