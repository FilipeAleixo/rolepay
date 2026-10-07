import { existsSync, readFileSync } from 'node:fs'
import type { Assets } from '@rolepay/web'

/**
 * The client bundle `pnpm build` wrote (dist/rolepay.js, next to dist/main.js), read once at start,
 * so production never runs esbuild on a page request. null when there is none: `pnpm dev` runs the
 * sources, and `bundledAssets()` builds the bundle on the first page request instead.
 */
export function prebuiltAssets(path: string): Assets | null {
  if (!existsSync(path)) return null
  const bundle = readFileSync(path, 'utf8')
  return { get: async (name) => (name === 'rolepay.js' ? bundle : null) }
}
