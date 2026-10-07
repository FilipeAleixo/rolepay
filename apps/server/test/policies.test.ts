// Standing policies end to end, in process, every Discord step a signed POST /discord/interactions:
// setup -> /rolepay policy new (the fake model compiles it once) -> the public preview -> Approve
// -> autopilot with a one-hour veto window -> the scheduler (the server's tick) posts the run with
// Veto -> the window passes -> one batch on the fake chain -> receipts -> the audit trail.
import { WEEKDAYS } from '@rolepay/core'
import { emptyCriteria } from '@rolepay/core/adapters'
import { buttonClick, slashCommand, wireMessage } from '@rolepay/discord/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer, usd } from './support.js'

const CHANNEL = '700000000000000001'
const HELP = '700000000000000002'
const SCOPE = { guildId: GUILD, channelId: CHANNEL }
const TREASURER_ROLE = '400000000000000001'
const MODS_ROLE = '400000000000000002'
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE], manageGuild: true }
const ANA = '200000000000000001'
const RUI = '200000000000000002'
const ADDR: Record<string, string> = { [ANA]: '0x1111111111111111111111111111111111111111', [RUI]: '0x2222222222222222222222222222222222222222' }
const text = (v: unknown) => JSON.stringify(v ?? null)
const json = async (res: Response) => (await res.json()) as { type: number; data?: Record<string, unknown> }

describe('standing policies end to end through the HTTP endpoint', () => {
  it('write once, approve, autopilot: the scheduler posts the run with Veto, and after the window it pays once, within the limit, with an audit trail', async () => {
    const s = await testServer()
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

    // The server as Discord shows it: a Mods role, #help, and this week's answers (Ana 3, Rui 1).
    s.rest.roles.set(GUILD, [
      { id: TREASURER_ROLE, name: 'Treasurer' },
      { id: MODS_ROLE, name: 'Mods' },
    ])
    s.rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }])
    for (const id of [ANA, RUI]) s.rest.setMember(GUILD, id, [MODS_ROLE])
    s.rest.setMember(GUILD, TREASURER.userId, [TREASURER_ROLE])
    const now = s.clock.now().getTime()
    const answer = (author: string, seconds: number) => wireMessage({ channelId: HELP, authorId: author, at: new Date(now - seconds * 1000), replyTo: { id: '820000000000000001', authorId: '200000000000000009' } })
    s.rest.addChannelMessages(answer(ANA, 30), answer(ANA, 40), answer(ANA, 50), answer(RUI, 60))
    s.proposer.onCriteria = () =>
      emptyCriteria(
        { amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk' },
        { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C1'], since: new Date(now - 7 * 86_400_000).toISOString().slice(0, 10), until: '', min: 1 }] },
      )
    // It runs tomorrow at this hour (UTC), so the week counted includes the answers above.
    const tomorrow = new Date(now + 26 * 3_600_000)

    // 1. Write it once: the model compiles it, the preview is posted publicly.
    const created = await json(
      await s.interact(
        slashCommand(
          SCOPE,
          'rolepay',
          'policy new',
          { instruction: '1 per answered question in #help, max 50 a week each, for Mods', schedule: 'weekly', weekday: WEEKDAYS[tomorrow.getUTCDay()] as string, hour: tomorrow.getUTCHours(), name: 'Help desk' },
          TREASURER,
          'tok-policy',
        ),
      ),
    )
    expect(created).toEqual({ type: 5, data: {} })
    await s.drain()
    const preview = text(s.rest.lastEdit('tok-policy'))
    expect(preview).toContain('Policy draft: Help desk')
    expect(preview).toContain(`<@${ANA}>  3 AlphaUSD`)
    expect(preview).toContain('4 AlphaUSD for 2 people so far')
    expect(s.proposer.requests).toHaveLength(1)
    const approveId = /policy:approve:pol_[A-Za-z0-9_]+:1/.exec(preview)?.[0] as string
    const policyId = approveId.split(':')[2] as string

    // 2. The treasurer approves, then switches autopilot on with a one-hour veto window (both public).
    expect((await json(await s.interact(buttonClick(SCOPE, approveId, TREASURER)))).type).toBe(7)
    const mode = await json(await s.interact(slashCommand(SCOPE, 'rolepay', 'policy mode', { policy: policyId, mode: 'autopilot', veto_hours: 1 }, TREASURER)))
    expect(text(mode.data)).toContain('Autopilot is on')

    // 3. Time passes to the scheduled hour: the server's tick posts the run with Veto. Nothing is paid yet.
    expect((await s.tickPolicies()).events).toEqual([])
    const due = Math.ceil((Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), tomorrow.getUTCHours()) - now) / 1000)
    s.clock.advance(due)
    s.chain.advance(due)
    const posted = await s.tickPolicies()
    expect(posted.events.map((e) => [e.kind, e.policyRun.status])).toEqual([['generated', 'scheduled']])
    const message = s.rest.channelPosts.at(-1)
    expect(message?.channelId).toBe(CHANNEL)
    expect(text(message?.message)).toContain('unless vetoed')
    expect(text(message?.message)).toContain('policy-run:veto:')
    expect(s.chain.landedTxCount).toBe(0)

    // 4. The window passes: approved in the treasurer's name, one batch, receipts, the same message says Paid.
    s.clock.advance(3600)
    s.chain.advance(3600)
    const released = await s.tickPolicies()
    expect(released.events.map((e) => [e.kind, e.outcome])).toEqual([['released', 'paid']])
    expect(s.chain.landedTxCount).toBe(1)
    expect([ANA, RUI].map((u) => s.chain.balance(TOKEN, ADDR[u] as string))).toEqual([usd('3'), usd('1')])
    expect(s.rest.dms.map((d) => d.userId).sort()).toEqual([ANA, RUI])
    const edited = s.rest.channelEdits.at(-1)
    expect(edited?.messageId).toBe(message?.messageId)
    expect(text(edited?.message)).toContain('"title":"Paid"')

    // 5. Nothing more on later ticks; the audit trail tells the whole story, with no user text.
    s.clock.advance(60)
    s.chain.advance(60)
    expect((await s.tickPolicies()).events).toEqual([])
    expect(s.chain.landedTxCount).toBe(1)
    const audit = await s.rolepay.audit.list({ guildId: GUILD, policyId, limit: 100 })
    if (!audit.ok) throw new Error(audit.error.code)
    expect(audit.value.events.map((e) => e.type).reverse()).toEqual([
      'policy.created',
      'policy.compiled',
      'policy.approved',
      'policy.mode_changed',
      'run.created',
      'run.submitted',
      'policy_run.generated',
      'run.approved',
      'run.executing',
      'run.paid',
      'policy_run.released',
    ])
    expect(text(audit.value.events)).not.toContain('answered question')
    const csv = await s.rolepay.audit.exportCsv({ guildId: GUILD, policyId })
    expect(csv.ok && csv.value.count).toBe(11)
  })

  it('the scheduler runs on the server interval like the recovery sweep', async () => {
    const s = await testServer({ env: { ROLEPAY_SCHEDULER_INTERVAL_SECONDS: '1' } })
    let ticks = 0
    const original = s.rolepay.scheduler.tick.bind(s.rolepay.scheduler)
    s.rolepay.scheduler.tick = async () => {
      ticks++
      return original()
    }
    const loop = s.startScheduler()
    await new Promise((r) => setTimeout(r, 1100))
    await loop.stop()
    expect(ticks).toBeGreaterThanOrEqual(2)
  })
})
