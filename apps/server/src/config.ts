import { AddressSchema, ConfigError, DiscordIdSchema, type PayrunConfig, TESTNET_TOKENS, parseAmount, parseConfig } from '@rolepay/core'
import type { DiscordAppConfig } from '@rolepay/discord'
import type { WebConfig } from '@rolepay/web'
import { z } from 'zod'

const DAY = 86_400

/** The server's own settings. Core's PAYRUN_* settings are parsed by core's parseConfig. */
const ServerEnvSchema = z.object({
  DISCORD_APP_ID: DiscordIdSchema,
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be the 64-character hex public key'),
  DISCORD_BOT_TOKEN: z.string().regex(/^\S+$/, 'must be the bot token, with no spaces'),
  DISCORD_DEV_GUILD_ID: DiscordIdSchema.optional(),
  /** The public origin of this server (claim and setup pages, WebAuthn). The tunnel URL while developing. */
  PUBLIC_URL: z.url(),
  /** Passkeys are bound to this host for good. Default: PUBLIC_URL's host. */
  PAYRUN_RP_ID: z.string().min(1).optional(),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PAYRUN_PAYOUT_TOKEN: AddressSchema.optional(),
  /** The fee token for `/payrun setup fees:fee_budget` without `fee_token` (default pathUSD on testnet). */
  PAYRUN_FEE_TOKEN: AddressSchema.optional(),
  PAYRUN_BOT_KEY_LIMIT: z
    .string()
    .default('100')
    .refine((s) => parseAmount(s).ok, 'must be a positive amount such as 100 or 12.5'),
  PAYRUN_BOT_KEY_PERIOD_DAYS: z.coerce.number().int().positive().default(30),
  PAYRUN_BOT_KEY_VALIDITY_DAYS: z.coerce.number().int().positive().default(30),
  PAYRUN_BOT_KEY_FEE_BUDGET: z
    .string()
    .default('1')
    .refine((s) => parseAmount(s).ok, 'must be a positive amount such as 1 or 0.5'),
  PAYRUN_RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
})

export type ServerConfig = {
  core: PayrunConfig
  discord: { applicationId: string; publicKey: string; botToken: string; devGuildId: string | null }
  app: DiscordAppConfig
  http: { host: string; port: number }
  recoveryIntervalMs: number
  /** The claim and setup pages: origin, passkey relying party, chain endpoints for the browser. */
  web: WebConfig
}

/** Shown only with the testnet dev shortcuts on (PAYRUN_DEV_SHORTCUTS=true). */
const DEV_AUTHORIZE_HINT =
  'Testnet dev shortcut, with the dev treasury (`/payrun setup treasury:`): `pnpm dev:authorize-key {guildId}` on the machine running payrun signs it instead.'

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
  const limit = parseAmount(e.PAYRUN_BOT_KEY_LIMIT)
  if (!limit.ok) throw new ConfigError('invalid server config: PAYRUN_BOT_KEY_LIMIT')
  const feeBudget = parseAmount(e.PAYRUN_BOT_KEY_FEE_BUDGET)
  if (!feeBudget.ok) throw new ConfigError('invalid server config: PAYRUN_BOT_KEY_FEE_BUDGET')
  const { origin, rpId } = passkeyDomain(e.PUBLIC_URL, e.PAYRUN_RP_ID)
  const botKey = { limit: limit.value, periodSeconds: e.PAYRUN_BOT_KEY_PERIOD_DAYS * DAY, validitySeconds: e.PAYRUN_BOT_KEY_VALIDITY_DAYS * DAY }

  return {
    core,
    discord: { applicationId: e.DISCORD_APP_ID, publicKey: e.DISCORD_PUBLIC_KEY, botToken: e.DISCORD_BOT_TOKEN, devGuildId: e.DISCORD_DEV_GUILD_ID ?? null },
    app: {
      network: core.network,
      claimBaseUrl: `${origin}/claim`,
      setupBaseUrl: `${origin}/setup`,
      defaultFeeToken: e.PAYRUN_FEE_TOKEN ?? (testnet ? TESTNET_TOKENS.path_usd : null),
      defaultPayoutToken: e.PAYRUN_PAYOUT_TOKEN ?? TESTNET_TOKENS.alpha_usd,
      botKey,
      authorizeHint: core.devShortcuts ? DEV_AUTHORIZE_HINT : null,
      devShortcuts: core.devShortcuts,
    },
    http: { host: e.HOST, port: e.PORT },
    recoveryIntervalMs: e.PAYRUN_RECOVERY_INTERVAL_SECONDS * 1000,
    web: {
      origin,
      rpId,
      network: core.network,
      rpcUrl: core.rpcUrl,
      sponsorUrl: core.sponsorUrl,
      explorerUrl: core.explorerUrl,
      botKeyDefaults: { ...botKey, feeBudget: feeBudget.value },
    },
  }
}

/**
 * The origin the pages are served from and the WebAuthn relying party ID. Browsers only
 * allow passkeys on https (or http://localhost), never on an IP address, and the rpId must
 * be the host or a parent domain of it. Passkeys are bound to the rpId for good.
 */
function passkeyDomain(publicUrl: string, rpIdOverride: string | undefined): { origin: string; rpId: string } {
  const url = new URL(publicUrl)
  const bad = (why: string) => new ConfigError(`invalid server config: ${why}`)
  if (url.pathname !== '/' || url.search || url.hash) throw bad('PUBLIC_URL must be an origin only, for example https://pay.example.org (no path)')
  const host = url.hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) throw bad('PUBLIC_URL cannot be an IP address: passkeys need a name, use http://localhost:8787 locally')
  if (url.protocol !== 'https:' && host !== 'localhost') throw bad('PUBLIC_URL must use https (passkeys need it), or be http://localhost')
  const rpId = (rpIdOverride ?? host).toLowerCase()
  if (rpId !== host && !host.endsWith(`.${rpId}`)) throw bad('PAYRUN_RP_ID must be the PUBLIC_URL host or a parent domain of it')
  return { origin: url.origin, rpId }
}
