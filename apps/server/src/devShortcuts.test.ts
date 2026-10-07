import { parseConfig } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { requireDevShortcuts } from './devShortcuts.js'

const MASTER = 'ab'.repeat(32)

describe('requireDevShortcuts (pnpm dev:treasury, pnpm dev:authorize-key)', () => {
  it('refuses unless ROLEPAY_DEV_SHORTCUTS=true', () => {
    expect(() => requireDevShortcuts(parseConfig({ ROLEPAY_MASTER_KEY: MASTER }), 'dev:authorize-key')).toThrow(/dev:authorize-key.*ROLEPAY_DEV_SHORTCUTS=true/)
  })

  it('refuses any network but the Moderato testnet, whatever the flag says', () => {
    const mainnet = parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_NETWORK: 'mainnet', ROLEPAY_ALLOW_MAINNET: 'true' })
    expect(() => requireDevShortcuts({ ...mainnet, devShortcuts: true }, 'dev:authorize-key')).toThrow(/testnet only/)
  })

  it('allows the Moderato testnet with the flag on', () => {
    expect(() => requireDevShortcuts(parseConfig({ ROLEPAY_MASTER_KEY: MASTER, ROLEPAY_DEV_SHORTCUTS: 'true' }), 'dev:authorize-key')).not.toThrow()
  })
})
