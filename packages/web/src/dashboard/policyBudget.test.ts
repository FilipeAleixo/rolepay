// A policy's own budget on its dashboard page: what it may spend, read from the chain through the
// policy keys port, and, for the Treasurer role, the way to the treasury page that gives it one.
import type { KeyStatusView } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, TOKEN, TREASURER, dashboardHarness, identity, usd } from '../../test/dashboardHarness.js'

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replaceAll('&#39;', "'")
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)

const ownKey = (over: { remaining?: bigint; status?: KeyStatusView['state']['status'] } = {}): KeyStatusView => ({
  key: {
    address: '0x6666666666666666666666666666666666666666',
    communityId: GUILD,
    status: 'active',
    policy: { token: TOKEN, limit: usd('30'), periodSeconds: 7 * 86_400, expiresAt: at('2026-12-05T12:00:00Z'), recipients: null, feeToken: null, feeBudget: null },
    createdAt: new Date('2026-10-06T12:00:00Z'),
    authorizedAt: new Date('2026-10-06T12:00:00Z'),
    revokedAt: null,
  },
  state: { status: over.status ?? 'active', expiry: at('2026-12-05T12:00:00Z'), remaining: over.remaining ?? usd('20'), periodEnd: at('2026-10-13T12:00:00Z'), chainTime: at('2026-10-06T12:00:00Z'), feeBudgetRemaining: null },
})

async function withPolicy(opts: { policyKeys?: boolean; status?: 'active' | 'archived' } = {}) {
  const h = dashboardHarness({ ...(opts.policyKeys === false ? { policyKeys: false } : {}) })
  await h.community()
  const id = h.policies.seed(GUILD, { name: 'Judges', instruction: 'Every day: 1 AlphaUSD to every new judge', status: opts.status ?? 'active' })
  return { h, id, page: `/dashboard/${GUILD}/policies/${id}` }
}

describe("a policy's own budget on its page", () => {
  it('a policy with no key of its own: it pays from the bot key, shared; a member reads that, only the Treasurer gets the button', async () => {
    const { h, page } = await withPolicy()
    const member = await h.signIn(identity(MEMBER))
    const seen = text(await (await member.browser.get(page)).text())
    expect(seen).toContain("Budget This policy pays from the bot key's budget, shared with manual runs, AI-proposed runs and other policies.")
    expect(seen).not.toContain('Give this policy its own budget')
    const treasurer = await h.signIn(identity(TREASURER))
    const html = await (await treasurer.browser.get(page)).text()
    expect(html).toMatch(/<form method="post" action="\/dashboard\/[0-9]+\/policies\/pol_[0-9]+\/budget"><input type="hidden" name="csrf" value="[^"]+"><button type="submit">Give this policy its own budget<\/button><\/form>/)
    expect(text(html)).toContain('Opens the treasury page: the treasury passkey signs it, and the chain enforces it.')
  })

  it('its own key: spent and left this period, the limit as the end of the bar, when it resets and expires; read from the chain', async () => {
    const { h, id, page } = await withPolicy()
    h.policyKeys.set(GUILD, id, { kind: 'own', key: ownKey() })
    for (const who of [MEMBER, TREASURER]) {
      const { browser } = await h.signIn(identity(who))
      const html = await (await browser.get(page)).text()
      const t = text(html)
      expect(t, who.name).toMatch(/This policy's own budget Spent this period 10 AlphaUSD Left 20 AlphaUSD/)
      expect(html, who.name).toContain('aria-label="This policy&#39;s own budget: 10 of 30 AlphaUSD spent, 20 AlphaUSD left.')
      expect(t, who.name).toMatch(/Limit 30 AlphaUSD/)
      expect(t, who.name).toContain('Resets 2026-10-13 12:00 UTC · expires 2026-12-05 12:00 UTC')
      expect(t, who.name).toContain('This policy can never spend past that line: the chain enforces it')
      expect(t, who.name).toContain("Only this policy's runs are signed with this key; the bot key and other policies are not touched.")
    }
    const { browser } = await h.signIn(identity(TREASURER))
    expect(text(await (await browser.get(page)).text())).toContain('Change or revoke its budget')
  })

  it("its key revoked: it pays nothing until a treasurer gives it a new budget, and never falls back to the bot key", async () => {
    const { h, id, page } = await withPolicy()
    h.policyKeys.set(GUILD, id, { kind: 'retired' })
    const { browser } = await h.signIn(identity(TREASURER))
    const t = text(await (await browser.get(page)).text())
    expect(t).toContain("This policy's own key is revoked: it pays nothing until a treasurer gives it a new budget. It never falls back to the bot key.")
    expect(t).toContain('Give this policy its own budget')
  })

  it('archived with its key still live on chain: the page offers to revoke it', async () => {
    const { h, id, page } = await withPolicy({ status: 'archived' })
    h.policyKeys.set(GUILD, id, { kind: 'own', key: ownKey() })
    const { browser } = await h.signIn(identity(TREASURER))
    const t = text(await (await browser.get(page)).text())
    expect(t).toContain('This policy is archived, but its own key is still live on chain. Revoke it on the treasury page, so nothing can spend with it.')
    expect(t).toContain('Revoke its key on the treasury page')
    // Archived with no key of its own: nothing to offer.
    h.policyKeys.set(GUILD, id, { kind: 'shared' })
    expect(text(await (await browser.get(page)).text())).not.toContain('Give this policy its own budget')
  })

  it('the chain could not be read: the page says so and still renders', async () => {
    const { h, id, page } = await withPolicy()
    h.policyKeys.set(GUILD, id, new Error('rpc down'))
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(page)
    expect(res.status).toBe(200)
    expect(text(await res.text())).toContain("Rolepay could not read this policy's budget from the chain just now. Reload in a moment.")
  })

  it('a server without the port: no budget card, as before', async () => {
    const { h, page } = await withPolicy({ policyKeys: false })
    const { browser } = await h.signIn(identity(TREASURER))
    const t = text(await (await browser.get(page)).text())
    expect(t).not.toContain('Give this policy its own budget')
    expect(t).not.toMatch(/^Budget /m)
    expect((await browser.act(`${page}/budget`)).status).toBe(404)
  })

  it("the button: the Treasurer gets a fresh treasury page link for this policy (CSRF, roles read fresh); a member does not", async () => {
    const { h, id, page } = await withPolicy()
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`${page}/budget`)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    const m = /^\/setup\/([^/]+)\/policies\/(.+)$/.exec(location)
    expect(m?.[2]).toBe(id)
    const link = await h.rolepay.communities.describeSetupLink({ token: decodeURIComponent(m?.[1] ?? '') })
    expect(link).toMatchObject({ ok: true, value: { guildId: GUILD, discordUserId: TREASURER.id } })
    // Without the CSRF token, or as a member: refused, and no link.
    expect((await browser.post(`${page}/budget`)).status).toBe(403)
    const member = await h.signIn(identity(MEMBER))
    expect((await member.browser.act(`${page}/budget`)).status).toBe(403)
    // An unknown policy: no link either.
    expect((await browser.act(`/dashboard/${GUILD}/policies/pol_unknown/budget`)).status).toBe(404)
  })
})
