import { AddressSchema, ConfigError, DiscordIdSchema, type PayrunConfig, TESTNET_TOKENS, parseAmount, parseConfig } from '@payrun/core'
import type { DiscordAppConfig } from '@payrun/discord'
import { z } from 'zod'

const DAY = 86_400

/** The server's own settings. Core's PAYRUN_* settings are parsed by core's parseConfig. */
const ServerEnvSchema = z.object({
  DISCORD_APP_ID: DiscordIdSchema,
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be the 64-character hex public key'),
  DISCORD_BOT_TOKEN: z.string().regex(/^\S+$/, 'must be the bot token, with no spaces'),
  DISCORD_DEV_GUILD_ID: DiscordIdSchema.optional(),
  CLAIM_BASE_URL: z.url(),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PAYRUN_PAYOUT_TOKEN: AddressSchema.optional(),
  PAYRUN_BOT_KEY_LIMIT: z
    .string()
    .default('100')
    .refine((s) => parseAmount(s).ok, 'must be a positive amount such as 100 or 12.5'),
  PAYRUN_BOT_KEY_PERIOD_DAYS: z.coerce.number().int().positive().default(30),
  PAYRUN_BOT_KEY_VALIDITY_DAYS: z.coerce.number().int().positive().default(30),
  PAYRUN_RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  PAYRUN_DEV_CLAIM: z.enum(['true', 'false']).default('false'),
})

export type ServerConfig = {
  core: PayrunConfig
  discord: { applicationId: string; publicKey: string; botToken: string; devGuildId: string | null }
  app: DiscordAppConfig
  http: { host: string; port: number }
  recoveryIntervalMs: number
  /** Serve a throwaway testnet claim page at /claim/:token until the passkey page (WP5) exists. */
  devClaim: boolean
}

const TESTNET_AUTHORIZE_HINT =
  'Testnet: run `pnpm dev:authorize-key {guildId}` on the machine running payrun (it signs with PAYRUN_TEST_ROOT_PRIVATE_KEY). The passkey signing page comes in a later build.'
const MAINNET_AUTHORIZE_HINT = 'The treasury signs it with its passkey on the setup page (coming in a later build).'

/** Throws a ConfigError naming the bad variables. Never includes their values. */
export function parseServerConfig(raw: Record<string, string | undefined>): ServerConfig {
  // `NAME=` (a blank line copied from .env.example) means unset, not invalid.
  const env = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== ''))
  const parsed = ServerEnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code === 'invalid_type' ? 'required' : i.message.replace(/received .*/i, 'invalid value')}`)
    throw new ConfigError(`invalid server config: ${issues.join('; ')}`)
  }
  const e = parsed.data
  const core = parseConfig(env)
  const testnet = core.network === 'moderato'
  if (!testnet && !e.PAYRUN_PAYOUT_TOKEN) throw new ConfigError('invalid server config: PAYRUN_PAYOUT_TOKEN is required off testnet')
  if (!testnet && e.PAYRUN_DEV_CLAIM === 'true') throw new ConfigError('invalid server config: PAYRUN_DEV_CLAIM is testnet only')
  const limit = parseAmount(e.PAYRUN_BOT_KEY_LIMIT)
  if (!limit.ok) throw new ConfigError('invalid server config: PAYRUN_BOT_KEY_LIMIT')

  return {
    core,
    discord: { applicationId: e.DISCORD_APP_ID, publicKey: e.DISCORD_PUBLIC_KEY, botToken: e.DISCORD_BOT_TOKEN, devGuildId: e.DISCORD_DEV_GUILD_ID ?? null },
    app: {
      network: core.network,
      claimBaseUrl: e.CLAIM_BASE_URL,
      defaultPayoutToken: e.PAYRUN_PAYOUT_TOKEN ?? TESTNET_TOKENS.alpha_usd,
      botKey: { limit: limit.value, periodSeconds: e.PAYRUN_BOT_KEY_PERIOD_DAYS * DAY, validitySeconds: e.PAYRUN_BOT_KEY_VALIDITY_DAYS * DAY },
      authorizeHint: testnet ? TESTNET_AUTHORIZE_HINT : MAINNET_AUTHORIZE_HINT,
    },
    http: { host: e.HOST, port: e.PORT },
    recoveryIntervalMs: e.PAYRUN_RECOVERY_INTERVAL_SECONDS * 1000,
    devClaim: e.PAYRUN_DEV_CLAIM === 'true',
  }
}
