import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, ROLE, TOKEN, TREASURER, TREASURY, dashboardHarness, identity, usd } from '../../test/dashboardHarness.js'

const ALICE = { id: '200000000000000011', address: '0x1111111111111111111111111111111111111111' }
const BOB = { id: '200000000000000012', address: '0x2222222222222222222222222222222222222222' }
const EXPLORER = 'https://explore.testnet.tempo.xyz'

/** Visible text, roughly: tags dropped, whitespace collapsed, entities kept. */
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

async function seeded() {
  const h = dashboardHarness()
  await h.community()
  h.members.set(GUILD, ALICE.id, [], 'Alice')
  h.members.set(GUILD, BOB.id, [], 'Bob')
  await h.payee(ALICE.id, ALICE.address)
  await h.payee(BOB.id, BOB.address)
  return h
}

describe('Overview', () => {
  it('shows the treasury and its balance, the bot key (status, limit, remaining budget, expiry), the next scheduled runs and recent runs', async () => {
    const h = await seeded()
    await h.activeKey(usd('100'))
    const paid = await h.run([[ALICE.id, '10'], [BOB.id, '2.5']], { note: 'October mods' })
    h.policies.seed(GUILD, { name: 'Weekly helpers', instruction: 'Every Monday...', nextRunAt: new Date('2026-10-12T18:00:00Z') })
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    const t = text(html)
    expect(html).toContain(`href="${EXPLORER}/address/${TREASURY}"`)
    expect(t).toContain('987.5 AlphaUSD') // 1000 funded, 12.5 paid
    expect(t).toMatch(/Bot key\s+active/i)
    expect(t).toContain('100 AlphaUSD every 30 days')
    expect(t).toContain('87.5 AlphaUSD left')
    expect(t).toMatch(/Expires 2026-12-05/)
    expect(t).toContain('Weekly helpers')
    expect(t).toContain('2026-10-12 18:00 UTC')
    expect(html).toContain(`href="/dashboard/${GUILD}/runs/${paid.id}"`)
    expect(t).toContain('October mods')
    expect(t).toContain('12.5 AlphaUSD')
  })

  it('leads with "At a glance", the same for a member and a treasurer: the bot key budget as a bar and what was paid each week', async () => {
    const h = await seeded()
    await h.activeKey(usd('100'))
    await h.run([[ALICE.id, '10'], [BOB.id, '2.5']])
    h.payouts.set(GUILD, h.payouts.weeks([null, [usd('50'), usd('12')], null, null, null, null, null, null, null, null, [0n, usd('3')], [0n, usd('12.5')]]))
    for (const who of [MEMBER, TREASURER]) {
      const { browser } = await h.signIn(identity(who))
      const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
      const t = text(html)
      expect(t, who.name).toMatch(/At a glance Bot key budget Spent this period 12.5 AlphaUSD Left 87.5 AlphaUSD/)
      expect(html, who.name).toContain('aria-label="Bot key budget: 12.5 of 100 AlphaUSD spent, 87.5 AlphaUSD left.')
      expect(t, who.name).toMatch(/Resets 2026-11-05 12:00 UTC · expires 2026-12-05 12:00 UTC/)
      expect(t, who.name).toMatch(/Paid per week Last 12 weeks 77.5 AlphaUSD Made by a policy Made by hand/)
      expect(html.match(/role="img"/g)?.length, who.name).toBe(3)
      expect(html, who.name).toContain('<summary>Show the numbers</summary>')
      // The panel comes before the cards.
      expect(html.indexOf('At a glance'), who.name).toBeLessThan(html.indexOf('<h2>Treasury</h2>'))
    }
  })

  it('with nothing paid yet, the weekly part is a calm line; with the key revoked, the budget says so and draws no bar', async () => {
    const h = await seeded()
    await h.activeKey()
    await h.rolepay.communities.revokeBotKey({ guildId: GUILD, root: h.chain.rootSigner(TREASURY) })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
    const t = text(html)
    expect(t).toMatch(/The bot key is revoked: the bot can spend nothing/)
    expect(t).toContain('Nothing paid in the last 12 weeks.')
    expect(html).not.toContain('role="img"')
  })

  it('without the weekly payouts wired, the panel keeps the budget alone', async () => {
    const h = dashboardHarness({ payouts: false })
    await h.community()
    await h.activeKey()
    const { browser } = await h.signIn(identity(MEMBER))
    const t = text(await (await browser.get(`/dashboard/${GUILD}`)).text())
    expect(t).toContain('Bot key budget')
    expect(t).not.toContain('Paid per week')
  })

  it('still renders when the chain cannot be read, and says so', async () => {
    const h = await seeded()
    await h.activeKey()
    h.chain.balanceOf = async () => {
      throw new Error('rpc down')
    }
    h.chain.keyState = async () => {
      throw new Error('rpc down')
    }
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}`)
    expect(res.status).toBe(200)
    expect(text(await res.text())).toMatch(/could not read the chain/i)
  })

  it('without a bot key, says how to get one', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).toMatch(/No bot key yet/)
  })

  it('without the policy services, says policies are not available rather than failing', async () => {
    const h = dashboardHarness({ policies: false })
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}`)
    expect(res.status).toBe(200)
    expect(text(await res.text())).toMatch(/Scheduled runs come with policies/)
  })
})

