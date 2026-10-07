import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { withDeprecatedEnvNames } from '@rolepay/core'
import { config as loadDotenv } from 'dotenv'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

/** The SQLite file before the rename to Rolepay. An install that has one keeps it: it holds the treasury, passkeys and runs. */
const LEGACY_DB = 'payrun.db'
const DEFAULT_DB = 'rolepay.db'

/**
 * A relative ROLEPAY_DB_PATH is taken from the repo root, whatever the working directory. Unset, it is
 * the repo-root payrun.db when that file exists (an install from before the rename) and rolepay.db otherwise.
 */
export function withRepoRelativeDb(
  env: Record<string, string | undefined>,
  root: string,
  exists: (path: string) => boolean = existsSync,
): Record<string, string | undefined> {
  const path = env.ROLEPAY_DB_PATH || (exists(resolve(root, LEGACY_DB)) ? LEGACY_DB : DEFAULT_DB)
  return { ...env, ROLEPAY_DB_PATH: isAbsolute(path) ? path : resolve(root, path) }
}

/** The environment the server and scripts read: deprecated PAYRUN_* names filled in as ROLEPAY_*, the DB path anchored. */
export function environmentFrom(
  raw: Record<string, string | undefined>,
  root: string,
  exists: (path: string) => boolean = existsSync,
): Record<string, string | undefined> {
  return withRepoRelativeDb(withDeprecatedEnvNames(raw), root, exists)
}

/** The repo-root .env (gitignored) under the real environment, which wins. */
export function loadEnvironment(): Record<string, string | undefined> {
  loadDotenv({ path: join(REPO_ROOT, '.env'), quiet: true })
  return environmentFrom(process.env, REPO_ROOT)
}
