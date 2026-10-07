// Standing policies across Discord and the web dashboard, in process, with the public demo's
// flags (ROLEPAY_DEMO_CONTROLS on, the dev shortcuts off). Every Discord step is a signed POST
// /discord/interactions; every dashboard step is a browser request with cookies and the CSRF token;
// the dashboard reads and acts through core's real services (the policy seam as main.ts wires it).
// setup on the treasury page -> /rolepay policy new -> preview -> Approve -> the dashboard shows who
// it applies to -> autopilot with a one-minute window -> run_now -> veto on the dashboard (Discord's
// message follows) -> next week the scheduler makes the next run -> it pays -> the audit log has
// every step.
import { AUDIT_EVENT_TYPES, WEEKDAYS } from '@rolepay/core'
import { emptyCriteria } from '@rolepay/core/adapters'
import { buttonClick, slashCommand, wireMessage } from '@rolepay/discord/testing'
import { TestBrowser, identity } from '@rolepay/web/contract'
import { FakeDiscordOAuth } from '@rolepay/web/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer, usd } from './support.js'

const CHANNEL = '700000000000000001'
const HELP = '700000000000000002'
const SCOPE = { guildId: GUILD, channelId: CHANNEL }
const TREASURER_ROLE = '400000000000000001'
const MODS_ROLE = '400000000000000002'
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE] }
const TREASURER_ADMIN = { ...TREASURER, manageGuild: true }
const ANA = '200000000000000001'
const RUI = '200000000000000002'
const FELIX = '200000000000000003'
const ADDR: Record<string, string> = { [ANA]: '0x1111111111111111111111111111111111111111', [RUI]: '0x2222222222222222222222222222222222222222' }
const ORIGIN = 'https://rolepay.test'
const text = (v: unknown) => JSON.stringify(v ?? null)
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const json = async (res: Response) => (await res.json()) as { type: number; data?: Record<string, unknown> }

type Server = Awaited<ReturnType<typeof testServer>>

/** The production setup, as the public demo has it: the treasury page binds the passkey and authorises a key of 100. */
async function setUp(s: Server) {
  s.rest.guilds.set(GUILD, 'Mods guild')
  await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { approver_role: TREASURER_ROLE }, TREASURER_ADMIN, 'tok-setup'))
  await s.drain()
  const path = /https:\/\/rolepay\.test(\/setup\/[A-Za-z0-9_-]+)/.exec(text(s.rest.lastEdit('tok-setup')))?.[1] as string
  expect((await s.browserPost(`${path}/treasury`, TREASURY)).status).toBe(200)
  const provisioned = (await (await s.browserPost(`${path}/key`, TREASURY, { limit: '100', periodDays: 30, expiresAt: Math.floor(s.clock.now().getTime() / 1000) + 30 * 86_400 })).json()) as {
    keyAddress: `0x${string}`
    authorization: { expiry: number; limits: { token: string; limit: string; period?: number }[]; scopes: never }
  }
  const authorization = { ...provisioned.authorization, limits: provisioned.authorization.limits.map((l) => ({ ...l, limit: BigInt(l.limit) })) }
  expect((await s.chain.authorizeKey({ root: s.chain.rootSigner(TREASURY), accessKey: provisioned.keyAddress, authorization: authorization as never })).ok).toBe(true)
  expect((await s.browserPost(`${path}/key/confirm`, TREASURY, { keyAddress: provisioned.keyAddress })).status).toBe(200)
  await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { ai_proposals: true }, TREASURER_ADMIN, 'tok-ai'))
  await s.drain()
  for (const user of [ANA, RUI]) {
    const res = await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: user }))
    const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(((await res.json()) as { data: { content: string } }).data.content)?.[1] as string
    expect((await s.browserPost(url, ADDR[user] as string)).status).toBe(200)
  }
  // The server as Discord shows it: a Mods role, #help, and the members' names (for the dashboard).
  s.rest.roles.set(GUILD, [
    { id: TREASURER_ROLE, name: 'Treasurer' },
    { id: MODS_ROLE, name: 'Mods' },
  ])
  s.rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }])
  s.rest.setMember(GUILD, TREASURER.userId, [TREASURER_ROLE], null, 'Tess')
  s.rest.setMember(GUILD, ANA, [MODS_ROLE], null, 'Ana')
  s.rest.setMember(GUILD, RUI, [MODS_ROLE], null, 'Rui')
  s.rest.setMember(GUILD, FELIX, [], null, 'Felix')
}

