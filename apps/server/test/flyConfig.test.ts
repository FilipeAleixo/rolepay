// The Fly configs as shipped: their [env] blocks, with stand-in secrets, must parse into the server
// each one is meant to be. The mainnet app is checked hardest: real money runs on it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAINNET_TOKENS } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { parseServerConfig } from '../src/config.js'
import { REPO_ROOT } from '../src/env.js'

/**
 * A Fly config's tables: `key = value` lines (raw values, comments dropped) under each `[table]`
 * or `[[table]]` header; '' is the top level. Enough TOML for these flat files.
 */
function flyTables(file: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>([['', new Map()]])
  let current = tables.get('') as Map<string, string>
  for (const raw of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line)
    if (header) {
      current = new Map()
      tables.set(header[1] as string, current)
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line)
    if (kv) current.set(kv[1] as string, kv[2] as string)
  }
  return tables
}

/** The `[env]` table as the environment the server reads (string values unquoted). */
const flyEnv = (file: string): Record<string, string> =>
  Object.fromEntries([...(flyTables(file).get('env') ?? new Map<string, string>())].map(([k, v]) => [k, v.replace(/^"(.*)"$/, '$1')]))

/** Stand-ins for what `fly secrets` holds. Never real values. */
const SECRETS = {
  ROLEPAY_MASTER_KEY: 'ab'.repeat(32),
  DISCORD_APP_ID: '500000000000000001',
  DISCORD_PUBLIC_KEY: 'cd'.repeat(32),
  DISCORD_BOT_TOKEN: 'stand-in-bot-token',
}

describe('fly.app.toml (the mainnet app, https://app.rolepay.app)', () => {
  const env = flyEnv('fly.app.toml')
  const config = () => parseServerConfig({ ...SECRETS, ...env })

  it('parses into a mainnet server: USDC.e payouts, fees from a pathUSD fee budget, its own passkey domain', () => {
    const c = config()
    expect(c.core).toMatchObject({ network: 'mainnet', chainId: 4217, rpcUrl: 'https://rpc.tempo.xyz', sponsorUrl: null, dbPath: '/data/rolepay.db' })
    expect(c.app).toMatchObject({ defaultPayoutToken: MAINNET_TOKENS.usdc_e, defaultFeeToken: MAINNET_TOKENS.path_usd, sponsor: false })
    expect(c.web).toMatchObject({ origin: 'https://app.rolepay.app', rpId: 'app.rolepay.app', explorerUrl: 'https://explore.tempo.xyz' })
    expect(c.http).toEqual({ host: '0.0.0.0', port: 8787, clientIpHeader: 'fly-client-ip' })
  })

  it('has no testnet controls: no dev shortcuts, no demo controls, veto windows of an hour at least', () => {
    const c = config()
    expect([c.core.devShortcuts, c.core.demoControls, c.app.devShortcuts, c.app.demoControls, c.app.authorizeHint]).toEqual([false, false, false, false, null])
    expect(c.policies.minVetoMinutes).toBe(60)
    expect(env.ROLEPAY_DEMO_CONTROLS ?? 'false').toBe('false')
    expect(env.ROLEPAY_DEV_SHORTCUTS ?? 'false').toBe('false')
  })

  it('caps AI calls per day and suggests a small bot key for a small pilot treasury', () => {
    const c = config()
    expect(env.ROLEPAY_AI_DAILY_CAP).toBeDefined()
    expect(c.core.ai.dailyCap).toBeLessThanOrEqual(50)
    expect(c.web.botKeyDefaults.limit).toBeLessThanOrEqual(50_000_000n)
    expect(c.web.botKeyDefaults.validitySeconds).toBeLessThanOrEqual(30 * 86_400)
    expect(c.web.botKeyDefaults.feeBudget).toBeLessThanOrEqual(1_000_000n)
  })

  it('holds no secret: those are fly secrets', () => {
    for (const name of ['ROLEPAY_MASTER_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APP_ID', 'ANTHROPIC_API_KEY', 'ROLEPAY_DISCORD_CLIENT_SECRET']) {
      expect(env[name]).toBeUndefined()
    }
  })

  it('one always-on machine with 512 MB next to Discord (iad, as the demo), the database on a volume at /data, a health check', () => {
    const t = flyTables('fly.app.toml')
    const get = (table: string, key: string) => t.get(table)?.get(key)
    expect([get('', 'app'), get('', 'primary_region')]).toEqual(['"rolepay-app"', '"iad"'])
    expect(get('', 'primary_region')).toBe(flyTables('fly.demo.toml').get('')?.get('primary_region'))
    expect([get('mounts', 'source'), get('mounts', 'destination')]).toEqual(['"rolepay_app_data"', '"/data"'])
    expect([get('http_service', 'force_https'), get('http_service', 'auto_stop_machines'), get('http_service', 'min_machines_running')]).toEqual(['true', '"off"', '1'])
    expect([get('http_service.checks', 'method'), get('http_service.checks', 'path')]).toEqual(['"GET"', '"/health"'])
    expect(get('vm', 'memory')).toBe('"512mb"')
  })
})

describe('fly.demo.toml (the testnet demo, https://demo.rolepay.app)', () => {
  it('parses into a Moderato server with the demo controls and without the dev shortcuts, on a passkey domain of its own', () => {
    const c = parseServerConfig({ ...SECRETS, ...flyEnv('fly.demo.toml') })
    expect(c.core).toMatchObject({ network: 'moderato', demoControls: true, devShortcuts: false })
    expect(c.web).toMatchObject({ origin: 'https://demo.rolepay.app', rpId: 'demo.rolepay.app' })
  })

  it('ticks the policy scheduler every 10 seconds, so a one-minute veto window pays soon after it ends; the default stays 30', () => {
    expect(parseServerConfig({ ...SECRETS, ...flyEnv('fly.demo.toml') }).policies.schedulerIntervalMs).toBe(10_000)
    // The mainnet app keeps the default.
    expect(flyEnv('fly.app.toml').ROLEPAY_SCHEDULER_INTERVAL_SECONDS).toBeUndefined()
    expect(parseServerConfig({ ...SECRETS, ...flyEnv('fly.app.toml') }).policies.schedulerIntervalMs).toBe(30_000)
  })
})
