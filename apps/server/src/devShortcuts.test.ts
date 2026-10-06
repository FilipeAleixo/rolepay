import { parseConfig } from '@payrun/core'
import { describe, expect, it } from 'vitest'
import { requireDevShortcuts } from './devShortcuts.js'

const MASTER = 'ab'.repeat(32)

describe('requireDevShortcuts (pnpm dev:treasury, pnpm dev:authorize-key)', () => {
  it('refuses unless PAYRUN_DEV_SHORTCUTS=true', () => {
    expect(() => requireDevShortcuts(parseConfig({ PAYRUN_MASTER_KEY: MASTER }), 'dev:authorize-key')).toThrow(/dev:authorize-key.*PAYRUN_DEV_SHORTCUTS=true/)
  })

  it('refuses any network but the Moderato testnet, whatever the flag says', () => {
    const mainnet = parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_NETWORK: 'mainnet', PAYRUN_ALLOW_MAINNET: 'true' })
    expect(() => requireDevShortcuts({ ...mainnet, devShortcuts: true }, 'dev:authorize-key')).toThrow(/testnet only/)
  })

  it('allows the Moderato testnet with the flag on', () => {
    expect(() => requireDevShortcuts(parseConfig({ PAYRUN_MASTER_KEY: MASTER, PAYRUN_DEV_SHORTCUTS: 'true' }), 'dev:authorize-key')).not.toThrow()
  })
})
