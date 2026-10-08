import { describe, expect, it } from 'vitest'
import { DiscordUsernameSchema, type LinkToken, LinkTokenSchema, checkLinkToken } from './payee.js'

const t0 = new Date('2026-10-06T12:00:00Z')
const token: LinkToken = {
  tokenHash: 'h1',
  communityId: '1094309218049937418',
  discordUserId: '200000000000000001',
  createdAt: t0,
  expiresAt: new Date(t0.getTime() + 30 * 60_000),
  consumedAt: null,
  discordUsername: null,
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

describe("DiscordUsernameSchema (the name a payee's passkey is labelled with)", () => {
  it("accepts Discord's usernames: 2 to 32 lowercase letters, digits, underscores and periods", () => {
    for (const name of ['al', 'alice', 'bob_99', 'carol.k', 'a'.repeat(32)]) expect(DiscordUsernameSchema.safeParse(name).success).toBe(true)
  })

  it('refuses anything else (a display name, a legacy name with a discriminator, brackets that could make two labels read alike)', () => {
    for (const name of ['a', 'a'.repeat(33), 'Alice', 'alice bob', 'bob#1234', 'x) (y', '', 'émile']) expect(DiscordUsernameSchema.safeParse(name).success).toBe(false)
  })

  it('a link stored before usernames were kept reads as no username', () => {
    const { discordUsername: _, ...old } = token
    expect(LinkTokenSchema.parse(old).discordUsername).toBeNull()
  })
})
