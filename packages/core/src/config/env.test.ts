import { describe, expect, it } from 'vitest'
import { parseConfig } from './env.js'

const MASTER = 'a'.repeat(64)

describe('parseConfig (operational settings from env)', () => {
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

  it('rejects unknown networks', () => {
    expect(() => parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'sepolia' })).toThrow(/PAYRUN_NETWORK/)
  })
})
