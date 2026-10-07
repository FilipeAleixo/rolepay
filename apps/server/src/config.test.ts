import { MAINNET_TOKENS, TESTNET_TOKENS } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { parseServerConfig } from './config.js'

/** A mainnet server as fly.app.toml configures it: USDC.e payouts, fees from a pathUSD fee budget (no sponsor on mainnet). */
const MAINNET = {
  ROLEPAY_NETWORK: 'mainnet',
  ROLEPAY_ALLOW_MAINNET: 'true',
  ROLEPAY_PAYOUT_TOKEN: MAINNET_TOKENS.usdc_e,
  ROLEPAY_FEE_TOKEN: MAINNET_TOKENS.path_usd,
}
const SECRET_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.secret-bot-token'
const env = (over: Record<string, string | undefined> = {}) => ({
  ROLEPAY_MASTER_KEY: 'ab'.repeat(32),
  DISCORD_APP_ID: '500000000000000001',
  DISCORD_PUBLIC_KEY: 'cd'.repeat(32),
  DISCORD_BOT_TOKEN: SECRET_TOKEN,
  PUBLIC_URL: 'https://pay.example.org',
  ...over,
})

describe('parseServerConfig', () => {
  it('reads the Discord app and applies testnet defaults', () => {
    const c = parseServerConfig(env())
    expect(c.core.network).toBe('moderato')
    expect(c.discord).toEqual({ applicationId: '500000000000000001', publicKey: 'cd'.repeat(32), botToken: SECRET_TOKEN, devGuildId: null })
    expect(c.http).toEqual({ host: '127.0.0.1', port: 8787, clientIpHeader: null })
    expect(c.app.claimBaseUrl).toBe('https://pay.example.org/claim')
    expect(c.app.setupBaseUrl).toBe('https://pay.example.org/setup')
    expect(c.app.defaultFeeToken).toBe(TESTNET_TOKENS.path_usd)
    expect(c.web).toEqual({
      origin: 'https://pay.example.org',
      rpId: 'pay.example.org',
      network: 'moderato',
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      explorerUrl: 'https://explore.testnet.tempo.xyz',
      botKeyDefaults: { limit: 100_000_000n, periodSeconds: 30 * 86_400, validitySeconds: 30 * 86_400, feeBudget: 1_000_000n },
    })
    expect(c.app.defaultPayoutToken).toBe(TESTNET_TOKENS.alpha_usd)
    expect(c.app.botKey).toEqual({ limit: 100_000_000n, periodSeconds: 30 * 86_400, validitySeconds: 30 * 86_400 })
    expect(c.app.devShortcuts).toBe(false)
    expect(c.app.demoControls).toBe(false)
    expect(c.app.authorizeHint).toBeNull()
    expect(c.app.sponsor).toBe(true)
    expect(c.recoveryIntervalMs).toBe(30_000)
    expect(c.policies).toEqual({ schedulerIntervalMs: 30_000, minVetoMinutes: 60 })
  })

  it('policies: the scheduler interval is configurable; the demo controls (not the dev shortcuts) allow a one-minute veto window', () => {
    expect(parseServerConfig(env({ ROLEPAY_SCHEDULER_INTERVAL_SECONDS: '10' })).policies.schedulerIntervalMs).toBe(10_000)
    expect(parseServerConfig(env({ ROLEPAY_DEMO_CONTROLS: 'true' })).policies.minVetoMinutes).toBe(1)
    expect(parseServerConfig(env({ ROLEPAY_DEV_SHORTCUTS: 'true' })).policies.minVetoMinutes).toBe(60)
  })

  it('the demo controls (run_now, short veto windows) exist only with ROLEPAY_DEMO_CONTROLS=true on testnet, and never turn on the dev shortcuts', () => {
    const demo = parseServerConfig(env({ ROLEPAY_DEMO_CONTROLS: 'true' }))
    expect([demo.app.demoControls, demo.app.devShortcuts, demo.app.authorizeHint]).toEqual([true, false, null])
    const dev = parseServerConfig(env({ ROLEPAY_DEV_SHORTCUTS: 'true' }))
    expect([dev.app.demoControls, dev.app.devShortcuts]).toEqual([false, true])
    expect(parseServerConfig(env()).app.demoControls).toBe(false)
    expect(() => parseServerConfig(env({ ...MAINNET, ROLEPAY_DEMO_CONTROLS: 'true' }))).toThrow(/ROLEPAY_DEMO_CONTROLS/)
    expect(parseServerConfig(env(MAINNET)).app.demoControls).toBe(false)
  })

  it('the dev shortcuts (and their hint) exist only with ROLEPAY_DEV_SHORTCUTS=true on testnet', () => {
    const c = parseServerConfig(env({ ROLEPAY_DEV_SHORTCUTS: 'true' }))
    expect(c.app.devShortcuts).toBe(true)
    expect(c.app.authorizeHint).toMatch(/pnpm dev:authorize-key \{guildId\}/)
    expect(() => parseServerConfig(env({ ...MAINNET, ROLEPAY_DEV_SHORTCUTS: 'true' }))).toThrow(/ROLEPAY_DEV_SHORTCUTS/)
    expect(parseServerConfig(env(MAINNET)).app.devShortcuts).toBe(false)
  })

  it('reads overrides', () => {
    const c = parseServerConfig(
      env({ PORT: '9000', HOST: '0.0.0.0', ROLEPAY_BOT_KEY_LIMIT: '250.5', ROLEPAY_BOT_KEY_PERIOD_DAYS: '7', ROLEPAY_BOT_KEY_FEE_BUDGET: '2', DISCORD_DEV_GUILD_ID: '1094309218049937418' }),
    )
    expect(c.http).toEqual({ host: '0.0.0.0', port: 9000, clientIpHeader: null })
    expect(c.app.botKey.limit).toBe(250_500_000n)
    expect(c.app.botKey.periodSeconds).toBe(7 * 86_400)
    expect(c.web.botKeyDefaults).toMatchObject({ limit: 250_500_000n, periodSeconds: 7 * 86_400, feeBudget: 2_000_000n })
    expect(c.discord.devGuildId).toBe('1094309218049937418')
  })

  it("the dashboard's Discord sign-in: client ID = the app ID, the secret from ROLEPAY_DISCORD_CLIENT_SECRET (unset or blank: not configured)", () => {
    expect(parseServerConfig(env()).dashboard).toEqual({ clientId: '500000000000000001', clientSecret: null })
    expect(parseServerConfig(env({ ROLEPAY_DISCORD_CLIENT_SECRET: '' })).dashboard.clientSecret).toBeNull()
    expect(parseServerConfig(env({ ROLEPAY_DISCORD_CLIENT_SECRET: 'oauth-client-secret' })).dashboard).toEqual({ clientId: '500000000000000001', clientSecret: 'oauth-client-secret' })
    let message = ''
    try {
      parseServerConfig(env({ ROLEPAY_DISCORD_CLIENT_SECRET: 'has a space', DISCORD_APP_ID: 'nope' }))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/ROLEPAY_DISCORD_CLIENT_SECRET/)
    expect(message).not.toContain('has a space')
  })

  it('the rate limits key on the last X-Forwarded-For hop unless ROLEPAY_CLIENT_IP_HEADER names the header the proxy in front sets', () => {
    expect(parseServerConfig(env()).http.clientIpHeader).toBeNull()
    expect(parseServerConfig(env({ ROLEPAY_CLIENT_IP_HEADER: 'Fly-Client-IP' })).http.clientIpHeader).toBe('fly-client-ip')
    expect(() => parseServerConfig(env({ ROLEPAY_CLIENT_IP_HEADER: 'not a header' }))).toThrow(/ROLEPAY_CLIENT_IP_HEADER/)
  })

  it('AI proposals: off without ANTHROPIC_API_KEY (blank is unset), Opus 5.5 by default, ROLEPAY_AI_MODEL overrides', () => {
    expect(parseServerConfig(env()).core.ai).toEqual({ apiKey: null, model: 'claude-opus-5-5', dailyCap: 50 })
    expect(parseServerConfig(env({ ANTHROPIC_API_KEY: '', ROLEPAY_AI_MODEL: '', ROLEPAY_AI_DAILY_CAP: '' })).core.ai).toEqual({ apiKey: null, model: 'claude-opus-5-5', dailyCap: 50 })
    expect(parseServerConfig(env({ ANTHROPIC_API_KEY: 'sk-ant-api03-SECRET', ROLEPAY_AI_MODEL: 'claude-sonnet-5-5', ROLEPAY_AI_DAILY_CAP: '20' })).core.ai).toEqual({
      apiKey: 'sk-ant-api03-SECRET',
      model: 'claude-sonnet-5-5',
      dailyCap: 20,
    })
  })

  it('still reads the deprecated PAYRUN_* names (an .env from before the rename), with ROLEPAY_* winning', () => {
    const c = parseServerConfig(
      env({
        ROLEPAY_MASTER_KEY: undefined,
        PAYRUN_MASTER_KEY: 'ef'.repeat(32),
        PUBLIC_URL: 'https://demo.rolepay.app',
        PAYRUN_RP_ID: 'rolepay.app',
        PAYRUN_BOT_KEY_LIMIT: '7',
        ROLEPAY_BOT_KEY_PERIOD_DAYS: '3',
        PAYRUN_BOT_KEY_PERIOD_DAYS: '9',
      }),
    )
    expect(c.core.masterKey).toBe('ef'.repeat(32))
    expect(c.web).toMatchObject({ origin: 'https://demo.rolepay.app', rpId: 'rolepay.app' })
    expect(c.app.botKey).toMatchObject({ limit: 7_000_000n, periodSeconds: 3 * 86_400 })
  })

  it('treats blank values (copied from .env.example) as unset', () => {
    const c = parseServerConfig(env({ DISCORD_DEV_GUILD_ID: '', ROLEPAY_PAYOUT_TOKEN: '', PORT: '', ROLEPAY_RPC_URL: '' }))
    expect(c.discord.devGuildId).toBeNull()
    expect(c.app.defaultPayoutToken).toBe(TESTNET_TOKENS.alpha_usd)
    expect(c.http.port).toBe(8787)
  })

  it('names every missing or bad variable, and never prints a value', () => {
    let message = ''
    try {
      parseServerConfig(env({ DISCORD_APP_ID: undefined, DISCORD_PUBLIC_KEY: 'nope', PUBLIC_URL: 'not a url', DISCORD_BOT_TOKEN: `${SECRET_TOKEN} x`, ROLEPAY_BOT_KEY_LIMIT: 'lots' }))
    } catch (e) {
      message = (e as Error).message
    }
    for (const name of ['DISCORD_APP_ID', 'DISCORD_PUBLIC_KEY', 'PUBLIC_URL', 'ROLEPAY_BOT_KEY_LIMIT']) expect(message).toContain(name)
    expect(message).not.toContain(SECRET_TOKEN)
    expect(message).not.toContain('nope')
  })

  it('on mainnet needs an explicit payout token, has no sponsor, no dev hint and no demo controls', () => {
    const c = parseServerConfig(env(MAINNET))
    expect(c.core).toMatchObject({ network: 'mainnet', chainId: 4217, sponsorUrl: null, devShortcuts: false, demoControls: false })
    expect(c.app).toMatchObject({ defaultPayoutToken: MAINNET_TOKENS.usdc_e, defaultFeeToken: MAINNET_TOKENS.path_usd, sponsor: false, authorizeHint: null })
    expect(c.web).toMatchObject({ network: 'mainnet', rpcUrl: 'https://rpc.tempo.xyz', sponsorUrl: null, explorerUrl: 'https://explore.tempo.xyz' })
    expect(c.policies.minVetoMinutes).toBe(60)
    expect(() => parseServerConfig(env({ ...MAINNET, ROLEPAY_PAYOUT_TOKEN: undefined }))).toThrow(/ROLEPAY_PAYOUT_TOKEN/)
  })

  it('without a fee sponsor (mainnet, or ROLEPAY_SPONSOR_URL=none) needs ROLEPAY_FEE_TOKEN: new communities pay fees from a fee budget in it', () => {
    expect(() => parseServerConfig(env({ ...MAINNET, ROLEPAY_FEE_TOKEN: undefined }))).toThrow(/ROLEPAY_FEE_TOKEN.*fee sponsor/)
    // A mainnet server with its own sponsor (Tempo's hosted relay, or a self-hosted one) may leave it out.
    const sponsored = parseServerConfig(env({ ...MAINNET, ROLEPAY_FEE_TOKEN: undefined, ROLEPAY_SPONSOR_URL: 'https://relay.example.org' }))
    expect(sponsored.app).toMatchObject({ sponsor: true, defaultFeeToken: null })
    // Testnet without the sponsor (a rehearsal of mainnet) falls back to pathUSD like testnet always did.
    expect(parseServerConfig(env({ ROLEPAY_SPONSOR_URL: 'none' })).app).toMatchObject({ sponsor: false, defaultFeeToken: TESTNET_TOKENS.path_usd })
  })

  it('refuses a fee token that is the payout token: fees would silently come out of the payout limit', () => {
    expect(() => parseServerConfig(env({ ...MAINNET, ROLEPAY_FEE_TOKEN: MAINNET_TOKENS.usdc_e.toUpperCase().replace('0X', '0x') }))).toThrow(/ROLEPAY_FEE_TOKEN.*payout token/)
    expect(() => parseServerConfig(env({ ROLEPAY_FEE_TOKEN: TESTNET_TOKENS.alpha_usd }))).toThrow(/ROLEPAY_FEE_TOKEN.*payout token/)
  })

  it('on mainnet the pages must be on https: a treasury passkey made on localhost would only ever work on that machine', () => {
    expect(() => parseServerConfig(env({ ...MAINNET, PUBLIC_URL: 'http://localhost:8787' }))).toThrow(/PUBLIC_URL.*https.*mainnet/)
    expect(parseServerConfig(env({ ...MAINNET, PUBLIC_URL: 'https://app.rolepay.app' })).web).toMatchObject({ origin: 'https://app.rolepay.app', rpId: 'app.rolepay.app' })
  })

  it('the passkey domain is config only: the origin from PUBLIC_URL, the rpId its host unless ROLEPAY_RP_ID says otherwise', () => {
    const tunnel = parseServerConfig(env({ PUBLIC_URL: 'https://abc-123.ngrok-free.app/' }))
    expect(tunnel.web).toMatchObject({ origin: 'https://abc-123.ngrok-free.app', rpId: 'abc-123.ngrok-free.app' })
    expect(tunnel.app.claimBaseUrl).toBe('https://abc-123.ngrok-free.app/claim')
    const parent = parseServerConfig(env({ PUBLIC_URL: 'https://pay.example.org', ROLEPAY_RP_ID: 'example.org' }))
    expect(parent.web.rpId).toBe('example.org')
    const local = parseServerConfig(env({ PUBLIC_URL: 'http://localhost:8787' }))
    expect(local.web).toMatchObject({ origin: 'http://localhost:8787', rpId: 'localhost' })
  })

  it('refuses a passkey domain browsers would reject: plain http off localhost, an IP address, a path, an rpId that is not the host or a parent of it', () => {
    expect(() => parseServerConfig(env({ PUBLIC_URL: 'http://pay.example.org' }))).toThrow(/PUBLIC_URL.*https/)
    expect(() => parseServerConfig(env({ PUBLIC_URL: 'http://127.0.0.1:8787' }))).toThrow(/PUBLIC_URL.*localhost/)
    expect(() => parseServerConfig(env({ PUBLIC_URL: 'https://pay.example.org/claim' }))).toThrow(/PUBLIC_URL.*origin/)
    expect(() => parseServerConfig(env({ PUBLIC_URL: 'https://pay.example.org', ROLEPAY_RP_ID: 'other.org' }))).toThrow(/ROLEPAY_RP_ID/)
    expect(() => parseServerConfig(env({ PUBLIC_URL: 'https://pay.example.org', ROLEPAY_RP_ID: 'ample.org' }))).toThrow(/ROLEPAY_RP_ID/)
  })
})
