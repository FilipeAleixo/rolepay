import { AddressSchema, ConfigError, DiscordIdSchema, POLICY_LIMITS, type RolepayConfig, TESTNET_TOKENS, parseAmount, parseConfig, withDeprecatedEnvNames } from '@rolepay/core'
import type { DiscordAppConfig } from '@rolepay/discord'
import type { WebConfig } from '@rolepay/web'
import { z } from 'zod'

const DAY = 86_400

/** The server's own settings. Core's ROLEPAY_* settings are parsed by core's parseConfig. */
const ServerEnvSchema = z.object({
  DISCORD_APP_ID: DiscordIdSchema,
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be the 64-character hex public key'),
  DISCORD_BOT_TOKEN: z.string().regex(/^\S+$/, 'must be the bot token, with no spaces'),
  DISCORD_DEV_GUILD_ID: DiscordIdSchema.optional(),
  /** The OAuth2 client secret (Developer Portal > OAuth2) for the dashboard's "Sign in with Discord". Unset: sign-in is not configured. */
  ROLEPAY_DISCORD_CLIENT_SECRET: z.string().regex(/^\S+$/, 'must be the OAuth2 client secret, with no spaces').optional(),
  /** The public origin of this server (claim and setup pages, WebAuthn). The tunnel URL while developing. */
  PUBLIC_URL: z.url(),
  /** Passkeys are bound to this host for good. Default: PUBLIC_URL's host. */
  ROLEPAY_RP_ID: z.string().min(1).optional(),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  /**
   * The header the proxy in front sets to the client's IP, overwriting any the client sent
   * (Fly-Client-IP on Fly). The per-client rate limits key on it. Unset: the last X-Forwarded-For hop.
   */
  ROLEPAY_CLIENT_IP_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, 'must be a header name such as Fly-Client-IP')
    .transform((s) => s.toLowerCase())
    .optional(),
  ROLEPAY_PAYOUT_TOKEN: AddressSchema.optional(),
  /** The fee token for `/rolepay setup fees:fee_budget` without `fee_token` (default pathUSD on testnet). */
  ROLEPAY_FEE_TOKEN: AddressSchema.optional(),
  ROLEPAY_BOT_KEY_LIMIT: z
    .string()
    .default('100')
    .refine((s) => parseAmount(s).ok, 'must be a positive amount such as 100 or 12.5'),
  ROLEPAY_BOT_KEY_PERIOD_DAYS: z.coerce.number().int().positive().default(30),
  ROLEPAY_BOT_KEY_VALIDITY_DAYS: z.coerce.number().int().positive().default(30),
  ROLEPAY_BOT_KEY_FEE_BUDGET: z
    .string()
    .default('1')
    .refine((s) => parseAmount(s).ok, 'must be a positive amount such as 1 or 0.5'),
  ROLEPAY_RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  /** How often the policy scheduler ticks (makes due runs, releases autopilot runs whose veto window passed). */
  ROLEPAY_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
})

export type ServerConfig = {
  core: RolepayConfig
  discord: { applicationId: string; publicKey: string; botToken: string; devGuildId: string | null }
  app: DiscordAppConfig
  /** `clientIpHeader`: where the proxy in front puts the client's IP (lowercase), or null for the last X-Forwarded-For hop. */
  http: { host: string; port: number; clientIpHeader: string | null }
  recoveryIntervalMs: number
  /** Standing policies: the scheduler's interval, and the shortest veto window (1 minute with the testnet demo controls). */
  policies: { schedulerIntervalMs: number; minVetoMinutes: number }
  /** The claim and setup pages: origin, passkey relying party, chain endpoints for the browser. */
  web: WebConfig
  /** The dashboard's Discord OAuth2 client: the app itself. `clientSecret` null = sign-in not configured. */
  dashboard: { clientId: string; clientSecret: string | null }
}

/** Shown only with the testnet dev shortcuts on (ROLEPAY_DEV_SHORTCUTS=true). */
const DEV_AUTHORIZE_HINT =
  'Testnet dev shortcut, with the dev treasury (`/rolepay setup treasury:`): `pnpm dev:authorize-key {guildId}` on the machine running Rolepay signs it instead.'

