import { describe, expect, it } from 'vitest'
import { MAX_PASSKEY_NAME_BYTES, payeePasskeyName } from './passkeyNames.js'

const bytes = (s: string) => new TextEncoder().encode(s).length

describe('payeePasskeyName (what a payee passkey is called, in the device list and in the SDK)', () => {
  it('names the community and the person: two payees of one community never share a name', () => {
    expect(payeePasskeyName('Mods guild', 'alice')).toBe('Rolepay: Mods guild (alice)')
    expect(payeePasskeyName('Mods guild', 'bob')).toBe('Rolepay: Mods guild (bob)')
    // A link from before usernames were kept: the Discord ID, unique all the same.
    expect(payeePasskeyName('Mods guild', '200000000000000001')).toBe('Rolepay: Mods guild (200000000000000001)')
  })

  it("stays within WebAuthn's 64 bytes by shortening the community name, never the person", () => {
    const long = payeePasskeyName('A very long community name that goes on and on and on', 'a_rather_long_username_99')
    expect(bytes(long)).toBeLessThanOrEqual(MAX_PASSKEY_NAME_BYTES)
    expect(long).toMatch(/^Rolepay: A very long .*… \(a_rather_long_username_99\)$/)
    // Multi-byte names are cut on a whole character, never inside one.
    const emoji = payeePasskeyName('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉 party club', 'alice')
    expect(bytes(emoji)).toBeLessThanOrEqual(MAX_PASSKEY_NAME_BYTES)
    expect(emoji).not.toContain('�')
    expect(emoji.endsWith('… (alice)')).toBe(true)
    // Different people stay apart when the community part is cut.
    expect(payeePasskeyName('x'.repeat(100), 'alice')).not.toBe(payeePasskeyName('x'.repeat(100), 'bob'))
  })
})
