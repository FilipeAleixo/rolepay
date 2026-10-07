// The composition root: config from env, production adapters, core services, the
// Discord adapter, an HTTP server. The only place (with scripts/) that opens adapters.
import { serve } from '@hono/node-server'
import { createRolepay, deprecatedEnvNames } from '@rolepay/core'
import { openRolepayAdapters } from '@rolepay/core/adapters'
import { FetchDiscordRest, RestActivityReader } from '@rolepay/discord'
import { bundledAssets, createPasskeys } from '@rolepay/web'
import { composeServer } from './compose.js'
import { parseServerConfig } from './config.js'
import { loadEnvironment } from './env.js'

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))

async function main() {
  const env = loadEnvironment()
  // Names only, never values: the PAYRUN_* names from before the rename still work but are deprecated.
  const deprecated = deprecatedEnvNames(env)
  if (deprecated.length > 0) log('deprecated_env', { names: deprecated, hint: 'rename PAYRUN_* to ROLEPAY_* in .env' })
  const config = parseServerConfig(env)
  const { deps, kv, close } = await openRolepayAdapters(config.core)
  const rest = new FetchDiscordRest({ botToken: config.discord.botToken })
  // AI proposals read Discord through the bot's REST client; one log line per proposal (counts and cost, never text).
  const rolepay = createRolepay({ ...deps, activity: new RestActivityReader(rest), proposalLog: (entry) => log('proposal', entry) })
  const passkeys = createPasskeys({ kv, origin: config.web.origin, rpId: config.web.rpId })
  const web = { sessions: passkeys.sessions, passkeys: passkeys.handler, assets: bundledAssets() }
  const composed = composeServer({ config, rolepay, rest, clock: deps.clock, kv, web, log })
  const recovery = composed.startRecovery()

  const server = serve({ fetch: composed.app.fetch, hostname: config.http.host, port: config.http.port }, (info) => {
    log('listening', {
      url: `http://${config.http.host}:${info.port}`,
      interactions: '/discord/interactions',
      network: config.core.network,
      db: config.core.dbPath,
      publicUrl: config.web.origin,
      passkeyRpId: config.web.rpId,
      ai: config.core.ai.apiKey ? config.core.ai.model : 'off (no ANTHROPIC_API_KEY)',
      dashboard: config.dashboard.clientSecret ? `${config.web.origin}/dashboard` : 'sign-in off (no ROLEPAY_DISCORD_CLIENT_SECRET)',
    })
  })

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log('stopping', { signal })
    server.close()
    await recovery.stop()
    // Give payments in flight a moment; anything cut short is reconciled on the next start.
    await Promise.race([composed.drain(), new Promise((r) => setTimeout(r, 10_000))])
    await close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error)
  process.exit(1)
})
