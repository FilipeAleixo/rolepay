// The treasury channel in process, as main.ts wires it: a Treasurer picks a private channel on the
// dashboard (Rolepay posts its confirmation there through the bot's REST client), a scheduler pass
// posts the autopilot run with Veto in that channel and a copy without buttons in the policy's
// channel, the Veto pressed there (a signed POST /discord/interactions) updates both; and with none
// set, a channel named "treasury" is found by the first scheduler pass, logged and audited.
import { WEEKDAYS } from '@rolepay/core'
import { emptyCriteria } from '@rolepay/core/adapters'
import { buttonClick, slashCommand, wireMessage } from '@rolepay/discord/testing'
import { TestBrowser, identity } from '@rolepay/web/contract'
import { FakeDiscordOAuth } from '@rolepay/web/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TREASURY, testServer } from './support.js'

const CHANNEL = '700000000000000001'
const HELP = '700000000000000002'
const MONEY_TEAM = '700000000000000005'
const TREASURY_CHANNEL = '700000000000000009'
const SCOPE = { guildId: GUILD, channelId: CHANNEL }
const TREASURER_ROLE = '400000000000000001'
const MODS_ROLE = '400000000000000002'
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE], manageGuild: true }
const ANA = '200000000000000001'
const RUI = '200000000000000002'
const ADDR: Record<string, string> = { [ANA]: '0x1111111111111111111111111111111111111111', [RUI]: '0x2222222222222222222222222222222222222222' }
const VIEW = String(1 << 10)
const CONFIRMATION = 'Rolepay will post here what needs a Treasurer: runs to approve, runs you can veto, and runs it holds.'
const ORIGIN = 'https://rolepay.test'
const text = (v: unknown) => JSON.stringify(v ?? null)
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

type Server = Awaited<ReturnType<typeof testServer>>

/**
 * A community with a key of 100, two payees, the help desk policy on autopilot (a one-hour window)
 * posting in #payouts, and the server as Discord shows it: `channels` besides #payouts and #help.
 */
async function world(channels: { id: string; name: string; type: number; permission_overwrites?: { id: string; type: number; allow: string; deny: string }[] }[]) {
  const oauth = new FakeDiscordOAuth()
  const s = await testServer({ policySeam: true, dashboard: { oauth } })
  await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { treasury: TREASURY, approver_role: TREASURER_ROLE, key_limit: '100' }, TREASURER, 'tok-setup'))
  await s.drain()
  expect((await s.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: s.chain.rootSigner(TREASURY) })).ok).toBe(true)
  await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { ai_proposals: true }, TREASURER, 'tok-ai'))
  await s.drain()
  for (const user of [ANA, RUI]) {
    const res = await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: user }))
    const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(((await res.json()) as { data: { content: string } }).data.content)?.[1] as string
    expect((await s.browserPost(url, ADDR[user] as string)).status).toBe(200)
  }
  s.rest.roles.set(GUILD, [
    { id: GUILD, name: '@everyone', permissions: VIEW },
    { id: TREASURER_ROLE, name: 'Treasurer' },
    { id: MODS_ROLE, name: 'Mods' },
  ])
  // #help first: the compiled rule names it as the first channel (C1).
  s.rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }, { id: CHANNEL, name: 'payouts', type: 0 }, ...channels])
  for (const id of [ANA, RUI]) s.rest.setMember(GUILD, id, [MODS_ROLE])
  s.rest.setMember(GUILD, TREASURER.userId, [TREASURER_ROLE], null, 'Tess')
  const now = s.clock.now().getTime()
  const answer = (author: string, seconds: number) => wireMessage({ channelId: HELP, authorId: author, at: new Date(now - seconds * 1000), replyTo: { id: '820000000000000001', authorId: '200000000000000009' } })
  s.rest.addChannelMessages(answer(ANA, 30), answer(ANA, 40), answer(RUI, 60))
  s.proposer.onCriteria = () =>
    emptyCriteria(
      { amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk' },
      { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C1'], since: new Date(now - 7 * 86_400_000).toISOString().slice(0, 10), until: '', min: 1 }] },
    )
  const tomorrow = new Date(now + 26 * 3_600_000)
  const actor = { guildId: GUILD, actor: TREASURER.userId, actorRoleIds: [TREASURER_ROLE] }
  const created = await s.rolepay.policies.create({
    ...actor,
    name: 'Help desk',
    instruction: '1 per answered question in #help, max 50 a week each, for Mods',
    schedule: { kind: 'weekly', weekday: WEEKDAYS[tomorrow.getUTCDay()] as (typeof WEEKDAYS)[number], hour: tomorrow.getUTCHours() },
    channelId: CHANNEL,
  })
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  await s.rolepay.policies.approve({ ...actor, policyId: created.value.id, version: 1 })
  await s.rolepay.policies.setMode({ ...actor, policyId: created.value.id, mode: 'autopilot', vetoWindowMinutes: 60 })
  /** To the policy's next run, a little after its hour. */
  const toTheRun = () => {
    const occurrence = Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), tomorrow.getUTCHours())
    const jump = Math.ceil((occurrence - s.clock.now().getTime()) / 1000) + 30
    s.clock.advance(jump)
    s.chain.advance(jump)
  }
  /** A browser signed in to the dashboard through the real Discord sign-in routes (the fake consent screen). */
  const dashboard = async () => {
    const b = new TestBrowser(s.app, ORIGIN)
    oauth.signInAs(identity({ id: TREASURER.userId, name: 'tess' }, [{ id: GUILD, name: 'Mods guild' }]))
    const start = await b.get('/auth/discord')
    const consent = new URL(start.headers.get('location') as string)
    expect((await b.get(consent.pathname + consent.search)).status).toBe(303)
    return b
  }
  return { s, toTheRun, dashboard }
}

