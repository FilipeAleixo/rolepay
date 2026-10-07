import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, ROLE, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'
import { ALICE, preview } from '../../test/policyFixtures.js'

const EVIL = '<img src=x onerror=alert(1)>"\'&'
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'

describe('every string a person or Discord controls is escaped (XSS)', () => {
  it('server names, user names, run notes, policy texts, preview reasons, audit summaries and AI model names', async () => {
    const h = dashboardHarness()
    await h.community({ name: `Guild ${EVIL}` })
    h.members.set(GUILD, TREASURER.id, [ROLE], `Tess ${EVIL}`)
    h.members.set(GUILD, MEMBER.id, [], `Felix ${EVIL}`)
    h.members.set(GUILD, ALICE.id, [], `Alice ${EVIL}`)
    await h.payee(ALICE.id, ALICE.address)
    await h.activeKey()
    const run = await h.run([[ALICE.id, '1']], { note: `Note ${EVIL}`, by: MEMBER.id })
    const evilPreview = preview({
      matches: [{ userId: ALICE.id, metrics: { [`k${EVIL}`]: 1 }, reasons: [`reason ${EVIL}`], amount: 1_000_000n, registered: true }],
      nearMisses: [{ userId: MEMBER.id, metrics: {}, missing: `missing ${EVIL}` }],
      held: `held ${EVIL}`,
    })
    const policyId = h.policies.seed(
      GUILD,
      { name: `Policy ${EVIL}`, instruction: `Instruction ${EVIL}`, ruleInWords: `Rule ${EVIL}`, filter: { evil: EVIL }, schedule: { kind: 'weekly', weekday: 1, hour: 18, timezone: `UTC${EVIL}` } },
      evilPreview,
    )
    await h.policies.edit({ guildId: GUILD, policyId, actor: { id: TREASURER.id, roleIds: [ROLE] }, draft: { name: 'x', instruction: `Edited ${EVIL}`, schedule: { kind: 'weekly', weekday: 1, hour: 1, timezone: 'UTC' } } })
    h.policies.linkRun(GUILD, run.id, { policyId, policyRunId: 'prun_1', policyName: `Policy ${EVIL}`, version: 1, period: `period ${EVIL}`, mode: 'autopilot', scheduledFor: new Date(), executesAt: null, vetoedBy: MEMBER.id, vetoedAt: new Date(), executedAt: null, vetoable: false })
    h.policies.addEvent(GUILD, { at: new Date(), type: 'run.vetoed', actorId: MEMBER.id, policyId, runId: run.id, summary: `Summary ${EVIL}` })
    // The model name comes from the API's answer (or ROLEPAY_AI_MODEL); the outcome is a code, escaped anyway.
    h.aiUsage.addProposal(GUILD, { at: new Date(), model: `Model ${EVIL}`, latencyMs: 2_100, costMicroUsd: 3_869n, mode: 'messages', actorId: MEMBER.id, outcome: `code ${EVIL}`, runId: run.id })
    h.aiUsage.addCompile(GUILD, policyId, 1, { at: new Date(), model: `Model ${EVIL}`, latencyMs: 3_400, costMicroUsd: null })
    // A funding source is named by a treasurer: user text on the Funding page.
    await h.depositAddresses()
    const source = await h.fundingSource(`Sponsor ${EVIL}`)
    await h.deposit(source.depositAddress, '5')

    const { browser } = await h.signIn(identity({ id: TREASURER.id, name: `Tess ${EVIL}` }, [{ id: GUILD, name: `Listed ${EVIL}` }]))
    const pages = ['/dashboard', `/dashboard/${GUILD}`, `/dashboard/${GUILD}/runs`, `/dashboard/${GUILD}/runs/${run.id}`, `/dashboard/${GUILD}/payees`, `/dashboard/${GUILD}/policies`, `/dashboard/${GUILD}/policies/${policyId}`, `/dashboard/${GUILD}/policies/${policyId}/edit`, `/dashboard/${GUILD}/audit`, `/dashboard/${GUILD}/funding`]
    let escapedSeen = 0
    for (const path of pages) {
      const res = await browser.get(path)
      expect(res.status, path).toBe(200)
      const html = await res.text()
      expect(html, path).not.toContain('<img')
      expect(html, path).not.toMatch(/onerror=alert\(1\)>/)
      escapedSeen += html.split(ESCAPED).length - 1
    }
    // The hostile strings did reach the pages, escaped (not dropped).
    expect(escapedSeen).toBeGreaterThan(20)
  })

  it('a hostile policy form value comes back escaped in the form', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`/dashboard/${GUILD}/policies`, { name: `"><script>alert(1)</script>`, instruction: '</textarea><script>alert(2)</script>', kind: 'weekly', weekday: '1', day: '1', hour: '99', timezone: 'UTC' })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(2)&lt;/script&gt;')
  })
})
