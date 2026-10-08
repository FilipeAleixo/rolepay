import { describe, expect, it } from 'vitest'
import { bundledAssets } from './assets.js'

describe('the client bundle', () => {
  it('builds the browser code (Accounts SDK, viem) into one ES module, once, and serves nothing else', async () => {
    const assets = bundledAssets()
    const js = await assets.get('rolepay.js')
    expect(js).not.toBeNull()
    expect(js?.length).toBeGreaterThan(10_000)
    expect(js).toContain('rolepay-config')
    expect(await assets.get('rolepay.js')).toBe(js) // cached
    expect(await assets.get('other.js')).toBeNull()
    expect(await assets.get('toString')).toBeNull()
  }, 60_000)

  it("builds the dashboard's live script on its own: small, no viem, no passkeys", async () => {
    const js = await bundledAssets().get('live.js')
    expect(js).toContain('data-live')
    expect(js).toContain('EventSource')
    expect(js?.length).toBeLessThan(10_000)
    expect(js).not.toContain('rolepay-config')
  }, 60_000)
})