describe('Runs', () => {
  it('lists runs newest first with status, total, lines, who made them and which policy', async () => {
    const h = await seeded()
    await h.activeKey()
    const first = await h.run([[ALICE.id, '10']], { note: 'first' })
    h.clock.advance(60)
    const second = await h.run([[BOB.id, '3']], { approve: false, by: MEMBER.id })
    h.policies.linkRun(GUILD, first.id, { policyId: 'pol_9', policyRunId: 'prun_1', policyName: 'Weekly helpers', version: 2, period: 'week of 2026-10-05', mode: 'autopilot', scheduledFor: new Date('2026-10-05T18:00:00Z'), executesAt: null, vetoedBy: null, vetoedAt: null, executedAt: null, vetoable: false })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/runs`)).text()
    const t = text(html)
    expect(html.indexOf(second.id)).toBeLessThan(html.indexOf(first.id))
    expect(t).toMatch(/Paid/)
    expect(t).toMatch(/Waiting for approval/)
    expect(t).toContain('Weekly helpers')
    expect(t).toContain('Felix')
    expect(t).toContain('10 AlphaUSD')
  })

  it('filters by status and by policy, and keeps the filter in the form', async () => {
    const h = await seeded()
    await h.activeKey()
    const paid = await h.run([[ALICE.id, '10']])
    const pending = await h.run([[BOB.id, '3']], { approve: false })
    h.policies.seed(GUILD, { id: 'pol_9', name: 'Weekly helpers', instruction: 'x' })
    h.policies.linkRun(GUILD, pending.id, { policyId: 'pol_9', policyRunId: 'prun_1', policyName: 'Weekly helpers', version: 1, period: 'p', mode: 'propose', scheduledFor: new Date(), executesAt: null, vetoedBy: null, vetoedAt: null, executedAt: null, vetoable: false })
    const { browser } = await h.signIn(identity(MEMBER))
    const byStatus = await (await browser.get(`/dashboard/${GUILD}/runs?status=paid`)).text()
    expect(byStatus).toContain(paid.id)
    expect(byStatus).not.toContain(`/runs/${pending.id}`)
    expect(byStatus).toMatch(/<option value="paid" selected>/)
    const byPolicy = await (await browser.get(`/dashboard/${GUILD}/runs?policy=pol_9`)).text()
    expect(byPolicy).toContain(`/runs/${pending.id}`)
    expect(byPolicy).not.toContain(`/runs/${paid.id}`)
    const manual = await (await browser.get(`/dashboard/${GUILD}/runs?policy=manual`)).text()
    expect(manual).toContain(`/runs/${paid.id}`)
    expect(manual).not.toContain(`/runs/${pending.id}`)
    // Junk filters are ignored, never echoed.
    const junk = await browser.get(`/dashboard/${GUILD}/runs?status=%3Cscript%3E`)
    expect(junk.status).toBe(200)
    expect(await junk.text()).not.toContain('<script>')
  })

  it('pages through long lists, 25 at a time', async () => {
    const h = await seeded()
    await h.activeKey(usd('1000'))
    for (let i = 0; i < 27; i++) await h.run([[ALICE.id, '1']], { approve: false })
    const { browser } = await h.signIn(identity(MEMBER))
    const first = await (await browser.get(`/dashboard/${GUILD}/runs`)).text()
    expect(first.match(/href="\/dashboard\/\d+\/runs\/run_/g)?.length).toBe(25)
    expect(first).toContain('page=2')
    const second = await (await browser.get(`/dashboard/${GUILD}/runs?page=2`)).text()
    expect(second.match(/href="\/dashboard\/\d+\/runs\/run_/g)?.length).toBe(2)
  })
})

describe('money on the dashboard reads with thousands grouped', () => {
  it('the treasury balance, a run\'s total and its lines: "999,995 AlphaUSD", while the CSV stays plain digits', async () => {
    const h = await seeded()
    await h.activeKey(usd('2000'))
    h.chain.fund(TOKEN, TREASURY, usd('998995')) // 1,000 from the harness: 999,995 in all
    const run = await h.run([[ALICE.id, '1500'], [BOB.id, '0.5']], { pay: false })
    const { browser } = await h.signIn(identity(MEMBER))
    const overview = text(await (await browser.get(`/dashboard/${GUILD}`)).text())
    expect(overview).toContain('999,995 AlphaUSD')
    expect(overview).not.toMatch(/\b999995\b/)
    const detail = text(await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)).text())
    expect(detail).toContain('1,500 AlphaUSD')
    expect(detail).toContain('1,500.5 AlphaUSD')
    const csv = await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}/csv`)).text()
    expect(csv).toContain('1500.000000')
    expect(csv).not.toContain('1,500')
  })
})

