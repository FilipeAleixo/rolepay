import { describe, expect, it } from 'vitest'
import { demoControlsEnabled, deprecatedEnvNames, devShortcutsEnabled, parseConfig, withDeprecatedEnvNames } from './env.js'

const MASTER = 'a'.repeat(64)

describe('parseConfig (operational settings from env)', () => {
  it('AI proposals: no model without ANTHROPIC_API_KEY (blank counts as unset); Opus 5.5 by default', () => {
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER }).ai).toEqual({ apiKey: null, model: 'claude-opus-5-5', dailyCap: 50 })
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ANTHROPIC_API_KEY: '  ' }).ai.apiKey).toBeNull()
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ANTHROPIC_API_KEY: 'sk-ant-SECRET', ROLEPAY_AI_MODEL: 'claude-sonnet-5-5' }).ai).toEqual({
      apiKey: 'sk-ant-SECRET',
      model: 'claude-sonnet-5-5',
      dailyCap: 50,
    })
  })

  it('AI proposals: at most ROLEPAY_AI_DAILY_CAP model calls per UTC day on this server (default 50, a positive whole number)', () => {
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_AI_DAILY_CAP: '10' }).ai.dailyCap).toBe(10)
    for (const bad of ['0', '-1', '2.5', 'many']) expect(() => parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_AI_DAILY_CAP: bad })).toThrow(/ROLEPAY_AI_DAILY_CAP/)
  })

  it('refuses a malformed model name without echoing the key', () => {
    try {
      parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ANTHROPIC_API_KEY: 'sk-ant-SECRET', ROLEPAY_AI_MODEL: 'opus please' })
      expect.unreachable()
    } catch (e) {
      expect(String(e)).toMatch(/ROLEPAY_AI_MODEL/)
      expect(String(e)).not.toContain('SECRET')
    }
  })

  it('defaults to the Moderato testnet with its public sponsor', () => {
    const c = parseConfig({ ROLEPAY_MASTER_KEY: MASTER })
    expect(c).toMatchObject({
      network: 'moderato',
      chainId: 42431,
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      dbPath: './rolepay.db',
      linkTtlSeconds: 1800,
    })
    expect(c.masterKey).toBe(MASTER)
  })

  it('allows RPC and sponsor overrides', () => {
    const c = parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_RPC_URL: 'http://localhost:8545', ROLEPAY_SPONSOR_URL: 'http://localhost:3000' })
    expect(c).toMatchObject({ rpcUrl: 'http://localhost:8545', sponsorUrl: 'http://localhost:3000' })
  })

  it('refuses mainnet unless explicitly allowed', () => {
    expect(() => parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_NETWORK: 'mainnet' })).toThrow(/ROLEPAY_ALLOW_MAINNET/)
    const c = parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_NETWORK: 'mainnet', ROLEPAY_ALLOW_MAINNET: 'true' })
    expect(c).toMatchObject({ network: 'mainnet', chainId: 4217, sponsorUrl: null })
  })

  it('requires a 32-byte hex master key and never echoes secret values in errors', () => {
    expect(() => parseConfig({})).toThrow(/ROLEPAY_MASTER_KEY/)
    try {
      parseConfig({ ROLEPAY_MASTER_KEY: 'not-a-key-SECRETVALUE' })
      expect.unreachable()
    } catch (e) {
      expect(String(e)).toMatch(/ROLEPAY_MASTER_KEY/)
      expect(String(e)).not.toContain('SECRETVALUE')
    }
  })

  it('dev shortcuts are off unless ROLEPAY_DEV_SHORTCUTS=true, and only exist on the Moderato testnet', () => {
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER }).devShortcuts).toBe(false)
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEV_SHORTCUTS: 'false' }).devShortcuts).toBe(false)
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEV_SHORTCUTS: 'true' }).devShortcuts).toBe(true)
    const mainnet = { ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_NETWORK: 'mainnet', ROLEPAY_ALLOW_MAINNET: 'true' }
    expect(parseConfig(mainnet).devShortcuts).toBe(false)
    expect(() => parseConfig({ ...mainnet, ROLEPAY_DEV_SHORTCUTS: 'true' })).toThrow(/ROLEPAY_DEV_SHORTCUTS.*testnet/)
    expect(() => parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEV_SHORTCUTS: 'yes' })).toThrow(/ROLEPAY_DEV_SHORTCUTS/)
  })

  it('devShortcutsEnabled reads only the network and the flag (for scripts that run before the rest is configured)', () => {
    expect(devShortcutsEnabled({})).toBe(false)
    expect(devShortcutsEnabled({ ROLEPAY_DEV_SHORTCUTS: 'true' })).toBe(true)
    expect(devShortcutsEnabled({ ROLEPAY_DEV_SHORTCUTS: 'true', ROLEPAY_NETWORK: 'moderato' })).toBe(true)
    expect(() => devShortcutsEnabled({ ROLEPAY_DEV_SHORTCUTS: 'true', ROLEPAY_NETWORK: 'mainnet' })).toThrow(/testnet/)
  })

  it('demo controls are off unless ROLEPAY_DEMO_CONTROLS=true, only exist on the Moderato testnet, and are separate from the dev shortcuts', () => {
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER }).demoControls).toBe(false)
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEMO_CONTROLS: 'false' }).demoControls).toBe(false)
    const demo = parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEMO_CONTROLS: 'true' })
    expect([demo.demoControls, demo.devShortcuts]).toEqual([true, false])
    const dev = parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEV_SHORTCUTS: 'true' })
    expect([dev.demoControls, dev.devShortcuts]).toEqual([false, true])
    const mainnet = { ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_NETWORK: 'mainnet', ROLEPAY_ALLOW_MAINNET: 'true' }
    expect(parseConfig(mainnet).demoControls).toBe(false)
    expect(() => parseConfig({ ...mainnet, ROLEPAY_DEMO_CONTROLS: 'true' })).toThrow(/ROLEPAY_DEMO_CONTROLS.*testnet/)
    expect(() => parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEMO_CONTROLS: 'yes' })).toThrow(/ROLEPAY_DEMO_CONTROLS/)
  })

  it('demoControlsEnabled reads only the network and the flag (for registering commands before the rest is configured)', () => {
    expect(demoControlsEnabled({})).toBe(false)
    expect(demoControlsEnabled({ ROLEPAY_DEMO_CONTROLS: 'true' })).toBe(true)
    expect(demoControlsEnabled({ ROLEPAY_DEV_SHORTCUTS: 'true' })).toBe(false)
    expect(() => demoControlsEnabled({ ROLEPAY_DEMO_CONTROLS: 'true', ROLEPAY_NETWORK: 'mainnet' })).toThrow(/testnet/)
  })

  it('rejects unknown networks', () => {
    expect(() => parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_NETWORK: 'sepolia' })).toThrow(/ROLEPAY_NETWORK/)
  })
})

