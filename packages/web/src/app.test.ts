import { describe, expect, it } from 'vitest'
import { createRolepay } from '@rolepay/core'
import { FakePayoutChain, ManualClock, MemoryKeyValueStore, PlainKeyVault, SequentialIds, createMemoryRepositories } from '@rolepay/core/adapters'
import { webHarness } from '../test/harness.js'
import { createWebApp } from './app.js'
import { TokenBucketLimiter } from './rateLimit.js'
import { FakeDiscordOAuth, FakeGuildMembers, FakePasskeySessions, staticAssets } from './testing/index.js'

describe('the web app', () => {
  it('serves the client bundle compressed when the browser accepts it, and 404 for anything else under /assets', async () => {
    const h = webHarness()
    const res = await h.send('/assets/rolepay.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect((await h.send('/assets/other.js')).status).toBe(404)
  })

  it('serves the fonts (woff2, cached for good) and their SIL Open Font License texts from this origin, and nothing else under /assets/fonts', async () => {
    const h = webHarness()
    for (const name of ['lora-latin-400-normal.woff2', 'montserrat-latin-400-normal.woff2', 'montserrat-latin-500-normal.woff2', 'montserrat-latin-600-normal.woff2']) {
      const res = await h.send(`/assets/fonts/${name}`, { headers: { 'accept-encoding': 'gzip' } })
      expect(res.status, name).toBe(200)
      expect(res.headers.get('content-type')).toBe('font/woff2')
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(res.headers.get('content-encoding')).toBeNull() // woff2 is compressed already
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe('wOF2')
    }
    for (const name of ['Lora-OFL.txt', 'Montserrat-OFL.txt']) {
      const res = await h.send(`/assets/fonts/${name}`)
      expect(res.status, name).toBe(200)
      expect(await res.text()).toMatch(/SIL Open Font License, Version 1\.1/)
    }
    expect((await h.send('/assets/fonts/other.woff2')).status).toBe(404)
    expect((await h.send('/assets/fonts/..%2Fpackage.json')).status).toBe(404)
  })

  it('serves the mark as the favicon, and every page links it and shows the mark', async () => {
    const h = webHarness()
    const icon = await h.send('/favicon.svg')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/svg+xml')
    expect(await icon.text()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"><rect [^>]*fill="#4A1B2A"\/>/)
    for (const path of ['/', '/account', '/claim/nope', '/setup/nope']) {
      const html = await (await h.send(path)).text()
      expect(html, path).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
      expect(html, path).toMatch(/<svg class="mark" width="\d+" height="\d+" aria-hidden="true"/)
    }
  })

  it('sends security headers on every page', async () => {
    const h = webHarness()
    const res = await h.send('/claim/nope')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('sends a strict Content-Security-Policy: our own script only, the inline style by hash, and connections only to us, the RPC and the sponsor', async () => {
    const h = webHarness()
    const csp = (await h.send('/claim/nope')).headers.get('content-security-policy') ?? ''
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
    expect(directives['default-src']).toEqual(["'none'"])
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['style-src']?.[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/)
    expect(directives['connect-src']).toEqual(["'self'", 'https://rpc.moderato.tempo.xyz', 'https://sponsor.moderato.tempo.xyz'])
    expect(directives['img-src']).toEqual(["'self'", 'data:'])
    expect(directives['font-src']).toEqual(["'self'"])
    expect(directives['frame-ancestors']).toEqual(["'none'"])
    expect(directives['base-uri']).toEqual(["'none'"])
    expect(directives['object-src']).toEqual(["'none'"])
  })

  it('sends HSTS only on an https origin', async () => {
    expect((await webHarness().send('/claim/nope')).headers.get('strict-transport-security')).toBeNull()
    const clock = new ManualClock()
    const app = createWebApp({
      rolepay: createRolepay({ chain: new FakePayoutChain(), repositories: createMemoryRepositories(), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' }),
      clock,
      sessions: new FakePasskeySessions(),
      assets: staticAssets({}),
      config: { origin: 'https://pay.example.org', rpId: 'pay.example.org', network: 'moderato', rpcUrl: 'https://rpc.moderato.tempo.xyz', sponsorUrl: null, explorerUrl: 'x', botKeyDefaults: { limit: 1n, periodSeconds: 1, validitySeconds: 1, feeBudget: 1n } },
    })
    const res = await app.request('https://pay.example.org/claim/nope')
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' https://rpc.moderato.tempo.xyz;")
  })

  it('hands the WebAuthn handler the public URL, so behind a tunnel (plain http inside) its session cookie is still Secure', async () => {
    const seen: { url: string; method: string; body: string }[] = []
    const clock = new ManualClock()
    const app = createWebApp({
      rolepay: createRolepay({ chain: new FakePayoutChain(), repositories: createMemoryRepositories(), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' }),
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
      rolepay: createRolepay({ chain: new FakePayoutChain(), repositories: createMemoryRepositories(), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' }),
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

  it('rate limits the Discord sign-in (GETs too: each one writes a record or calls Discord) and dashboard actions, never dashboard pages', async () => {
    const clock = new ManualClock()
    const config = { origin: 'https://pay.example.org', rpId: 'pay.example.org', network: 'moderato' as const, rpcUrl: 'x', sponsorUrl: null, explorerUrl: 'x', botKeyDefaults: { limit: 1n, periodSeconds: 1, validitySeconds: 1, feeBudget: 1n } }
    const app = createWebApp({
      rolepay: createRolepay({ chain: new FakePayoutChain(), repositories: createMemoryRepositories(), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' }),
      clock,
      sessions: new FakePasskeySessions(),
      assets: staticAssets({}),
      config,
      rateLimits: { perClient: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 0 }), overall: new TokenBucketLimiter({ capacity: 100, refillPerSecond: 0 }) },
      dashboard: { kv: new MemoryKeyValueStore(clock), oauth: new FakeDiscordOAuth(), members: new FakeGuildMembers() },
    })
    const from = (path: string, method = 'GET') =>
      app.request(`https://pay.example.org${path}`, { method, headers: { origin: 'https://pay.example.org', 'x-forwarded-for': '1.1.1.1' } })
    expect((await from('/auth/discord')).status).toBe(302)
    expect((await from('/auth/discord/callback?state=x')).status).toBe(400)
    expect((await from('/auth/discord')).status).toBe(429)
    expect((await from('/dashboard/1094309218049937418/policies/p/pause', 'POST')).status).not.toBe(429)
    expect((await from('/auth/logout', 'POST')).status).toBe(429)
    for (let i = 0; i < 5; i++) expect((await from('/dashboard')).status).toBe(200)
  })
})
