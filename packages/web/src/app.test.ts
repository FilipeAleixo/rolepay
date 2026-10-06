import { describe, expect, it } from 'vitest'
import { createPayrun } from '@payrun/core'
import { FakePayoutChain, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@payrun/core/adapters'
import { webHarness } from '../test/harness.js'
import { createWebApp } from './app.js'
import { TokenBucketLimiter } from './rateLimit.js'
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

  it('rate limits the public passkey, claim and setup endpoints per client and overall (429 with Retry-After); GETs and the handler behind are spared', async () => {
    let calls = 0
    const clock = new ManualClock()
    const app = createWebApp({
      payrun: createPayrun({ chain: new FakePayoutChain(), repositories: createMemoryRepositories(), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' }),
      clock,
      sessions: new FakePasskeySessions(),
      assets: staticAssets({}),
      passkeys: { fetch: async () => (calls++, new Response('{}')) },
      config: { origin: 'https://pay.example.org', rpId: 'pay.example.org', network: 'moderato', rpcUrl: 'x', sponsorUrl: null, explorerUrl: 'x', botKeyDefaults: { limit: 1n, periodSeconds: 1, validitySeconds: 1, feeBudget: 1n } },
      rateLimits: { perClient: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 0 }), overall: new TokenBucketLimiter({ capacity: 4, refillPerSecond: 0 }) },
    })
    // Behind the tunnel every request comes from the proxy; the client is the hop it appended last.
    const from = (ip: string, path = '/webauthn/register/options') =>
      app.request(`https://pay.example.org${path}`, { method: 'POST', body: '{}', headers: { origin: 'https://pay.example.org', 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.9, ${ip}` } })
    expect((await from('1.1.1.1')).status).toBe(200)
    expect((await from('1.1.1.1')).status).toBe(200)
    const limited = await from('1.1.1.1')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await limited.json()).toEqual({ ok: false, error: { code: 'rate_limited' } })
    expect(calls).toBe(2)
    expect((await from('2.2.2.2', '/claim/some-token')).status).not.toBe(429)
    expect((await from('3.3.3.3')).status).toBe(200)
    expect((await from('4.4.4.4')).status).toBe(200)
    // The overall budget for the passkey endpoints is spent (claim has its own), whatever the client claims to be.
    expect((await from('5.5.5.5')).status).toBe(429)
    expect((await app.request('https://pay.example.org/claim/nope')).status).toBe(404)
  })
})
