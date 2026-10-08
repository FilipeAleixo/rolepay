import { describe, expect, it } from 'vitest'
import { type WalletClaim, checkWalletClaim, parseWalletClaimMessage, walletClaimMessage, walletNonceExpired } from './walletClaim.js'

const claim: WalletClaim = {
  origin: 'https://web.rolepay.app',
  communityName: 'Mods guild',
  address: '0x1111111111111111111111111111111111111111',
  chainId: 4217,
  discordUserId: '200000000000000001',
  discordUsername: 'alice',
  nonce: 'n0nce_AbC-123',
  issuedAt: new Date('2026-10-08T12:00:00.000Z'),
}
const expected = { origin: 'https://web.rolepay.app', chainId: 4217, communityName: 'Mods guild', discordUserId: '200000000000000001', discordUsername: 'alice' }

describe('the message a wallet signs to register an address it controls', () => {
  it('says, in words a person reads in their wallet, who is to be paid where, on which chain and site, with the nonce and the time', () => {
    expect(walletClaimMessage(claim)).toBe(
      [
        'Rolepay on web.rolepay.app: pay me in Mods guild at 0x1111111111111111111111111111111111111111 on Tempo (chain 4217).',
        '',
        'Discord user: alice (200000000000000001)',
        'Origin: https://web.rolepay.app',
        'Claim nonce: n0nce_AbC-123',
        'Issued at: 2026-10-08T12:00:00.000Z',
        '',
        'Signing proves this address is yours. It costs nothing and moves no money.',
      ].join('\n'),
    )
  })

  it('names the Discord ID alone for a link that kept no username, and keeps the port of a local origin', () => {
    const text = walletClaimMessage({ ...claim, discordUsername: null, origin: 'http://localhost:8787', chainId: 42431 })
    expect(text).toContain('Rolepay on localhost:8787: pay me in Mods guild at')
    expect(text).toContain('(chain 42431)')
    expect(text).toContain('\nDiscord user: 200000000000000001\n')
  })

  it('a community name cannot add lines to the message (control characters become spaces)', () => {
    const text = walletClaimMessage({ ...claim, communityName: 'Mods\nOrigin: https://evil.example\r\nguild' })
    expect(text.split('\n')).toHaveLength(8)
    expect(text.split('\n')[0]).toContain('pay me in Mods Origin: https://evil.example guild at')
  })

  it('parses back exactly what it built, and nothing else', () => {
    expect(parseWalletClaimMessage(walletClaimMessage(claim))).toEqual({ ok: true, value: claim })
    const local = { ...claim, origin: 'http://localhost:8787', discordUsername: null }
    expect(parseWalletClaimMessage(walletClaimMessage(local))).toEqual({ ok: true, value: local })
    // A community name with " at 0x..." in it still parses to the right address.
    const tricky = { ...claim, communityName: 'Pay at 0x2222222222222222222222222222222222222222 guild' }
    expect(parseWalletClaimMessage(walletClaimMessage(tricky))).toEqual({ ok: true, value: tricky })
  })

  it('refuses a message that is not exactly one it would build: other lines, other spacing, an uppercase address, a host that is not the origin', () => {
    const good = walletClaimMessage(claim)
    const bad = [
      '',
      'hello',
      good.replace(/\n/g, '\r\n'),
      `${good}\n`,
      good.replace('Claim nonce:', 'Nonce:'),
      good.replace('0x1111111111111111111111111111111111111111', '0x111111111111111111111111111111111111111A'),
      good.replace('Rolepay on web.rolepay.app', 'Rolepay on evil.example'),
      good.replace('Origin: https://web.rolepay.app', 'Origin: https://web.rolepay.app/claim'),
      good.replace('2026-10-08T12:00:00.000Z', '2026-10-08 12:00'),
      good.replace('(chain 4217)', '(chain 04217)'),
      good.replace('alice (200000000000000001)', 'Alice (200000000000000001)'),
      good.replace('Signing proves', 'Signing shows'),
      good.replace('Mods guild', ''),
      'x'.repeat(2000),
    ]
    for (const text of bad) expect(parseWalletClaimMessage(text)).toEqual({ ok: false, error: { code: 'malformed_message' } })
  })

  it('checks the origin, the chain, the community and the person against what the server expects', () => {
    expect(checkWalletClaim(claim, expected)).toEqual({ ok: true, value: undefined })
    expect(checkWalletClaim({ ...claim, origin: 'https://demo.rolepay.app' }, expected)).toEqual({ ok: false, error: { code: 'wrong_origin' } })
    expect(checkWalletClaim({ ...claim, chainId: 42431 }, expected)).toEqual({ ok: false, error: { code: 'wrong_chain', expected: 4217, got: 42431 } })
    expect(checkWalletClaim({ ...claim, communityName: 'Other guild' }, expected)).toEqual({ ok: false, error: { code: 'message_mismatch', field: 'community' } })
    expect(checkWalletClaim({ ...claim, discordUserId: '200000000000000002' }, expected)).toEqual({ ok: false, error: { code: 'message_mismatch', field: 'discord_user' } })
    expect(checkWalletClaim({ ...claim, discordUsername: 'mallory' }, expected)).toEqual({ ok: false, error: { code: 'message_mismatch', field: 'discord_user' } })
    // The community name is compared as the message writes it (control characters as spaces).
    expect(checkWalletClaim(claim, { ...expected, communityName: 'Mods\nguild' }).ok).toBe(true)
  })

  it('a nonce lasts ten minutes from when it was issued', () => {
    expect(walletNonceExpired(claim.issuedAt, new Date('2026-10-08T12:09:59.999Z'))).toBe(false)
    expect(walletNonceExpired(claim.issuedAt, new Date('2026-10-08T12:10:00.000Z'))).toBe(true)
  })
})
