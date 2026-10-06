import { isAbsolute, join, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

/** A relative (or default) PAYRUN_DB_PATH is taken from the repo root, whatever the working directory. */
export function withRepoRelativeDb(env: Record<string, string | undefined>, root: string): Record<string, string | undefined> {
  const path = env.PAYRUN_DB_PATH || './payrun.db'
  return { ...env, PAYRUN_DB_PATH: isAbsolute(path) ? path : resolve(root, path) }
}

/** The repo-root .env (gitignored) under the real environment, which wins. */
export function loadEnvironment(): Record<string, string | undefined> {
  loadDotenv({ path: join(REPO_ROOT, '.env'), quiet: true })
  return withRepoRelativeDb(process.env, REPO_ROOT)
}
