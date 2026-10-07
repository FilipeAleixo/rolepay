// Standing policies on a real SQLite file shared by two "instances" (two connections, two sets of
// services, as two server processes would have): the unique key per policy and period and the
// compare-and-set on releases mean one run per period and one payment, whoever ticks.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FakeActivityReader, FakePayoutChain, FakeRunProposer, ManualClock, PlainKeyVault, RandomIds, openSqliteDatabase } from '../src/adapters/index.js'
import { createRolepay } from '../src/index.js'
import { ANA, APPROVER, BIG, GUILD, HELP, INSTRUCTION, MODS, MONDAY, MONDAYS, RUI, T0, TOKEN, TREASURER, TREASURY, addressOf, asTreasurer, helpDeskAnswer, reply, usd } from './support/policyWorld.js'

const dir = mkdtempSync(join(tmpdir(), 'rolepay-policies-sqlite-'))
const toClose: { close(): Promise<void> }[] = []
afterAll(async () => {
  for (const d of toClose) await d.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('policies on SQLite with two instances', () => {
  it('two instances ticking together make one run per period and pay an autopilot run once; a restart changes nothing', async () => {
    const path = join(dir, 'two.db')
    const clock = new ManualClock(T0)
    const chain = new FakePayoutChain({ startTime: Math.floor(T0.getTime() / 1000) })
    chain.fund(TOKEN, TREASURY, usd(5000))
    const activity = new FakeActivityReader()
    activity.roles = [
      { id: APPROVER, name: 'Treasurer' },
      { id: MODS, name: 'Mods' },
    ]
    activity.channels = [{ id: HELP, name: 'help', kind: 'text' }]
    for (const id of [ANA, RUI, BIG]) activity.setMember(id, { roleIds: [MODS], joinedAt: null })
    activity.setMember(TREASURER, { roleIds: [APPROVER], joinedAt: null })
    activity.addMessages(...Array.from({ length: 5 }, (_, i) => reply(ANA, new Date(T0.getTime() - (i + 1) * 3_600_000))), reply(RUI, new Date(T0.getTime() - 3_600_000)))
    const proposer = new FakeRunProposer()
    proposer.onCriteria = () => {
      const a = helpDeskAnswer()
      return { ...a, conditions: { ...a.conditions, activity: [{ metric: 'replies', channels: ['C1'], since: '2026-09-30', until: '', min: 1 }] } }
    }
    const instance = async () => {
      const db = await openSqliteDatabase(path, { clock })
      toClose.push(db)
      return createRolepay({ chain, repositories: db.repositories, vault: new PlainKeyVault(), ids: new RandomIds(), clock, network: 'moderato', proposer, activity })
    }
    const a = await instance()
    const b = await instance()
    await a.communities.register({ guildId: GUILD, name: 'g', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: APPROVER })
    await a.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [APPROVER] })
    await a.communities.provisionBotKey({ guildId: GUILD, limit: usd(1000), expiresAt: chain.time + 60 * 86_400 })
    await a.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    for (const id of [ANA, RUI]) {
      const link = await a.payees.issueLink({ guildId: GUILD, discordUserId: id })
      if (!link.ok) throw new Error(link.error.code)
      await a.payees.register({ token: link.value.token, address: addressOf(id) })
    }
    const created = await a.policies.create({ ...asTreasurer, name: 'Help desk', instruction: INSTRUCTION, schedule: MONDAYS })
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect((await b.policies.approve({ ...asTreasurer, policyId: created.value.id, version: 1 })).ok).toBe(true)
    expect((await a.policies.setMode({ ...asTreasurer, policyId: created.value.id, mode: 'autopilot', vetoWindowMinutes: 60 })).ok).toBe(true)

    const travel = (s: number) => {
      clock.advance(s)
      chain.advance(s)
    }
    travel((MONDAY.getTime() - T0.getTime()) / 1000)
    const generated = await Promise.all([a.scheduler.tick(), b.scheduler.tick()])
    expect(generated.flatMap((r) => r.errors)).toEqual([])
    expect(generated.flatMap((r) => r.events).map((e) => [e.kind, e.policyRun.status, e.policyRun.total])).toEqual([['generated', 'scheduled', usd(6)]])
    expect(await a.payRuns.list({ guildId: GUILD })).toHaveLength(1)

    travel(3600)
    const released = await Promise.all([a.scheduler.tick(), b.scheduler.tick()])
    expect(released.flatMap((r) => r.events).map((e) => [e.kind, e.outcome])).toEqual([['released', 'paid']])
    expect(chain.landedTxCount).toBe(1)
    expect([chain.balance(TOKEN, addressOf(ANA)), chain.balance(TOKEN, addressOf(RUI)), chain.balance(TOKEN, addressOf(BIG))]).toEqual([usd(5), usd(1), 0n])

    // A third process on the same file (a restart) finds nothing to do.
    travel(60)
    expect((await (await instance()).scheduler.tick()).events).toEqual([])
    expect(chain.landedTxCount).toBe(1)
    const audit = await a.audit.list({ guildId: GUILD, types: ['policy_run.generated', 'policy_run.released', 'run.paid'] })
    expect(audit.ok && audit.value.events.map((e) => e.type)).toEqual(['policy_run.released', 'run.paid', 'policy_run.generated'])
  })
})
