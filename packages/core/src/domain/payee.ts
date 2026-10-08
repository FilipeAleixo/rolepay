import { z } from 'zod'
import { AddressSchema, DiscordIdSchema } from './ids.js'
import { type Result, err, ok } from './result.js'

/**
 * A person this community can pay: a Discord user mapped to the address of the
 * passkey account they registered. Recipients register BEFORE they are paid.
 */
export const PayeeSchema = z.object({
  communityId: DiscordIdSchema,
  discordUserId: DiscordIdSchema,
  address: AddressSchema,
  /**
   * The USD stablecoin they want to receive. null = the community's payout token (the default). Used
   * only while the community has preferred tokens on, and only if it is still one it can deliver.
   */
  preferredToken: AddressSchema.nullable().default(null),
  registeredAt: z.date(),
  updatedAt: z.date(),
})
export type Payee = z.infer<typeof PayeeSchema>

/**
 * A Discord username as Discord issues them today: 2 to 32 lowercase letters, digits, underscores
 * and periods, unique across Discord. It names the payee's passkey on the claim page ("Rolepay:
 * <community> (<username>)"), so no two people's passkeys share a name in one browser. Anything
 * else (a display name, a legacy name with a discriminator) is not kept, and the page names the
 * passkey with the Discord ID instead. The charset has no brackets or spaces, so two labels can
 * never read alike.
 */
export const DiscordUsernameSchema = z.string().regex(/^[a-z0-9_.]{2,32}$/, 'expected a Discord username')

/** A one-time registration link. Only a keyed fingerprint of the token is stored. */
export const LinkTokenSchema = z.object({
  tokenHash: z.string().min(1),
  communityId: DiscordIdSchema,
  discordUserId: DiscordIdSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
  consumedAt: z.date().nullable(),
  /** The username of the member it was issued to, as Discord vouched for it in `/payee link`. null for links from before it was kept. */
  discordUsername: DiscordUsernameSchema.nullable().default(null),
})
export type LinkToken = z.infer<typeof LinkTokenSchema>

export type LinkTokenError = { code: 'link_already_used' } | { code: 'link_expired' }

export function checkLinkToken(token: LinkToken, now: Date): Result<void, LinkTokenError> {
  if (token.consumedAt !== null) return err({ code: 'link_already_used' })
  if (now.getTime() >= token.expiresAt.getTime()) return err({ code: 'link_expired' })
  return ok(undefined)
}
