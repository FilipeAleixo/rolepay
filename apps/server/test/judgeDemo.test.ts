// The judge demo, in process, with the public demo's flags (ROLEPAY_DEMO_CONTROLS on, the dev
// shortcuts off), as apps/server/README.md sets it up: one daily policy, "1
// AlphaUSD to every registered payee who reacted ✅ to the welcome post and has never been paid",
// on autopilot with the one-minute veto window, and then nobody online. A judge joins, runs /payee
// link, claims with a passkey, reacts ✅, and is paid by the next daily run with a DM receipt (a
// judge with DMs closed is paid all the same). The day after, nobody new: no run, no post. Nobody
// is paid twice. Every Discord step is a signed POST /discord/interactions.
import { emptyCriteria } from '@rolepay/core/adapters'
import { buttonClick, slashCommand } from '@rolepay/discord/testing'
import { TestBrowser, identity } from '@rolepay/web/contract'
import { FakeDiscordOAuth } from '@rolepay/web/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer, usd } from './support.js'

const POLICIES = '700000000000000001' // where the treasurer writes the policy: its runs are posted here
const START_HERE = '700000000000000010'
const WELCOME = '810000000000000123' // the welcome post in #start-here
const SCOPE = { guildId: GUILD, channelId: POLICIES }
const TREASURER_ROLE = '400000000000000001'
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE] }
const TREASURER_ADMIN = { ...TREASURER, manageGuild: true }
const JUDGE = '200000000000000021'
const QUIET_JUDGE = '200000000000000022' // DMs from server members off
const LATE_JUDGE = '200000000000000023' // reacts first, links the next day
const STRANGER = '200000000000000029' // reacts, never links
const ADDR: Record<string, string> = {
  [JUDGE]: '0x2121212121212121212121212121212121212121',
  [QUIET_JUDGE]: '0x2222222222222222222222222222222222222222',
  [LATE_JUDGE]: '0x2323232323232323232323232323232323232323',
}
const ORIGIN = 'https://rolepay.test'
const text = (v: unknown) => JSON.stringify(v ?? null)
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

type Server = Awaited<ReturnType<typeof testServer>>

/** The production setup, as the public demo has it: the treasury page binds the passkey and authorises a key of 100. */
async function setUp(s: Server) {
  s.rest.guilds.set(GUILD, 'Rolepay demo')
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
  s.rest.roles.set(GUILD, [{ id: TREASURER_ROLE, name: 'Treasurer' }])
  s.rest.channels.set(GUILD, [
    { id: POLICIES, name: 'policies', type: 0 },
    { id: START_HERE, name: 'start-here', type: 0 },
  ])
  s.rest.setMember(GUILD, TREASURER.userId, [TREASURER_ROLE], null, 'Tess')
}

/** A judge joins the server and registers: /payee link, then the claim page with a passkey. */
async function joinAndLink(s: Server, judge: string) {
  s.rest.setMember(GUILD, judge, [], null, `judge ${judge.slice(-2)}`)
  const res = await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: judge }))
  const reply = (await res.json()) as { data: { content: string; flags?: number } }
  expect(reply.data.flags).toBe(64) // only the judge sees their link
  const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(reply.data.content)?.[1] as string
  expect((await s.browserPost(url, ADDR[judge] as string)).status).toBe(200)
}

/** Moves the services' clock and the chain together, as real waiting would. */
function travelTo(s: Server, at: number) {
  const seconds = Math.ceil((at - s.clock.now().getTime()) / 1000)
  s.clock.advance(seconds)
  s.chain.advance(seconds)
}

