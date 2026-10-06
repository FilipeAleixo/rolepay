// Real core services on core's in-memory fakes, plus a fake Discord. Test-only: production
// code in this package never imports @payrun/core/adapters.
import { type Payrun, createPayrun, parseAmount } from '@payrun/core'
import { FakePayoutChain, FakeRunProposer, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@payrun/core/adapters'
import { RestActivityReader } from '../src/adapters/restActivityReader.js'
import { FakeDiscordRest, RecordingQueue } from '../src/testing/fakeDiscordRest.js'
import { ADDR, ALICE, BOB, CAROL, GUILD, T0, TOKEN, TREASURER_ROLE, TREASURY } from './fixtures.js'

export const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(`bad amount ${s}`)
  return r.value
}

export type Harness = Awaited<ReturnType<typeof harness>>

/** `proposer: null` = a server with no Anthropic API key. The activity reader is the real one, over the fake Discord. */
export async function harness(opts: { proposer?: FakeRunProposer | null } = {}) {
  const clock = new ManualClock(T0)
  const chain = new FakePayoutChain({ startTime: Math.floor(T0.getTime() / 1000) })
  chain.fund(TOKEN, TREASURY, usd('1000'))
  const rest = new FakeDiscordRest()
  const proposer = opts.proposer === undefined ? new FakeRunProposer() : opts.proposer
  const payrun: Payrun = createPayrun({
    chain,
    repositories: createMemoryRepositories({ clock }),
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato',
    proposer,
    activity: new RestActivityReader(rest),
  })
  const queue = new RecordingQueue()
  /** Moves the service clock and chain time together, as real waiting would. */
  const sleep = async (ms: number) => {
    clock.advance(ms / 1000)
    chain.advance(Math.ceil(ms / 1000))
  }

  async function setupCommunity(opts: { approverRoleId?: string | null; activeKey?: boolean; limit?: string } = {}) {
    const reg = await payrun.communities.register({
      guildId: GUILD,
      name: 'Test guild',
      treasuryAddress: TREASURY,
      payoutToken: TOKEN,
      feeMode: 'sponsor',
      approverRoleId: opts.approverRoleId === undefined ? TREASURER_ROLE : opts.approverRoleId,
    })
    if (!reg.ok) throw new Error(reg.error.code)
    if (opts.activeKey === false) return
    await payrun.communities.provisionBotKey({ guildId: GUILD, limit: usd(opts.limit ?? '100'), periodSeconds: 2_592_000, expiresAt: chain.time + 86_400 * 30 })
    const auth = await payrun.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    if (!auth.ok) throw new Error(auth.error.code)
  }

  async function registerPayee(userId: string, address: string) {
    const link = await payrun.payees.issueLink({ guildId: GUILD, discordUserId: userId })
    if (!link.ok) throw new Error(link.error.code)
    const r = await payrun.payees.register({ token: link.value.token, address })
    if (!r.ok) throw new Error(r.error.code)
  }

  async function registerAll() {
    await registerPayee(ALICE, ADDR.alice)
    await registerPayee(BOB, ADDR.bob)
    await registerPayee(CAROL, ADDR.carol)
  }

  /** A run for Alice (1.5) and Bob (25), submitted and approved. */
  async function approvedRun(by = '300000000000000001') {
    const r = await payrun.payRuns.create({
      guildId: GUILD,
      createdBy: '300000000000000002',
      note: 'October mods',
      lines: [
        { discordUserId: ALICE, amount: usd('1.5') },
        { discordUserId: BOB, amount: usd('25') },
      ],
    })
    if (!r.ok) throw new Error(r.error.code)
    await payrun.payRuns.submit({ guildId: GUILD, runId: r.value.id, actor: '300000000000000002' })
    const a = await payrun.payRuns.approve({ guildId: GUILD, runId: r.value.id, actor: by, actorCanApprove: true })
    if (!a.ok) throw new Error(a.error.code)
    return a.value
  }

  return { clock, chain, payrun, rest, queue, sleep, setupCommunity, registerPayee, registerAll, approvedRun, proposer: proposer as FakeRunProposer }
}
