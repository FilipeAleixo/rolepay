import { z } from 'zod'
import { NETWORKS, NETWORK_NAMES, type NetworkName } from '../constants/tempo.js'

/** Operational settings, from the environment. Fixed facts live in constants/. */
const EnvSchema = z.object({
  ROLEPAY_NETWORK: z.enum(NETWORK_NAMES as [NetworkName, ...NetworkName[]]).default('moderato'),
  ROLEPAY_ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  ROLEPAY_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex (64 chars)'),
  ROLEPAY_DB_PATH: z.string().min(1).default('./rolepay.db'),
  ROLEPAY_RPC_URL: z.url().optional(),
  ROLEPAY_SPONSOR_URL: z.url().optional(),
  ROLEPAY_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  ROLEPAY_DEV_SHORTCUTS: z.enum(['true', 'false']).default('false'),
  /** AI proposals. Optional: without it the AI commands answer that AI is not configured. */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  ROLEPAY_AI_MODEL: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, 'must be a model ID such as claude-opus-5-5').default('claude-opus-5-5'),
  /** At most this many model calls per UTC day, across every community on this server, so a public server cannot run up the bill. */
  ROLEPAY_AI_DAILY_CAP: z.coerce.number().int().positive().default(50),
})

const DevShortcutsSchema = EnvSchema.pick({ ROLEPAY_NETWORK: true, ROLEPAY_DEV_SHORTCUTS: true })

export type RolepayConfig = {
  network: NetworkName
  chainId: number
  rpcUrl: string
  /** null = no sponsor configured (mainnet default): fees come from the fee budget. */
  sponsorUrl: string | null
  explorerUrl: string
  masterKey: string
  dbPath: string
  linkTtlSeconds: number
  /**
   * The testnet dev shortcuts: `/rolepay setup treasury:`, `new_key`, `key_limit` and
   * `pnpm dev:authorize-key`. Only with ROLEPAY_DEV_SHORTCUTS=true, and only on Moderato;
   * on any other network they do not exist.
   */
  devShortcuts: boolean
  /** AI-proposed pay runs: the Anthropic API key (null = AI off on this server), the model and the cap on model calls per UTC day. */
  ai: { apiKey: string | null; model: string; dailyCap: number }
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** The settings were called PAYRUN_* before the product was renamed Rolepay. Deprecated, still read. */
const DEPRECATED_PREFIX = 'PAYRUN_'
const PREFIX = 'ROLEPAY_'

const blank = (v: string | undefined) => v === undefined || v.trim() === ''

/**
 * A copy of `env` where every deprecated PAYRUN_X fills in ROLEPAY_X when ROLEPAY_X is unset
 * or blank, so an existing .env keeps working without edits. ROLEPAY_X always wins.
 */
export function withDeprecatedEnvNames(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env }
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(DEPRECATED_PREFIX) || blank(value)) continue
    const current = PREFIX + name.slice(DEPRECATED_PREFIX.length)
    if (blank(out[current])) out[current] = value
  }
  return out
}

/** The deprecated PAYRUN_* names set in `env` (names only, never values), to warn about at start. */
export function deprecatedEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((name) => name.startsWith(DEPRECATED_PREFIX) && !blank(env[name]))
}

/**
 * Whether the testnet dev shortcuts are on. Reads only ROLEPAY_NETWORK and ROLEPAY_DEV_SHORTCUTS,
 * so scripts that run before the rest is configured (registering commands) can ask too.
 * Throws a ConfigError when the flag is set off testnet: the shortcuts never exist there.
 */
export function devShortcutsEnabled(raw: Record<string, string | undefined>): boolean {
  const parsed = DevShortcutsSchema.safeParse(withDeprecatedEnvNames(raw))
  if (!parsed.success) throw new ConfigError(`invalid Rolepay config: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}: invalid value`)
  if (parsed.data.ROLEPAY_DEV_SHORTCUTS !== 'true') return false
  if (parsed.data.ROLEPAY_NETWORK !== 'moderato') {
    throw new ConfigError('invalid Rolepay config: ROLEPAY_DEV_SHORTCUTS=true is allowed only on the Moderato testnet')
  }
  return true
}

/** Throws a ConfigError naming the bad variables. Never includes their values. */
export function parseConfig(raw: Record<string, string | undefined>): RolepayConfig {
  const env = withDeprecatedEnvNames(raw)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code === 'invalid_format' ? 'invalid format' : i.message.replace(/received .*/i, 'invalid value')}`)
    throw new ConfigError(`invalid Rolepay config: ${issues.join('; ')}`)
  }
  const e = parsed.data
  if (e.ROLEPAY_NETWORK === 'mainnet' && e.ROLEPAY_ALLOW_MAINNET !== 'true') {
    throw new ConfigError('invalid Rolepay config: ROLEPAY_NETWORK=mainnet also needs ROLEPAY_ALLOW_MAINNET=true')
  }
  const net = NETWORKS[e.ROLEPAY_NETWORK]
  return {
    network: net.name,
    chainId: net.chainId,
    rpcUrl: e.ROLEPAY_RPC_URL ?? net.rpcUrl,
    sponsorUrl: e.ROLEPAY_SPONSOR_URL ?? net.sponsorUrl,
    explorerUrl: net.explorerUrl,
    masterKey: e.ROLEPAY_MASTER_KEY,
    dbPath: e.ROLEPAY_DB_PATH,
    linkTtlSeconds: e.ROLEPAY_LINK_TTL_SECONDS,
    devShortcuts: devShortcutsEnabled(env),
    ai: { apiKey: e.ANTHROPIC_API_KEY ?? null, model: e.ROLEPAY_AI_MODEL, dailyCap: e.ROLEPAY_AI_DAILY_CAP },
  }
}
