// The judge demo with its own budget, in process, with the public demo's flags: the founder approves
// the daily Judges policy in Discord and is offered, privately, "Give this policy its own budget";
// on the treasury page the treasury passkey authorises a key for that policy alone (2 AlphaUSD a
// day). Its runs are then signed with that key: a day it can pay is paid from it (the bot key
// untouched), a day over its budget is held whole and explained, and once the passkey revokes it the
// policy stops while runs made by hand keep paying from the bot key. Discord, the treasury page,
// /rolepay policy show, the dashboard and the audit log all say the same thing.
import { emptyCriteria } from '@rolepay/core/adapters'
import { buttonClick, slashCommand } from '@rolepay/discord/testing'
import { TestBrowser, identity } from '@rolepay/web/contract'
import { FakeDiscordOAuth } from '@rolepay/web/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer, usd } from './support.js'

const POLICIES = '700000000000000001'
const START_HERE = '700000000000000010'
const WELCOME = '810000000000000123'
const SCOPE = { guildId: GUILD, channelId: POLICIES }
const TREASURER_ROLE = '400000000000000001'
const FOUNDER = { userId: '300000000000000001', roles: [TREASURER_ROLE] }
const FOUNDER_ADMIN = { ...FOUNDER, manageGuild: true }
const JUDGES = ['200000000000000031', '200000000000000032', '200000000000000033', '200000000000000034', '200000000000000035']
const addressOf = (judge: string) => `0x${judge.slice(-2).repeat(20)}`
const ORIGIN = 'https://rolepay.test'
const DAY = 86_400_000
const text = (v: unknown) => JSON.stringify(v ?? null)
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replaceAll('&#39;', "'")

type Server = Awaited<ReturnType<typeof testServer>>
type Provisioned = { keyAddress: `0x${string}`; authorization: { expiry: number; limits: { token: string; limit: string; period?: number }[]; scopes: never } }

/** What the treasurer's browser does with the passkey: sign, on chain, the authorisation the page built (here: the server's, checked equal). */
async function signOnChain(s: Server, p: Provisioned) {
  const authorization = { ...p.authorization, limits: p.authorization.limits.map((l) => ({ ...l, limit: BigInt(l.limit) })) }
  expect((await s.chain.authorizeKey({ root: s.chain.rootSigner(TREASURY), accessKey: p.keyAddress, authorization: authorization as never })).ok).toBe(true)
}

/** The production setup on the treasury page: the passkey binds the treasury and authorises a bot key of 100. */
async function setUp(s: Server) {
  s.rest.guilds.set(GUILD, 'Rolepay demo')
  await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { approver_role: TREASURER_ROLE }, FOUNDER_ADMIN, 'tok-setup'))
  await s.drain()
  const path = /https:\/\/rolepay\.test(\/setup\/[A-Za-z0-9_-]+)/.exec(text(s.rest.lastEdit('tok-setup')))?.[1] as string
  expect((await s.browserPost(`${path}/treasury`, TREASURY)).status).toBe(200)
  const bot = (await (await s.browserPost(`${path}/key`, TREASURY, { limit: '100', periodDays: 30, expiresAt: Math.floor(s.clock.now().getTime() / 1000) + 30 * 86_400 })).json()) as Provisioned
  await signOnChain(s, bot)
  expect((await s.browserPost(`${path}/key/confirm`, TREASURY, { keyAddress: bot.keyAddress })).status).toBe(200)
  await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { ai_proposals: true }, FOUNDER_ADMIN, 'tok-ai'))
  await s.drain()
  s.rest.roles.set(GUILD, [{ id: TREASURER_ROLE, name: 'Treasurer' }])
  s.rest.channels.set(GUILD, [
    { id: POLICIES, name: 'policies', type: 0 },
    { id: START_HERE, name: 'start-here', type: 0 },
  ])
  s.rest.setMember(GUILD, FOUNDER.userId, [TREASURER_ROLE], null, 'Filipe')
  return bot.keyAddress
}

async function joinAndLink(s: Server, judge: string) {
  s.rest.setMember(GUILD, judge, [], null, `judge ${judge.slice(-2)}`)
  const res = await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: judge }))
  const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(((await res.json()) as { data: { content: string } }).data.content)?.[1] as string
  expect((await s.browserPost(url, addressOf(judge))).status).toBe(200)
}

function travelTo(s: Server, at: number) {
  const seconds = Math.ceil((at - s.clock.now().getTime()) / 1000)
  s.clock.advance(seconds)
  s.chain.advance(seconds)
}

