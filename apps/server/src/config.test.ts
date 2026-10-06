import { TESTNET_TOKENS } from '@payrun/core'
import { describe, expect, it } from 'vitest'
import { parseServerConfig } from './config.js'

const SECRET_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.secret-bot-token'
const env = (over: Record<string, string | undefined> = {}) => ({
  PAYRUN_MASTER_KEY: 'ab'.repeat(32),
  DISCORD_APP_ID: '500000000000000001',
  DISCORD_PUBLIC_KEY: 'cd'.repeat(32),
  DISCORD_BOT_TOKEN: SECRET_TOKEN,
  CLAIM_BASE_URL: 'https://payrun.example/claim',
  ...over,
})

describe('parseServerConfig', () => {
  it('reads the Discord app and applies testnet defaults', () => {
    const c = parseServerConfig(env())
    expect(c.core.network).toBe('moderato')
    expect(c.discord).toEqual({ applicationId: '500000000000000001', publicKey: 'cd'.repeat(32), botToken: SECRET_TOKEN, devGuildId: null })
    expect(c.http).toEqual({ host: '127.0.0.1', port: 8787 })
    expect(c.app.claimBaseUrl).toBe('https://payrun.example/claim')
    expect(c.app.defaultPayoutToken).toBe(TESTNET_TOKENS.alpha_usd)
    expect(c.app.botKey).toEqual({ limit: 100_000_000n, periodSeconds: 30 * 86_400, validitySeconds: 30 * 86_400 })
    expect(c.app.authorizeHint).toMatch(/pnpm dev:authorize-key \{guildId\}/)
    expect(c.recoveryIntervalMs).toBe(30_000)
    expect(c.devClaim).toBe(false)
  })

  it('reads overrides', () => {
    const c = parseServerConfig(
      env({ PORT: '9000', HOST: '0.0.0.0', PAYRUN_BOT_KEY_LIMIT: '250.5', PAYRUN_BOT_KEY_PERIOD_DAYS: '7', PAYRUN_DEV_CLAIM: 'true', DISCORD_DEV_GUILD_ID: '1094309218049937418' }),
    )
    expect(c.http).toEqual({ host: '0.0.0.0', port: 9000 })
    expect(c.app.botKey.limit).toBe(250_500_000n)
    expect(c.app.botKey.periodSeconds).toBe(7 * 86_400)
    expect(c.devClaim).toBe(true)
    expect(c.discord.devGuildId).toBe('1094309218049937418')
  })

  it('names every missing or bad variable, and never prints a value', () => {
    let message = ''
    try {
      parseServerConfig(env({ DISCORD_APP_ID: undefined, DISCORD_PUBLIC_KEY: 'nope', CLAIM_BASE_URL: 'not a url', DISCORD_BOT_TOKEN: `${SECRET_TOKEN} x`, PAYRUN_BOT_KEY_LIMIT: 'lots' }))
    } catch (e) {
      message = (e as Error).message
    }
    for (const name of ['DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'CLAIM_BASE_URL', 'PAYRUN_BOT_KEY_LIMIT']) expect(message).toContain(name)
    expect(message).not.toContain(SECRET_TOKEN)
    expect(message).not.toContain('nope')
  })

  it('on mainnet needs an explicit payout token and refuses the dev claim page', () => {
    const mainnet = { PAYRUN_NETWORK: 'mainnet', PAYRUN_ALLOW_MAINNET: 'true' }
    expect(() => parseServerConfig(env(mainnet))).toThrow(/PAYRUN_PAYOUT_TOKEN/)
    expect(() => parseServerConfig(env({ ...mainnet, PAYRUN_PAYOUT_TOKEN: '0x20c0000000000000000000000000000000000001', PAYRUN_DEV_CLAIM: 'true' }))).toThrow(
      /PAYRUN_DEV_CLAIM/,
    )
  })
})
