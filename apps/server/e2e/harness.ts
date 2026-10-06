// The real server in this process, on http://localhost:<port>: production adapters (SQLite in a
// temp dir, Tempo on Moderato, AES vault), real passkeys (Accounts SDK Handler.webAuthn, rpId
// localhost) and the real client bundle. Only Discord is fake. Testnet only.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { type CDPSession, type Page } from '@playwright/test'
import { NETWORKS, createPayrun } from '@payrun/core'
import { createTestnetTools, openPayrunAdapters } from '@payrun/core/adapters'
import { FakeDiscordRest } from '@payrun/discord/testing'
import { bundledAssets, createPasskeys } from '@payrun/web'
import { generatePrivateKey } from 'viem/accounts'
import { composeServer } from '../src/compose.js'
import { parseServerConfig } from '../src/config.js'

export const NET = NETWORKS.moderato

export async function startServer(port: number) {
  const dir = mkdtempSync(join(tmpdir(), 'payrun-e2e-'))
  const config = parseServerConfig({
    PAYRUN_NETWORK: 'moderato',
    PAYRUN_MASTER_KEY: generatePrivateKey().slice(2),
    PAYRUN_DB_PATH: join(dir, 'payrun.db'),
    DISCORD_APP_ID: '500000000000000001',
    DISCORD_PUBLIC_KEY: 'cd'.repeat(32),
    DISCORD_BOT_TOKEN: 'fake-bot-token',
    PUBLIC_URL: `http://localhost:${port}`,
  })
  const testnet = createTestnetTools({ rpcUrl: config.core.rpcUrl })
  if ((await testnet.chainId()) !== 42431) throw new Error('e2e refuses any chain but Moderato')
  const { deps, kv, close } = await openPayrunAdapters(config.core)
  const payrun = createPayrun(deps)
  const passkeys = createPasskeys({ kv, origin: config.web.origin, rpId: config.web.rpId })
  const composed = composeServer({
    config,
    payrun,
    rest: new FakeDiscordRest(),
    clock: deps.clock,
    kv,
    web: { sessions: passkeys.sessions, passkeys: passkeys.handler, assets: bundledAssets() },
    log: () => {},
  })
  const server = serve({ fetch: composed.app.fetch, hostname: 'localhost', port })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return {
    url: `http://localhost:${port}`,
    payrun,
    kv,
    testnet,
    async stop() {
      server.close()
      await close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Chromium's virtual authenticator: a platform passkey that always verifies the user. */
export async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; credentials: () => Promise<unknown[]> }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return { cdp, credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials }
}
