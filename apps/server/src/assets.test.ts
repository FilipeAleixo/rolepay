import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prebuiltAssets } from './assets.js'

describe('prebuiltAssets (the client bundle `pnpm build` writes next to dist/main.js)', () => {
  it('serves the file as rolepay.js, and nothing else', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rolepay-assets-')), 'rolepay.js')
    writeFileSync(path, 'console.log("bundle")')
    const assets = prebuiltAssets(path)
    expect(await assets?.get('rolepay.js')).toBe('console.log("bundle")')
    expect(await assets?.get('other.js')).toBeNull()
  })

  it('is null when there is no built file (pnpm dev: the bundle is built on first request)', () => {
    expect(prebuiltAssets(join(tmpdir(), 'no-such-dir', 'rolepay.js'))).toBeNull()
  })
})
