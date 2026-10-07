import type { Clock, KeyValueStore, Rolepay, SchedulerEvent } from '@rolepay/core'
import {
  type DiscordRest,
  InProcessExecutionQueue,
  KvInteractionLog,
  KvPendingSources,
  KvRunNotices,
  type MemberDirectory,
  RestMemberDirectory,
  createDiscordInteractions,
  createPolicyNotifier,
  createRecoveryNotifier,
  createRunExecutor,
} from '@rolepay/discord'
import { type Assets, type PasskeySessions, type PolicyPort, type RateLimiter, TokenBucketLimiter, createWebApp } from '@rolepay/web'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ServerConfig } from './config.js'
import { type DashboardOverrides, dashboardDeps } from './dashboard.js'
import { errorFields } from './logging.js'
import { startRecovery } from './recovery.js'
import { startScheduler } from './scheduler.js'

export type Log = (event: string, fields?: Record<string, unknown>) => void

/** The largest request body the server reads (1 MB). */
export const MAX_BODY_BYTES = 1024 * 1024

export type ServerDeps = {
  config: ServerConfig
  rolepay: Rolepay
  rest: DiscordRest
  clock: Clock
  /** Small records that must survive a restart (where a run's message is, receipts sent). The SQLite file in production. */
  kv: KeyValueStore
  members?: MemberDirectory
  /** The web pages: passkey sessions, the WebAuthn endpoints (production), the client bundle and the dashboard. */
  web: {
    sessions: PasskeySessions
    assets: Assets
    passkeys?: { fetch: (req: Request) => Response | Promise<Response> }
    /** Default: in-memory token buckets (`defaultRateLimits`). */
    rateLimits?: { perClient: RateLimiter; overall: RateLimiter }
    /** The dashboard's OAuth, member view and the policy seam (`dashboard.ts`); defaults from config and the bot's REST client. */
    dashboard?: DashboardOverrides
  }
  sleep?: (ms: number) => Promise<void>
  log?: Log
}

/**
 * Budgets for the public page endpoints (POSTs to /webauthn, /claim, /setup and /dashboard, and
 * every request under /auth/: `rateLimitGroup` in @rolepay/web): a person clicking through the
 * pages uses a handful; a loop filling the database with challenge rows does not
 * get far. Per client a burst of 30 then one every 2 seconds; per endpoint group 300 then 5 a
 * second, whatever client the requests claim to come from.
 */
export const defaultRateLimits = () => ({
  perClient: new TokenBucketLimiter({ capacity: 30, refillPerSecond: 0.5 }),
  overall: new TokenBucketLimiter({ capacity: 300, refillPerSecond: 5 }),
})

/**
 * The dashboard's policy port, with each successful veto announced in Discord: the run's message
 * (posted with "pays at ... unless vetoed" and a Veto button) turns into "Vetoed by". A run that
 * was not made by a core policy (another port) is left alone.
 */
export function vetoesAnnounced(port: PolicyPort, rolepay: Rolepay, announce: (events: SchedulerEvent[]) => Promise<void>): PolicyPort {
  return {
    list: (i) => port.list(i),
    get: (i) => port.get(i),
    preview: (i) => port.preview(i),
    versions: (i) => port.versions(i),
    upcoming: (i) => port.upcoming(i),
    runOrigins: (i) => port.runOrigins(i),
    create: (i) => port.create(i),
    edit: (i) => port.edit(i),
    approve: (i) => port.approve(i),
    discard: (i) => port.discard(i),
    pause: (i) => port.pause(i),
    resume: (i) => port.resume(i),
    archive: (i) => port.archive(i),
    setMode: (i) => port.setMode(i),
    async veto(input) {
      const r = await port.veto(input)
      if (!r.ok) return r
      const found = await rolepay.policies.runFor({ guildId: input.guildId, runId: input.runId })
      if (found) {
        const run = await rolepay.payRuns.get({ guildId: input.guildId, runId: input.runId })
        await announce([{ kind: 'cancelled', policy: found.policy, policyRun: found.policyRun, run: run.ok ? run.value : null }])
      }
      return r
    },
  }
}

/**
 * Wires the HTTP app over the core services and the Discord adapter. Shared by main.ts
 * (production adapters) and the tests (in-memory adapters, fake Discord), so the tests
 * exercise the real wiring.
 */
