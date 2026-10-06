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
})

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
}

export class ConfigError extends Error {
  override name = 'ConfigError'
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
  }
}
