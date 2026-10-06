import type { Clock, Payrun } from '@payrun/core'
import {
  type DiscordRest,
  InProcessExecutionQueue,
  type MemberDirectory,
  RestMemberDirectory,
  createDiscordInteractions,
  createRunExecutor,
} from '@payrun/discord'
import { Hono } from 'hono'
import type { ServerConfig } from './config.js'
import { devClaimRoutes } from './devClaim.js'
import { startRecovery } from './recovery.js'

export type Log = (event: string, fields?: Record<string, unknown>) => void

export type ServerDeps = {
  config: ServerConfig
  payrun: Payrun
  rest: DiscordRest
  clock: Clock
  members?: MemberDirectory
  sleep?: (ms: number) => Promise<void>
  log?: Log
}

/**
 * Wires the HTTP app over the core services and the Discord adapter. Shared by main.ts
 * (production adapters) and the tests (in-memory adapters, fake Discord), so the tests
 * exercise the real wiring.
 */
export function composeServer(deps: ServerDeps) {
  const log: Log = deps.log ?? ((event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })))
  const errorFields = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { config, payrun, rest } = deps

  const queue = new InProcessExecutionQueue(
    createRunExecutor({
      payrun,
      rest,
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
      clock: deps.clock,
      config: config.app,
      onError: (error) => log('interaction_error', errorFields(error)),
    },
    waitUntil,
  })

  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true, network: config.core.network, jobsInFlight: queue.size }))
  app.post('/discord/interactions', (c) => interactions(c.req.raw))
  if (config.devClaim) app.route('/', devClaimRoutes(payrun.payees))

  return {
    app,
    queue,
    /** Starts the crash-recovery sweep (on start, then every interval). */
    startRecovery: () =>
      startRecovery({
        recover: () => payrun.payRuns.recoverInFlight(),
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
