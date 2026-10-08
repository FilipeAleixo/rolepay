// A community for policy tests: real services from createRolepay on the in-memory adapters, a fake
// chain, a fake Discord (activity) and the deterministic fake model. Wednesday 7 October 2026, noon
// UTC; the help desk policy runs on Mondays at 18:00 UTC.
import { type Rolepay, createRolepay } from '../../src/index.js'
import { FakeActivityReader } from '../../src/adapters/memory/fakeActivity.js'
import { FakePayoutChain } from '../../src/adapters/memory/fakeChain.js'
import { FakeRunProposer, emptyCriteria } from '../../src/adapters/memory/fakeProposer.js'
import { createMemoryRepositories } from '../../src/adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../../src/adapters/memory/support.js'
import type { SourceMessage } from '../../src/domain/proposal/sources.js'
import type { RawCriteriaProposal } from '../../src/domain/proposal/raw.js'

export const GUILD = '1094309218049937418'
export const OTHER_GUILD = '1094309218049937419'
export const BOUNTIES = '700000000000000001'
export const HELP = '700000000000000002'
export const POSTS = '700000000000000009'
export const APPROVER = '400000000000000001'
export const MODS = '400000000000000002'
export const PROPOSERS = '400000000000000003'
export const TREASURER = '300000000000000001'
export const TREASURER_TWO = '300000000000000002'
export const WRITER = '300000000000000003' // holds the proposer role only
export const ANA = '200000000000000001'
export const RUI = '200000000000000002'
export const LI = '200000000000000003'
export const BIG = '200000000000000005'
export const DAVE = '200000000000000004' // a Mod who never registers
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const TOKEN = '0x20c0000000000000000000000000000000000001'
export const T0 = new Date('2026-10-07T12:00:00Z') // a Wednesday
export const MONDAY = new Date('2026-10-12T18:00:00Z')
export const usd = (n: number) => BigInt(Math.round(n * 1_000_000))
export const asTreasurer = { guildId: GUILD, actor: TREASURER, actorRoleIds: [APPROVER] }
export const asWriter = { guildId: GUILD, actor: WRITER, actorRoleIds: [PROPOSERS] }
export const INSTRUCTION = 'Every Monday: 1 per answered question in #help, max 50 a week each, for Mods'
export const MONDAYS = { kind: 'weekly' as const, weekday: 'monday' as const, hour: 18, timezone: 'UTC' }
/** The testnet demo's schedule (only with the demo controls on): every day at 18:00 UTC. */
export const DAILY = { kind: 'daily' as const, hour: 18, timezone: 'UTC' }
/** Today's 18:00 UTC, the first daily occurrence after T0. */
export const TODAY_18 = new Date('2026-10-07T18:00:00Z')
/** The judge demo's welcome post in #start-here, and the instruction that pays whoever reacts ✅ to it once. */
export const START_HERE = '700000000000000010'
export const WELCOME = '810000000000000123'
export const JUDGES = `Every day at 18:00 UTC: 1 AlphaUSD to every registered payee who reacted ✅ to https://discord.com/channels/${GUILD}/${START_HERE}/${WELCOME} and has never been paid`
/** The judge rule as the model writes it: a flat 1, reacted ✅ to the linked message (M1), never paid. */
export const judgesAnswer = (): RawCriteriaProposal =>
  emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' }, note: 'Judges' }, { anchors: [{ kind: 'reactedTo', message: 'M1', thread: '', emoji: '✅' }], neverPaid: true })

const ADDRESS: Record<string, string> = {
  [ANA]: '0x1111111111111111111111111111111111111111',
  [RUI]: '0x2222222222222222222222222222222222222222',
  [LI]: '0x3333333333333333333333333333333333333333',
  [BIG]: '0x5555555555555555555555555555555555555555',
}
export const addressOf = (id: string) => ADDRESS[id] as `0x${string}`

