import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { ViemMessageSignatures } from './messageSignatures.js'

const signatures = new ViemMessageSignatures()
const account = privateKeyToAccount(generatePrivateKey())

describe('ViemMessageSignatures (who signed a personal message: secp256k1 accounts, offline)', () => {
  it('recovers the account that signed, from the signature and the message alone', async () => {
    const message = 'Rolepay on web.rolepay.app: pay me\nin two lines'
    const signature = await account.signMessage({ message })
    expect(await signatures.recover(message, signature)).toEqual({ ok: true, value: account.address.toLowerCase() })
  })

  it('a different message or a flipped bit names someone else, never the claimed signer', async () => {
    const signature = await account.signMessage({ message: 'one' })
    const other = await signatures.recover('two', signature)
    expect(other.ok && other.value).not.toBe(account.address.toLowerCase())
    const flipped = `${signature.slice(0, 10)}${signature[10] === 'a' ? 'b' : 'a'}${signature.slice(11)}`
    const r = await signatures.recover('one', flipped)
    expect(r.ok ? r.value : r.error.code).not.toBe(account.address.toLowerCase())
  })

  it('refuses what is not a 65-byte signature as malformed', async () => {
    const good = await account.signMessage({ message: 'one' })
    for (const bad of ['', '0x', 'hello', good.slice(2), `${good}0`, good.slice(0, 130), `0x${'00'.repeat(65)}`, `${good.slice(0, 130)}05`, `0x${'zz'.repeat(65)}`]) {
      expect(await signatures.recover('one', bad)).toEqual({ ok: false, error: { code: 'malformed_signature' } })
    }
  })

  it("says plainly that a smart-contract or Tempo passkey signature is not supported yet (longer than 65 bytes)", async () => {
    // A Tempo P256 account's signature is an envelope (type byte, r, s, public key), not an EOA's 65 bytes.
    const p256 = Account.fromP256(`0x${'01'.repeat(32)}`)
    const envelope = await p256.signMessage({ message: 'one' })
    expect((envelope.length - 2) / 2).toBeGreaterThan(65)
    expect(await signatures.recover('one', envelope)).toEqual({ ok: false, error: { code: 'unsupported_signature' } })
    // ERC-6492 (a counterfactual smart account) wraps its signature with a magic suffix.
    const erc6492 = `0x${'ab'.repeat(200)}${'6492'.repeat(16)}`
    expect(await signatures.recover('one', erc6492)).toEqual({ ok: false, error: { code: 'unsupported_signature' } })
  })
})
