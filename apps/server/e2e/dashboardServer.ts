// The real composed server on http://localhost:<port> for the dashboard e2e: core on in-memory
// adapters (a fake chain) with its REAL policy services behind the dashboard (the policy seam as
// main.ts wires it), a fake Discord (the bot's member view and the activity the policies count),
// a scripted model and the fake Discord OAuth provider (its consent screen approves at once and
// redirects back). No network.
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { TESTNET_TOKENS, WEEKDAYS, createRolepay, parseAmount } from '@rolepay/core'
import { FakeFundingChain, FakePayoutChain, FakeRunProposer, InProcessLiveFeed, MemoryKeyValueStore, PlainKeyVault, SequentialIds, SystemClock, createMemoryRepositories, emptyCriteria } from '@rolepay/core/adapters'
import { RestActivityReader } from '@rolepay/discord'
import { FakeDiscordRest, wireMessage } from '@rolepay/discord/testing'
import { bundledAssets } from '@rolepay/web'
import { FakeDiscordOAuth, FakePasskeySessions } from '@rolepay/web/testing'
import { composeServer } from '../src/compose.js'
import { parseServerConfig } from '../src/config.js'
import { auditPortFromCore, payoutsPortFromCore, policyKeysPortFromCore, policyPortFromCore } from '../src/policySeam.js'

export const GUILD = '1094309218049937418'
export const ROLE = '400000000000000001'
const MODS = '400000000000000002'
const HELP = '700000000000000002'
export const TESS = { id: '300000000000000001', name: 'Tess' }
export const ALICE = { id: '200000000000000011', address: '0x1111111111111111111111111111111111111111' }
export const BOB = { id: '200000000000000012', address: '0x2222222222222222222222222222222222222222' }
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = TESTNET_TOKENS.alpha_usd
export const RULE = 'Every Monday: 1 USDC per answered question in #help, max 50 a week each.'

const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(r.error.code)
  return r.value
}

