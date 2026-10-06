// Convention guards for @payrun/discord, enforced by the build. Test files are exempt.
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

function violations(dir: string, allowed: (t: string) => boolean) {
  return files(join(SRC, dir)).flatMap((f) =>
    importsOf(f)
      .map((spec) => ({ spec, t: target(f, spec) }))
      .filter(({ t }) => !allowed(t))
      .map(({ spec }) => `${relative(PKG, f)} imports ${spec}`),
  )
}

describe('@payrun/discord layering', () => {
  it('reaches core only through @payrun/core (never @payrun/core/adapters or core files), and imports nothing but zod besides', () => {
    expect(violations('.', (t) => t === '@payrun/core' || t === 'zod' || t.startsWith('src/'))).toEqual([])
  })

  it('views are pure builders: domain values in, message payloads out', () => {
    expect(
      violations('views', (t) => t === '@payrun/core' || t === 'src/api.ts' || t === 'src/api.js' || t.startsWith('src/views') || t === 'src/components'),
    ).toEqual([])
  })

  it('handlers (commands, components) never reach adapters, the HTTP layer or the queue implementation; they use ports via deps', () => {
    const forbidden = (t: string) => ['src/adapters', 'src/http', 'src/execution', 'src/testing'].includes(t)
    expect([...violations('commands', (t) => !forbidden(t)), ...violations('components', (t) => !forbidden(t))]).toEqual([])
  })

  it('production code never imports the testing fakes', () => {
    const prod = files(SRC).filter((f) => !f.includes(`${join('src', 'testing')}`))
    const bad = prod.flatMap((f) => importsOf(f).filter((s) => target(f, s) === 'src/testing').map((s) => `${relative(PKG, f)} imports ${s}`))
    expect(bad).toEqual([])
  })

  it('the package root exports no fakes (they live in @payrun/discord/testing)', () => {
    expect(Object.keys(root).filter((k) => /Fake|Recording|Static|TestSigner|slashCommand|buttonClick/.test(k))).toEqual([])
  })

  it('money is never a float here either', () => {
    const bad = files(SRC).filter((f) => /parseFloat\(|\.toFixed\(/.test(readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })
})
