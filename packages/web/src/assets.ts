import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Assets } from './ports.js'

const CLIENT_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'client', 'main.ts')

/**
 * The client bundle, built in memory with esbuild on first request and cached for the
 * life of the process. No separate build step or dev server: `pnpm dev` serves it, and
 * the pages and the WebAuthn endpoints share one origin (passkeys are bound to it).
 */
export function bundledAssets(): Assets {
  let bundle: Promise<string> | null = null
  const make = async () => {
    const out = await build({
      entryPoints: [CLIENT_ENTRY],
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
      if (name !== 'payrun.js') return null
      bundle ??= make().catch((e) => {
        bundle = null // retry on the next request rather than serving a stale failure forever
        throw e
      })
      return bundle
    },
  }
}
