// `pnpm build` compiles the workspace packages into dist/main.js and leaves every npm package an
// import that node resolves at runtime from apps/server/node_modules (scripts/build.ts). So
// whatever a workspace package needs at runtime, the server must depend on too, at the same
// version, or production fails where every test (which runs the sources) passes. That includes
// files resolved by path rather than imported: the web pages' fonts (packages/web/src/fonts.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/env.js'

type Manifest = { name: string; dependencies?: Record<string, string> }
const manifest = (dir: string) => JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as Manifest

describe('the server bundle resolves its packages at runtime', () => {
  it('depends on every npm package the workspace packages depend on, at the same version', () => {
    const server = manifest('apps/server').dependencies ?? {}
    const missing = ['packages/core', 'packages/discord', 'packages/web'].flatMap((dir) => {
      const m = manifest(dir)
      return Object.entries(m.dependencies ?? {})
        .filter(([name]) => !name.startsWith('@rolepay/'))
        .filter(([name, version]) => server[name] !== version)
        .map(([name, version]) => `${m.name} needs ${name}@${version}, the server has ${server[name] ?? 'nothing'}`)
    })
    expect(missing).toEqual([])
  })

  it('so the fonts the pages serve resolve from the server too', () => {
    expect(manifest('apps/server').dependencies).toMatchObject({ '@fontsource/lora': expect.any(String), '@fontsource/montserrat': expect.any(String) })
  })
})
