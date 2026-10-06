import { describe, expect, it } from 'vitest'
import { webHarness } from '../test/harness.js'

describe('the web app', () => {
  it('serves the client bundle compressed when the browser accepts it, and 404 for anything else under /assets', async () => {
    const h = webHarness()
    const res = await h.send('/assets/payrun.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect((await h.send('/assets/other.js')).status).toBe(404)
  })

  it('sends security headers on every page', async () => {
    const h = webHarness()
    const res = await h.send('/claim/nope')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })
})