describe('the judge demo: get paid with nobody online', () => {
  it('one daily policy on autopilot pays each judge who linked and reacted ✅ once, with a DM receipt; empty days post nothing', async () => {
    const oauth = new FakeDiscordOAuth()
    const s = await testServer({ devShortcuts: false, demoControls: true, policySeam: true, dashboard: { oauth } })
    await setUp(s)
    // The policy runs every day at an hour (UTC) whose next occurrence is between one and two hours from now.
    const now = s.clock.now().getTime()
    const first = Math.floor((now + 2 * 3_600_000) / 3_600_000) * 3_600_000
    const hour = new Date(first).getUTCHours()
    const DAY = 86_400_000

    // 1. The treasurer writes the policy once, in Discord; the AI compiles it, the preview is posted publicly.
    s.proposer.onCriteria = () =>
      emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' }, note: 'Judges' }, { anchors: [{ kind: 'reactedTo', message: 'M1', thread: '', emoji: '✅' }], neverPaid: true })
    const instruction = `Every day at ${String(hour).padStart(2, '0')}:00 UTC: 1 AlphaUSD to every registered payee who reacted ✅ to https://discord.com/channels/${GUILD}/${START_HERE}/${WELCOME} and has never been paid`
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy new', { instruction, schedule: 'daily', hour, name: 'Judges' }, TREASURER, 'tok-policy'))
    await s.drain()
    const preview = text(s.rest.lastEdit('tok-policy'))
    expect(preview).toContain('Policy draft: Judges')
    expect(preview).toContain(`every day at ${String(hour).padStart(2, '0')}:00 (UTC)`)
    expect(preview).toContain(`Who: reacted ✅ to https://discord.com/channels/${GUILD}/${START_HERE}/${WELCOME}; has never been paid by this community.`)
    expect(preview).toContain('Nobody matches yet in this period.')
    // The model saw the message as a token, never its ID.
    expect(JSON.stringify(s.proposer.requests[0])).not.toContain(WELCOME)
    const approveId = /policy:approve:pol_[A-Za-z0-9_]+:1/.exec(preview)?.[0] as string
    const policyId = approveId.split(':')[2] as string

    // 2. Approve, then autopilot with the demo controls' shortest veto window. Then the treasurer goes offline.
    expect(((await (await s.interact(buttonClick(SCOPE, approveId, TREASURER))).json()) as { type: number }).type).toBe(7)
    const mode = (await (await s.interact(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 1 }, TREASURER))).json()) as { data: unknown }
    expect(text(mode.data)).toContain('Autopilot is on')
    expect(text(mode.data)).toContain('1 minute')
    expect(s.proposer.requests).toHaveLength(1)

    // 3. Judges join, link and react ✅ to the welcome post; one has DMs closed, one reacts before linking, one never links.
    await joinAndLink(s, JUDGE)
    await joinAndLink(s, QUIET_JUDGE)
    s.rest.closedDms.add(QUIET_JUDGE)
    s.rest.setReactions(START_HERE, WELCOME, '✅', [{ id: JUDGE }, { id: QUIET_JUDGE }, { id: LATE_JUDGE }, { id: STRANGER }])

    // 4. At the hour the scheduler makes the run by itself (no AI) and posts it with its veto window; a minute later it pays.
    const posts = s.rest.channelPosts.length
    travelTo(s, first)
    const made = await s.tickPolicies()
    expect(made.events.map((e) => [e.kind, e.policyRun.status])).toEqual([['generated', 'scheduled']])
    expect(made.events[0]?.policyRun.lines.map((l) => [l.discordUserId, l.amount])).toEqual([
      [JUDGE, usd('1')],
      [QUIET_JUDGE, usd('1')],
    ])
    expect(made.events[0]?.policyRun.unregistered.map((u) => u.discordUserId).sort()).toEqual([LATE_JUDGE, STRANGER])
    const posted = s.rest.channelPosts.at(-1)
    expect(posted?.channelId).toBe(POLICIES)
    expect(text(posted?.message)).toContain('unless vetoed')
    travelTo(s, first + 61_000)
    const released = await s.tickPolicies()
    expect(released.events.map((e) => [e.kind, e.outcome])).toEqual([['released', 'paid']])
    expect([JUDGE, QUIET_JUDGE].map((u) => s.chain.balance(TOKEN, ADDR[u] as string))).toEqual([usd('1'), usd('1')])
    expect(s.chain.landedTxCount).toBe(1)
    expect(text(s.rest.channelEdits.at(-1)?.message)).toContain('"title":"Paid"')
    // The receipt DM reaches the judge who accepts DMs from server members; the other is paid all the same.
    expect(s.rest.dms.map((d) => d.userId)).toEqual([JUDGE])
    expect(text(s.rest.dms[0]?.message)).toContain('You were paid 1 AlphaUSD')
    expect(text(s.rest.dms[0]?.message)).toContain('From **Rolepay demo**')
    expect(text(s.rest.dms[0]?.message)).toContain(`${ORIGIN}/account`)

    // 5. The next day the late judge has linked: only they are paid. The judges already paid never match again.
    await joinAndLink(s, LATE_JUDGE)
    travelTo(s, first + DAY)
    const day2 = await s.tickPolicies()
    expect(day2.events[0]?.policyRun.lines.map((l) => l.discordUserId)).toEqual([LATE_JUDGE])
    travelTo(s, first + DAY + 61_000)
    expect((await s.tickPolicies()).events.map((e) => e.outcome)).toEqual(['paid'])
    expect(s.rest.dms.map((d) => d.userId)).toEqual([JUDGE, LATE_JUDGE])

    // 6. The day after, nobody new: no run, nothing posted, nothing paid; the audit log records the day quietly.
    const quiet = s.rest.channelPosts.length
    travelTo(s, first + 2 * DAY)
    const day3 = await s.tickPolicies()
    expect(day3.events.map((e) => [e.kind, e.policyRun.status, e.run])).toEqual([['generated', 'empty', null]])
    expect(s.rest.channelPosts.length).toBe(quiet)
    expect(s.chain.landedTxCount).toBe(2)
    expect([JUDGE, QUIET_JUDGE, LATE_JUDGE].map((u) => s.chain.balance(TOKEN, ADDR[u] as string))).toEqual([usd('1'), usd('1'), usd('1')])
    expect(s.rest.channelPosts.length - posts).toBe(2) // the two runs, nothing else
    const empty = await s.rolepay.audit.list({ guildId: GUILD, policyId, types: ['policy_run.empty'] })
    expect(empty.ok && empty.value.events).toHaveLength(1)

    // 7. The dashboard shows the policy in the same words.
    const b = new TestBrowser(s.app, ORIGIN)
    oauth.signInAs(identity({ id: TREASURER.userId, name: 'tess' }, [{ id: GUILD, name: 'Rolepay demo' }]))
    const consent = new URL((await b.get('/auth/discord')).headers.get('location') as string)
    await b.get(consent.pathname + consent.search)
    const page = visible(await (await b.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())
    expect(page).toContain(`Every day at ${String(hour).padStart(2, '0')}:00 (UTC)`)
    expect(page).toContain('has never been paid by this community')
    expect(page).toContain('Autopilot, veto window 1 minute')
  })
})
