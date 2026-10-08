// Real core services on core's in-memory fakes, plus a fake Discord. Test-only: production
// code in this package never imports @rolepay/core/adapters.
import { type Address, type MessageSignatures, type Rolepay, createRolepay, ok, parseAmount } from '@rolepay/core'
import { FakeFundingChain, FakePayoutChain, FakeRunProposer, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import { RestActivityReader } from '../src/adapters/restActivityReader.js'
import { FakeDiscordRest, RecordingQueue } from '../src/testing/fakeDiscordRest.js'
import { ADDR, ALICE, BOB, CAROL, GUILD, T0, TOKEN, TREASURER_ROLE, TREASURY } from './fixtures.js'

export const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(`bad amount ${s}`)
  return r.value
}

export type Harness = Awaited<ReturnType<typeof harness>>

/**
 * The Discord layer never sees a signature: this stand-in "recovers" the address the claim message
 * names, so a test can register a payee at their own wallet. Core's own tests check real signatures.
 */
const trustingSignatures: MessageSignatures = {
  recover: async (message) => ok((/ at (0x[0-9a-f]{40}) on Tempo /.exec(message)?.[1] ?? '0x0000000000000000000000000000000000000001') as Address),
}

/**
 * `proposer: null` = a server with no Anthropic API key. The activity reader is the real one, over the fake Discord.
 * `demoControls: false` = core without the testnet demo controls (no daily schedules); on by default, like the test config.
 */
export async function harness(opts: { proposer?: FakeRunProposer | null; demoControls?: boolean } = {}) {
  const clock = new ManualClock(T0)
  const chain = new FakePayoutChain({ startTime: Math.floor(T0.getTime() / 1000) })
  chain.fund(TOKEN, TREASURY, usd('1000'))
  const rest = new FakeDiscordRest()
  const proposer = opts.proposer === undefined ? new FakeRunProposer() : opts.proposer
  // Deposit addresses: an in-memory registry and transfer log (the fake masterId is a salt's last 4 bytes).
  const fundingChain = new FakeFundingChain()
  const rolepay: Rolepay = createRolepay({
    chain,
    repositories: createMemoryRepositories({ clock }),
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato',
    proposer,
    activity: new RestActivityReader(rest),
    // As the server runs with the testnet demo controls on: veto windows down to a minute, and daily schedules.
    minVetoMinutes: 1,
    demoControls: opts.demoControls ?? true,
    fundingChain,
    signatures: trustingSignatures,
  })
  const queue = new RecordingQueue()
  /** Moves the service clock and chain time together, as real waiting would. */
  const sleep = async (ms: number) => {
    clock.advance(ms / 1000)
    chain.advance(Math.ceil(ms / 1000))
  }

  async function setupCommunity(opts: { approverRoleId?: string | null; activeKey?: boolean; limit?: string } = {}) {
    const reg = await rolepay.communities.register({
      guildId: GUILD,
      name: 'Test guild',
      treasuryAddress: TREASURY,
      payoutToken: TOKEN,
      feeMode: 'sponsor',
      approverRoleId: opts.approverRoleId === undefined ? TREASURER_ROLE : opts.approverRoleId,
    })
    if (!reg.ok) throw new Error(reg.error.code)
    if (opts.activeKey === false) return
    await rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd(opts.limit ?? '100'), periodSeconds: 2_592_000, expiresAt: chain.time + 86_400 * 30 })
    const auth = await rolepay.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
    if (!auth.ok) throw new Error(auth.error.code)
  }

  async function registerPayee(userId: string, address: string) {
    const link = await rolepay.payees.issueLink({ guildId: GUILD, discordUserId: userId })
    if (!link.ok) throw new Error(link.error.code)
    const r = await rolepay.payees.register({ token: link.value.token, address })
    if (!r.ok) throw new Error(r.error.code)
  }

  /** A payee paid at a wallet they already have (registered through the wallet claim, its signature taken as valid here). */
  async function registerWallet(userId: string, address: string) {
    const link = await rolepay.payees.issueLink({ guildId: GUILD, discordUserId: userId })
    if (!link.ok) throw new Error(link.error.code)
    const challenge = await rolepay.payees.walletChallenge({ token: link.value.token, address, origin: 'http://localhost:8787' })
    if (!challenge.ok) throw new Error(challenge.error.code)
    const r = await rolepay.payees.registerExternal({ token: link.value.token, message: challenge.value.message, signature: '0xsigned', origin: 'http://localhost:8787' })
    if (!r.ok) throw new Error(r.error.code)
  }

  async function registerAll() {
    await registerPayee(ALICE, ADDR.alice)
    await registerPayee(BOB, ADDR.bob)
    await registerPayee(CAROL, ADDR.carol)
  }

  /** A run for Alice (1.5) and Bob (25), submitted and approved. */
  async function approvedRun(by = '300000000000000001') {
    const r = await rolepay.payRuns.create({
      guildId: GUILD,
      createdBy: '300000000000000002',
      note: 'October mods',
      lines: [
        { discordUserId: ALICE, amount: usd('1.5') },
        { discordUserId: BOB, amount: usd('25') },
      ],
    })
    if (!r.ok) throw new Error(r.error.code)
    await rolepay.payRuns.submit({ guildId: GUILD, runId: r.value.id, actor: '300000000000000002' })
    const a = await rolepay.payRuns.approve({ guildId: GUILD, runId: r.value.id, actor: by, actorCanApprove: true })
    if (!a.ok) throw new Error(a.error.code)
    return a.value
  }

  /** The treasury registered as a virtual-address master (as the setup page does), recorded by Rolepay. */
  async function setUpDepositAddresses() {
    const { txHash, masterId } = fundingChain.register(TREASURY, `0x${'00'.repeat(28)}58e21090`)
    const r = await rolepay.funding.confirmMaster({ guildId: GUILD, masterId, txHash })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }

  return { clock, chain, fundingChain, rolepay, rest, queue, sleep, setupCommunity, registerPayee, registerWallet, registerAll, approvedRun, setUpDepositAddresses, proposer: proposer as FakeRunProposer }
}
