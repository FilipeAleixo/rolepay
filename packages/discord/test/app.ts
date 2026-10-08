// The Discord app wired to real core services (in-memory fakes) and a fake Discord.
import { TESTNET_TOKENS } from '@rolepay/core'
import { RestMemberDirectory } from '../src/adapters/restMemberDirectory.js'
import type { DiscordAppConfig, DiscordAppDeps } from '../src/app/deps.js'
import { createDispatcher } from '../src/app/router.js'
import type { Dispatched } from '../src/http/handler.js'
import type { MemberDirectory } from '../src/ports.js'
import { createPolicyNotifier } from '../src/execution/policyNotifier.js'
import { MemoryPendingSources, MemoryRunNotices } from '../src/testing/fakeDiscordRest.js'
import type { FakeRunProposer } from '@rolepay/core/adapters'
import { CHANNEL, GUILD } from './fixtures.js'
import { harness, usd } from './harness.js'

export const CONFIG: DiscordAppConfig = {
  network: 'moderato',
  claimBaseUrl: 'https://rolepay.test/claim',
  setupBaseUrl: 'https://rolepay.test/setup',
  dashboardBaseUrl: 'https://rolepay.test/dashboard',
  defaultFeeToken: TESTNET_TOKENS.path_usd,
  defaultPayoutToken: TESTNET_TOKENS.alpha_usd,
  sponsor: true,
  botKey: { limit: usd('100'), periodSeconds: 2_592_000, validitySeconds: 2_592_000 },
  authorizeHint: 'Dev: run `pnpm dev:authorize-key {guildId}`.',
  devShortcuts: true,
  demoControls: true,
}

export const SCOPE = { guildId: GUILD, channelId: CHANNEL }

export async function appHarness(opts: { members?: MemberDirectory; config?: Partial<DiscordAppConfig>; proposer?: FakeRunProposer | null } = {}) {
  // Core and the Discord layer agree on the demo controls, as the server wires them from one setting.
  const h = await harness({ ...(opts.proposer === undefined ? {} : { proposer: opts.proposer }), demoControls: opts.config?.demoControls ?? CONFIG.demoControls })
  const errors: unknown[] = []
  // Where each run's messages are, shared as the server shares it (the treasury channel keeps two in step).
  const notices = new MemoryRunNotices()
  const treasuryEvents: unknown[] = []
  const deps: DiscordAppDeps = {
    rolepay: h.rolepay,
    rest: h.rest,
    queue: h.queue,
    members: opts.members ?? new RestMemberDirectory(h.rest),
    pendingSources: new MemoryPendingSources(),
    clock: h.clock,
    config: { ...CONFIG, ...opts.config },
    announcer: createPolicyNotifier({ rolepay: h.rolepay, rest: h.rest, notices, network: 'moderato' }),
    notices,
    onTreasury: (e) => treasuryEvents.push(e),
    onError: (e) => errors.push(e),
  }
  const dispatch = createDispatcher(deps)
  /** Dispatches and runs any background work to completion. */
  async function send(interaction: unknown) {
    const d = await dispatch(interaction)
    if (d.kind === 'respond') await d.background?.()
    return d
  }
  return { ...h, deps, dispatch, send, errors, notices, treasuryEvents }
}

export function body(d: Dispatched) {
  if (d.kind !== 'respond') throw new Error(`expected a response, got ${d.kind}`)
  return d.body as { type: number; data?: Record<string, unknown> & { flags?: number; content?: string } }
}

export const isEphemeral = (d: Dispatched) => ((body(d).data?.flags ?? 0) & 64) === 64
export const text = (v: unknown) => JSON.stringify(v ?? null)