describe('the judge demo with its own budget: one policy, one key, capped by the chain', () => {
  it('approve, give it its own budget on the treasury page, pay from it, hold over it, revoke it; the bot key pays everything else', async () => {
    const oauth = new FakeDiscordOAuth()
    const s = await testServer({ devShortcuts: false, demoControls: true, policySeam: true, dashboard: { oauth } })
    const botKey = await setUp(s)
    const botLeft = async () => (await s.chain.keyState({ account: TREASURY, accessKey: botKey, token: TOKEN, feeToken: null })).remaining
    const now = s.clock.now().getTime()
    const first = Math.floor((now + 2 * 3_600_000) / 3_600_000) * 3_600_000
    const hour = new Date(first).getUTCHours()

    // 1. The founder writes the Judges policy and approves it; Discord offers its own budget, privately.
    s.proposer.onCriteria = () =>
      emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' }, note: 'Judges' }, { anchors: [{ kind: 'reactedTo', message: 'M1', thread: '', emoji: '✅' }], neverPaid: true })
    const instruction = `Every day at ${String(hour).padStart(2, '0')}:00 UTC: 1 AlphaUSD to every registered payee who reacted ✅ to https://discord.com/channels/${GUILD}/${START_HERE}/${WELCOME} and has never been paid`
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy new', { instruction, schedule: 'daily', hour, name: 'Judges' }, FOUNDER, 'tok-policy'))
    await s.drain()
    const approveId = /policy:approve:pol_[A-Za-z0-9_]+:1/.exec(text(s.rest.lastEdit('tok-policy')))?.[0] as string
    const policyId = approveId.split(':')[2] as string
    const approved = await s.interact(buttonClick(SCOPE, approveId, FOUNDER, 'tok-approve'))
    expect(((await approved.json()) as { type: number }).type).toBe(7)
    await s.drain()
    const offer = s.rest.followUps.find((f) => f.reply.token === 'tok-approve')?.message
    expect(offer?.flags).toBe(64)
    const pagePath = /https:\/\/rolepay\.test(\/setup\/[^"/]+\/policies\/pol_[A-Za-z0-9_]+)/.exec(text(offer))?.[1] as string
    expect(pagePath).toContain(`/policies/${policyId}`)
    expect(text(s.rest.channelPosts)).not.toContain('/policies/')
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_minutes: 1 }, FOUNDER))

    // 2. The treasury page: the passkey gives Judges 2 AlphaUSD a day for 30 days.
    const page = await s.app.request(pagePath)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('A budget of its own for Judges')
    const provisioned = (await (await s.browserPost(`${pagePath}/key`, TREASURY, { limit: '2', periodDays: 1, expiresAt: Math.floor(s.clock.now().getTime() / 1000) + 30 * 86_400 })).json()) as Provisioned
    expect(provisioned.authorization.limits).toEqual([{ token: TOKEN, limit: '2000000', period: 86_400 }])
    await signOnChain(s, provisioned)
    expect((await s.browserPost(`${pagePath}/key/confirm`, TREASURY, { keyAddress: provisioned.keyAddress })).status).toBe(200)
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, FOUNDER, 'tok-show'))
    await s.drain()
    expect(text(s.rest.lastEdit('tok-show'))).toContain('Own budget: 2 of 2 AlphaUSD left this period (chain-enforced)')

    // 3. Day 1: two judges linked and reacted. The run (2) pays from the policy's own key; the bot key is untouched.
    for (const j of JUDGES.slice(0, 2)) await joinAndLink(s, j)
    s.rest.setReactions(START_HERE, WELCOME, '✅', JUDGES.slice(0, 2).map((id) => ({ id })))
    travelTo(s, first)
    expect((await s.tickPolicies()).events.map((e) => [e.kind, e.policyRun.status])).toEqual([['generated', 'scheduled']])
    travelTo(s, first + 61_000)
    expect((await s.tickPolicies()).events.map((e) => [e.kind, e.outcome])).toEqual([['released', 'paid']])
    expect(JUDGES.slice(0, 2).map((j) => s.chain.balance(TOKEN, addressOf(j)))).toEqual([usd('1'), usd('1')])
    expect(await s.chain.keyState({ account: TREASURY, accessKey: provisioned.keyAddress, token: TOKEN, feeToken: null })).toMatchObject({ remaining: 0n })
    expect(await botLeft()).toBe(usd('100'))

    // The dashboard draws the policy's own budget from the chain: all 2 spent this period.
    const b = new TestBrowser(s.app, ORIGIN)
    oauth.signInAs(identity({ id: FOUNDER.userId, name: 'filipe' }, [{ id: GUILD, name: 'Rolepay demo' }]))
    const consent = new URL((await b.get('/auth/discord')).headers.get('location') as string)
    await b.get(consent.pathname + consent.search)
    const dash = visible(await (await b.get(`/dashboard/${GUILD}/policies/${policyId}`)).text())
    expect(dash).toMatch(/This policy's own budget Spent this period 2 AlphaUSD Left 0 AlphaUSD/)
    expect(dash).toContain('This policy can never spend past that line: the chain enforces it')

    // 4. Day 2: three new judges, 3 AlphaUSD, over the policy's 2 a day: held whole and explained, nothing paid; the bot key still has 100.
    for (const j of JUDGES.slice(2)) await joinAndLink(s, j)
    s.rest.setReactions(START_HERE, WELCOME, '✅', JUDGES.map((id) => ({ id })))
    const posts = s.rest.channelPosts.length
    travelTo(s, first + DAY)
    const held = await s.tickPolicies()
    expect(held.events.map((e) => [e.kind, e.policyRun.status, e.policyRun.hold?.code])).toEqual([['generated', 'held', 'over_policy_budget']])
    expect(held.events[0]?.policyRun.hold).toMatchObject({ total: usd('3'), limit: usd('2') })
    expect(text(s.rest.channelPosts.slice(posts))).toContain("more than this policy's own key has left (2 AlphaUSD)")
    expect(JUDGES.slice(2).map((j) => s.chain.balance(TOKEN, addressOf(j)))).toEqual([0n, 0n, 0n])
    expect(await botLeft()).toBe(usd('100'))

    // 5. The approval's link has expired (30 minutes); /rolepay policy show gives the approver a fresh one. The
    // passkey revokes the policy's key on that page: the policy stops, and never falls back to the bot key.
    expect((await s.browserPost(`${pagePath}/key/revoked`, TREASURY, { keyAddress: provisioned.keyAddress })).status).toBe(410)
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, FOUNDER, 'tok-show-manage'))
    await s.drain()
    const manage = text(s.rest.lastEdit('tok-show-manage'))
    expect(manage).toContain('Manage its budget')
    const freshPath = /https:\/\/rolepay\.test(\/setup\/[^"/]+\/policies\/pol_[A-Za-z0-9_]+)/.exec(manage)?.[1] as string
    await s.chain.revokeKey({ root: s.chain.rootSigner(TREASURY), accessKey: provisioned.keyAddress })
    expect((await s.browserPost(`${freshPath}/key/revoked`, TREASURY, { keyAddress: provisioned.keyAddress })).status).toBe(200)
    s.rest.setReactions(START_HERE, WELCOME, '✅', JUDGES.slice(2, 3).map((id) => ({ id })))
    travelTo(s, first + 2 * DAY)
    expect((await s.tickPolicies()).events.map((e) => e.policyRun.hold?.code)).toEqual(['policy_key_inactive'])
    await s.interact(slashCommand(SCOPE, 'rolepay', 'policy show', { policy: policyId }, FOUNDER, 'tok-show-revoked'))
    await s.drain()
    expect(text(s.rest.lastEdit('tok-show-revoked'))).toContain('Own budget: its key is revoked, so it pays nothing until a treasurer gives it a new one.')
    // A run made by hand still pays from the bot key.
    const manual = await s.rolepay.payRuns.create({ guildId: GUILD, createdBy: FOUNDER.userId, lines: [{ discordUserId: JUDGES[2] as string, amount: usd('5') }] })
    if (!manual.ok) throw new Error(JSON.stringify(manual.error))
    await s.rolepay.payRuns.submit({ guildId: GUILD, runId: manual.value.id, actor: FOUNDER.userId })
    await s.rolepay.payRuns.approve({ guildId: GUILD, runId: manual.value.id, actor: FOUNDER.userId, actorCanApprove: true })
    expect(await s.rolepay.payRuns.execute({ guildId: GUILD, runId: manual.value.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(await botLeft()).toBe(usd('95'))

    // 6. The audit log: who opened the treasury page, what the passkey authorised, and the revoke.
    const audit = await s.rolepay.audit.list({ guildId: GUILD, policyId, types: ['policy_key.authorized', 'policy_key.revoked'] })
    expect(audit.ok && audit.value.events.map((e) => [e.type, e.actor])).toEqual([
      ['policy_key.revoked', FOUNDER.userId],
      ['policy_key.authorized', FOUNDER.userId],
    ])
    // Two days later the dashboard session (8 hours) is gone: sign in again.
    const again = new TestBrowser(s.app, ORIGIN)
    const consent2 = new URL((await again.get('/auth/discord')).headers.get('location') as string)
    await again.get(consent2.pathname + consent2.search)
    const log = visible(await (await again.get(`/dashboard/${GUILD}/audit?policy=${policyId}`)).text())
    expect(log).toContain('The treasury passkey gave the policy its own key on chain: up to 2 AlphaUSD every day')
    expect(log).toContain("The treasury passkey revoked the policy's own key on chain")
  })
})