export function composeServer(deps: ServerDeps) {
  const log: Log = deps.log ?? ((event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { config, rolepay, rest } = deps
  const notices = new KvRunNotices(deps.kv)
  // Every receipt links the payee's account page on this server, where they see and move the money.
  const accountUrl = `${config.web.origin}/account`

  const queue = new InProcessExecutionQueue(
    createRunExecutor({
      rolepay,
      rest,
      notices,
      network: config.core.network,
      accountUrl,
      now: () => deps.clock.now(),
      sleep,
      onError: (error, job) => log('job_error', { runId: job.runId, ...errorFields(error) }),
      // One line per payment job: how it ended, ms in all, split into paying (chain, database) and Discord.
      onDone: (report) => log('job', report),
    }),
    { onError: (error, job) => log('job_error', { runId: job.runId, ...errorFields(error) }) },
  )

  // Tells each policy's channel what the scheduler did (and edits those messages later), sharing
  // the run message records with the executor and the recovery sweep.
  const policyNotifier = createPolicyNotifier({ rolepay, rest, notices, network: config.core.network, accountUrl, onError: (error) => log('policy_notify_error', errorFields(error)) })
  /** One scheduler pass and its announcement: what the interval runs (and the tests call). */
  const tickPolicies = async () => {
    const report = await rolepay.scheduler.tick()
    await policyNotifier.announce(report.events)
    return report
  }

  // Background work started by an interaction (deferred replies). Tracked for tests and shutdown.
  const background = new Set<Promise<unknown>>()
  const waitUntil = (work: Promise<unknown>) => {
    const tracked = work.finally(() => background.delete(tracked))
    background.add(tracked)
  }

  const interactions = createDiscordInteractions({
    publicKey: config.discord.publicKey,
    deps: {
      rolepay,
      rest,
      queue,
      members: deps.members ?? new RestMemberDirectory(rest),
      // The message a "Propose pay run" command targeted, until its modal is submitted (15 minutes at most).
      pendingSources: new KvPendingSources(deps.kv),
      clock: deps.clock,
      config: config.app,
      announcer: policyNotifier,
      onError: (error) => log('interaction_error', errorFields(error)),
    },
    waitUntil,
    interactionLog: new KvInteractionLog(deps.kv),
    // One line per request: kind, command or button name, ms until the response, its type, ok (never options or text).
    onResponse: (timing) => log('interaction', timing),
    // One line per deferred reply or late answer as it ends: ms after the response, per phase (Discord, database...).
    onBackground: (timing) => log('deferred', timing),
  })

  const notifyRecovered = createRecoveryNotifier({
    rolepay,
    rest,
    notices,
    network: config.core.network,
    accountUrl,
    onError: (error) => log('recovery_notify_error', errorFields(error)),
  })

  const app = new Hono()
  // No request needs more than a few kilobytes (a Discord interaction with a long message, a passkey
  // ceremony); a bigger body is refused before anything reads it, counted as it arrives when it has
  // no Content-Length, so one request cannot exhaust a 512 MB machine.
  app.use(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ ok: false, error: { code: 'body_too_large' } }, 413) }))
  app.get('/health', (c) => c.json({ ok: true, network: config.core.network, jobsInFlight: queue.size }))
  app.post('/discord/interactions', (c) => interactions(c.req.raw))
  // Behind Fly the client is Fly-Client-IP, which Fly's proxy sets (ROLEPAY_CLIENT_IP_HEADER);
  // otherwise the web layer takes the last X-Forwarded-For hop (the one the tunnel appended).
  const header = config.http.clientIpHeader
  const clientKey = header ? { clientKey: (req: Request) => req.headers.get(header)?.trim() || 'direct' } : {}
  const rateLimits = { ...(deps.web.rateLimits ?? defaultRateLimits()), ...clientKey }
  const { dashboard: given, ...web } = deps.web
  // A veto on the dashboard updates the run's message in Discord too, as the Veto button does there.
  const overrides = given?.policies ? { ...given, policies: vetoesAnnounced(given.policies, rolepay, (events) => policyNotifier.announce(events)) } : given
  const dashboard = dashboardDeps({ config, rest, kv: deps.kv, ...(overrides ? { overrides } : {}), onError: (error) => log('dashboard_error', errorFields(error)) })
  app.route('/', createWebApp({ rolepay, clock: deps.clock, config: config.web, ...web, rateLimits, dashboard }))

  return {
    app,
    queue,
    /** Starts the crash-recovery sweep (on start, then every interval). */
    startRecovery: () =>
      startRecovery({
        // A run the sweep settles (typically after a restart) is reported in Discord as part of the sweep.
        recover: async () => {
          // A run with a job in this process (paying, or waiting between checks) is the job's to finish and report.
          const results = await rolepay.payRuns.recoverInFlight({ skip: (run) => queue.isBusy(run.guildId, run.runId) })
          await notifyRecovered(results)
          // Expired records (an abandoned proposal modal's message, old proposals) leave the disk too.
          await deps.kv.sweep().catch((error) => log('kv_sweep_error', errorFields(error)))
          return results
        },
        intervalMs: config.recoveryIntervalMs,
        onResult: (results) => log('recovery', { results }),
        onError: (error) => log('recovery_error', errorFields(error)),
      }),
    /** One policy scheduler pass, announced in Discord. */
    tickPolicies,
    /**
     * Starts the policy scheduler (on start, then every interval, never two ticks at once): makes
     * due runs and releases autopilot runs whose veto window passed, with code only.
     */
    startScheduler: () =>
      startScheduler({
        tick: () => rolepay.scheduler.tick(),
        announce: (events) => policyNotifier.announce(events),
        intervalMs: config.policies.schedulerIntervalMs,
        // Counts and codes only: the events carry no user text worth logging.
        onReport: (report) =>
          log('policies', {
            events: report.events.map((e) => ({ kind: e.kind, policyId: e.policy.id, policyRunId: e.policyRun.id, status: e.policyRun.status, hold: e.policyRun.hold?.code ?? null })),
            errors: report.errors,
          }),
        onError: (error) => log('policies_error', errorFields(error)),
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