export async function startDashboardServer(port: number) {
  const config = parseServerConfig({
    ROLEPAY_MASTER_KEY: randomBytes(32).toString('hex'),
    DISCORD_APP_ID: '500000000000000001',
    DISCORD_PUBLIC_KEY: 'cd'.repeat(32),
    DISCORD_BOT_TOKEN: 'fake-bot-token',
    PUBLIC_URL: `http://localhost:${port}`,
  })
  const clock = new SystemClock()
  const chain = new FakePayoutChain({ startTime: Math.floor(Date.now() / 1000) })
  const rest = new FakeDiscordRest()
  const activity = new RestActivityReader(rest)
  // The model, scripted: 1 per answer in #help (the amount from the instruction), max 50 each, for Mods.
  const proposer = new FakeRunProposer()
  proposer.onCriteria = (r) =>
    emptyCriteria(
      { amount: { kind: 'perUnit', amount: /(\d+)\s*USDC/i.exec(r.instruction)?.[1] ?? '1', per: 'replies', cap: '50', total: '', splitBy: '' }, note: 'Help desk' },
      { hasRole: ['R2'], activity: [{ metric: 'replies', channels: ['C1'], since: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), until: '', min: 1 }] },
    )
  // Deposit addresses: an in-memory registry and transfer log (its deposits do not move the payout fake's balances).
  const fundingChain = new FakeFundingChain()
  const rolepay = createRolepay({ chain, repositories: createMemoryRepositories({ clock }), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato', proposer, activity, fundingChain, live: new InProcessLiveFeed() })
  const oauth = new FakeDiscordOAuth()
  const kv = new MemoryKeyValueStore(clock)

  // A community with a treasurer, two registered payees, an active key of 200 and AI proposals on.
  must(await rolepay.communities.register({ guildId: GUILD, name: 'E2E guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE }))
  must(await rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [ROLE] }))
  rest.roles.set(GUILD, [
    { id: ROLE, name: 'Treasurer' },
    { id: MODS, name: 'Mods' },
  ])
  rest.channels.set(GUILD, [{ id: HELP, name: 'help', type: 0 }])
  rest.setMember(GUILD, TESS.id, [ROLE], null, TESS.name)
  rest.setMember(GUILD, ALICE.id, [MODS], null, 'Alice')
  rest.setMember(GUILD, BOB.id, [MODS], null, 'Bob')
  for (const p of [ALICE, BOB]) {
    const link = must(await rolepay.payees.issueLink({ guildId: GUILD, discordUserId: p.id }))
    must(await rolepay.payees.register({ token: link.token, address: p.address }))
  }
  chain.fund(TOKEN, TREASURY, usd('1000'))
  must(await rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('200'), periodSeconds: 30 * 86_400, expiresAt: Math.floor(Date.now() / 1000) + 60 * 86_400 }))
  must(await rolepay.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) }))

  // This week in #help: Alice answered 12 questions, Bob 60 (he is capped at 50).
  let minute = 0
  for (const [id, count] of [
    [ALICE.id, 12],
    [BOB.id, 60],
  ] as const) {
    for (let i = 0; i < count; i++) rest.addChannelMessages(wireMessage({ channelId: HELP, authorId: id, at: new Date(Date.now() - ++minute * 60_000), replyTo: { id: '820000000000000001', authorId: '200000000000000090' } }))
  }

  // Two policies that run tomorrow at this hour (so this week's answers count), written and approved by Tess.
  const tomorrow = new Date(Date.now() + 26 * 3_600_000)
  const schedule = { kind: 'weekly' as const, weekday: WEEKDAYS[tomorrow.getUTCDay()] ?? 'monday', hour: tomorrow.getUTCHours(), timezone: 'UTC' }
  const tess = { guildId: GUILD, actor: TESS.id, actorRoleIds: [ROLE] }
  const policy = async (name: string) => {
    const p = must(await rolepay.policies.create({ ...tess, name, instruction: RULE, schedule }))
    must(await rolepay.policies.approve({ ...tess, policyId: p.id, version: 1 }))
    return p.id
  }
  // "Weekly helpers" (propose): its next run made now, approved by Tess and paid (62 AlphaUSD).
  const policyId = await policy('Weekly helpers')
  const made = must(await rolepay.scheduler.runNow({ ...tess, policyId }))
  const run = made.run
  if (!run) throw new Error(`no run: ${made.policyRun.status}`)
  must(await rolepay.payRuns.approve({ guildId: GUILD, runId: run.id, actor: TESS.id, actorCanApprove: true }))
  must(await rolepay.payRuns.execute({ guildId: GUILD, runId: run.id }))
  // "Autopilot helpers": its next run made now, paying in an hour unless vetoed.
  const autopilotId = await policy('Autopilot helpers')
  must(await rolepay.policies.setMode({ ...tess, policyId: autopilotId, mode: 'autopilot', vetoWindowMinutes: 60 }))
  const scheduled = must(await rolepay.scheduler.runNow({ ...tess, policyId: autopilotId }))
  if (!scheduled.run || scheduled.policyRun.status !== 'scheduled') throw new Error(`no autopilot run: ${scheduled.policyRun.status}`)

  // Deposit addresses set up on the treasury page, a funding source made by Tess, and a 25 AlphaUSD deposit to it.
  const registered = fundingChain.register(TREASURY, `0x${'00'.repeat(28)}58e21090`)
  must(await rolepay.funding.confirmMaster({ guildId: GUILD, ...registered }))
  const acme = must(await rolepay.funding.createSource({ ...tess, name: 'Acme DAO' }))
  const deposit = fundingChain.transfer({ token: TOKEN, from: '0x5555555555555555555555555555555555555555', to: acme.depositAddress, amount: usd('25') })
  await rolepay.funding.scan()

  const composed = composeServer({
    config,
    rolepay,
    rest,
    clock,
    kv,
    web: {
      sessions: new FakePasskeySessions(),
      // The real bundles: the dashboard's live script (/assets/live.js) runs in the browser.
      assets: bundledAssets(),
      dashboard: { oauth, policies: policyPortFromCore(rolepay, { names: activity }), audit: auditPortFromCore(rolepay), payouts: payoutsPortFromCore(rolepay), policyKeys: policyKeysPortFromCore(rolepay) },
    },
    log: () => {},
  })
  const server = serve({ fetch: composed.app.fetch, hostname: 'localhost', port })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return {
    url: `http://localhost:${port}`,
    oauth,
    rolepay,
    proposer,
    runId: run.id,
    policyId,
    autopilotRunId: scheduled.run.id,
    deposit: { address: acme.depositAddress, txHash: deposit.txHash },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
