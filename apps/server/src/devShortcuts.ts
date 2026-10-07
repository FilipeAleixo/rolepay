import type { PayrunConfig } from '@rolepay/core'

/**
 * The guard for the dev scripts (`pnpm dev:treasury`, `pnpm dev:authorize-key`): they exist only
 * on the Moderato testnet with PAYRUN_DEV_SHORTCUTS=true. Throws with a plain reason otherwise.
 */
export function requireDevShortcuts(config: PayrunConfig, script: string): void {
  if (config.network !== 'moderato') throw new Error(`${script} is testnet only (PAYRUN_NETWORK=moderato)`)
  if (!config.devShortcuts) throw new Error(`${script} is a testnet dev shortcut: set PAYRUN_DEV_SHORTCUTS=true in .env to use it`)
}
