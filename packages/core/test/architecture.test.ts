// Convention guards: the layering rules in CLAUDE.md, enforced by the build instead of by memory.
// Test files are exempt (they wire fakes and adapters on purpose).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as core from '../src/index.js'

const CORE = resolve(import.meta.dirname, '..')
const SRC = join(CORE, 'src')
const REPO = resolve(CORE, '../..')

function files(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return []
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === 'dist') return []
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const IMPORT = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3]) as string)
}

/** The src/ layer an import lands in ('domain', 'ports', ...), or the bare package name. */
function target(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec
  const abs = resolve(dirname(file), spec)
  const rel = relative(SRC, abs)
  return rel.startsWith('..') ? `outside:${relative(REPO, abs)}` : `src/${rel.split(/[\\/]/)[0]}`
}

function violations(layer: string, allowed: (t: string) => boolean) {
  return files(join(SRC, layer)).flatMap((f) =>
    importsOf(f)
      .map((spec) => ({ spec, t: target(f, spec) }))
      .filter(({ t }) => !allowed(t))
      .map(({ spec }) => `${relative(CORE, f)} imports ${spec}`),
  )
}

describe('layering', () => {
  it('domain/ is pure: zod, constants and itself only (no viem, kysely, node:*, IO)', () => {
    expect(violations('domain', (t) => t === 'zod' || t === 'src/domain' || t === 'src/constants')).toEqual([])
  })

  it('ports/ are interfaces over the domain (and fixed constants) only', () => {
    expect(violations('ports', (t) => ['src/domain', 'src/ports', 'src/constants'].includes(t))).toEqual([])
  })

  it('services/ import only domain, ports, constants and each other (never adapters or config)', () => {
    expect(
      violations('services', (t) => t === 'zod' || ['src/domain', 'src/ports', 'src/constants', 'src/services'].includes(t)),
    ).toEqual([])
  })

  it('constants/ import nothing', () => {
    expect(violations('constants', (t) => t === 'src/constants')).toEqual([])
  })

  it('adapters/ never import services or the package root (they implement ports, nothing more)', () => {
    expect(violations('adapters', (t) => t !== 'src/services' && !/^src\/index\.(js|ts)$/.test(t))).toEqual([])
  })
})

describe('public surface', () => {
  it('the package root exports no adapter or repository implementation', () => {
    const leaked = Object.keys(core).filter((k) => /Sqlite|Memory|Fake|Tempo(Payout)?Chain|AesGcm|RandomIds|SystemClock|openSqlite|Repository$/.test(k))
    expect(leaked).toEqual([])
  })

  it('nothing outside core reaches into core internals (only @payrun/core and @payrun/core/adapters)', () => {
    const outside = [
      ...readdirSync(join(REPO, 'packages')).filter((p) => p !== 'core').map((p) => join(REPO, 'packages', p)),
      ...(statSync(join(REPO, 'apps'), { throwIfNoEntry: false })?.isDirectory()
        ? readdirSync(join(REPO, 'apps')).map((p) => join(REPO, 'apps', p))
        : []),
    ]
    const bad = outside.flatMap((pkg) =>
      files(pkg).flatMap((f) =>
        importsOf(f)
          .filter((spec) => (spec.startsWith('@payrun/core/') && spec !== '@payrun/core/adapters') || resolve(dirname(f), spec).startsWith(CORE))
          .map((spec) => `${relative(REPO, f)} imports ${spec}`),
      ),
    )
    expect(bad).toEqual([])
  })
})

describe('money', () => {
  it('is never handled as a float in src/ (no parseFloat, toFixed, or Number() on amounts)', () => {
    const bad = files(SRC).flatMap((f) => {
      const text = readFileSync(f, 'utf8')
      return [/parseFloat\(/, /\.toFixed\(/, /Number\([^)]*(amount|limit|total|remaining|balance)/i]
        .filter((re) => re.test(text))
        .map((re) => `${relative(CORE, f)} matches ${re}`)
    })
    expect(bad).toEqual([])
  })
})
