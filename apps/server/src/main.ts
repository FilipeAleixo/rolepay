// The composition root: config from env, production adapters, core services, the
// Discord adapter, an HTTP server. The only place (with scripts/) that opens adapters.
import { serve } from '@hono/node-server'
import { createPayrun } from '@payrun/core'
import { openPayrunAdapters } from '@payrun/core/adapters'
import { FetchDiscordRest } from '@payrun/discord'
import { bundledAssets, createPasskeys } from '@payrun/web'
import { composeServer } from './compose.js'
import { parseServerConfig } from './config.js'
import { loadEnvironment } from './env.js'

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))

async function main() {
  const config = parseServerConfig(loadEnvironment())
  const { deps, kv, close } = await openPayrunAdapters(config.core)
  const payrun = createPayrun(deps)
  const rest = new FetchDiscordRest({ botToken: config.discord.botToken })
  const passkeys = createPasskeys({ kv, origin: config.web.origin, rpId: config.web.rpId })
  const web = { sessions: passkeys.sessions, passkeys: passkeys.handler, assets: bundledAssets() }
  const composed = composeServer({ config, payrun, rest, clock: deps.clock, web, log })
  const recovery = composed.startRecovery()

  const server = serve({ fetch: composed.app.fetch, hostname: config.http.host, port: config.http.port }, (info) => {
    log('listening', {
      url: `http://${config.http.host}:${info.port}`,
      interactions: '/discord/interactions',
      network: config.core.network,
      db: config.core.dbPath,
      publicUrl: config.web.origin,
      passkeyRpId: config.web.rpId,
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
