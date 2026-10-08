import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Assets } from '@rolepay/web'

/**
 * The client bundles `pnpm build` wrote (dist/rolepay.js, and the dashboard's dist/live.js beside it,
 * next to dist/main.js), read once at start, so production never runs esbuild on a page request.
 * null when there is none: `pnpm dev` runs the sources, and `bundledAssets()` builds the bundles on
 * the first page request instead.
 */
export function prebuiltAssets(path: string): Assets | null {
  if (!existsSync(path)) return null
  const live = join(dirname(path), 'live.js')
  const files: Record<string, string> = { 'rolepay.js': readFileSync(path, 'utf8'), ...(existsSync(live) ? { 'live.js': readFileSync(live, 'utf8') } : {}) }
  return { get: async (name) => (Object.hasOwn(files, name) ? (files[name] ?? null) : null) }
}