const postsIn = (s: Server, channelId: string) => s.rest.channelPosts.filter((p) => p.channelId === channelId)
const editsIn = (s: Server, channelId: string) => s.rest.channelEdits.filter((e) => e.channelId === channelId)

describe('the treasury channel, wired', () => {
  it('chosen on the dashboard: confirmed in Discord, then the scheduler puts Veto there and the run without buttons in the policy channel; Veto there updates both', async () => {
    const { s, toTheRun, dashboard } = await world([{ id: MONEY_TEAM, name: 'money-team', type: 0, permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] }])
    const tess = await dashboard()
    // The Overview lists the server's text channels, as the bot reads them.
    const overview = await (await tess.get(`/dashboard/${GUILD}`)).text()
    expect(overview).toContain(`<option value="${MONEY_TEAM}">#money-team</option>`)
    expect(overview).toContain(`<option value="${CHANNEL}">#payouts (everyone can see it)</option>`)
    const saved = await tess.act(`/dashboard/${GUILD}/treasury-channel`, { channel: MONEY_TEAM })
    expect(saved.headers.get('location')).toBe(`/dashboard/${GUILD}?done=treasury_set#treasury-channel`)
    expect(postsIn(s, MONEY_TEAM).map((p) => p.message.content)).toEqual([CONFIRMATION])

    toTheRun()
    const made = await s.tickPolicies()
    expect(made.events.map((e) => [e.kind, e.policyRun.status])).toEqual([['generated', 'scheduled']])
    const [there] = postsIn(s, MONEY_TEAM).slice(1)
    const [here] = postsIn(s, CHANNEL)
    expect(text(there?.message)).toContain('policy-run:veto:')
    expect(text(here?.message)).toContain('unless a member with')
    expect(here?.message.components).toEqual([])

    // Veto, pressed in the treasury channel.
    const veto = /policy-run:veto:[A-Za-z0-9_]+/.exec(text(there?.message))?.[0] as string
    const res = (await (await s.interact(buttonClick({ guildId: GUILD, channelId: MONEY_TEAM }, veto, TREASURER))).json()) as { type: number; data: unknown }
    expect(res.type).toBe(7)
    expect(text(res.data)).toContain(`Vetoed by <@${TREASURER.userId}>`)
    await s.drain()
    const copy = editsIn(s, CHANNEL).at(-1)
    expect(copy?.messageId).toBe(here?.messageId)
    expect(text(copy?.message)).toContain(`Vetoed by <@${TREASURER.userId}>`)
    expect(s.chain.landedTxCount).toBe(0)

    // The choice is in the audit log, in words (a day later: the first sign-in has expired, sign in again).
    const audit = visible(await (await (await dashboard()).get(`/dashboard/${GUILD}/audit`)).text())
    expect(audit).toContain(`Chose the treasury channel (channel ${MONEY_TEAM}): what needs a Treasurer is posted there, with its buttons.`)
  })

  it('none set: the first scheduler pass finds #treasury, confirms it, posts there, logs and audits the pick; the dashboard names it', async () => {
    const { s, toTheRun, dashboard } = await world([{ id: TREASURY_CHANNEL, name: 'treasury', type: 0, permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] }])
    toTheRun()
    await s.tickPolicies()
    expect(postsIn(s, TREASURY_CHANNEL).map((p) => p.message.content ?? 'run')).toEqual([CONFIRMATION, 'run'])
    expect(text(postsIn(s, TREASURY_CHANNEL)[1]?.message)).toContain('policy-run:veto:')
    expect(postsIn(s, CHANNEL)[0]?.message.components).toEqual([])
    expect(s.logs.filter((l) => l.event === 'treasury_channel').map((l) => l.fields)).toEqual([{ kind: 'found', guildId: GUILD, channelId: TREASURY_CHANNEL, replaced: null }])
    const tess = await dashboard()
    expect(visible(await (await tess.get(`/dashboard/${GUILD}`)).text())).toMatch(/Treasury channel #treasury Found by its name\./)
    expect(visible(await (await tess.get(`/dashboard/${GUILD}/audit`)).text())).toContain(`Picked #treasury as the treasury channel (found by its name; channel ${TREASURY_CHANNEL}).`)
  })

  it('the treasury channel deleted: the scheduler posts in the policy channel with Veto, and logs why', async () => {
    const { s, toTheRun } = await world([])
    await s.rolepay.communities.setTreasuryChannel({ guildId: GUILD, actor: TREASURER.userId, actorRoleIds: [TREASURER_ROLE], channelId: MONEY_TEAM })
    s.rest.closedChannels.set(MONEY_TEAM, 'not_found')
    toTheRun()
    await s.tickPolicies()
    expect(s.rest.channelPosts.map((p) => p.channelId)).toEqual([CHANNEL])
    expect(text(s.rest.channelPosts[0]?.message)).toContain('policy-run:veto:')
    expect(s.logs.filter((l) => l.event === 'treasury_channel').map((l) => l.fields)).toEqual([{ kind: 'unavailable', guildId: GUILD, channelId: MONEY_TEAM, reason: 'not_found' }])
  })
})
