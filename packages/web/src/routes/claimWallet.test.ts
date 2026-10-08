// "Use a wallet I already have" over HTTP: a real viem local account plays the wallet (it signs
// exactly what a browser wallet's personal_sign would), and the real core service recovers the
// signer. What it pins: the address registered is the one that signed, the message is bound to this
// server's origin, its chain, the community, the member and a single-use nonce, and anything else
// registers nothing.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { ALICE, GUILD, OTHER_PASSKEY, PASSKEY, claimLink, pageConfig, registeredCommunity, webHarness } from '../../test/harness.js'

const wallet = privateKeyToAccount(generatePrivateKey())
const WALLET = wallet.address.toLowerCase()

async function world(opts: { mainnet?: boolean } = {}) {
  const h = webHarness(opts)
  await registeredCommunity(h)
  const token = await claimLink(h)
  const challenge = async (address: string = wallet.address) => {
    const res = await h.post(`/claim/${token}/wallet/challenge`, { address })
    const body = (await res.json()) as { ok: boolean; message: string; error?: { code: string } }
    return { status: res.status, body }
  }
  const submit = (message: string, signature: string, extra: Record<string, unknown> = {}) => h.post(`/claim/${token}/wallet`, { message, signature, ...extra })
  const payee = () => h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })
  return { h, token, challenge, submit, payee }
}