describe('Run detail', () => {
  it('shows lines with people, addresses, amounts and memos, the transaction link, who made and approved it, and a status timeline', async () => {
    const h = await seeded()
    await h.activeKey()
    const run = await h.run([[ALICE.id, '10'], [BOB.id, '2.5']], { note: 'October mods', by: MEMBER.id })
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    const t = text(html)
    expect(t).toContain('October mods')
    expect(t).toContain('Alice')
    expect(t).toContain('Bob')
    expect(t).toContain('2.5 AlphaUSD')
    expect(t).toContain('12.5 AlphaUSD')
    expect(html).toContain(run.lines[0]?.memo as string)
    expect(html).toContain(`href="${EXPLORER}/address/${ALICE.address}"`)
    expect(html).toContain(`href="${EXPLORER}/tx/${run.paidTxHash}"`)
    expect(t).toMatch(/Created by Felix/)
    expect(t).toMatch(/Approved by Tess/)
    const order = ['Created by', 'Submitted for approval', 'Approved by', 'Attempt 1', 'Paid in block'].map((s) => t.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain(`href="/dashboard/${GUILD}/runs/${run.id}/csv"`)
  })

  it('shows which policy and version made a run, and an autopilot veto', async () => {
    const h = await seeded()
    await h.activeKey()
    const run = await h.run([[ALICE.id, '10']], { approve: false })
    h.policies.linkRun(GUILD, run.id, {
      policyId: 'pol_9',
      policyRunId: 'prun_9',
      policyName: 'Weekly helpers',
      version: 3,
      period: 'week of 2026-10-05',
      mode: 'autopilot',
      scheduledFor: new Date('2026-10-05T18:00:00Z'),
      executesAt: new Date('2026-10-06T18:00:00Z'),
      vetoedBy: TREASURER.id,
      vetoedAt: new Date('2026-10-06T09:30:00Z'),
      executedAt: null,
      vetoable: false,
    })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)).text()
    const t = text(html)
    expect(html).toContain(`href="/dashboard/${GUILD}/policies/pol_9"`)
    expect(t).toContain('Weekly helpers')
    expect(t).toContain('version 3')
    expect(t).toContain('week of 2026-10-05')
    expect(t).toMatch(/Vetoed by Tess/)
    expect(t).toContain('2026-10-06 09:30 UTC')
  })

  it('a run autopilot paid after its veto window: nobody approved this run, so it never reads "Approved by"; a propose-mode one keeps it', async () => {
    const h = await seeded()
    await h.activeKey()
    const run = await h.run([[ALICE.id, '10']])
    const approvedAt = run.approvedAt as Date
    h.policies.seed(GUILD, { id: 'pol_9', name: 'Weekly helpers', instruction: '10 each', version: 3, mode: 'autopilot', approvedBy: MEMBER.id, approvedAt: new Date(approvedAt.getTime() - 86_400_000) })
    const origin = {
      policyId: 'pol_9',
      policyRunId: 'prun_9',
      policyName: 'Weekly helpers',
      version: 3,
      period: 'week of 2026-10-05',
      mode: 'autopilot' as const,
      scheduledFor: new Date(approvedAt.getTime() - 3_600_000),
      executesAt: new Date(approvedAt.getTime() - 1000),
      vetoedBy: null,
      vetoedAt: null,
      executedAt: approvedAt,
      vetoable: false,
    }
    h.policies.linkRun(GUILD, run.id, origin)
    const { browser } = await h.signIn(identity(MEMBER))
    const t = text(await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)).text())
    expect(t).toContain('Released on autopilot after the veto window; no veto. Policy approved by Felix (version 3); autopilot switched on by Tess.')
    expect(t).toMatch(/Approver\s*Autopilot, after the veto window/)
    expect(t).not.toMatch(/Approved by/)

    // The same run approved by a person (propose mode): "Approved by" stays.
    h.policies.linkRun(GUILD, run.id, { ...origin, mode: 'propose', executesAt: null, executedAt: null })
    const manual = text(await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)).text())
    expect(manual).toMatch(/Approved by Tess/)
    expect(manual).not.toContain('on autopilot after the veto window')
  })

  it('a failed run shows why', async () => {
    const h = await seeded()
    await h.activeKey()
    const run = await h.run([[ALICE.id, '10']], { pay: false })
    h.chain.faults.nextBroadcast = 'reject_but_keep_pending'
    const r = await h.rolepay.payRuns.execute({ guildId: GUILD, runId: run.id })
    expect(r.ok && r.value.status).toBe('failed')
    const { browser } = await h.signIn(identity(MEMBER))
    const t = text(await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)).text())
    expect(t).toMatch(/Failed/)
    expect(t).toMatch(/rejected/)
  })

  it('a line paid in the payee\'s preferred stablecoin reads "10 AlphaUSD -> 10 BetaUSD (swapped)", and the CSV has its delivered token', async () => {
    const BETA = '0x20c0000000000000000000000000000000000002'
    const h = await seeded()
    await h.rolepay.communities.setPreferredTokens({ guildId: GUILD, enabled: true })
    await h.activeKey()
    await h.rolepay.payees.setPreferredToken({ guildId: GUILD, discordUserId: ALICE.id, token: BETA })
    h.chain.setSwapRoute(TOKEN, BETA, { inPerOutBps: 9_954, liquidity: usd('1000') })
    const run = await h.run([[ALICE.id, '10'], [BOB.id, '2.5']])
    const { browser } = await h.signIn(identity(MEMBER))
    const t = text(await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}`)).text())
    expect(t).toContain('10 AlphaUSD → 10 BetaUSD (swapped)')
    expect(t).not.toContain('2.5 AlphaUSD →')
    const csv = (await (await browser.get(`/dashboard/${GUILD}/runs/${run.id}/csv`)).text()).split('\r\n')
    expect(csv[0]).toMatch(/,delivered_token$/)
    expect(csv[1]).toMatch(new RegExp(`,${BETA}$`))
    expect(csv[2]).toMatch(new RegExp(`,${TOKEN}$`))
  })

  it("another community's run, or an unknown one, is not found", async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    expect((await browser.get(`/dashboard/${GUILD}/runs/run_999999`)).status).toBe(404)
  })

  it('downloads the run as CSV for accounting', async () => {
    const h = await seeded()
    await h.activeKey()
    const run = await h.run([[ALICE.id, '10']], { note: '=HYPERLINK("x")' })
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/runs/${run.id}/csv`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="rolepay-${run.id}.csv"`)
    const csv = await res.text()
    expect(csv.split('\r\n')[0]).toMatch(/^run_id,line,discord_user_id/)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
  })
})

describe('Payees', () => {
  it('lists registered people with what they were paid this month, last month and in all, and their last payment', async () => {
    const h = await seeded()
    await h.activeKey(usd('500'))
    await h.run([[ALICE.id, '7']]) // 2026-10-06: last month, seen from November
    const later = new Date('2026-11-02T12:00:00Z')
    h.chain.advance((later.getTime() - h.clock.now().getTime()) / 1000)
    h.clock.set(later)
    const last = await h.run([[ALICE.id, '10'], [BOB.id, '1']])
    await h.run([[ALICE.id, '99']], { approve: false }) // not paid: not counted
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/payees`)).text()
    const row = (name: string) => text(html.slice(html.indexOf(`>${name}<`), html.indexOf('</tr>', html.indexOf(`>${name}<`))))
    expect(row('Alice')).toContain('10 AlphaUSD')
    expect(row('Alice')).toContain('7 AlphaUSD')
    expect(row('Alice')).toContain('17 AlphaUSD')
    expect(row('Alice')).toContain('2026-11-02')
    expect(row('Bob')).toContain('1 AlphaUSD')
    expect(html).toContain(`href="/dashboard/${GUILD}/runs/${last.id}"`)
    expect(html).toContain(`href="${EXPLORER}/address/${BOB.address}"`)
    expect(text(html)).toMatch(/November 2026/)
    expect(text(html)).toMatch(/October 2026/)
  })
})