describe('the deprecated PAYRUN_* names (from before the rename to Rolepay)', () => {
  it('are read as their ROLEPAY_* names, so an existing .env keeps working without edits', () => {
    const c = parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_DB_PATH: './payrun.db', PAYRUN_AI_MODEL: 'claude-sonnet-5-5' })
    expect(c).toMatchObject({ masterKey: MASTER, dbPath: './payrun.db', ai: { model: 'claude-sonnet-5-5' } })
    expect(() => parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'mainnet' })).toThrow(/ROLEPAY_ALLOW_MAINNET/)
    expect(devShortcutsEnabled({ PAYRUN_DEV_SHORTCUTS: 'true' })).toBe(true)
  })

  it('lose to the ROLEPAY_* name when both are set; a blank ROLEPAY_* line counts as unset', () => {
    const env = withDeprecatedEnvNames({ ROLEPAY_NETWORK: 'moderato', PAYRUN_NETWORK: 'mainnet', ROLEPAY_DB_PATH: '', PAYRUN_DB_PATH: './old.db', HOST: 'x' })
    expect(env).toMatchObject({ ROLEPAY_NETWORK: 'moderato', ROLEPAY_DB_PATH: './old.db', HOST: 'x' })
    expect(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, PAYRUN_MASTER_KEY: 'b'.repeat(64) }).masterKey).toBe(MASTER)
  })

  it('never change the environment they are given', () => {
    const raw = { PAYRUN_MASTER_KEY: MASTER }
    withDeprecatedEnvNames(raw)
    expect(raw).toEqual({ PAYRUN_MASTER_KEY: MASTER })
  })

  it('in use are listed by name (never value) so the server can warn once at start', () => {
    expect(deprecatedEnvNames({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_DB_PATH: '', ROLEPAY_NETWORK: 'moderato', HOST: 'x' })).toEqual(['PAYRUN_MASTER_KEY'])
    expect(deprecatedEnvNames({ ROLEPAY_MASTER_KEY: MASTER })).toEqual([])
  })
})
