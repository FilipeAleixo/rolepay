// The real server in this process, on http://localhost:<port>: production adapters (SQLite in a
// temp dir, Tempo on Moderato, AES vault), real passkeys (Accounts SDK Handler.webAuthn, rpId
// localhost) and the real client bundle. Only Discord is fake. Testnet only.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { type CDPSession, type Page } from '@playwright/test'
import { NETWORKS, createRolepay } from '@rolepay/core'
import { createTestnetTools, openRolepayAdapters } from '@rolepay/core/adapters'
import { FakeDiscordRest } from '@rolepay/discord/testing'
import { bundledAssets, createPasskeys } from '@rolepay/web'
import { generatePrivateKey } from 'viem/accounts'
import { composeServer } from '../src/compose.js'
import { parseServerConfig } from '../src/config.js'

export const NET = NETWORKS.moderato

/** `env` adds settings, for example `ROLEPAY_SPONSOR_URL: 'none'` to rehearse mainnet's unsponsored path on Moderato. */
export async function startServer(port: number, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rolepay-e2e-'))
  const config = parseServerConfig({
    ROLEPAY_NETWORK: 'moderato',
    ROLEPAY_MASTER_KEY: generatePrivateKey().slice(2),
    ROLEPAY_DB_PATH: join(dir, 'rolepay.db'),
    DISCORD_APP_ID: '500000000000000001',
    DISCORD_PUBLIC_KEY: 'cd'.repeat(32),
    DISCORD_BOT_TOKEN: 'fake-bot-token',
    PUBLIC_URL: `http://localhost:${port}`,
    ...env,
  })
  const testnet = createTestnetTools({ rpcUrl: config.core.rpcUrl })
  if ((await testnet.chainId()) !== 42431) throw new Error('e2e refuses any chain but Moderato')
  const { deps, kv, close } = await openRolepayAdapters(config.core)
  const rolepay = createRolepay(deps)
  const passkeys = createPasskeys({ kv, origin: config.web.origin, rpId: config.web.rpId })
  const composed = composeServer({
    config,
    rolepay,
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
    rolepay,
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

type Prompts = { create: number; get: number }

/**
 * Counts the passkey prompts a person would see: every navigator.credentials.create (a new
 * passkey) and .get (a sign-in or a signature). Counts restart on every page load.
 */
export async function passkeyPrompts(page: Page): Promise<() => Promise<Prompts>> {
  await page.addInitScript(() => {
    const counts = { create: 0, get: 0 }
    const c = navigator.credentials
    const create = c.create.bind(c)
    const get = c.get.bind(c)
    c.create = (o) => (counts.create++, create(o))
    c.get = (o) => (counts.get++, get(o))
    ;(globalThis as unknown as { __passkeyPrompts: Prompts }).__passkeyPrompts = counts
  })
  return () => page.evaluate(() => ({ ...(globalThis as unknown as { __passkeyPrompts: Prompts }).__passkeyPrompts }))
}
