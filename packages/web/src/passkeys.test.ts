import { MemoryKeyValueStore } from '@rolepay/core/adapters'
import { Account, P256 } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { accountsKv, createPasskeys, passkeyAddress, withLoginProof } from './passkeys.js'

describe('passkeys (Accounts SDK Handler.webAuthn over core KeyValueStore)', () => {
  it('stores the handler records under a prefix, with ttl and the atomic operations passed through', async () => {
    const store = new MemoryKeyValueStore()
    const kv = accountsKv(store)
    await kv.set('challenge:0xab', 1, { ttl: 300 })
    expect(await store.get('webauthn:challenge:0xab')).toBe(1)
    expect(await kv.create?.('credential:c1', { publicKey: '0x04' })).toBe(true)
    expect(await kv.create?.('credential:c1', { publicKey: '0x05' })).toBe(false)
    expect(await kv.take?.('challenge:0xab')).toBe(1)
    expect(await store.get('webauthn:challenge:0xab')).toBeUndefined()
  })

  it('derives the same Tempo address the browser account has', () => {
    const key = P256.randomPrivateKey()
    const headless = Account.fromHeadlessWebAuthn(key, { rpId: 'localhost', origin: 'http://localhost' })
    const publicKey = Account.fromP256(key).publicKey
    expect(passkeyAddress({ id: 'cred', publicKey })).toBe(headless.address.toLowerCase())
  })

  it('serves registration options bound to the configured relying party, and keeps the challenge', async () => {
    const store = new MemoryKeyValueStore()
    const { handler, sessions } = createPasskeys({ kv: store, origin: 'https://pay.example.org', rpId: 'pay.example.org' })
    const res = await handler.fetch(
      new Request('https://pay.example.org/webauthn/register/options', { method: 'POST', body: JSON.stringify({ name: 'payrun: Mods' }), headers: { 'content-type': 'application/json' } }),
    )
    expect(res.status).toBe(200)
    const { options } = (await res.json()) as { options: { publicKey: { rp: { id: string }; user: { name: string } } } }
    expect(options.publicKey.rp.id).toBe('pay.example.org')
    expect(options.publicKey.user.name).toBe('payrun: Mods')
    expect(await sessions.current(new Request('https://pay.example.org/'))).toBeNull()
    expect(await sessions.current(new Request('https://pay.example.org/', { headers: { cookie: 'accounts_webauthn=forged' } }))).toBeNull()
  })

  it('a session counts as a passkey login only when /webauthn/login (a verified assertion) issued it; a registration session does not (M4)', async () => {
    const store = new MemoryKeyValueStore()
    const { sessions } = createPasskeys({ kv: store, origin: 'https://pay.example.org', rpId: 'pay.example.org' })
    const key = P256.randomPrivateKey()
    const publicKey = Account.fromP256(key).publicKey
    const issuedAt = Math.floor(Date.now() / 1000)
    // Sessions as the Accounts SDK stores them, one from /register and one from /login.
    for (const token of ['tok-register', 'tok-login']) {
      await store.set(`webauthn:session:${token}`, { credentialId: 'cred', publicKey, issuedAt, expiresAt: issuedAt + 3600 })
    }
    const login = withLoginProof({ fetch: async () => new Response('{}', { headers: { 'set-cookie': 'accounts_webauthn=tok-login; Path=/; HttpOnly' } }) }, store, 3600)
    await login.fetch(new Request('https://pay.example.org/webauthn/login', { method: 'POST', body: '{}' }))
    const register = withLoginProof({ fetch: async () => new Response('{}', { headers: { 'set-cookie': 'accounts_webauthn=tok-register; Path=/; HttpOnly' } }) }, store, 3600)
    await register.fetch(new Request('https://pay.example.org/webauthn/register', { method: 'POST', body: '{}' }))

    const read = (token: string, header = 'cookie') =>
      sessions.current(new Request('https://pay.example.org/', { headers: { [header]: header === 'cookie' ? `accounts_webauthn=${token}` : `Bearer ${token}` } }))
    expect(await read('tok-login')).toMatchObject({ proof: 'login', issuedAt, address: passkeyAddress({ id: 'cred', publicKey }) })
    expect(await read('tok-login', 'authorization')).toMatchObject({ proof: 'login' })
    expect(await read('tok-register')).toMatchObject({ proof: 'registration', issuedAt })
    // A failed login marks nothing, and the marker never holds the raw token.
    const failed = withLoginProof({ fetch: async () => new Response('{}', { status: 400, headers: { 'set-cookie': 'accounts_webauthn=tok-register' } }) }, store, 3600)
    await failed.fetch(new Request('https://pay.example.org/webauthn/login', { method: 'POST', body: '{}' }))
    expect(await read('tok-register')).toMatchObject({ proof: 'registration' })
    expect(await store.get('payrun:passkey-login:tok-login')).toBeUndefined()
  })
})
