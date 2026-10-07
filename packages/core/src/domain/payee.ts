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

/** A one-time registration link. Only a keyed fingerprint of the token is stored. */
export const LinkTokenSchema = z.object({
  tokenHash: z.string().min(1),
  communityId: DiscordIdSchema,
  discordUserId: DiscordIdSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
  consumedAt: z.date().nullable(),
})
export type LinkToken = z.infer<typeof LinkTokenSchema>

export type LinkTokenError = { code: 'link_already_used' } | { code: 'link_expired' }

export function checkLinkToken(token: LinkToken, now: Date): Result<void, LinkTokenError> {
  if (token.consumedAt !== null) return err({ code: 'link_already_used' })
  if (now.getTime() >= token.expiresAt.getTime()) return err({ code: 'link_expired' })
  return ok(undefined)
}
