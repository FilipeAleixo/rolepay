// The policy page contract's in-memory backend: `InMemoryPolicies`, seeded the way the contract
// describes each state. The core backend (apps/server/test/coreBackend.ts) reaches the same states
// through core's real services.
import { InMemoryPolicies } from '../../src/testing/index.js'
import { GUILD, ROLE, TREASURER, usd } from '../dashboardHarness.js'
import { ALICE, BOB, CAROL, DAN, MONDAY, MONDAY_RULE, type PolicyBackend, type PolicyBackendFactory } from './policyPages.js'

const DAY = 86_400_000

export const inMemoryBackend: PolicyBackendFactory = (clock) => ({
  attach(h): PolicyBackend {
    const ports = new InMemoryPolicies(clock)
    ports.setApproverRole(GUILD, ROLE)
    const nextMonday = new Date('2026-10-12T18:00:00Z')
    let runs = 0

    const preview = (held: string | null = null) => ({
      asOf: clock.now(),
      window: { since: new Date('2026-10-05T18:00:00Z'), until: clock.now() },
      matches: [
        { userId: ALICE.id, metrics: { replies: 12 }, reasons: ['12 replies to other people in #help (at least 2)'], amount: usd('12'), registered: true },
        { userId: BOB.id, metrics: { replies: 60 }, reasons: ['60 replies to other people in #help (at least 2)', 'capped at 50 AlphaUSD'], amount: usd('50'), registered: true },
        { userId: CAROL.id, metrics: { replies: 3 }, reasons: ['3 replies to other people in #help (at least 2)'], amount: null, registered: false },
      ],
      nearMisses: [{ userId: DAN.id, metrics: { replies: 1 }, missing: '1 short of the minimum: 1 reply to other people in #help (at least 2)' }],
      nextRunAt: nextMonday,
      total: usd('62'),
      remainingBudget: held ? usd('50') : usd('100'),
      held,
    })

    /** Like core: writing and approving a policy leave events in the audit stream. */
    const written = (id: string, name: string) => {
      ports.addEvent(GUILD, { at: clock.now(), type: 'policy.created', actorId: TREASURER.id, policyId: id, runId: null, summary: `Wrote "${name}" as a draft.` })
      ports.addEvent(GUILD, { at: clock.now(), type: 'policy.approved', actorId: TREASURER.id, policyId: id, runId: null, summary: 'Approved version 1.' })
    }

    const linkedRun = async (policyId: string, origin: { vetoable: boolean; executedAt: Date | null }) => {
      const run = await h.run([[ALICE.id, '12'], [BOB.id, '50']], { approve: false })
      ports.linkRun(GUILD, run.id, {
        policyId,
        policyRunId: `prun_${++runs}`,
        policyName: 'Weekly helpers',
        version: 1,
        period: '2026-10-05 18:00 UTC to 2026-10-12 18:00 UTC',
        mode: 'autopilot',
        scheduledFor: nextMonday,
        executesAt: new Date(clock.now().getTime() + DAY),
        vetoedBy: null,
        vetoedAt: null,
        ...origin,
      })
      return run.id
    }

    return {
      policies: ports,
      audit: ports,
      uncompilable: 'pay the unclear <b>people</b>',
      async prepare() {
        h.members.set(GUILD, ALICE.id, [], 'Alice')
        h.members.set(GUILD, BOB.id, [], 'Bob')
        await h.payee(ALICE.id, ALICE.address)
        await h.payee(BOB.id, BOB.address)
        await h.activeKey(usd('100'))
      },
      async mondayPolicy(name = 'Weekly helpers') {
        const id = ports.seed(
          GUILD,
          {
            name,
            instruction: MONDAY_RULE,
            schedule: MONDAY,
            ruleInWords: '1 AlphaUSD per reply to other people, at most 50 AlphaUSD each. Who: has @Mods; replied to other people at least twice in #help during the period.',
            filter: { criteria: { repliesIn: { channelIds: ['700000000000000002'], min: 2 } }, plan: { rule: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50' } } },
            nextRunAt: nextMonday,
            matchesNow: null,
            version: 1,
            createdBy: TREASURER.id,
            approvedBy: TREASURER.id,
            approvedAt: clock.now(),
          },
          preview(),
        )
        written(id, name)
        return id
      },
      async policy(p) {
        const id = ports.seed(GUILD, {
          name: p.name,
          instruction: `${p.name}: 1 USDC per answered question in #help.`,
          status: p.status,
          mode: p.mode,
          schedule: p.schedule,
          nextRunAt: p.status === 'active' ? nextMonday : null,
          createdBy: TREASURER.id,
          approvedBy: TREASURER.id,
          approvedAt: clock.now(),
        })
        written(id, p.name)
        return id
      },
      async unreadablePolicy(name) {
        return ports.seed(GUILD, { name, instruction: 'Every Monday: 1 USDC per message in #secret.', createdBy: TREASURER.id, approvedBy: TREASURER.id, approvedAt: clock.now() }, null)
      },
      async exhaustBudget(policyId) {
        ports.setPreview(GUILD, policyId, preview('The run (62 AlphaUSD) is more than the bot key has left (50 AlphaUSD): it would be held, not partly paid.'))
      },
      async autopilotRun(policyId) {
        const runId = await linkedRun(policyId, { vetoable: true, executedAt: null })
        ports.addEvent(GUILD, { at: clock.now(), type: 'policy_run.generated', actorId: TREASURER.id, policyId, runId, summary: "Made the period's run: 62 AlphaUSD for 2 people." })
        return runId
      },
      async releasedRun(policyId) {
        const runId = await linkedRun(policyId, { vetoable: false, executedAt: clock.now() })
        ports.addEvent(GUILD, { at: clock.now(), type: 'policy_run.generated', actorId: TREASURER.id, policyId, runId, summary: "Made the period's run: 62 AlphaUSD for 2 people." })
        ports.addEvent(GUILD, { at: clock.now(), type: 'policy_run.released', actorId: null, policyId, runId, summary: 'Released the run after its veto window: paid.' })
        return runId
      },
    }
  },
})