describe('the claim page: a wallet the payee already has', () => {
  it('registers the address a viem account signed with, as an external address, once', async () => {
    const w = await world()
    const c = await w.challenge()
    expect(c.status).toBe(200)
    const res = await w.submit(c.body.message, await wallet.signMessage({ message: c.body.message }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, address: WALLET, addressKind: 'external', communityName: 'Mods guild' })
    expect(await w.payee()).toMatchObject({ ok: true, value: { address: WALLET, addressKind: 'external' } })
    // The link is spent.
    const again = await w.submit(c.body.message, await wallet.signMessage({ message: c.body.message }))
    expect(again.status).toBe(410)
    expect((await w.challenge()).status).toBe(410)
  })

  it("the message names this server's origin from config (whatever the request's Host says), the network's chain, the community, the member, a nonce and the time", async () => {
    const w = await world()
    const res = await w.h.send(`/claim/${w.token}/wallet/challenge`, { method: 'POST', body: JSON.stringify({ address: wallet.address }), headers: { host: 'evil.example' } })
    const { message } = (await res.json()) as { message: string }
    expect(message.split('\n')[0]).toBe(`Rolepay on localhost:8787: pay me in Mods guild at ${WALLET} on Tempo (chain 42431).`)
    expect(message).toContain(`\nDiscord user: alice (${ALICE})\nOrigin: http://localhost:8787\nClaim nonce: `)
    expect(message).toContain('\nIssued at: 2026-10-06T12:00:00.000Z\n')
    // The mainnet server names its own origin and chain 4217.
    const m = await world({ mainnet: true })
    const main = (await m.challenge()).body.message
    expect(main.split('\n')[0]).toBe(`Rolepay on web.rolepay.app: pay me in Mods guild at ${WALLET} on Tempo (chain 4217).`)
    expect(main).toContain('\nOrigin: https://web.rolepay.app\n')
  })

  it('the address is the one recovered from the signature, never one the page sends', async () => {
    const w = await world()
    const { message } = (await w.challenge()).body
    // An address field, and a passkey session in the same browser, change nothing.
    const res = await w.h.post(`/claim/${w.token}/wallet`, { message, signature: await wallet.signMessage({ message }), address: OTHER_PASSKEY }, PASSKEY)
    expect(await res.json()).toMatchObject({ ok: true, address: WALLET })
    expect(await w.payee()).toMatchObject({ ok: true, value: { address: WALLET, addressKind: 'external' } })
  })

  it('tampering with any field of the message registers nothing', async () => {
    const tamper: [string, (m: string) => string, string][] = [
      ['community', (m) => m.replace('pay me in Mods guild', 'pay me in Other guild'), 'message_mismatch'],
      ['Discord user', (m) => m.replace(`alice (${ALICE})`, 'mallory (200000000000000009)'), 'message_mismatch'],
      ['address', (m) => m.replaceAll(WALLET, '0x2222222222222222222222222222222222222222'), 'signature_mismatch'],
      ['chain', (m) => m.replace('(chain 42431)', '(chain 4217)'), 'wrong_chain'],
      ['origin', (m) => m.replace('Rolepay on localhost:8787', 'Rolepay on evil.example').replace('Origin: http://localhost:8787', 'Origin: https://evil.example'), 'wrong_origin'],
      ['host only', (m) => m.replace('Rolepay on localhost:8787', 'Rolepay on evil.example'), 'malformed_message'],
      ['nonce', (m) => m.replace(/Claim nonce: \S+/, 'Claim nonce: guessed'), 'nonce_mismatch'],
      ['issued at', (m) => m.replace('2026-10-06T12:00:00.000Z', '2026-10-06T11:59:00.000Z'), 'nonce_mismatch'],
      ['an added line', (m) => `${m}\nAlso pay Mallory.`, 'malformed_message'],
    ]
    for (const [field, change, code] of tamper) {
      const w = await world()
      const message = change((await w.challenge()).body.message)
      // Signed by the wallet itself, after the change: the server still refuses.
      const res = await w.submit(message, await wallet.signMessage({ message }))
      expect(res.status, field).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code, field).toBe(code)
      expect((await w.payee()).ok, field).toBe(false)
    }
    // Changed after signing: the signature no longer matches the address the message names.
    const w = await world()
    const { message } = (await w.challenge()).body
    const signature = await wallet.signMessage({ message })
    const res = await w.submit(message.replace('Signing proves', 'Signing shows'), signature)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('malformed_message')
    const swapped = await w.submit(message.replaceAll(WALLET, '0x2222222222222222222222222222222222222222'), signature)
    expect(((await swapped.json()) as { error: { code: string } }).error.code).toBe('signature_mismatch')
    expect((await w.payee()).ok).toBe(false)
  })

  it('a nonce works once: reusing it, even after a failed attempt, fails; a fresh challenge works', async () => {
    const w = await world()
    const { message } = (await w.challenge()).body
    const bad = await w.submit(message, `0x${'11'.repeat(65)}`)
    expect(bad.status).toBe(400)
    const reused = await w.submit(message, await wallet.signMessage({ message }))
    expect(await reused.json()).toEqual({ ok: false, error: { code: 'nonce_mismatch' } })
    const fresh = (await w.challenge()).body.message
    expect((await w.submit(fresh, await wallet.signMessage({ message: fresh }))).status).toBe(200)
  })

  it('a malformed signature, an unsupported signature type and a nonce past ten minutes register nothing', async () => {
    const w = await world()
    const one = (await w.challenge()).body.message
    expect(await (await w.submit(one, 'not a signature')).json()).toEqual({ ok: false, error: { code: 'malformed_signature' } })
    const two = (await w.challenge()).body.message
    expect(await (await w.submit(two, `0x${'ab'.repeat(200)}`)).json()).toEqual({ ok: false, error: { code: 'unsupported_signature' } })
    const three = (await w.challenge()).body.message
    w.h.clock.advance(600)
    expect(await (await w.submit(three, await wallet.signMessage({ message: three }))).json()).toEqual({ ok: false, error: { code: 'nonce_expired' } })
    expect((await w.payee()).ok).toBe(false)
  })

  it('bad bodies, unknown links and cross-site requests are refused', async () => {
    const w = await world()
    expect((await w.h.post(`/claim/${w.token}/wallet/challenge`, { address: 'nope' })).status).toBe(400)
    expect((await w.h.post(`/claim/${w.token}/wallet/challenge`, {})).status).toBe(400)
    expect((await w.h.post(`/claim/${w.token}/wallet`, { message: 1 })).status).toBe(400)
    expect((await w.h.post('/claim/nope/wallet/challenge', { address: WALLET })).status).toBe(404)
    const cross = await w.h.send(`/claim/${w.token}/wallet/challenge`, { method: 'POST', body: JSON.stringify({ address: WALLET }), headers: { origin: 'https://evil.example' } })
    expect(cross.status).toBe(403)
  })

  it('re-claiming switches between a passkey and the wallet, and both ways work through the page', async () => {
    const w = await world()
    expect((await w.h.post(`/claim/${w.token}`, {}, PASSKEY)).status).toBe(200)
    const token = await claimLink(w.h)
    const { message } = (await (await w.h.post(`/claim/${token}/wallet/challenge`, { address: WALLET })).json()) as { message: string }
    expect((await w.h.post(`/claim/${token}/wallet`, { message, signature: await wallet.signMessage({ message }) })).status).toBe(200)
    expect(await w.payee()).toMatchObject({ ok: true, value: { address: WALLET, addressKind: 'external' } })
    const audit = await w.h.rolepay.audit.list({ guildId: GUILD, types: ['payee.address_changed'] })
    expect(audit.ok && audit.value.events.map((e) => e.details)).toEqual([{ fromKind: 'passkey', toKind: 'external' }])
  })

  it('the claim page and the wallet endpoints keep the strict CSP exactly (the wallet is in the page: no new origin)', async () => {
    const w = await world()
    const strict = (await w.h.send('/claim/nope')).headers.get('content-security-policy')
    expect((await w.h.send(`/claim/${w.token}`)).headers.get('content-security-policy')).toBe(strict)
    expect((await w.h.post(`/claim/${w.token}/wallet/challenge`, { address: WALLET })).headers.get('content-security-policy')).toBe(strict)
    expect((await w.h.post(`/claim/${w.token}/wallet`, { message: 'x', signature: '0x' })).headers.get('content-security-policy')).toBe(strict)
    expect(strict).not.toMatch(/frame-src|child-src|wallet\.tempo\.xyz/)
  })
})

describe('the claim page offers both ways, passkey first', () => {
  it('two clear choices and the line on which addresses work', async () => {
    const w = await world()
    const html = await (await w.h.send(`/claim/${w.token}`)).text()
    const create = html.indexOf('>Create my passkey (no wallet needed)</button>')
    const own = html.indexOf('>Use a wallet I already have</button>')
    expect(create).toBeGreaterThan(0)
    expect(own).toBeGreaterThan(create)
    expect(html).toContain('Only an address you control on Tempo. Exchange deposit addresses usually cannot receive on Tempo, and they cannot sign, so they will not work here.')
    expect(html).toMatch(/<section data-step="done-wallet" hidden>[\s\S]*Keep that wallet: Rolepay cannot move or recover money there\.[\s\S]*<\/section>/)
    expect(html).not.toContain('—')
    const config = await pageConfig(await w.h.send(`/claim/${w.token}`))
    expect(config).toMatchObject({ network: 'moderato', explorerUrl: 'https://explore.testnet.tempo.xyz' })
  })
})
