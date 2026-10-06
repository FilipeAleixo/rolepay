import { describe, expect, it } from 'vitest'
import { devShortcutsEnabled, parseConfig } from './env.js'

const MASTER = 'a'.repeat(64)

describe('parseConfig (operational settings from env)', () => {
  it('AI proposals: no model without ANTHROPIC_API_KEY (blank counts as unset); Opus 5.5 by default', () => {
    expect(parseConfig({ PAYRUN_MASTER_KEY: MASTER }).ai).toEqual({ apiKey: null, model: 'claude-opus-5-5' })
    expect(parseConfig({ PAYRUN_MASTER_KEY: MASTER, ANTHROPIC_API_KEY: '  ' }).ai.apiKey).toBeNull()
    expect(parseConfig({ PAYRUN_MASTER_KEY: MASTER, ANTHROPIC_API_KEY: 'sk-ant-SECRET', PAYRUN_AI_MODEL: 'claude-sonnet-5-5' }).ai).toEqual({ apiKey: 'sk-ant-SECRET', model: 'claude-sonnet-5-5' })
  })

  it('refuses a malformed model name without echoing the key', () => {
    try {
      parseConfig({ PAYRUN_MASTER_KEY: MASTER, ANTHROPIC_API_KEY: 'sk-ant-SECRET', PAYRUN_AI_MODEL: 'opus please' })
      expect.unreachable()
    } catch (e) {
      expect(String(e)).toMatch(/PAYRUN_AI_MODEL/)
      expect(String(e)).not.toContain('SECRET')
    }
  })

  it('defaults to the Moderato testnet with its public sponsor', () => {
    const c = parseConfig({ PAYRUN_MASTER_KEY: MASTER })
    expect(c).toMatchObject({
      network: 'moderato',
      chainId: 42431,
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      dbPath: './payrun.db',
      linkTtlSeconds: 1800,
    })
    expect(c.masterKey).toBe(MASTER)
  })

  it('allows RPC and sponsor overrides', () => {
    const c = parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_RPC_URL: 'http://localhost:8545', PAYRUN_SPONSOR_URL: 'http://localhost:3000' })
    expect(c).toMatchObject({ rpcUrl: 'http://localhost:8545', sponsorUrl: 'http://localhost:3000' })
  })

  it('refuses mainnet unless explicitly allowed', () => {
    expect(() => parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'mainnet' })).toThrow(/PAYRUN_ALLOW_MAINNET/)
    const c = parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'mainnet', PAYRUN_ALLOW_MAINNET: 'true' })
    expect(c).toMatchObject({ network: 'mainnet', chainId: 4217, sponsorUrl: null })
  })

  it('requires a 32-byte hex master key and never echoes secret values in errors', () => {
    expect(() => parseConfig({})).toThrow(/PAYRUN_MASTER_KEY/)
    try {
      parseConfig({ PAYRUN_MASTER_KEY: 'not-a-key-SECRETVALUE' })
      expect.unreachable()
    } catch (e) {
      expect(String(e)).toMatch(/PAYRUN_MASTER_KEY/)
      expect(String(e)).not.toContain('SECRETVALUE')
    }
  })

  it('dev shortcuts are off unless PAYRUN_DEV_SHORTCUTS=true, and only exist on the Moderato testnet', () => {
    expect(parseConfig({ PAYRUN_MASTER_KEY: MASTER }).devShortcuts).toBe(false)
    expect(parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_DEV_SHORTCUTS: 'false' }).devShortcuts).toBe(false)
    expect(parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_DEV_SHORTCUTS: 'true' }).devShortcuts).toBe(true)
    const mainnet = { PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'mainnet', PAYRUN_ALLOW_MAINNET: 'true' }
    expect(parseConfig(mainnet).devShortcuts).toBe(false)
    expect(() => parseConfig({ ...mainnet, PAYRUN_DEV_SHORTCUTS: 'true' })).toThrow(/PAYRUN_DEV_SHORTCUTS.*testnet/)
    expect(() => parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_DEV_SHORTCUTS: 'yes' })).toThrow(/PAYRUN_DEV_SHORTCUTS/)
  })

  it('devShortcutsEnabled reads only the network and the flag (for scripts that run before the rest is configured)', () => {
    expect(devShortcutsEnabled({})).toBe(false)
    expect(devShortcutsEnabled({ PAYRUN_DEV_SHORTCUTS: 'true' })).toBe(true)
    expect(devShortcutsEnabled({ PAYRUN_DEV_SHORTCUTS: 'true', PAYRUN_NETWORK: 'moderato' })).toBe(true)
    expect(() => devShortcutsEnabled({ PAYRUN_DEV_SHORTCUTS: 'true', PAYRUN_NETWORK: 'mainnet' })).toThrow(/testnet/)
  })

  it('rejects unknown networks', () => {
    expect(() => parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'sepolia' })).toThrow(/PAYRUN_NETWORK/)
  })
})