/** "1 per reply in #help to Mods, at most 50 each", as the model writes it (tokens, amounts as text). */
export const helpDeskAnswer = (over: Partial<RawCriteriaProposal> = {}, min = 1): RawCriteriaProposal =>
  emptyCriteria(
    { amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk', assumptions: ['"a week" means since the previous run'], ...over },
    { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C2'], since: '2026-09-30', until: '', min }] },
  )

let seq = 0
export const reply = (authorId: string, at: Date, to = LI): SourceMessage => ({
  id: `82${String(++seq).padStart(16, '0')}`,
  channelId: HELP,
  authorId,
  authorIsBot: false,
  content: '',
  mentionIds: [],
  at,
  replyTo: { messageId: '820000000000999999', authorId: to },
})
const hoursBefore = (t: Date, h: number) => new Date(t.getTime() - h * 3_600_000)

export type PolicyWorld = Awaited<ReturnType<typeof policyWorld>>

export async function policyWorld(
  opts: { limit?: number; key?: boolean; ai?: boolean; proposer?: FakeRunProposer | null; minVetoMinutes?: number; separateApprover?: boolean; demoControls?: boolean } = {},
) {
  const clock = new ManualClock(T0)
  const chain = new FakePayoutChain({ startTime: Math.floor(T0.getTime() / 1000) })
  const repos = createMemoryRepositories({ clock })
  const proposer = opts.proposer === undefined ? new FakeRunProposer() : opts.proposer
  const activity = new FakeActivityReader()
  const deps = {
    chain,
    repositories: repos,
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato' as const,
    proposer,
    activity,
    ...(opts.minVetoMinutes ? { minVetoMinutes: opts.minVetoMinutes } : {}),
    ...(opts.demoControls ? { demoControls: true } : {}),
  }
  const rolepay: Rolepay = createRolepay(deps)
  const reg = await rolepay.communities.register({
    guildId: GUILD,
    name: 'Help desk guild',
    treasuryAddress: TREASURY,
    payoutToken: TOKEN,
    feeMode: 'sponsor',
    approverRoleId: APPROVER,
    requireSeparateApprover: opts.separateApprover ?? false,
  })
  if (!reg.ok) throw new Error(reg.error.code)
  if (opts.ai !== false) await rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, proposerRoleId: PROPOSERS, actorRoleIds: [APPROVER] })
  if (opts.key !== false) {
    await rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd(opts.limit ?? 1000), periodSeconds: 30 * 86_400, expiresAt: chain.time + 60 * 86_400 })
    const auth = await rolepay.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    if (!auth.ok) throw new Error(auth.error.code)
  }
  chain.fund(TOKEN, TREASURY, usd(5000))
  for (const id of [ANA, RUI, LI, BIG]) await repos.payees.upsert({ communityId: GUILD, discordUserId: id, address: addressOf(id), addressKind: 'passkey', preferredToken: null, registeredAt: T0, updatedAt: T0 })

  activity.roles = [
    { id: APPROVER, name: 'Treasurer' },
    { id: MODS, name: 'Mods' },
  ]
  activity.channels = [
    { id: BOUNTIES, name: 'bounties', kind: 'text' },
    { id: HELP, name: 'help', kind: 'text' },
  ]
  for (const [id, roles] of [
    [ANA, [MODS]],
    [RUI, [MODS]],
    [LI, []],
    [BIG, [MODS]],
    [DAVE, [MODS]],
    [TREASURER, [APPROVER]],
    [TREASURER_TWO, [APPROVER]],
  ] as const) {
    activity.setMember(id, { roleIds: [...roles], joinedAt: new Date('2026-01-01T00:00:00Z') })
  }
  // This week so far (since Monday 5 October 18:00): Ana 12 replies, Rui 2, Li 15 (not a Mod), Big 70, Dave 4.
  const week = (author: string, n: number) => Array.from({ length: n }, (_, i) => reply(author, hoursBefore(T0, 1 + (i % 40))))
  activity.addMessages(...week(ANA, 12), ...week(RUI, 2), ...week(LI, 15), ...week(BIG, 70), ...week(DAVE, 4))
  // Older than the period: never counted.
  activity.addMessages(reply(RUI, new Date('2026-10-01T10:00:00Z')))
  if (proposer) proposer.onCriteria = () => helpDeskAnswer()

  /** Moves the services' clock and the chain together, as real waiting would. */
  const travel = (seconds: number) => {
    clock.advance(seconds)
    chain.advance(seconds)
  }
  const travelTo = (at: Date) => travel(Math.round((at.getTime() - clock.now().getTime()) / 1000))

  /** Creates the help desk policy (draft v1) as the treasurer. */
  async function draft(over: Record<string, unknown> = {}) {
    const r = await rolepay.policies.create({ ...asTreasurer, name: 'Help desk', instruction: INSTRUCTION, schedule: MONDAYS, channelId: POSTS, ...over })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value
  }

  /** Creates and approves the help desk policy; with `autopilot`, switches it on (veto window in minutes). */
  async function active(over: Record<string, unknown> = {}, autopilot: { vetoWindowMinutes?: number } | null = null) {
    const p = await draft(over)
    const approved = await rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: p.version })
    if (!approved.ok) throw new Error(JSON.stringify(approved.error))
    if (!autopilot) return approved.value
    const auto = await rolepay.policies.setMode({ ...asTreasurer, policyId: p.id, mode: 'autopilot', ...autopilot })
    if (!auto.ok) throw new Error(JSON.stringify(auto.error))
    return auto.value
  }

  return { clock, chain, repos, rolepay, proposer: proposer as FakeRunProposer, activity, travel, travelTo, draft, active, deps }
}
