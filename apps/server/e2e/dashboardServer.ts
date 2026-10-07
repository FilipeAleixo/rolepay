// The real composed server on http://localhost:<port> for the dashboard e2e: core on in-memory
// adapters (a fake chain), a fake Discord (the bot's member view), the fake Discord OAuth provider
// (its consent screen approves at once and redirects back) and the in-memory policy port. No network.
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { TESTNET_TOKENS, createRolepay, parseAmount } from '@rolepay/core'
import { FakePayoutChain, MemoryKeyValueStore, PlainKeyVault, SequentialIds, SystemClock, createMemoryRepositories } from '@rolepay/core/adapters'
import { FakeDiscordRest } from '@rolepay/discord/testing'
import { FakeDiscordOAuth, FakePasskeySessions, InMemoryPolicies, staticAssets } from '@rolepay/web/testing'
import { composeServer } from '../src/compose.js'
import { parseServerConfig } from '../src/config.js'

export const GUILD = '1094309218049937418'
export const ROLE = '400000000000000001'
export const TESS = { id: '300000000000000001', name: 'Tess' }
export const ALICE = { id: '200000000000000011', address: '0x1111111111111111111111111111111111111111' }
export const BOB = { id: '200000000000000012', address: '0x2222222222222222222222222222222222222222' }
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = TESTNET_TOKENS.alpha_usd

const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
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
  const rolepay = createRolepay({ chain, repositories: createMemoryRepositories({ clock }), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' })
  const rest = new FakeDiscordRest()
  const oauth = new FakeDiscordOAuth()
  const policies = new InMemoryPolicies(clock)
  policies.setApproverRole(GUILD, ROLE)
  const kv = new MemoryKeyValueStore(clock)

  // A community with a treasurer, two registered payees, an active key and one paid run.
  const registered = await rolepay.communities.register({ guildId: GUILD, name: 'E2E guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE })
  if (!registered.ok) throw new Error(registered.error.code)
  rest.setMember(GUILD, TESS.id, [ROLE], null, TESS.name)
  rest.setMember(GUILD, ALICE.id, [], null, 'Alice')
  rest.setMember(GUILD, BOB.id, [], null, 'Bob')
  for (const p of [ALICE, BOB]) {
    const link = await rolepay.payees.issueLink({ guildId: GUILD, discordUserId: p.id })
    if (!link.ok) throw new Error(link.error.code)
    await rolepay.payees.register({ token: link.value.token, address: p.address })
  }
  chain.fund(TOKEN, TREASURY, usd('1000'))
  await rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 30 * 86_400, expiresAt: Math.floor(Date.now() / 1000) + 60 * 86_400 })
  await rolepay.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
  const run = await rolepay.payRuns.create({ guildId: GUILD, createdBy: TESS.id, note: 'Weekly helpers, week 40', lines: [{ discordUserId: ALICE.id, amount: usd('12') }, { discordUserId: BOB.id, amount: usd('50') }] })
  if (!run.ok) throw new Error(run.error.code)
  await rolepay.payRuns.submit({ guildId: GUILD, runId: run.value.id, actor: TESS.id })
  await rolepay.payRuns.approve({ guildId: GUILD, runId: run.value.id, actor: TESS.id, actorCanApprove: true })
  await rolepay.payRuns.execute({ guildId: GUILD, runId: run.value.id })

  // The Monday rule as a policy that made that run.
  const policyId = policies.seed(
    GUILD,
    {
      name: 'Weekly helpers',
      instruction: 'Every Monday: 1 USDC per answered question in #help, max 50 a week each.',
      ruleInWords: 'Pays 1 AlphaUSD per reply in #help since the last run, at most 50 each.',
      filter: { repliesIn: { channels: ['#help'], min: 1 }, amount: { kind: 'perUnit', each: '1', cap: '50' } },
      nextRunAt: new Date(Date.now() + 3 * 86_400_000),
      approvedBy: TESS.id,
      approvedAt: new Date(),
    },
    {
      asOf: new Date(),
      window: null,
      matches: [
        { userId: ALICE.id, metrics: { replies: 12 }, reasons: ['12 replies in #help (at least 1)'], amount: usd('12'), registered: true },
        { userId: BOB.id, metrics: { replies: 60 }, reasons: ['60 replies in #help', 'capped at 50'], amount: usd('50'), registered: true },
      ],
      nearMisses: [],
      nextRunAt: new Date(Date.now() + 3 * 86_400_000),
      total: usd('62'),
      remainingBudget: usd('38'),
      held: null,
    },
  )
  policies.linkRun(GUILD, run.value.id, { policyId, policyRunId: 'prun_1', policyName: 'Weekly helpers', version: 1, period: 'week 40', mode: 'propose', scheduledFor: new Date(), executesAt: null, vetoedBy: null, vetoedAt: null, executedAt: null, vetoable: false })
  policies.addEvent(GUILD, { at: new Date(), type: 'run.generated', actorId: null, policyId, runId: run.value.id, summary: 'Generated a run of 62 AlphaUSD for 2 people.' })

  const composed = composeServer({
    config,
    rolepay,
    rest,
    clock,
    kv,
    web: { sessions: new FakePasskeySessions(), assets: staticAssets({}), dashboard: { oauth, policies, audit: policies } },
    log: () => {},
  })
  const server = serve({ fetch: composed.app.fetch, hostname: 'localhost', port })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return {
    url: `http://localhost:${port}`,
    oauth,
    policies,
    runId: run.value.id,
    policyId,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
