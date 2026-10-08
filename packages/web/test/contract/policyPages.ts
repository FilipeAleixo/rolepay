// The dashboard's Policies, Audit log and policy-run pages as a CONTRACT: the same page tests run
// against every policy backend, so the in-memory port the page tests use and core's real policy
// services (through the server's adapters, apps/server/test/dashboardContract.test.ts) cannot
// drift apart. Assertions are made against what the backend's own ports answer, never against
// one backend's fixture text.
import type { ManualClock } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import type { AuditPort, PolicyMode, PolicyPort, PolicySchedule } from '../../src/dashboard/policyPort.js'
import { esc } from '../../src/views/page.js'
import { GUILD, MEMBER, OUTSIDER, type PolicyBackendSetup, ROLE, TREASURER, dashboardHarness, identity } from '../dashboardHarness.js'

export const ALICE = { id: '200000000000000011', address: '0x1111111111111111111111111111111111111111' }
export const BOB = { id: '200000000000000012', address: '0x2222222222222222222222222222222222222222' }
/** Matches the Monday rule but has not registered a payout account. */
export const CAROL = { id: '200000000000000013' }
/** Just below the Monday rule's line. */
export const DAN = { id: '200000000000000014' }

export const MONDAY_RULE = 'Every Monday: 1 USDC per answered question in #help, max 50 a week each.'
export const MONDAY: PolicySchedule = { kind: 'weekly', weekday: 1, hour: 18, timezone: 'UTC' }

/** What a policy backend gives the contract: its two ports, and ways to put itself in the states the pages show. */
export interface PolicyBackend {
  readonly policies: PolicyPort
  readonly audit: AuditPort
  /** After `h.community()`: whatever else the backend needs (AI on, Discord's roles, channels and activity, payees, a bot key). */
  prepare(): Promise<void>
  /**
   * The Monday rule (MONDAY_RULE, weekly on Monday 18:00 UTC), active at version 1, approved by
   * the treasurer. Who it applies to right now: ALICE (registered), BOB (registered, capped), CAROL
   * (not registered), and DAN just below the line. The bot names Alice and Bob.
   */
  mondayPolicy(name?: string): Promise<string>
  /** Another policy, approved, in this state, mode and schedule. */
  policy(p: { name: string; status: 'active' | 'paused'; mode: PolicyMode; schedule: PolicySchedule }): Promise<string>
  /** A policy whose preview cannot be worked out just now (Discord cannot be read). */
  unreadablePolicy(name: string): Promise<string>
  /** Spends the bot key's budget so that the Monday rule's next run would be held. */
  exhaustBudget(policyId: string): Promise<void>
  /** An autopilot run of this policy, made now and inside its veto window. The pay run's ID. */
  autopilotRun(policyId: string): Promise<string>
  /** An autopilot run of this policy that Rolepay itself released after its window: events with no actor. The pay run's ID. */
  releasedRun(policyId: string): Promise<string>
  /** From now on the community requires a separate approver (four eyes): an edit then waits for another Treasurer. */
  separateApprover(): Promise<void>
  /** An instruction this backend cannot compile. */
  readonly uncompilable: string
}

export type PolicyBackendFactory = (clock: ManualClock) => PolicyBackendSetup<PolicyBackend>