/** Throws a ConfigError naming the bad variables. Never includes their values. */
export function parseServerConfig(raw: Record<string, string | undefined>): ServerConfig {
  // `NAME=` (a blank line copied from .env.example) means unset, not invalid. The deprecated
  // PAYRUN_* names (from before the rename) still count, under their ROLEPAY_* names.
  const env = withDeprecatedEnvNames(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== '')))
  const parsed = ServerEnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code === 'invalid_type' ? 'required' : i.message.replace(/received .*/i, 'invalid value')}`)
    throw new ConfigError(`invalid server config: ${issues.join('; ')}`)
  }
  const e = parsed.data
  const core = parseConfig(env)
  const testnet = core.network === 'moderato'
  const sponsor = core.sponsorUrl !== null
  if (!testnet && !e.ROLEPAY_PAYOUT_TOKEN) throw new ConfigError('invalid server config: ROLEPAY_PAYOUT_TOKEN is required off testnet')
  const payoutToken = e.ROLEPAY_PAYOUT_TOKEN ?? TESTNET_TOKENS.alpha_usd
  const feeToken = e.ROLEPAY_FEE_TOKEN ?? (testnet ? TESTNET_TOKENS.path_usd : null)
  // Without a sponsor every run pays its fee from the bot key's fee budget, in a token of its own.
  if (!sponsor && !feeToken) {
    throw new ConfigError('invalid server config: ROLEPAY_FEE_TOKEN is required without a fee sponsor (mainnet): new communities pay network fees from a fee budget in it')
  }
  if (feeToken === payoutToken) {
    throw new ConfigError('invalid server config: ROLEPAY_FEE_TOKEN must differ from the payout token, or fees would come out of the payout limit')
  }
  const limit = parseAmount(e.ROLEPAY_BOT_KEY_LIMIT)
  if (!limit.ok) throw new ConfigError('invalid server config: ROLEPAY_BOT_KEY_LIMIT')
  const feeBudget = parseAmount(e.ROLEPAY_BOT_KEY_FEE_BUDGET)
  if (!feeBudget.ok) throw new ConfigError('invalid server config: ROLEPAY_BOT_KEY_FEE_BUDGET')
  const { origin, rpId } = passkeyDomain(e.PUBLIC_URL, e.ROLEPAY_RP_ID)
  // A treasury passkey is bound to its host for good: on mainnet that host must be the public one.
  if (!testnet && !origin.startsWith('https://')) throw new ConfigError('invalid server config: PUBLIC_URL must use https on mainnet (never localhost: passkeys made there only work there)')
  const botKey = { limit: limit.value, periodSeconds: e.ROLEPAY_BOT_KEY_PERIOD_DAYS * DAY, validitySeconds: e.ROLEPAY_BOT_KEY_VALIDITY_DAYS * DAY }

  return {
    core,
    discord: { applicationId: e.DISCORD_APP_ID, publicKey: e.DISCORD_PUBLIC_KEY, botToken: e.DISCORD_BOT_TOKEN, devGuildId: e.DISCORD_DEV_GUILD_ID ?? null },
    app: {
      network: core.network,
      claimBaseUrl: `${origin}/claim`,
      setupBaseUrl: `${origin}/setup`,
      defaultFeeToken: feeToken,
      defaultPayoutToken: payoutToken,
      sponsor,
      botKey,
      authorizeHint: core.devShortcuts ? DEV_AUTHORIZE_HINT : null,
      devShortcuts: core.devShortcuts,
      demoControls: core.demoControls,
    },
    http: { host: e.HOST, port: e.PORT, clientIpHeader: e.ROLEPAY_CLIENT_IP_HEADER ?? null },
    recoveryIntervalMs: e.ROLEPAY_RECOVERY_INTERVAL_SECONDS * 1000,
    policies: { schedulerIntervalMs: e.ROLEPAY_SCHEDULER_INTERVAL_SECONDS * 1000, minVetoMinutes: core.demoControls ? 1 : POLICY_LIMITS.minVetoMinutes },
    web: {
      origin,
      rpId,
      network: core.network,
      rpcUrl: core.rpcUrl,
      sponsorUrl: core.sponsorUrl,
      explorerUrl: core.explorerUrl,
      botKeyDefaults: { ...botKey, feeBudget: feeBudget.value },
    },
    dashboard: { clientId: e.DISCORD_APP_ID, clientSecret: e.ROLEPAY_DISCORD_CLIENT_SECRET ?? null },
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
  if (rpId !== host && !host.endsWith(`.${rpId}`)) throw bad('ROLEPAY_RP_ID must be the PUBLIC_URL host or a parent domain of it')
  return { origin: url.origin, rpId }
}
