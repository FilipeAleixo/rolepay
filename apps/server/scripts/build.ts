// The production build, into apps/server/dist (gitignored): `node dist/main.js` then runs plain JavaScript.
//
// - dist/main.js: the server as one ES module. The workspace packages (@rolepay/*, TypeScript sources)
//   are compiled into it; every npm package stays an import resolved from node_modules at runtime, so
//   better-sqlite3's native addon and esbuild's binary load exactly as they do in development.
// - dist/rolepay.js: the browser bundle for the claim and setup pages, and dist/live.js, the dashboard's
//   live updates, built here once instead of on the first page request (main.ts serves them when they are there).
//
// `pnpm dev` needs neither: tsx runs the sources and the client bundle is built on first request.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundledAssets } from '@rolepay/web'
import { type Plugin, build } from 'esbuild'

const APP = join(import.meta.dirname, '..')
const DIST = join(APP, 'dist')

/** npm packages (and node: builtins) stay imports; only the workspace's own TypeScript is bundled. */
const npmPackagesExternal: Plugin = {
  name: 'npm-packages-external',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@rolepay/') ? undefined : { path: args.path, external: true }))
  },
}

const started = Date.now()
rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
await build({
  entryPoints: [join(APP, 'src', 'main.ts')],
  outfile: join(DIST, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [npmPackagesExternal],
  logLevel: 'warning',
})
const assets = bundledAssets()
for (const name of ['rolepay.js', 'live.js']) {
  const client = await assets.get(name)
  if (!client) throw new Error(`the client bundle ${name} came out empty`)
  writeFileSync(join(DIST, name), client)
}
console.log(`built dist/main.js, dist/rolepay.js and dist/live.js in ${Date.now() - started} ms`)
