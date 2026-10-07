// The policy page contract's core backend: core's real PolicyService, SchedulerService and audit
// stream on in-memory adapters, through the server's adapters (`policyPortFromCore`,
// `auditPortFromCore`). The model is a scripted fake; Discord's roles, channels and activity are
// core's fake activity reader. Every state the contract asks for is reached by the services' own
// methods, never by writing records directly.
import type { SourceMessage } from '@rolepay/core'
import { FakeActivityReader, FakeRunProposer, emptyCriteria, unclearCriteria } from '@rolepay/core/adapters'
import { ALICE, BOB, CAROL, DAN, GUILD, MONDAY, MONDAY_RULE, type PolicyBackend, type PolicyBackendFactory, ROLE, TREASURER, usd } from '@rolepay/web/contract'
import { auditPortFromCore, policyPortFromCore, toCoreSchedule } from '../src/policySeam.js'

export const MODS = '400000000000000002'
export const HELP = '700000000000000002'
/** A channel the bot cannot read. */
const PRIVATE = '700000000000000003'
/** Whoever asked the questions the payees answered. */
const ASKER = '200000000000000090'

let messageIds = 0
const reply = (authorId: string, channelId: string, at: Date): SourceMessage => ({
  id: String(810000000000000000n + BigInt(++messageIds)),
  channelId,
  authorId,
  authorIsBot: false,
  content: '',
  mentionIds: [],
  at,
  replyTo: { messageId: '810000000000000000', authorId: ASKER },
})

/**
 * The model, scripted: "1 USDC per answered question in #help (at least two a week), max 50 each,
 * for Mods", with the amount and the cap taken from the instruction so they are always stated in
 * it. "unclear" cannot be compiled; "private room" counts in a channel the bot cannot read.
 */
export function scriptedProposer() {
  const proposer = new FakeRunProposer()
  proposer.onCriteria = (r) => {
    if (/unclear/i.test(r.instruction)) return unclearCriteria('It does not say who to pay.')
    const amount = /(\d+(?:\.\d+)?)\s*USDC/i.exec(r.instruction)?.[1] ?? '1'
    const cap = /max (\d+)/i.exec(r.instruction)?.[1] ?? ''
    const channel = /private room/i.test(r.instruction) ? 'C2' : 'C1'
    return emptyCriteria(
      { amount: { kind: 'perUnit', amount, per: 'replies', cap, total: '', splitBy: '' }, note: 'Help desk' },
      { hasRole: ['R2'], activity: [{ metric: 'replies', channels: [channel], since: '2026-09-30', until: '', min: 2 }] },
    )
  }
  return proposer
}

export const coreBackend: PolicyBackendFactory = (clock) => {
  const proposer = scriptedProposer()
  const activity = new FakeActivityReader()
  return {
    core: { proposer, activity },
    attach(h): PolicyBackend {
      const { rolepay } = h
      const treasurer = { guildId: GUILD, actor: TREASURER.id, actorRoleIds: [ROLE] }
      const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
        if (!r.ok) throw new Error(r.error.code)
        return r.value
      }
      const create = async (name: string, instruction: string, schedule = MONDAY) => must(await rolepay.policies.create({ ...treasurer, name, instruction, schedule: toCoreSchedule(schedule) })).id
      const autopilotRun = async (policyId: string) => {
        must(await rolepay.policies.setMode({ ...treasurer, policyId, mode: 'autopilot', vetoWindowMinutes: 60 }))
        const made = must(await rolepay.scheduler.runNow({ ...treasurer, policyId }))
        if (!made.run || made.policyRun.status !== 'scheduled') throw new Error(`no autopilot run: ${made.policyRun.status} ${made.policyRun.hold?.code ?? ''}`)
        return made.run.id
      }

      return {
        policies: policyPortFromCore(rolepay, { names: activity }),
        audit: auditPortFromCore(rolepay),
        uncompilable: 'pay the unclear <b>people</b>',
        async prepare() {
          must(await rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [ROLE] }))
          activity.roles = [
            { id: ROLE, name: 'Treasurer' },
            { id: MODS, name: 'Mods' },
          ]
          activity.channels = [
            { id: HELP, name: 'help', kind: 'text' },
            { id: PRIVATE, name: 'private', kind: 'text' },
          ]
          activity.forbidden.add(PRIVATE)
          activity.setMember(TREASURER.id, { roleIds: [ROLE], joinedAt: null })
          // This week in #help: Alice answered 12 questions, Bob 60 (over the cap), Carol 3 (not registered), Dan 1 (one short).
          const answered: [string, number][] = [
            [ALICE.id, 12],
            [BOB.id, 60],
            [CAROL.id, 3],
            [DAN.id, 1],
          ]
          let minute = 0
          for (const [id, count] of answered) {
            activity.setMember(id, { roleIds: [MODS], joinedAt: null })
            for (let i = 0; i < count; i++) activity.addMessages(reply(id, HELP, new Date(clock.now().getTime() - ++minute * 60_000)))
          }
          h.members.set(GUILD, ALICE.id, [MODS], 'Alice')
          h.members.set(GUILD, BOB.id, [MODS], 'Bob')
          await h.payee(ALICE.id, ALICE.address)
          await h.payee(BOB.id, BOB.address)
          await h.activeKey(usd('100'))
        },
        async mondayPolicy(name = 'Weekly helpers') {
          const id = await create(name, MONDAY_RULE)
          must(await rolepay.policies.approve({ ...treasurer, policyId: id, version: 1 }))
          return id
        },
        async policy(p) {
          const id = await create(p.name, `${p.name}: 1 USDC per answered question in #help, max 50 a week each.`, p.schedule)
          must(await rolepay.policies.approve({ ...treasurer, policyId: id, version: 1 }))
          if (p.mode === 'autopilot') must(await rolepay.policies.setMode({ ...treasurer, policyId: id, mode: 'autopilot' }))
          if (p.status === 'paused') must(await rolepay.policies.pause({ ...treasurer, policyId: id }))
          return id
        },
        async unreadablePolicy(name) {
          return create(name, 'Every Monday: 1 USDC per answered question in the private room, max 50 a week each.')
        },
        async exhaustBudget() {
          // A paid run of 50 leaves the key 50, less than the 62 the rule's next run would pay.
          await h.run([[ALICE.id, '50']])
        },
        autopilotRun,
        async releasedRun(policyId) {
          const runId = await autopilotRun(policyId)
          h.clock.advance(61 * 60)
          h.chain.advance(61 * 60)
          const report = await rolepay.scheduler.tick()
          const released = report.events.find((e) => e.kind === 'released' && e.run.id === runId)
          if (!released || released.outcome !== 'paid') throw new Error(`not released: ${JSON.stringify(report.events.map((e) => [e.kind, e.policyRun.status]))} ${JSON.stringify(report.errors)}`)
          return runId
        },
      }
    },
  }
}