/** Answers in #help (replies to someone else's question) at these times. */
function answers(s: Server, who: string, times: Date[]) {
  s.rest.addChannelMessages(...times.map((at) => wireMessage({ channelId: HELP, authorId: who, at, replyTo: { id: '820000000000000001', authorId: '200000000000000009' } })))
}

/** A browser signed in to the dashboard through the real Discord sign-in routes (the fake consent screen). */
async function dashboard(s: Server, oauth: FakeDiscordOAuth, user: { id: string; name: string }) {
  const b = new TestBrowser(s.app, ORIGIN)
  oauth.signInAs(identity(user, [{ id: GUILD, name: 'Mods guild' }]))
  const start = await b.get('/auth/discord')
  const consent = new URL(start.headers.get('location') as string)
  expect((await b.get(consent.pathname + consent.search)).status).toBe(303)
  return b
}

describe('standing policies across Discord and the dashboard', () => {
  it('write in Discord, approve, see who it applies to on the dashboard, run_now on autopilot, veto one run on the dashboard, let the next pay, and read every step in the audit log', async () => {
    const oauth = new FakeDiscordOAuth()
    const s = await testServer({ devShortcuts: false, demoControls: true, policySeam: true, dashboard: { oauth } })
    expect([s.config.app.devShortcuts, s.config.app.demoControls, s.config.policies.minVetoMinutes]).toEqual([false, true, 1])
    await setUp(s)
    const now = s.clock.now().getTime()
    answers(s, ANA, [30, 40, 50].map((sec) => new Date(now - sec * 1000)))
    answers(s, RUI, [new Date(now - 60_000)])
    s.proposer.onCriteria = () =>
      emptyCriteria(
        { amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk' },
        { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C1'], since: new Date(now - 7 * 86_400_000).toISOString().slice(0, 10), until: '', min: 1 }] },
      )
    // It runs tomorrow at this hour (UTC), so the week counted includes the answers above.
    const tomorrow = new Date(now + 26 * 3_600_000)
    const occurrence = Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), tomorrow.getUTCHours())

    // 1. A treasurer writes the policy in Discord: the AI compiles it once, the preview is posted publicly.
    const instruction = '1 per answered question in #help, max 50 a week each, for Mods'
    const options = { instruction, schedule: 'weekly', weekday: WEEKDAYS[tomorrow.getUTCDay()] as string, hour: tomorrow.getUTCHours(), name: 'Help desk' }
    expect(await json(await s.interact(slashCommand(SCOPE, 'rolepay', 'policy new', options, TREASURER, 'tok-policy')))).toEqual({ type: 5, data: {} })
    await s.drain()
    const preview = text(s.rest.lastEdit('tok-policy'))
    expect(preview).toContain('Policy draft: Help desk')
    expect(preview).toContain(`<@${ANA}>  3 AlphaUSD`)
    const approveId = /policy:approve:pol_[A-Za-z0-9_]+:1/.exec(preview)?.[0] as string
    const policyId = approveId.split(':')[2] as string

    // 2. Approve, in Discord.
    expect((await json(await s.interact(buttonClick(SCOPE, approveId, TREASURER)))).type).toBe(7)

    // 3. The dashboard shows the policy, active, with who it applies to right now; a member reads it, a treasurer can act.
    const tess = await dashboard(s, oauth, { id: TREASURER.userId, name: 'tess' })
    const policyPage = visible(await (await tess.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())
    expect(policyPage).toContain('Help desk')
    expect(policyPage).toMatch(/Active/)
    expect(policyPage).toContain(instruction)
    expect(policyPage).toContain('1 AlphaUSD per reply to other people, at most 50 AlphaUSD each.')
    expect(policyPage).toContain('Who: has @Mods; replied to other people at least once in #help during the period.')
    const applies = policyPage.slice(policyPage.indexOf('Applies to right now'), policyPage.indexOf('Just below the line'))
    expect(applies).toMatch(/Ana 3 replies has @Mods 3 replies to other people in #help \(at least 1\) 3 AlphaUSD/)
    expect(applies).toMatch(/Rui 1 reply .* 1 AlphaUSD/)
    expect(policyPage).toContain('it would pay 4 AlphaUSD to 2 people')
    expect(policyPage).toContain('The bot key has 100 AlphaUSD left now.')
    expect(policyPage).toMatch(/Version 1 in force approved by Tess/)
    const felix = await dashboard(s, oauth, { id: FELIX, name: 'felix' })
    const readOnly = await (await felix.get(`/dashboard/${GUILD}/policies/${policyId}`)).text()
    expect(visible(readOnly)).toContain('Only the Treasurer role can change policies')
    expect(readOnly).not.toMatch(/<form method="post"[^>]*\/policies\//)

    // 4. Autopilot with a one-minute veto window, then run_now: both demo controls, in Discord.
    const mode = await json(await s.interact(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 1 }, TREASURER)))
    expect(text(mode.data)).toContain('Autopilot is on')
    expect(text(mode.data)).toContain('1 minute')
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy run_now', { policy: policyId }, TREASURER, 'tok-now'))
    await s.drain()
    expect(text(s.rest.lastEdit('tok-now'))).toContain(`posted it in <#${CHANNEL}>`)
    const first = s.rest.channelPosts.at(-1)
    expect(text(first?.message)).toContain('unless vetoed')
    expect(text(first?.message)).toContain('policy-run:veto:')
    const [firstRun] = await s.rolepay.policies.listRuns({ guildId: GUILD, policyId })
    expect(firstRun?.status).toBe('scheduled')
    const firstRunId = firstRun?.runId as string

    // 5. Tess vetoes it on the dashboard; Felix could not. The run is cancelled, Discord's message says so, nothing is paid.
    const runPage = `/dashboard/${GUILD}/runs/${firstRunId}`
    expect(visible(await (await tess.get(runPage)).text())).toMatch(/Made by a policy Policy Help desk , version 1/)
    expect((await felix.act(`${runPage}/veto`)).status).toBe(403)
    const vetoed = await tess.act(`${runPage}/veto`)
    expect(vetoed.headers.get('location')).toBe(`${runPage}?done=vetoed`)
    expect(visible(await (await tess.get(`${runPage}?done=vetoed`)).text())).toMatch(/Vetoed by Tess/)
    const cancelled = await s.rolepay.payRuns.get({ guildId: GUILD, runId: firstRunId })
    expect(cancelled.ok && [cancelled.value.status, cancelled.value.cancelledBy]).toEqual(['cancelled', TREASURER.userId])
    const edit = s.rest.channelEdits.at(-1)
    expect(edit?.messageId).toBe(first?.messageId)
    expect(text(edit?.message)).toContain(`Vetoed by <@${TREASURER.userId}>`)
    expect(text(edit?.message)).not.toContain('policy-run:veto:')
    s.clock.advance(120)
    s.chain.advance(120)
    expect((await s.tickPolicies()).events).toEqual([])
    expect(s.chain.landedTxCount).toBe(0)

    // 6. A week after that run's period, the scheduler makes the next run by itself (no AI), with Veto; after the minute it pays once.
    const nextWeek = occurrence + 7 * 86_400_000
    const jump = Math.ceil((nextWeek - s.clock.now().getTime()) / 1000) + 30
    s.clock.advance(jump)
    s.chain.advance(jump)
    answers(s, ANA, [new Date(nextWeek - 3_600_000), new Date(nextWeek - 3_000_000)])
    answers(s, RUI, [1, 2, 3, 4, 5].map((m) => new Date(nextWeek - m * 600_000)))
    const made = await s.tickPolicies()
    expect(made.events.map((e) => [e.kind, e.policyRun.status])).toEqual([['generated', 'scheduled']])
    expect(s.proposer.requests).toHaveLength(1)
    const second = s.rest.channelPosts.at(-1)
    expect(text(second?.message)).toContain('policy-run:veto:')
    expect(s.chain.landedTxCount).toBe(0)
    s.clock.advance(61)
    s.chain.advance(61)
    const released = await s.tickPolicies()
    expect(released.events.map((e) => [e.kind, e.outcome])).toEqual([['released', 'paid']])
    expect(s.chain.landedTxCount).toBe(1)
    expect([ANA, RUI].map((u) => s.chain.balance(TOKEN, ADDR[u] as string))).toEqual([usd('2'), usd('5')])
    expect(s.rest.dms.map((d) => d.userId).sort()).toEqual([ANA, RUI])
    expect(text(s.rest.channelEdits.at(-1)?.message)).toContain('"title":"Paid"')
    // Nobody approved this run: autopilot paid it after the window, under the policy a treasurer approved.
    expect(text(s.rest.channelEdits.at(-1)?.message)).toContain('Paid on autopilot after the veto window')
    expect(text(s.rest.channelEdits.at(-1)?.message)).not.toContain('Approved by')
    const secondRunId = released.events[0]?.run?.id as string

    // 7. The audit log shows every step, in order, and exports it.
    const events = await s.rolepay.audit.list({ guildId: GUILD, policyId, limit: 100 })
    if (!events.ok) throw new Error(events.error.code)
    expect(events.value.events.map((e) => e.type).reverse()).toEqual([
      'policy.created',
      'policy.compiled',
      'policy.approved',
      'policy.mode_changed',
      'run.created',
      'run.submitted',
      'policy_run.generated',
      'run.cancelled',
      'policy_run.vetoed',
      'run.created',
      'run.submitted',
      'policy_run.generated',
      'run.approved',
      'run.executing',
      'run.paid',
      'policy_run.released',
    ])
    expect(events.value.events.every((e) => (AUDIT_EVENT_TYPES as readonly string[]).includes(e.type))).toBe(true)
    const auditor = await dashboard(s, oauth, { id: FELIX, name: 'felix' })
    const auditHtml = await (await auditor.get(`/dashboard/${GUILD}/audit?policy=${policyId}`)).text()
    const audit = visible(auditHtml.slice(auditHtml.indexOf('<table')))
    const steps = [
      'Wrote the policy as a draft (version 1).',
      'Approved version 1.',
      'Switched on autopilot: each run pays after a veto window of 1 minute unless vetoed.',
      "Made the period&#39;s run: 4 AlphaUSD for 2 people, pays at",
      'Vetoed the run of 4 AlphaUSD for 2 people: nothing is paid.',
      "Made the period&#39;s run: 7 AlphaUSD for 2 people, pays at",
      'Approved the run of 7 AlphaUSD.',
      'Paid 7 AlphaUSD to 2 people.',
      'Released the run after its veto window: paid.',
    ]
    // Newest first: each step appears before the one that happened before it.
    let at = audit.length
    for (const step of steps) {
      const i = audit.lastIndexOf(step, at)
      expect(i, step).toBeGreaterThanOrEqual(0)
      at = i
    }
    expect(audit).toContain('Tess')
    expect(audit).toContain('Rolepay')
    expect(auditHtml).toContain(`href="/dashboard/${GUILD}/runs/${firstRunId}"`)
    expect(auditHtml).toContain(`href="/dashboard/${GUILD}/runs/${secondRunId}"`)
    expect(audit).not.toContain('answered question')
    const csv = (await (await auditor.get(`/dashboard/${GUILD}/audit/csv?policy=${policyId}`)).text()).trimEnd().split('\r\n')
    expect(csv[0]).toBe('at,type,actor_id,actor_name,policy_id,policy_name,run_id,summary')
    expect(csv).toHaveLength(events.value.events.length + 1)
    expect(csv.find((l) => l.includes(',policy_run.vetoed,'))).toContain(`,${TREASURER.userId},Tess,${policyId},Help desk,${firstRunId},`)
    expect(csv.find((l) => l.includes(',policy_run.released,'))).toContain(`,,Rolepay,${policyId},Help desk,${secondRunId},`)
  })
})
