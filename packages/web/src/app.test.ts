import { describe, expect, it } from 'vitest'
import { createPayrun } from '@payrun/core'
import { FakePayoutChain, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@payrun/core/adapters'
import { webHarness } from '../test/harness.js'
import { createWebApp } from './app.js'
import { FakePasskeySessions, staticAssets } from './testing/index.js'

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

  it('hands the WebAuthn handler the public URL, so behind a tunnel (plain http inside) its session cookie is still Secure', async () => {
    const seen: { url: string; method: string; body: string }[] = []
    const clock = new ManualClock()
    const app = createWebApp({
      payrun: createPayrun({ chain: new FakePayoutChain(), repositories: createMemoryRepositories(), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' }),
      clock,
      sessions: new FakePasskeySessions(),
      assets: staticAssets({}),
      passkeys: { fetch: async (req) => (seen.push({ url: req.url, method: req.method, body: await req.text() }), new Response('{}')) },
      config: { origin: 'https://pay.example.org', rpId: 'pay.example.org', network: 'moderato', rpcUrl: 'x', sponsorUrl: null, explorerUrl: 'x', botKeyDefaults: { limit: 1n, periodSeconds: 1, validitySeconds: 1, feeBudget: 1n } },
    })
    await app.request('http://127.0.0.1:8787/webauthn/login/options?x=1', { method: 'POST', body: '{"a":1}', headers: { origin: 'https://pay.example.org', 'content-type': 'application/json' } })
    expect(seen).toEqual([{ url: 'https://pay.example.org/webauthn/login/options?x=1', method: 'POST', body: '{"a":1}' }])
  })
})
