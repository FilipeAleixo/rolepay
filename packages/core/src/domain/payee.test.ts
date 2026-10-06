import { describe, expect, it } from 'vitest'
import { type LinkToken, checkLinkToken } from './payee.js'

const t0 = new Date('2026-10-06T12:00:00Z')
const token: LinkToken = {
  tokenHash: 'h1',
  communityId: '1094309218049937418',
  discordUserId: '200000000000000001',
  createdAt: t0,
  expiresAt: new Date(t0.getTime() + 30 * 60_000),
  consumedAt: null,
}

describe('checkLinkToken', () => {
  it('accepts an unused token before it expires', () => {
    expect(checkLinkToken(token, new Date(t0.getTime() + 60_000))).toEqual({ ok: true, value: undefined })
  })

  it('refuses a used token', () => {
    expect(checkLinkToken({ ...token, consumedAt: t0 }, t0)).toEqual({ ok: false, error: { code: 'link_already_used' } })
  })

  it('refuses at and after the expiry instant', () => {
    expect(checkLinkToken(token, token.expiresAt)).toEqual({ ok: false, error: { code: 'link_expired' } })
  })
})
