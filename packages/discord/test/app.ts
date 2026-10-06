// The Discord app wired to real core services (in-memory fakes) and a fake Discord.
import { TESTNET_TOKENS } from '@payrun/core'
import { RestMemberDirectory } from '../src/adapters/restMemberDirectory.js'
import type { DiscordAppConfig, DiscordAppDeps } from '../src/app/deps.js'
import { createDispatcher } from '../src/app/router.js'
import type { Dispatched } from '../src/http/handler.js'
import type { MemberDirectory } from '../src/ports.js'
import { CHANNEL, GUILD } from './fixtures.js'
import { harness, usd } from './harness.js'

export const CONFIG: DiscordAppConfig = {
  network: 'moderato',
  claimBaseUrl: 'https://payrun.test/claim',
  defaultPayoutToken: TESTNET_TOKENS.alpha_usd,
  botKey: { limit: usd('100'), periodSeconds: 2_592_000, validitySeconds: 2_592_000 },
  authorizeHint: 'Dev: run `pnpm dev:authorize-key {guildId}`.',
}

export const SCOPE = { guildId: GUILD, channelId: CHANNEL }

export async function appHarness(opts: { members?: MemberDirectory } = {}) {
  const h = await harness()
  const errors: unknown[] = []
  const deps: DiscordAppDeps = {
    payrun: h.payrun,
    rest: h.rest,
    queue: h.queue,
    members: opts.members ?? new RestMemberDirectory(h.rest),
    clock: h.clock,
    config: CONFIG,
    onError: (e) => errors.push(e),
  }
  const dispatch = createDispatcher(deps)
  /** Dispatches and runs any background work to completion. */
  async function send(interaction: unknown) {
    const d = await dispatch(interaction)
    if (d.kind === 'respond') await d.background?.()
    return d
  }
  return { ...h, deps, dispatch, send, errors }
}

export function body(d: Dispatched) {
  if (d.kind !== 'respond') throw new Error(`expected a response, got ${d.kind}`)
  return d.body as { type: number; data?: Record<string, unknown> & { flags?: number; content?: string } }
}

export const isEphemeral = (d: Dispatched) => ((body(d).data?.flags ?? 0) & 64) === 64
export const text = (v: unknown) => JSON.stringify(v ?? null)
