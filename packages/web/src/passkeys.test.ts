import { MemoryKeyValueStore } from '@payrun/core/adapters'
import { Account, P256 } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { accountsKv, createPasskeys, passkeyAddress } from './passkeys.js'

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
})
