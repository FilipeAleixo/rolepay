import type { Clock, KeyValueStore, Payrun } from '@rolepay/core'
import {
  type DiscordRest,
  InProcessExecutionQueue,
  KvInteractionLog,
  KvPendingSources,
  KvRunNotices,
  type MemberDirectory,
  RestMemberDirectory,
  createDiscordInteractions,
  createRecoveryNotifier,
  createRunExecutor,
} from '@rolepay/discord'
import { type Assets, type PasskeySessions, type RateLimiter, TokenBucketLimiter, createWebApp } from '@rolepay/web'
import { Hono } from 'hono'
import type { ServerConfig } from './config.js'
import { errorFields } from './logging.js'
import { startRecovery } from './recovery.js'

export type Log = (event: string, fields?: Record<string, unknown>) => void

export type ServerDeps = {
  config: ServerConfig
  payrun: Payrun
  rest: DiscordRest
  clock: Clock
  /** Small records that must survive a restart (where a run's message is, receipts sent). The SQLite file in production. */
  kv: KeyValueStore
  members?: MemberDirectory
  /** The claim and setup pages: passkey sessions, the WebAuthn endpoints (production) and the client bundle. */
  web: {
    sessions: PasskeySessions
    assets: Assets
    passkeys?: { fetch: (req: Request) => Response | Promise<Response> }
    /** Default: in-memory token buckets (`defaultRateLimits`). */
    rateLimits?: { perClient: RateLimiter; overall: RateLimiter }
  }
  sleep?: (ms: number) => Promise<void>
  log?: Log
}

/**
 * Budgets for the public page endpoints (/webauthn, /claim, /setup POSTs): a person clicking
 * through the pages uses a handful; a loop filling the database with challenge rows does not
 * get far. Per client a burst of 30 then one every 2 seconds; per endpoint group 300 then 5 a
 * second, whatever client the requests claim to come from.
 */
export const defaultRateLimits = () => ({
  perClient: new TokenBucketLimiter({ capacity: 30, refillPerSecond: 0.5 }),
  overall: new TokenBucketLimiter({ capacity: 300, refillPerSecond: 5 }),
})

/**
 * Wires the HTTP app over the core services and the Discord adapter. Shared by main.ts
 * (production adapters) and the tests (in-memory adapters, fake Discord), so the tests
 * exercise the real wiring.
 */
export function composeServer(deps: ServerDeps) {
  const log: Log = deps.log ?? ((event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { config, payrun, rest } = deps
  const notices = new KvRunNotices(deps.kv)

  const queue = new InProcessExecutionQueue(
    createRunExecutor({
      payrun,
      rest,
      notices,
      network: config.core.network,
      now: () => deps.clock.now(),
      sleep,
      onError: (error, job) => log('job_error', { runId: job.runId, ...errorFields(error) }),
    }),
    { onError: (error, job) => log('job_error', { runId: job.runId, ...errorFields(error) }) },
  )

  // Background work started by an interaction (deferred replies). Tracked for tests and shutdown.
  const background = new Set<Promise<unknown>>()
  const waitUntil = (work: Promise<unknown>) => {
    const tracked = work.finally(() => background.delete(tracked))
    background.add(tracked)
  }

  const interactions = createDiscordInteractions({
    publicKey: config.discord.publicKey,
    deps: {
      payrun,
      rest,
      queue,
      members: deps.members ?? new RestMemberDirectory(rest),
      // The message a "Propose pay run" command targeted, until its modal is submitted (15 minutes at most).
      pendingSources: new KvPendingSources(deps.kv),
      clock: deps.clock,
      config: config.app,
      onError: (error) => log('interaction_error', errorFields(error)),
    },
    waitUntil,
    interactionLog: new KvInteractionLog(deps.kv),
  })

  const notifyRecovered = createRecoveryNotifier({
    payrun,
    rest,
    notices,
    network: config.core.network,
    onError: (error) => log('recovery_notify_error', errorFields(error)),
  })

  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true, network: config.core.network, jobsInFlight: queue.size }))
  app.post('/discord/interactions', (c) => interactions(c.req.raw))
  app.route('/', createWebApp({ payrun, clock: deps.clock, config: config.web, ...deps.web, rateLimits: deps.web.rateLimits ?? defaultRateLimits() }))

  return {
    app,
    queue,
    /** Starts the crash-recovery sweep (on start, then every interval). */
    startRecovery: () =>
      startRecovery({
        // A run the sweep settles (typically after a restart) is reported in Discord as part of the sweep.
        recover: async () => {
          const results = await payrun.payRuns.recoverInFlight()
          await notifyRecovered(results)
          // Expired records (an abandoned proposal modal's message, old proposals) leave the disk too.
          await deps.kv.sweep().catch((error) => log('kv_sweep_error', errorFields(error)))
          return results
        },
        intervalMs: config.recoveryIntervalMs,
        onResult: (results) => log('recovery', { results }),
        onError: (error) => log('recovery_error', errorFields(error)),
      }),
    /** Resolves once deferred replies and queued payments have all finished. */
    async drain() {
      while (background.size || queue.size) {
        await Promise.all([...background])
        await queue.idle()
      }
    },
  }
}
