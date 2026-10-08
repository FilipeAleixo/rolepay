import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Assets } from './ports.js'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), 'client')
/**
 * The bundles by file name: `rolepay.js` for the claim, setup and account pages (passkeys, viem),
 * `live.js` for the dashboard (live updates only: a few kilobytes, no viem).
 */
export const CLIENT_BUNDLES: Record<string, string> = { 'rolepay.js': join(CLIENT, 'main.ts'), 'live.js': join(CLIENT, 'dashboard.ts') }

/**
 * The client bundles, built in memory with esbuild on first request and cached for the
 * life of the process. No separate build step or dev server: `pnpm dev` serves them, and
 * the pages and the WebAuthn endpoints share one origin (passkeys are bound to it).
 */
export function bundledAssets(): Assets {
  const bundles = new Map<string, Promise<string>>()
  const make = async (entry: string) => {
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    })
    const file = out.outputFiles[0]
    if (!file) throw new Error('client bundle produced no output')
    return file.text
  }
  return {
    async get(name) {
      const entry = CLIENT_BUNDLES[name]
      if (!entry || !Object.hasOwn(CLIENT_BUNDLES, name)) return null
      let bundle = bundles.get(name)
      if (!bundle) {
        bundle = make(entry).catch((e) => {
          bundles.delete(name) // retry on the next request rather than serving a stale failure forever
          throw e
        })
        bundles.set(name, bundle)
      }
      return bundle
    },
  }
}
