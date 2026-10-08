import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryAuditLog, MemoryCommunityRepository, MemoryPayeeRepository, MemoryPolicyRunRepository } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import { ViemMessageSignatures } from '../adapters/tempo/messageSignatures.js'
import { community } from '../../test/support/fixtures.js'
import { AuditTrail } from './auditTrail.js'
import { PayeeService } from './payeeService.js'

const GUILD = '1094309218049937418'
const ALICE = '200000000000000001'
const ADDR = '0x1111111111111111111111111111111111111111'

describe('PayeeService', () => {
  let clock: ManualClock
  let payees: MemoryPayeeRepository
  let svc: PayeeService

  beforeEach(async () => {
    clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
    const communities = new MemoryCommunityRepository()
    await communities.insert(community())
    payees = new MemoryPayeeRepository()
    svc = new PayeeService({ communities, payees, vault: new PlainKeyVault(), ids: new SequentialIds(), clock, linkTtlSeconds: 1800, network: 'moderato' })
  })

  const issue = async () => {
    const r = await svc.issueLink({ guildId: GUILD, discordUserId: ALICE })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }

  it('issues a one-time link that expires after the TTL, storing only a fingerprint', async () => {
    const link = await issue()
    expect(link.expiresAt).toEqual(new Date('2026-10-06T12:30:00Z'))
    expect(await payees.getLinkToken(link.token)).toBeNull()
    expect(await payees.getLinkToken(`fp:${link.token}`)).toMatchObject({ communityId: GUILD, discordUserId: ALICE })
  })

  it('refuses links for unknown communities and invalid users', async () => {
    expect(await svc.issueLink({ guildId: '1094309218049937499', discordUserId: ALICE })).toEqual({
      ok: false,
      error: { code: 'community_not_found' },
    })
    expect(await svc.issueLink({ guildId: GUILD, discordUserId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('describes a link for the claim page without consuming it', async () => {
    const link = await issue()
    expect(await svc.describeLink({ token: link.token })).toEqual({
      ok: true,
      value: { guildId: GUILD, communityName: 'Test guild', discordUserId: ALICE, discordUsername: null, expiresAt: link.expiresAt },
    })
    expect(await svc.describeLink({ token: link.token })).toMatchObject({ ok: true })
  })

  it('registers the passkey account address once, then the link is spent', async () => {
    const link = await issue()
    const r = await svc.register({ token: link.token, address: '0x1111111111111111111111111111111111111111' })
    expect(r).toMatchObject({ ok: true, value: { communityId: GUILD, discordUserId: ALICE, address: ADDR } })
    expect(await svc.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: ADDR } })
    expect(await svc.register({ token: link.token, address: ADDR })).toEqual({ ok: false, error: { code: 'link_already_used' } })
    expect(await svc.describeLink({ token: link.token })).toEqual({ ok: false, error: { code: 'link_already_used' } })
  })

  it("keeps the Discord username the link was issued to (it names the payee's passkey), and only a real username", async () => {
    const named = await svc.issueLink({ guildId: GUILD, discordUserId: ALICE, discordUsername: 'alice' })
    if (!named.ok) throw new Error(named.error.code)
    expect(await svc.describeLink({ token: named.value.token })).toMatchObject({ ok: true, value: { discordUserId: ALICE, discordUsername: 'alice' } })
    // A display name or a legacy name is not a username: the link is issued all the same, without it (the page falls back to the ID).
    for (const odd of ['Alice Smith', 'bob#1234', 'x) (y']) {
      const r = await svc.issueLink({ guildId: GUILD, discordUserId: ALICE, discordUsername: odd })
      if (!r.ok) throw new Error(r.error.code)
      expect(await svc.describeLink({ token: r.value.token })).toMatchObject({ ok: true, value: { discordUsername: null } })
    }
  })

  it('refuses expired and unknown links', async () => {
    const link = await issue()
    clock.advance(1800)
    expect(await svc.register({ token: link.token, address: ADDR })).toEqual({ ok: false, error: { code: 'link_expired' } })
    expect(await svc.register({ token: 'link_bogus', address: ADDR })).toEqual({ ok: false, error: { code: 'link_not_found' } })
  })

  it('refuses an invalid address without spending the link', async () => {
    const link = await issue()
    expect(await svc.register({ token: link.token, address: '0x0000000000000000000000000000000000000000' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect((await svc.register({ token: link.token, address: ADDR })).ok).toBe(true)
  })

  it('re-registering through a new link updates the address and keeps registeredAt', async () => {
    await svc.register({ token: (await issue()).token, address: ADDR })
    clock.advance(60)
    const r = await svc.register({ token: (await issue()).token, address: '0x2222222222222222222222222222222222222222' })
    expect(r).toMatchObject({
      ok: true,
      value: { address: '0x2222222222222222222222222222222222222222', registeredAt: new Date('2026-10-06T12:00:00Z') },
    })
  })

  it('lists payees per community and says payee_not_found for strangers', async () => {
    await svc.register({ token: (await issue()).token, address: ADDR })
    expect((await svc.list({ guildId: GUILD })).map((p) => p.discordUserId)).toEqual([ALICE])
    expect(await svc.get({ guildId: GUILD, discordUserId: '200000000000000009' })).toEqual({
      ok: false,
      error: { code: 'payee_not_found' },
    })
  })
})

/**
 * "Use a wallet I already have": the payee proves an address they control by signing the claim
 * message with it, and the address registered is the one recovered from the signature. Real viem
 * accounts sign; the real `ViemMessageSignatures` recovers.
 */
describe('PayeeService: a wallet the payee already has', () => {
  const ORIGIN = 'http://localhost:8787'
  const wallet = privateKeyToAccount(generatePrivateKey())
  const WALLET = wallet.address.toLowerCase()
  const PASSKEY = '0x7777777777777777777777777777777777777777'

  async function world() {
    const clock = new ManualClock(new Date('2026-10-08T12:00:00Z'))
    const communities = new MemoryCommunityRepository()
    await communities.insert(community({ name: 'Mods guild' }))
    const payees = new MemoryPayeeRepository()
    const log = new MemoryAuditLog()
    const audit = new AuditTrail({ log, policyRuns: new MemoryPolicyRunRepository(), clock })
    const deps = { communities, payees, vault: new PlainKeyVault(), ids: new SequentialIds(), clock, linkTtlSeconds: 1800, network: 'moderato' as const, audit }
    const svc = new PayeeService({ ...deps, signatures: new ViemMessageSignatures() })
    const link = async (username: string | null = 'alice') => {
      const r = await svc.issueLink({ guildId: GUILD, discordUserId: ALICE, discordUsername: username })
      if (!r.ok) throw new Error(r.error.code)
      return r.value.token
    }
    const challenge = async (token: string, address = WALLET) => {
      const r = await svc.walletChallenge({ token, address, origin: ORIGIN })
      if (!r.ok) throw new Error(r.error.code)
      return r.value.message
    }
    /** The message with one line changed, as an attacker would edit it before signing. */
    const edit = (message: string, from: string, to: string) => {
      expect(message).toContain(from)
      return message.replace(from, to)
    }
    const events = () => log.query({ guildId: GUILD, types: [], actor: null, policyId: null, runId: null, since: null, until: null, before: null, limit: 100 })
    return { clock, svc, deps, payees, link, challenge, edit, events, sign: (message: string) => wallet.signMessage({ message }) }
  }

  it('issues a single-use nonce bound to the link and the exact message to sign: community, Discord user, address, chain, origin, nonce, time', async () => {
    const w = await world()
    const token = await w.link()
    const r = await w.svc.walletChallenge({ token, address: wallet.address, origin: ORIGIN })
    expect(r).toMatchObject({ ok: true, value: { nonce: expect.any(String), issuedAt: new Date('2026-10-08T12:00:00Z') } })
    if (!r.ok) return
    expect(r.value.message).toBe(
      [
        `Rolepay on localhost:8787: pay me in Mods guild at ${WALLET} on Tempo (chain 42431).`,
        '',
        `Discord user: alice (${ALICE})`,
        `Origin: ${ORIGIN}`,
        `Claim nonce: ${r.value.nonce}`,
        'Issued at: 2026-10-08T12:00:00.000Z',
        '',
        'Signing proves this address is yours. It costs nothing and moves no money.',
      ].join('\n'),
    )
    // The nonce is on the link, nowhere else, and asking again replaces it.
    expect((await w.payees.getLinkToken(`fp:${token}`))?.walletNonce).toBe(r.value.nonce)
    const again = await w.svc.walletChallenge({ token, address: WALLET, origin: ORIGIN })
    expect(again.ok && again.value.nonce).not.toBe(r.value.nonce)
    expect((await w.payees.getLinkToken(`fp:${token}`))?.walletNonce).toBe(again.ok && again.value.nonce)
  })

  it('no challenge for a bad address or a link that cannot be used', async () => {
    const w = await world()
    const token = await w.link()
    expect(await w.svc.walletChallenge({ token, address: '0x0000000000000000000000000000000000000000', origin: ORIGIN })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await w.svc.walletChallenge({ token: 'link_bogus', address: WALLET, origin: ORIGIN })).toEqual({ ok: false, error: { code: 'link_not_found' } })
    w.clock.advance(1800)
    expect(await w.svc.walletChallenge({ token, address: WALLET, origin: ORIGIN })).toEqual({ ok: false, error: { code: 'link_expired' } })
  })

  it('registers the address recovered from the signature as an external address, spends the link, and keeps the stablecoin they chose', async () => {
    const w = await world()
    const token = await w.link()
    const message = await w.challenge(token)
    const r = await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })
    expect(r).toMatchObject({ ok: true, value: { communityId: GUILD, discordUserId: ALICE, address: WALLET, addressKind: 'external' } })
    expect(await w.svc.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: WALLET, addressKind: 'external' } })
    expect((await w.payees.getLinkToken(`fp:${token}`))?.consumedAt).not.toBeNull()
    // Once: the same message and signature again find the link spent.
    expect(await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'link_already_used' } })
  })

  it('a passkey registration is a passkey address', async () => {
    const w = await world()
    expect(await w.svc.register({ token: await w.link(), address: PASSKEY })).toMatchObject({ ok: true, value: { address: PASSKEY, addressKind: 'passkey' } })
  })

  describe('refuses, registering nothing', () => {
    const refused = async (w: Awaited<ReturnType<typeof world>>) => (await w.svc.get({ guildId: GUILD, discordUserId: ALICE })).ok === false

    it('a message with any field changed: the chain, the origin, the community, the Discord user, the nonce, the time, the address', async () => {
      const cases: [string, (m: string, w: Awaited<ReturnType<typeof world>>) => string, string][] = [
        ['wrong_chain', (m, w) => w.edit(m, '(chain 42431)', '(chain 4217)'), 'chain'],
        ['wrong_origin', (m, w) => w.edit(w.edit(m, 'Rolepay on localhost:8787', 'Rolepay on evil.example'), `Origin: ${ORIGIN}`, 'Origin: https://evil.example'), 'origin'],
        ['message_mismatch', (m, w) => w.edit(m, 'pay me in Mods guild', 'pay me in Other guild'), 'community'],
        ['message_mismatch', (m, w) => w.edit(m, `alice (${ALICE})`, `alice (200000000000000002)`), 'user'],
        ['nonce_mismatch', (m, w) => m.replace(/Claim nonce: \S+/, 'Claim nonce: made_up_nonce'), 'nonce'],
        ['nonce_mismatch', (m, w) => w.edit(m, '2026-10-08T12:00:00.000Z', '2026-10-08T12:05:00.000Z'), 'time'],
        ['malformed_message', (m, w) => w.edit(m, 'Rolepay on localhost:8787', 'Rolepay on other.host'), 'host not the origin'],
      ]
      for (const [code, change, what] of cases) {
        const w = await world()
        const token = await w.link()
        const message = change(await w.challenge(token), w)
        const r = await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })
        expect(r.ok ? 'ok' : r.error.code, what).toBe(code)
        expect(await refused(w), what).toBe(true)
      }
    })

    it('a signature over one message sent with another (the address in it is not the signer)', async () => {
      const w = await world()
      const token = await w.link()
      const message = await w.challenge(token)
      // Signed as issued, then the address changed to someone else's: the signer no longer matches the address it names.
      const signature = await w.sign(message)
      const other = w.edit(message, WALLET, '0x2222222222222222222222222222222222222222')
      expect(await w.svc.registerExternal({ token, message: other, signature, origin: ORIGIN })).toEqual({ ok: false, error: { code: 'signature_mismatch' } })
      // A challenge for an address the signer does not hold.
      const w2 = await world()
      const t2 = await w2.link()
      const forOther = await w2.challenge(t2, '0x2222222222222222222222222222222222222222')
      expect(await w2.svc.registerExternal({ token: t2, message: forOther, signature: await w2.sign(forOther), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'signature_mismatch' } })
      expect(await refused(w2)).toBe(true)
    })

    it('a malformed signature, and a signature type not supported yet (a smart-contract or passkey account)', async () => {
      const w = await world()
      const token = await w.link()
      const message = await w.challenge(token)
      expect(await w.svc.registerExternal({ token, message, signature: '0x1234', origin: ORIGIN })).toEqual({ ok: false, error: { code: 'malformed_signature' } })
      const w2 = await world()
      const t2 = await w2.link()
      const m2 = await w2.challenge(t2)
      expect(await w2.svc.registerExternal({ token: t2, message: m2, signature: `0x${'ab'.repeat(130)}`, origin: ORIGIN })).toEqual({ ok: false, error: { code: 'unsupported_signature' } })
      expect(await refused(w2)).toBe(true)
    })

    it('a nonce used once already, even by a failed attempt: each attempt takes it, and the page asks for a new one', async () => {
      const w = await world()
      const token = await w.link()
      const message = await w.challenge(token)
      expect(await w.svc.registerExternal({ token, message, signature: '0x1234', origin: ORIGIN })).toMatchObject({ ok: false, error: { code: 'malformed_signature' } })
      // The same message, now properly signed: its nonce is spent.
      expect(await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'nonce_mismatch' } })
      // An earlier nonce, replaced by a newer challenge, is no good either.
      const first = await w.challenge(token)
      const second = await w.challenge(token)
      expect(await w.svc.registerExternal({ token, message: first, signature: await w.sign(first), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'nonce_mismatch' } })
      expect((await w.svc.registerExternal({ token, message: second, signature: await w.sign(second), origin: ORIGIN })).ok).toBe(true)
    })

    it('a nonce older than ten minutes, an expired link, a used link, an unknown link', async () => {
      const w = await world()
      const token = await w.link()
      const message = await w.challenge(token)
      w.clock.advance(600)
      expect(await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'nonce_expired' } })
      const fresh = await w.challenge(token)
      w.clock.advance(1200)
      expect(await w.svc.registerExternal({ token, message: fresh, signature: await w.sign(fresh), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'link_expired' } })

      const w2 = await world()
      const t2 = await w2.link()
      const m2 = await w2.challenge(t2)
      expect((await w2.svc.register({ token: t2, address: PASSKEY })).ok).toBe(true)
      expect(await w2.svc.registerExternal({ token: t2, message: m2, signature: await w2.sign(m2), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'link_already_used' } })
      expect(await w2.svc.registerExternal({ token: 'link_bogus', message: m2, signature: await w2.sign(m2), origin: ORIGIN })).toEqual({ ok: false, error: { code: 'link_not_found' } })
    })

    it('anything, on a server without a signature checker', async () => {
      const w = await world()
      const plain = new PayeeService(w.deps)
      const token = await w.link()
      expect(await plain.walletChallenge({ token, address: WALLET, origin: ORIGIN })).toEqual({ ok: false, error: { code: 'not_configured' } })
      expect(await plain.registerExternal({ token, message: 'x', signature: '0x', origin: ORIGIN })).toEqual({ ok: false, error: { code: 'not_configured' } })
    })
  })

  it('a link that kept no username: the message names the Discord ID alone, and that is what it checks', async () => {
    const w = await world()
    const token = await w.link(null)
    const message = await w.challenge(token)
    expect(message).toContain(`\nDiscord user: ${ALICE}\n`)
    expect((await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })).ok).toBe(true)
  })

  it('re-claiming through a new link may switch between a passkey and a wallet, each switch audited with the kinds only (content-free); the first registration and an unchanged one are not', async () => {
    const w = await world()
    expect((await w.svc.register({ token: await w.link(), address: PASSKEY })).ok).toBe(true)
    expect(await w.events()).toEqual([])
    await w.svc.setPreferredToken({ guildId: GUILD, discordUserId: ALICE, token: null })

    const token = await w.link()
    const message = await w.challenge(token)
    expect(await w.svc.registerExternal({ token, message, signature: await w.sign(message), origin: ORIGIN })).toMatchObject({ ok: true, value: { address: WALLET, addressKind: 'external', registeredAt: new Date('2026-10-08T12:00:00Z') } })
    w.clock.advance(60)
    expect((await w.svc.register({ token: await w.link(), address: PASSKEY })).ok).toBe(true)
    expect((await w.svc.register({ token: await w.link(), address: PASSKEY })).ok).toBe(true) // the same again: no change

    const events = await w.events()
    expect(events.map((e) => [e.type, e.actor, e.details])).toEqual([
      ['payee.address_changed', ALICE, { fromKind: 'external', toKind: 'passkey' }],
      ['payee.address_changed', ALICE, { fromKind: 'passkey', toKind: 'external' }],
    ])
    // No address, no name, nothing anyone wrote: kinds only.
    expect(JSON.stringify(events)).not.toMatch(/0x[0-9a-f]{40}|alice|Mods/i)
    expect(await w.svc.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: PASSKEY, addressKind: 'passkey' } })
  })
})
