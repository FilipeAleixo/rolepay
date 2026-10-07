import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, TREASURER, TREASURY, dashboardHarness, identity, usd } from '../../test/dashboardHarness.js'

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
