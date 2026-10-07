// Convention guards for @rolepay/web, enforced by the build. Test files are exempt.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as root from '../src/index.js'

const PKG = resolve(import.meta.dirname, '..')
const SRC = join(PKG, 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : []
  })
}

const IMPORT = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3]) as string)

/** 'src/<dir>' for a relative import, or the bare specifier. */
function target(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec
  const rel = relative(SRC, resolve(dirname(file), spec))
  return rel.startsWith('..') ? `outside:${rel}` : `src/${rel.split(/[\\/]/).length > 1 ? rel.split(/[\\/]/)[0] : rel}`
}

const server = () => files(SRC).filter((f) => !f.includes(join('src', 'client')))
const violations = (list: string[], allowed: (t: string) => boolean) =>
  list.flatMap((f) =>
    importsOf(f)
      .map((spec) => ({ spec, t: target(f, spec) }))
      .filter(({ t }) => !allowed(t))
      .map(({ spec }) => `${relative(PKG, f)} imports ${spec}`),
  )

describe('@rolepay/web layering', () => {
  it('server code reaches core only through @rolepay/core, plus hono, zod, the Accounts SDK server, viem/tempo, esbuild and node', () => {
    const ok = (t: string) =>
      t === '@rolepay/core' || ['hono', 'hono/compress', 'zod', 'accounts/server', 'viem/tempo', 'esbuild'].includes(t) || t.startsWith('node:') || (t.startsWith('src/') && t !== 'src/client')
    expect(violations(server(), ok)).toEqual([])
  })

  it('client code (the browser bundle) imports only the Accounts SDK, viem and itself: no core, no server code, nothing secret', () => {
    const ok = (t: string) => t === 'accounts' || t.startsWith('viem/') || t === 'src/client' || t.startsWith('src/client')
    expect(violations(files(join(SRC, 'client')), ok)).toEqual([])
  })

  it('views are pure builders', () => {
    expect(violations(files(join(SRC, 'views')), (t) => t.startsWith('src/views'))).toEqual([])
  })

  it('production code never imports the testing fakes, and the root exports none', () => {
    const prod = files(SRC).filter((f) => !f.includes(join('src', 'testing')))
    expect(violations(prod, (t) => t !== 'src/testing')).toEqual([])
    expect(Object.keys(root).filter((k) => /Fake|static/.test(k))).toEqual([])
  })
})