/** Visible text, roughly: tags dropped, whitespace collapsed, entities kept. */
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const pad = (n: number) => String(n).padStart(2, '0')
const utc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
const rowsOf = (html: string) => (html.slice(html.indexOf('<tbody>')).match(/<tr>/g) ?? []).length
const formatMoney = (micros: bigint) => {
  const whole = micros / 1_000_000n
  const frac = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
const actor = { id: TREASURER.id, roleIds: [ROLE] }
const weekly = { name: 'Weekly helpers', instruction: 'Every Monday: 2 USDC per answered question in #help, max 50 a week each.', kind: 'weekly', weekday: '1', day: '1', hour: '18', timezone: 'UTC' }

/** Runs the dashboard's policy and audit page tests against one backend. */
export function policyPagesContract(name: string, factory: PolicyBackendFactory) {
  async function harness() {
    const h = dashboardHarness({ backend: factory })
    await h.community()
    const backend = h.backend as PolicyBackend
    await backend.prepare()
    return { h, backend }
  }

  async function setup() {
    const { h, backend } = await harness()
    const policyId = await backend.mondayPolicy()
    return { h, backend, policyId, base: `/dashboard/${GUILD}/policies/${policyId}` }
  }

  describe(`${name}: the Policies list`, () => {
    it('lists each policy with its schedule in words, mode, status, next run and how many people it matches now (when known)', async () => {
      const { h, backend, policyId } = await setup()
      await backend.policy({ name: 'Monthly bounties', status: 'paused', mode: 'autopilot', schedule: { kind: 'monthly', day: 1, hour: 9, timezone: 'Europe/Lisbon' } })
      const { browser } = await h.signIn(identity(MEMBER))
      const html = await (await browser.get(`/dashboard/${GUILD}/policies`)).text()
      const t = text(html)
      expect(html).toContain(`href="/dashboard/${GUILD}/policies/${policyId}"`)
      expect(t).toContain('Weekly helpers')
      expect(t).toContain('Every Monday at 18:00 (UTC)')
      expect(t).toContain('Monthly bounties')
      expect(t).toContain('Monthly on day 1 at 09:00 (Europe/Lisbon)')
      expect(t).toMatch(/Propose/)
      expect(t).toMatch(/Autopilot/)
      expect(t).toMatch(/Active/)
      expect(t).toMatch(/Paused/)
      const listed = await backend.policies.list({ guildId: GUILD })
      const monday = listed.find((p) => p.id === policyId)
      expect(monday?.nextRunAt).toBeInstanceOf(Date)
      expect(t).toContain(utc(monday?.nextRunAt as Date))
      expect(t).toContain(monday?.matchesNow === null ? '?' : String(monday?.matchesNow))
    })

    it('offers New policy to the Treasurer role only', async () => {
      const { h } = await setup()
      const { browser: member } = await h.signIn(identity(MEMBER))
      expect(await (await member.get(`/dashboard/${GUILD}/policies`)).text()).not.toContain(`/policies/new`)
      const { browser: treasurer } = await h.signIn(identity(TREASURER))
      expect(await (await treasurer.get(`/dashboard/${GUILD}/policies`)).text()).toContain(`href="/dashboard/${GUILD}/policies/new"`)
    })

    it('the Overview lists the next scheduled runs', async () => {
      const { h, backend, policyId } = await setup()
      const upcoming = await backend.policies.upcoming({ guildId: GUILD, limit: 5 })
      expect(upcoming.map((u) => u.policyId)).toEqual([policyId])
      const { browser } = await h.signIn(identity(MEMBER))
      const html = await (await browser.get(`/dashboard/${GUILD}`)).text()
      expect(html).toContain(`href="/dashboard/${GUILD}/policies/${policyId}"`)
      expect(text(html)).toContain(utc(upcoming[0]?.at as Date))
    })
  })

  describe(`${name}: a policy's page`, () => {
    it('shows the original instruction, the rule in plain words and the exact compiled filter (expandable)', async () => {
      const { h, backend, policyId } = await setup()
      const { browser } = await h.signIn(identity(MEMBER))
      const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
      const detail = await backend.policies.get({ guildId: GUILD, policyId })
      if (!detail.ok) throw new Error(detail.error.code)
      expect(detail.value.instruction).toBe(MONDAY_RULE)
      expect(text(html)).toContain(MONDAY_RULE)
      expect(detail.value.ruleInWords.length).toBeGreaterThan(10)
      expect(html).toContain(esc(detail.value.ruleInWords))
      const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'))
      expect(details).toContain('Exact filter')
      expect(details).toContain(esc(JSON.stringify(detail.value.filter, null, 2)))
      expect(details).toContain('&quot;repliesIn&quot;')
    })

    it('shows who it applies to right now, with metrics, reasons and amounts, who is not registered, and the near misses', async () => {
      const { h, backend, policyId } = await setup()
      const { browser } = await h.signIn(identity(MEMBER))
      const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
      const t = text(html)
      const preview = await backend.policies.preview({ guildId: GUILD, policyId })
      if (!preview.ok) throw new Error(preview.error.code)
      const p = preview.value
      expect(p.matches.map((m) => [m.userId, m.registered])).toEqual(
        expect.arrayContaining([
          [ALICE.id, true],
          [BOB.id, true],
          [CAROL.id, false],
        ]),
      )
      expect(p.nearMisses.map((n) => n.userId)).toContain(DAN.id)
      const applies = t.slice(t.indexOf('Applies to right now'), t.indexOf('Just below the line'))
      expect(applies).toContain('Alice')
      expect(applies).toContain('Bob')
      expect(applies).toContain(`user ${CAROL.id}`)
      expect(applies).toMatch(/not registered/)
      for (const m of p.matches) {
        for (const reason of m.reasons) expect(applies).toContain(esc(reason))
        if (m.registered && m.amount !== null) expect(applies).toContain(`${formatMoney(m.amount)} AlphaUSD`)
      }
      const bob = p.matches.find((m) => m.userId === BOB.id)
      expect(bob?.reasons.some((r) => /capped/.test(r))).toBe(true)
      const alice = p.matches.find((m) => m.userId === ALICE.id)
      expect(Object.values(alice?.metrics ?? {}).length).toBeGreaterThan(0)
      const near = t.slice(t.indexOf('Just below the line'))
      for (const n of p.nearMisses) expect(near).toContain(esc(n.missing))
    })

    it("previews the next run's total against the key's remaining budget, and says when it would be held", async () => {
      const { h, backend, policyId } = await setup()
      const { browser } = await h.signIn(identity(MEMBER))
      const t = text(await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())
      const before = await backend.policies.preview({ guildId: GUILD, policyId })
      if (!before.ok) throw new Error(before.error.code)
      expect(before.value.held).toBeNull()
      expect(before.value.remainingBudget).not.toBeNull()
      expect(t).toContain(utc(before.value.nextRunAt as Date))
      expect(t).toContain(`${formatMoney(before.value.total)} AlphaUSD`)
      expect(t).toContain(`${formatMoney(before.value.remainingBudget as bigint)} AlphaUSD`)
      await backend.exhaustBudget(policyId)
      const after = await backend.policies.preview({ guildId: GUILD, policyId })
      if (!after.ok) throw new Error(after.error.code)
      expect(after.value.held).toMatch(/held/)
      const held = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
      expect(held).toContain(esc(after.value.held as string))
    })

    it('when the preview cannot be worked out, the rest of the page still shows, and says why', async () => {
      const { h, backend } = await harness()
      const policyId = await backend.unreadablePolicy('No preview')
      const preview = await backend.policies.preview({ guildId: GUILD, policyId })
      expect(preview.ok).toBe(false)
      const { browser } = await h.signIn(identity(MEMBER))
      const res = await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)
      expect(res.status).toBe(200)
      const t = text(await res.text())
      expect(t).toMatch(/could not be worked out just now/)
      expect(t).toContain('No preview')
      if (!preview.ok && preview.error.message) expect(t).toContain(esc(preview.error.message))
    })

    it('shows the version history with approvals and what changed between versions', async () => {
      const { h, backend, policyId } = await setup()
      // The Treasurer's edit is in force at once: version 2 is approved by them, version 1 replaced.
      const edited = await backend.policies.edit({ guildId: GUILD, policyId, actor, draft: { name: 'Weekly helpers', instruction: weekly.instruction, schedule: MONDAY } })
      expect(edited).toEqual({ ok: true, value: { version: 2, inForce: true } })
      const { browser } = await h.signIn(identity(MEMBER))
      const html = await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
      const versions = html.slice(html.indexOf('Version history'))
      const t = text(versions)
      expect(t).toMatch(/Version 2 in force approved by Tess.*Version 1 replaced approved by Tess/)
      expect(versions).toContain('<span class="del">- Every Monday: 1 USDC')
      expect(versions).toContain('<span class="add">+ Every Monday: 2 USDC')
      expect((await backend.policies.versions({ guildId: GUILD, policyId })).map((v) => v.status)).toEqual(['superseded', 'approved'])
      // With four eyes on, the next edit waits for another Treasurer.
      await backend.separateApprover()
      expect(await backend.policies.edit({ guildId: GUILD, policyId, actor, draft: { name: 'Weekly helpers', instruction: MONDAY_RULE, schedule: MONDAY } })).toEqual({ ok: true, value: { version: 3, inForce: false } })
      expect(text(await (await browser.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())).toMatch(/Version 3 waiting for approval/)
      expect((await backend.policies.versions({ guildId: GUILD, policyId })).map((v) => v.status)).toEqual(['superseded', 'approved', 'pending'])
    })

    it('shows actions to the Treasurer role only: approve a pending version, edit, pause, switch mode, archive', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser: treasurer } = await h.signIn(identity(TREASURER))
      const active = await (await treasurer.get(base)).text()
      for (const action of ['pause', 'mode', 'archive']) expect(active).toContain(`action="${base}/${action}"`)
      expect(active).not.toContain(`action="${base}/resume"`)
      expect(active).not.toContain(`action="${base}/approve"`)
      // With four eyes on, an edit is a new version waiting for another Treasurer: the policy stops running until it is approved.
      await backend.separateApprover()
      await backend.policies.edit({ guildId: GUILD, policyId, actor, draft: { name: 'Weekly helpers', instruction: 'Every Monday: 3 USDC per answered question in #help.', schedule: MONDAY } })
      const { browser: member } = await h.signIn(identity(MEMBER))
      const readOnly = await (await member.get(base)).text()
      expect(readOnly).not.toMatch(/<form method="post"[^>]*\/policies\//)
      expect(readOnly).not.toContain('class="editor"') // no edit control for members
      expect(text(readOnly)).toMatch(/Only the Treasurer role can change policies/)
      const html = await (await treasurer.get(base)).text()
      for (const action of ['approve', 'discard', 'mode', 'archive']) expect(html).toContain(`action="${base}/${action}"`)
      expect(html).toContain(`href="${base}?edit=1#editor"`)
      expect(html).toContain(`<details class="editor" id="editor"><summary>Edit</summary>`)
      expect(html).toContain(`action="${base}/edit"`)
      expect(html).toContain('name="version" value="2"')
      expect(text(html)).toMatch(/Draft/)
      expect(html).not.toContain(`action="${base}/pause"`)
      expect(html).not.toContain(`action="${base}/resume"`)
    })

    it('an unknown policy is not found', async () => {
      const { h } = await setup()
      const { browser } = await h.signIn(identity(MEMBER))
      expect((await browser.get(`/dashboard/${GUILD}/policies/pol_nope`)).status).toBe(404)
    })
  })

  describe(`${name}: policy actions (the Treasurer role acts, everyone else reads)`, () => {
    it('the Treasurer pauses a policy: the port gets the actor as the bot sees them, and the page says it is done', async () => {
      const { h, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      const res = await browser.act(`${base}/pause`)
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`${base}?done=paused`)
      expect(h.calls).toEqual([{ method: 'pause', guildId: GUILD, policyId, actor: { id: TREASURER.id, roleIds: [ROLE] } }])
      const t = text(await (await browser.get(res.headers.get('location') as string)).text())
      expect(t).toMatch(/Paused\./)
      expect(t).toMatch(/Resume/)
    })

    it('a member cannot act, whatever the form claims: 403 and the port is never called', async () => {
      const { h, base } = await setup()
      const { browser } = await h.signIn(identity(MEMBER))
      for (const action of ['pause', 'resume', 'archive', 'approve', 'discard', 'mode', 'edit']) {
        const res = await browser.act(`${base}/${action}`, { roleIds: ROLE, roles: ROLE, canAct: 'true', version: '1', mode: 'autopilot', vetoWindowHours: '24', name: 'x', instruction: 'y' })
        expect(res.status).toBe(403)
      }
      expect((await browser.act(`/dashboard/${GUILD}/policies`, { name: 'x', instruction: 'y', kind: 'weekly', weekday: '1', hour: '1', timezone: 'UTC' })).status).toBe(403)
      expect(h.calls).toEqual([])
    })

    it('a non-member cannot act either', async () => {
      const { h, base } = await setup()
      const { browser } = await h.signIn(identity(OUTSIDER))
      expect((await browser.act(`${base}/pause`)).status).toBe(403)
      expect(h.calls).toEqual([])
    })

    it('a role revoked mid-session stops the next action at once (roles are read fresh for every action), and pages turn read only within a minute', async () => {
      const { h, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      expect((await browser.get(base)).status).toBe(200)
      expect((await browser.act(`${base}/pause`)).status).toBe(303)
      h.members.set(GUILD, TREASURER.id, [], 'Tess')
      expect((await browser.act(`${base}/resume`)).status).toBe(403)
      expect(h.calls.map((c) => c.method)).toEqual(['pause'])
      h.clock.advance(61)
      expect(text(await (await browser.get(base)).text())).toMatch(/Only the Treasurer role can change policies/)
    })

    it('every action needs this session’s CSRF token', async () => {
      const { h, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      expect((await browser.post(`${base}/pause`)).status).toBe(403)
      expect((await browser.post(`${base}/pause`, { csrf: 'nope' })).status).toBe(403)
      const { browser: other } = await h.signIn(identity(MEMBER))
      expect((await browser.post(`${base}/pause`, { csrf: await other.csrf() })).status).toBe(403)
      expect(h.calls).toEqual([])
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

    it('approves a pending version, and discards one (back to the last approved version, paused)', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      // A draft never approved: an edit keeps it a draft, and its approval stays an explicit step.
      const created = await backend.policies.create({ guildId: GUILD, actor, draft: { name: 'Monthly bounties', instruction: weekly.instruction, schedule: MONDAY } })
      if (!created.ok) throw new Error(created.error.code)
      const draft = `/dashboard/${GUILD}/policies/${created.value.policyId}`
      expect((await browser.act(`${draft}/edit`, { ...weekly, name: 'Monthly bounties' })).headers.get('location')).toBe(`${draft}?done=edited`)
      expect((await browser.act(`${draft}/approve`, { version: '1' })).headers.get('location')).toBe(`${draft}?error=version_mismatch`)
      expect((await browser.act(`${draft}/approve`, { version: '2' })).headers.get('location')).toBe(`${draft}?done=approved`)
      expect((await backend.policies.versions({ guildId: GUILD, policyId: created.value.policyId })).map((v) => v.status)).toEqual(['discarded', 'approved'])
      // With four eyes on, an edit of the active policy waits; discarding it goes back to the approved version, paused.
      await backend.separateApprover()
      expect((await browser.act(`${base}/edit`, { ...weekly, instruction: 'Every Monday: 3 USDC per answered question in #help, max 50 a week each.' })).headers.get('location')).toBe(`${base}?done=edited`)
      expect((await browser.act(`${base}/discard`, { version: '2' })).headers.get('location')).toBe(`${base}?done=discarded`)
      const after = await backend.policies.get({ guildId: GUILD, policyId })
      expect(after.ok && [after.value.status, after.value.version]).toEqual(['paused', 1])
      expect((await backend.policies.versions({ guildId: GUILD, policyId })).map((v) => v.status)).toEqual(['approved', 'discarded'])
      expect((await browser.act(`${base}/approve`, { version: 'x' })).status).toBe(400)
    })

    it('switches to autopilot with a veto window of at least one hour', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      expect((await browser.act(`${base}/mode`, { mode: 'autopilot', vetoWindowHours: '12' })).headers.get('location')).toBe(`${base}?done=mode_changed`)
      const p = await backend.policies.get({ guildId: GUILD, policyId })
      expect(p.ok && [p.value.mode, p.value.vetoWindowMinutes]).toEqual(['autopilot', 720])
      expect(text(await (await browser.get(base)).text())).toContain('Autopilot, veto window 12 hours')
      expect((await browser.act(`${base}/mode`, { mode: 'autopilot', vetoWindowHours: '0' })).status).toBe(400)
      expect((await browser.act(`${base}/mode`, { mode: 'yolo', vetoWindowHours: '24' })).status).toBe(400)
    })

    it('autopilot needs an approved policy', async () => {
      const { h, backend } = await harness()
      const created = await backend.policies.create({ guildId: GUILD, actor, draft: { name: 'Weekly helpers', instruction: weekly.instruction, schedule: MONDAY } })
      if (!created.ok) throw new Error(created.error.code)
      const base = `/dashboard/${GUILD}/policies/${created.value.policyId}`
      const { browser } = await h.signIn(identity(TREASURER))
      expect((await browser.act(`${base}/mode`, { mode: 'autopilot', vetoWindowHours: '2' })).headers.get('location')).toBe(`${base}?error=policy_not_approved`)
      expect(text(await (await browser.get(`${base}?error=policy_not_approved`)).text())).toMatch(/Approve the policy before switching on autopilot/)
    })

    it('archives a policy', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      expect((await browser.act(`${base}/archive`)).headers.get('location')).toBe(`${base}?done=archived`)
      const p = await backend.policies.get({ guildId: GUILD, policyId })
      expect(p.ok && p.value.status).toBe('archived')
      expect(text(await (await browser.get(base)).text())).toMatch(/Archived policies do not change/)
    })

    it('edits in place: the Treasurer opens the editor on the policy page, pre-filled, and saving comes back to it with the new version in force', async () => {
      const { h, base } = await setup()
      // The old edit page now opens the policy page with the editor open; a member gets the page without one.
      const { browser: member } = await h.signIn(identity(MEMBER))
      const old = await member.get(`${base}/edit`)
      expect([old.status, old.headers.get('location')]).toEqual([302, `${base}?edit=1#editor`])
      expect(await (await member.get(`${base}?edit=1`)).text()).not.toContain('class="editor"')
      const { browser } = await h.signIn(identity(TREASURER))
      expect((await browser.get(`${base}/edit`)).headers.get('location')).toBe(`${base}?edit=1#editor`)
      const closed = await (await browser.get(base)).text()
      expect(closed).toContain('<details class="editor" id="editor"><summary>Edit</summary>')
      const open = await (await browser.get(`${base}?edit=1`)).text()
      expect(open).toContain('<details class="editor" id="editor" open><summary>Edit</summary>')
      const editor = open.slice(open.indexOf('id="editor"'), open.indexOf('</details>', open.indexOf('id="editor"')))
      expect(editor).toContain(esc(MONDAY_RULE))
      expect(editor).toMatch(/<option value="1" selected>Monday<\/option>/)
      expect(editor).toContain('<button type="submit">Save and apply</button>')
      const done = await browser.act(`${base}/edit`, weekly)
      expect(done.headers.get('location')).toBe(`${base}?done=applied`)
      const after = text(await (await browser.get(`${base}?done=applied`)).text())
      expect(after).toContain('Saved. Version 2 is in force.')
      expect(after).not.toMatch(/Version \d waits for approval/)
      // A refused edit comes back to the same page, the editor open with what was sent and why.
      const refused = await browser.act(`${base}/edit`, { ...weekly, name: '', instruction: 'Keep <this> wording' })
      expect(refused.status).toBe(400)
      const again = await refused.text()
      expect(again).toContain('<details class="editor" id="editor" open>')
      expect(again).toContain('Give the policy a name.')
      expect(again).toContain('Keep &lt;this&gt; wording')
    })

    it('reads only the schedule fields the chosen kind uses: a hidden field with a stale value is never used, nor refused', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      // Weekly: the day of the month (hidden on the page) is out of range and ignored.
      expect((await browser.act(`${base}/edit`, { ...weekly, weekday: '3', day: '99' })).headers.get('location')).toBe(`${base}?done=applied`)
      const weeklyNow = await backend.policies.versions({ guildId: GUILD, policyId })
      expect(weeklyNow.length).toBe(2)
      const asWeekly = await backend.policies.get({ guildId: GUILD, policyId })
      expect(asWeekly.ok && asWeekly.value.schedule).toEqual({ kind: 'weekly', weekday: 3, hour: 18, minute: 0, timezone: 'UTC' })
      // Monthly: the weekday (hidden) is junk and ignored; the day of the month is what counts.
      expect((await browser.act(`${base}/edit`, { ...weekly, kind: 'monthly', weekday: 'x', day: '15' })).headers.get('location')).toBe(`${base}?done=applied`)
      const asMonthly = await backend.policies.get({ guildId: GUILD, policyId })
      expect(asMonthly.ok && asMonthly.value.schedule).toEqual({ kind: 'monthly', day: 15, hour: 18, minute: 0, timezone: 'UTC' })
      // The field the kind does use is still checked.
      expect((await browser.act(`${base}/edit`, { ...weekly, kind: 'monthly', day: '31' })).status).toBe(400)
      expect((await browser.act(`${base}/edit`, { ...weekly, weekday: '9' })).status).toBe(400)
    })

    it('the time has a minute: the editor shows it next to the hour, pre-filled; an edit changes it and the pages say HH:MM; past 59 is refused in words', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      const open = await (await browser.get(`${base}?edit=1`)).text()
      const editor = open.slice(open.indexOf('id="editor"'), open.indexOf('</details>', open.indexOf('id="editor"')))
      expect(editor).toContain('<label for="minute">Minute (0-59)</label><input id="minute" name="minute" type="number" min="0" max="59" value="0">')
      expect(editor.indexOf('name="minute"')).toBeGreaterThan(editor.indexOf('name="hour"'))
      expect((await browser.act(`${base}/edit`, { ...weekly, hour: '9', minute: '30' })).headers.get('location')).toBe(`${base}?done=applied`)
      const p = await backend.policies.get({ guildId: GUILD, policyId })
      expect(p.ok && p.value.schedule).toEqual({ kind: 'weekly', weekday: 1, hour: 9, minute: 30, timezone: 'UTC' })
      const page = await (await browser.get(`${base}?edit=1`)).text()
      expect(text(page)).toContain('Every Monday at 09:30 (UTC)')
      expect(page).toContain('name="minute" type="number" min="0" max="59" value="30"')
      expect(text(await (await browser.get(`/dashboard/${GUILD}/policies`)).text())).toContain('Every Monday at 09:30 (UTC)')
      const late = await browser.act(`${base}/edit`, { ...weekly, minute: '60' })
      expect(late.status).toBe(400)
      expect(text(await late.text())).toContain('The minute is 0 to 59.')
    })

    it("the Treasurer's edit is in force at once: the policy keeps running and its autopilot, and the page shows the new rule and who it applies to", async () => {
      const { h, backend, policyId, base } = await setup()
      expect((await backend.policies.setMode({ guildId: GUILD, policyId, actor, mode: 'autopilot', vetoWindowMinutes: 120 })).ok).toBe(true)
      const { browser } = await h.signIn(identity(TREASURER))
      const instruction = 'Every Monday: 2 USDC per answered question in #help, max 50 a week each.'
      const res = await browser.act(`${base}/edit`, { ...weekly, instruction, mode: 'autopilot', vetoWindowMinutes: '120' })
      expect(res.headers.get('location')).toBe(`${base}?done=applied`)
      const p = await backend.policies.get({ guildId: GUILD, policyId })
      if (!p.ok) throw new Error(p.error.code)
      expect([p.value.status, p.value.mode, p.value.vetoWindowMinutes, p.value.version, p.value.approvedBy, p.value.pendingVersion, p.value.instruction]).toEqual([
        'active',
        'autopilot',
        120,
        2,
        TREASURER.id,
        null,
        instruction,
      ])
      const html = await (await browser.get(`${base}?done=applied`)).text()
      const t = text(html)
      expect(t).toContain('Saved. Version 2 is in force.')
      expect(t).toContain(instruction)
      expect(html).toContain(esc(p.value.ruleInWords))
      expect(t).toContain('Autopilot, veto window 2 hours')
      expect(t).toMatch(/Version 2, approved by Tess/)
      expect(html).not.toContain(`action="${base}/approve"`)
      // Who the new rule applies to, worked out again.
      const preview = await backend.policies.preview({ guildId: GUILD, policyId })
      if (!preview.ok) throw new Error(preview.error.code)
      expect(t).toContain(`${formatMoney(preview.value.total)} AlphaUSD`)
      for (const m of preview.value.matches) for (const reason of m.reasons) expect(html).toContain(esc(reason))
    })

    it('the edit switches autopilot on or off; the veto window is read only with autopilot, and one the services refuse reopens the editor, nothing saved', async () => {
      const { h, backend, policyId, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      const mode = async () => {
        const p = await backend.policies.get({ guildId: GUILD, policyId })
        return p.ok && [p.value.mode, p.value.vetoWindowMinutes, p.value.version, p.value.name]
      }
      expect((await browser.act(`${base}/edit`, { ...weekly, mode: 'autopilot', vetoWindowMinutes: '90' })).headers.get('location')).toBe(`${base}?done=applied`)
      expect(await mode()).toEqual(['autopilot', 90, 2, 'Weekly helpers'])
      // Propose: the veto window (hidden on the page) is not read, junk included.
      expect((await browser.act(`${base}/edit`, { ...weekly, mode: 'propose', vetoWindowMinutes: 'junk' })).headers.get('location')).toBe(`${base}?done=applied`)
      expect(await mode()).toEqual(['propose', 90, 3, 'Weekly helpers'])
      // Under an hour: the services refuse it, and the editor comes back open with what was sent and why.
      const short = await browser.act(`${base}/edit`, { ...weekly, name: 'Faster helpers', mode: 'autopilot', vetoWindowMinutes: '30' })
      expect(short.status).toBe(422)
      const again = await short.text()
      expect(again).toContain('<details class="editor" id="editor" open>')
      expect(text(again)).toMatch(/Nothing was saved: .*veto window/)
      expect(again).toContain('value="Faster helpers"')
      expect(again).toContain('<input type="radio" name="mode" value="autopilot" checked>')
      expect(await mode()).toEqual(['propose', 90, 3, 'Weekly helpers'])
      // Out of the form's own range, or not a mode: refused before the services are asked.
      expect((await browser.act(`${base}/edit`, { ...weekly, mode: 'autopilot', vetoWindowMinutes: '0' })).status).toBe(400)
      expect((await browser.act(`${base}/edit`, { ...weekly, mode: 'yolo' })).status).toBe(400)
      expect(await mode()).toEqual(['propose', 90, 3, 'Weekly helpers'])
    })

    it('the editor says beforehand what saving does, and offers the mode only where the edit applies at once', async () => {
      const { h, backend, base } = await setup()
      const { browser } = await h.signIn(identity(TREASURER))
      const editorOf = async (path: string) => {
        const html = await (await browser.get(`${path}?edit=1`)).text()
        const at = html.indexOf('id="editor"')
        return html.slice(at, html.indexOf('</details>', at))
      }
      // An approved policy: at once, with the mode pre-filled.
      const now = await editorOf(base)
      expect(now).toContain('<input type="radio" name="mode" value="propose" checked>')
      expect(now).toContain('name="vetoWindowMinutes" type="number" min="1" max="10080" value="1440"')
      expect(text(now)).toContain('Your change applies as soon as you save: the policy keeps running with it, and the new version is recorded as approved by you.')
      expect(now).toContain('<button type="submit">Save and apply</button>')
      // A draft: its first approval stays a step of its own.
      const created = await backend.policies.create({ guildId: GUILD, actor, draft: { name: 'Monthly bounties', instruction: weekly.instruction, schedule: MONDAY } })
      if (!created.ok) throw new Error(created.error.code)
      const draft = await editorOf(`/dashboard/${GUILD}/policies/${created.value.policyId}`)
      expect(draft).not.toContain('name="mode"')
      expect(text(draft)).toContain('The new version waits for approval here, and the policy does not run until it is approved.')
      expect(draft).toContain('<button type="submit">Recompile and preview</button>')
      // Four eyes: another Treasurer approves the change.
      await backend.separateApprover()
      const four = await editorOf(base)
      expect(four).not.toContain('name="mode"')
      expect(text(four)).toContain('This community requires a second person: the new version waits for another Treasurer to approve it here, and the policy does not run until then.')
      // Autopilot posted anyway (not from this page) is refused for an edit that waits: nothing is saved.
      const forced = await browser.act(`${base}/edit`, { ...weekly, mode: 'autopilot', vetoWindowMinutes: '120' })
      expect(forced.status).toBe(422)
      expect(text(await forced.text())).toContain('Nothing was saved: autopilot can be switched on only for an approved policy')
    })
  })

  describe(`${name}: creating a policy from the web (the same compile, preview and approve flow as Discord)`, () => {
    it('compiles the instruction into a draft and lands on its page, ready for approval', async () => {
      const { h } = await harness()
      const { browser } = await h.signIn(identity(TREASURER))
      const form = await (await browser.get(`/dashboard/${GUILD}/policies/new`)).text()
      expect(form).toContain(`action="/dashboard/${GUILD}/policies"`)
      expect(form).toContain('name="instruction"')
      expect(form).toContain('<input id="minute" name="minute" type="number" min="0" max="59" value="0">')
      const res = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, kind: 'monthly', day: '15', hour: '9', minute: '15', timezone: 'Europe/Lisbon' })
      expect(res.status).toBe(303)
      const location = res.headers.get('location') as string
      expect(location).toMatch(new RegExp(`^/dashboard/${GUILD}/policies/[A-Za-z0-9_]+\\?done=created$`))
      const page = text(await (await browser.get(location)).text())
      expect(page).toMatch(/Draft/)
      expect(page).toMatch(/Monthly on day 15 at 09:15 \(Europe\/Lisbon\)/)
      expect(page).toMatch(/Version 1 waits for approval/)
      expect(h.calls.map((c) => [c.method, c.actor])).toEqual([['create', { id: TREASURER.id, roleIds: [ROLE] }]])
    })

    it('says what is wrong and keeps what was typed when the form is incomplete or the rule cannot be compiled', async () => {
      const { h, backend } = await harness()
      const { browser } = await h.signIn(identity(TREASURER))
      const empty = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, name: '' })
      expect(empty.status).toBe(400)
      expect(text(await empty.text())).toMatch(/Give the policy a name/)
      const badZone = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, timezone: 'Mars/Olympus' })
      expect(badZone.status).toBe(400)
      // The limits are core's own, so the form refuses what core would.
      const long = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, name: 'x'.repeat(81) })
      expect(long.status).toBe(400)
      expect(text(await long.text())).toMatch(/The name is at most 80 characters/)
      const longer = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, instruction: 'y'.repeat(1001) })
      expect(longer.status).toBe(400)
      expect(text(await longer.text())).toMatch(/The instruction is at most 1,000 characters/)
      const unclear = await browser.act(`/dashboard/${GUILD}/policies`, { ...weekly, instruction: backend.uncompilable })
      expect(unclear.status).toBe(422)
      const html = await unclear.text()
      expect(text(html)).toMatch(/could not be compiled/)
      expect(html).toContain(esc(backend.uncompilable))
      expect(h.calls.length).toBe(1)
    })

    it('a member does not get the form', async () => {
      const { h } = await harness()
      const { browser } = await h.signIn(identity(MEMBER))
      expect((await browser.get(`/dashboard/${GUILD}/policies/new`)).status).toBe(403)
    })
  })

  describe(`${name}: a run made by a policy, and the veto`, () => {
    it('shows which policy made a run; the Treasurer vetoes an autopilot run inside its window, a member cannot', async () => {
      const { h, backend, policyId } = await setup()
      const runId = await backend.autopilotRun(policyId)
      const page = `/dashboard/${GUILD}/runs/${runId}`
      const origins = await backend.policies.runOrigins({ guildId: GUILD, runIds: [runId] })
      expect(origins[runId]).toMatchObject({ policyId, mode: 'autopilot', vetoable: true, vetoedBy: null })

      const { browser: member } = await h.signIn(identity(MEMBER))
      const seen = await (await member.get(page)).text()
      expect(seen).toContain(`href="/dashboard/${GUILD}/policies/${policyId}"`)
      expect(text(seen)).toMatch(/Made by a policy/)
      expect(text(seen)).toMatch(/unless vetoed/)
      expect(text(seen)).toMatch(/A Treasurer can veto it until then/)
      expect(seen).not.toContain(`action="${page}/veto"`)
      expect((await member.act(`${page}/veto`)).status).toBe(403)
      expect(h.calls).toEqual([])

      const { browser } = await h.signIn(identity(TREASURER))
      expect(await (await browser.get(page)).text()).toContain(`action="${page}/veto"`)
      const vetoed = await browser.act(`${page}/veto`)
      expect(vetoed.status).toBe(303)
      expect(vetoed.headers.get('location')).toBe(`${page}?done=vetoed`)
      expect(h.calls).toEqual([{ method: 'veto', guildId: GUILD, actor: { id: TREASURER.id, roleIds: [ROLE] } }])
      const after = text(await (await browser.get(`${page}?done=vetoed`)).text())
      expect(after).toMatch(/Vetoed\. This run is cancelled/)
      expect(after).toMatch(/Vetoed by Tess/)
      expect((await backend.policies.runOrigins({ guildId: GUILD, runIds: [runId] }))[runId]).toMatchObject({ vetoable: false, vetoedBy: TREASURER.id })
      // Twice is not possible: the window is over for this run.
      expect((await browser.act(`${page}/veto`)).headers.get('location')).toBe(`${page}?error=illegal_state`)
    })

    it('the Runs page names the policy behind a run and filters by it', async () => {
      const { h, backend, policyId } = await setup()
      const runId = await backend.autopilotRun(policyId)
      const { browser } = await h.signIn(identity(MEMBER))
      const html = await (await browser.get(`/dashboard/${GUILD}/runs?policy=${policyId}`)).text()
      expect(html).toContain(`href="/dashboard/${GUILD}/runs/${runId}"`)
      expect(text(html)).toContain('Weekly helpers')
      expect(await (await browser.get(`/dashboard/${GUILD}/runs?policy=manual`)).text()).not.toContain(`href="/dashboard/${GUILD}/runs/${runId}"`)
    })
  })

  describe(`${name}: the Audit log`, () => {
    async function story() {
      const s = await setup()
      const runId = await s.backend.releasedRun(s.policyId)
      const { browser } = await s.h.signIn(identity(TREASURER))
      expect((await browser.act(`${s.base}/pause`)).status).toBe(303)
      return { ...s, runId }
    }

    it('lists every event newest first: when, what, who (Rolepay for its own steps), which policy and run, in plain words', async () => {
      const { h, backend, policyId, runId } = await story()
      const events = await backend.audit.events({ guildId: GUILD, limit: 50 })
      expect(events[0]?.type).toBe('policy.paused')
      expect(events.some((e) => e.actorId === null && e.runId === runId)).toBe(true)
      const { browser } = await h.signIn(identity(MEMBER))
      const res = await browser.get(`/dashboard/${GUILD}/audit`)
      expect(res.status).toBe(200)
      const html = await res.text()
      const table = html.slice(html.indexOf('<table'))
      expect(rowsOf(table)).toBe(events.length)
      let at = -1
      for (const e of events) {
        const i = table.indexOf(esc(e.summary), at + 1)
        expect(i, e.type).toBeGreaterThan(at)
        at = i
      }
      const t = text(table)
      expect(t).toContain(utc(events[0]?.at as Date))
      expect(t).toContain('Tess')
      expect(t).toContain('Rolepay')
      expect(html).toContain(`href="/dashboard/${GUILD}/policies/${policyId}"`)
      expect(html).toContain(`href="/dashboard/${GUILD}/runs/${runId}"`)
    })

    it('filters by type, actor and policy, and keeps them selected', async () => {
      const { h } = await story()
      const { browser } = await h.signIn(identity(MEMBER))
      const byType = await (await browser.get(`/dashboard/${GUILD}/audit?type=policy.paused`)).text()
      expect(rowsOf(byType.slice(byType.indexOf('<table')))).toBe(1)
      expect(byType).toMatch(/<option value="policy.paused" selected>/)
      const byActor = text(await (await browser.get(`/dashboard/${GUILD}/audit?actor=${TREASURER.id}`)).text())
      expect(byActor).toContain('Tess')
      expect(byActor.slice(byActor.indexOf('What happened'))).not.toContain('Rolepay')
      const byPolicy = text(await (await browser.get(`/dashboard/${GUILD}/audit?policy=pol_other`)).text())
      expect(byPolicy).toMatch(/No events match/)
    })

    it('pages back through older events, keeping the filter', async () => {
      const { h, backend, policyId } = await setup()
      for (let i = 0; i < 28; i++) {
        await backend.policies.pause({ guildId: GUILD, policyId, actor })
        await backend.policies.resume({ guildId: GUILD, policyId, actor })
      }
      const all = await backend.audit.events({ guildId: GUILD, policyId, limit: 500 })
      expect(all.length).toBeGreaterThan(50)
      const { browser } = await h.signIn(identity(MEMBER))
      const first = await (await browser.get(`/dashboard/${GUILD}/audit?policy=${policyId}`)).text()
      expect(rowsOf(first.slice(first.indexOf('<table')))).toBe(50)
      const older = /href="([^"]*before=[^"]*)"/.exec(first)?.[1]?.replaceAll('&amp;', '&') as string
      expect(older).toContain(`policy=${policyId}`)
      expect(older).toContain(`before=${encodeURIComponent(all[49]?.id as string)}`)
      const second = await (await browser.get(older)).text()
      expect(rowsOf(second.slice(second.indexOf('<table')))).toBe(all.length - 50)
      expect(second).toContain('Newest events')
    })

    it('exports the filtered log as CSV: every matching event, names included, formulas defused', async () => {
      const { h, backend } = await harness()
      const policyId = await backend.mondayPolicy('=cmd|"/c calc"!A1')
      const runId = await backend.releasedRun(policyId)
      const { browser } = await h.signIn(identity(TREASURER))
      await browser.act(`/dashboard/${GUILD}/policies/${policyId}/pause`)
      const page = await (await browser.get(`/dashboard/${GUILD}/audit?type=policy.paused`)).text()
      expect(page).toContain(`href="/dashboard/${GUILD}/audit/csv?type=policy.paused"`)
      const res = await browser.get(`/dashboard/${GUILD}/audit/csv`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="rolepay-audit-1094309218049937418-\d{4}-\d{2}-\d{2}\.csv"$/)
      const lines = (await res.text()).trimEnd().split('\r\n')
      expect(lines[0]).toBe('at,type,actor_id,actor_name,policy_id,policy_name,run_id,summary')
      expect(lines).toHaveLength((await backend.audit.events({ guildId: GUILD, limit: 500 })).length + 1)
      expect(lines[1]).toContain(`,policy.paused,${TREASURER.id},Tess,${policyId},"'=cmd|""/c calc""!A1",,`)
      expect(lines.some((l) => l.includes(',,Rolepay,') && l.includes(runId))).toBe(true)
      const filtered = (await (await browser.get(`/dashboard/${GUILD}/audit/csv?type=policy.paused`)).text()).trimEnd().split('\r\n')
      expect(filtered).toHaveLength(2)
    })

    it('members and the Treasurer alike can read and export it; outsiders cannot', async () => {
      const { h } = await setup()
      const { browser: member } = await h.signIn(identity(MEMBER))
      expect((await member.get(`/dashboard/${GUILD}/audit`)).status).toBe(200)
      expect((await member.get(`/dashboard/${GUILD}/audit/csv`)).status).toBe(200)
      const { browser } = await h.signIn(identity(OUTSIDER, [{ id: GUILD, name: 'Mods guild' }]))
      expect((await browser.get(`/dashboard/${GUILD}/audit`)).status).toBe(403)
      expect((await browser.get(`/dashboard/${GUILD}/audit/csv`)).status).toBe(403)
    })
  })
}
