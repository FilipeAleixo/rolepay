import { z } from 'zod'
import { NETWORKS, NETWORK_NAMES, type NetworkName } from '../constants/tempo.js'

/** Operational settings, from the environment. Fixed facts live in constants/. */
const EnvSchema = z.object({
  PAYRUN_NETWORK: z.enum(NETWORK_NAMES as [NetworkName, ...NetworkName[]]).default('moderato'),
  PAYRUN_ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  PAYRUN_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex (64 chars)'),
  PAYRUN_DB_PATH: z.string().min(1).default('./payrun.db'),
  PAYRUN_RPC_URL: z.url().optional(),
  PAYRUN_SPONSOR_URL: z.url().optional(),
  PAYRUN_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  PAYRUN_DEV_SHORTCUTS: z.enum(['true', 'false']).default('false'),
})

const DevShortcutsSchema = EnvSchema.pick({ PAYRUN_NETWORK: true, PAYRUN_DEV_SHORTCUTS: true })

export type PayrunConfig = {
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
   * The testnet dev shortcuts: `/payrun setup treasury:`, `new_key`, `key_limit` and
   * `pnpm dev:authorize-key`. Only with PAYRUN_DEV_SHORTCUTS=true, and only on Moderato;
   * on any other network they do not exist.
   */
  devShortcuts: boolean
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/**
 * Whether the testnet dev shortcuts are on. Reads only PAYRUN_NETWORK and PAYRUN_DEV_SHORTCUTS,
 * so scripts that run before the rest is configured (registering commands) can ask too.
 * Throws a ConfigError when the flag is set off testnet: the shortcuts never exist there.
 */
export function devShortcutsEnabled(env: Record<string, string | undefined>): boolean {
  const parsed = DevShortcutsSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(`invalid payrun config: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}: invalid value`)
  if (parsed.data.PAYRUN_DEV_SHORTCUTS !== 'true') return false
  if (parsed.data.PAYRUN_NETWORK !== 'moderato') {
    throw new ConfigError('invalid payrun config: PAYRUN_DEV_SHORTCUTS=true is allowed only on the Moderato testnet')
  }
  return true
}

/** Throws a ConfigError naming the bad variables. Never includes their values. */
export function parseConfig(env: Record<string, string | undefined>): PayrunConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code === 'invalid_format' ? 'invalid format' : i.message.replace(/received .*/i, 'invalid value')}`)
    throw new ConfigError(`invalid payrun config: ${issues.join('; ')}`)
  }
  const e = parsed.data
  if (e.PAYRUN_NETWORK === 'mainnet' && e.PAYRUN_ALLOW_MAINNET !== 'true') {
    throw new ConfigError('invalid payrun config: PAYRUN_NETWORK=mainnet also needs PAYRUN_ALLOW_MAINNET=true')
  }
  const net = NETWORKS[e.PAYRUN_NETWORK]
  return {
    network: net.name,
    chainId: net.chainId,
    rpcUrl: e.PAYRUN_RPC_URL ?? net.rpcUrl,
    sponsorUrl: e.PAYRUN_SPONSOR_URL ?? net.sponsorUrl,
    explorerUrl: net.explorerUrl,
    masterKey: e.PAYRUN_MASTER_KEY,
    dbPath: e.PAYRUN_DB_PATH,
    linkTtlSeconds: e.PAYRUN_LINK_TTL_SECONDS,
    devShortcuts: devShortcutsEnabled(env),
  }
}