describe('AI spend (read only, for every member)', () => {
  const OCT = new Date('2026-10-01T00:00:00Z')

  it('Overview: what the AI cost this month, and the average cost of a drafted proposal', async () => {
    const h = await seeded()
    h.aiUsage.setSpend(GUILD, { since: OCT, calls: 7, totalMicroUsd: 42_100n, unpriced: 0, proposals: 5, averagePerProposalMicroUsd: 3_869n })
    const { browser } = await h.signIn(identity(MEMBER))
    const t = text(await (await browser.get(`/dashboard/${GUILD}`)).text())
    expect(t).toMatch(/AI this month \$0\.042/)
    expect(t).toMatch(/7 model calls since 2026-10-01 ?, estimated from the list price/)
    expect(t).toMatch(/Average per proposal \$0\.004 \(5 drafted\)/)
    expect(t).not.toMatch(/no price/)
  })

  it('Overview: no calls yet, and calls on a model with no price said apart', async () => {
    const h = await seeded()
    const { browser } = await h.signIn(identity(MEMBER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}`)).text())).toMatch(/AI this month \$0 No model calls this month\./)
    h.aiUsage.setSpend(GUILD, { since: OCT, calls: 3, totalMicroUsd: 4_000n, unpriced: 2, proposals: 1, averagePerProposalMicroUsd: null })
    const t = text(await (await browser.get(`/dashboard/${GUILD}`)).text())
    expect(t).toMatch(/2 calls on a model with no price are not in the total/)
    expect(t).toMatch(/Average per proposal unknown \(1 drafted\)/)
  })

  it('Audit log: each proposal with who asked, its model, latency and cost, linked to the run it became', async () => {
    const h = await seeded()
    await h.activeKey()
    const run = await h.run([[ALICE.id, '10']])
    h.aiUsage.addProposal(GUILD, { at: new Date('2026-10-06T10:00:00Z'), model: 'Sonnet 5.5', latencyMs: 2_100, costMicroUsd: 3_869n, mode: 'messages', actorId: TREASURER.id, outcome: 'proposed', runId: run.id })
    h.aiUsage.addProposal(GUILD, { at: new Date('2026-10-06T11:00:00Z'), model: 'Sonnet 5.5', latencyMs: null, costMicroUsd: null, mode: 'criteria', actorId: MEMBER.id, outcome: 'could_not_propose', runId: null })
    h.aiUsage.addProposal(GUILD, { at: new Date('2026-10-06T09:00:00Z'), model: 'Sonnet 5.5', latencyMs: 40, costMicroUsd: 300n, mode: 'messages', actorId: TREASURER.id, outcome: 'proposed', runId: null })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/audit`)).text()
    const section = html.slice(html.indexOf('AI proposals'))
    const rows = section.split('<tr>').slice(2).map(text)
    expect(rows[0]).toMatch(/2026-10-06 11:00 UTC Felix from criteria Sonnet 5\.5 . . could_not_propose/)
    expect(rows[1]).toMatch(/2026-10-06 10:00 UTC Tess from messages Sonnet 5\.5 2\.1 s \$0\.004 drafted/)
    expect(section).toContain(`href="/dashboard/${GUILD}/runs/${run.id}"`)
    // Under a tenth of a second and of a cent, escaped like any text.
    expect(rows[2]).toMatch(/&lt;0\.1 s &lt;\$0\.001 drafted/)
  })

  it('Policy version history: what compiling each version cost', async () => {
    const h = await seeded()
    const policyId = h.policies.seed(GUILD, { name: 'Weekly helpers', instruction: 'Every Monday: 1 per answer' })
    await h.policies.edit({ guildId: GUILD, policyId, actor: { id: TREASURER.id, roleIds: [ROLE] }, draft: { name: 'Weekly helpers', instruction: 'Every Monday: 2 per answer', schedule: { kind: 'weekly', weekday: 1, hour: 18, timezone: 'UTC' } } })
    h.aiUsage.addCompile(GUILD, policyId, 1, { at: OCT, model: 'Sonnet 5.5', latencyMs: 3_400, costMicroUsd: 18_000n })
    h.aiUsage.addCompile(GUILD, policyId, 2, { at: OCT, model: 'Opus 5.5', latencyMs: 5_000, costMicroUsd: null })
    const { browser } = await h.signIn(identity(MEMBER))
    const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    const versions = text(html.slice(html.indexOf('Version history')))
    expect(versions).toMatch(/Version 2 .*Compiled by Opus 5\.5 in 5\.0 s \(no price for this model\)\./)
    expect(versions).toMatch(/Version 1 .*Compiled by Sonnet 5\.5 in 3\.4 s for \$0\.018\./)
  })

  it('a server without the AI spend leaves it out of every page', async () => {
    const h = dashboardHarness({ aiUsage: false })
    await h.community()
    const policyId = h.policies.seed(GUILD, { name: 'Weekly helpers', instruction: 'Every Monday: 1 per answer' })
    const { browser } = await h.signIn(identity(MEMBER))
    for (const path of [`/dashboard/${GUILD}`, `/dashboard/${GUILD}/audit`, `/dashboard/${GUILD}/policies/${policyId}`]) {
      const res = await browser.get(path)
      expect(res.status, path).toBe(200)
      expect(text(await res.text()), path).not.toMatch(/AI this month|AI proposals|Compiled by/)
    }
  })
})
