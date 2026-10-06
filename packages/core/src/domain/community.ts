import { z } from 'zod'
import { NETWORK_NAMES, type NetworkName, TRANSFER_WITH_MEMO_SIGNATURE, VALID_BEFORE_SECONDS } from '../constants/tempo.js'
import { type Address, AddressSchema, DiscordIdSchema } from './ids.js'
import type { Micros } from './money.js'
import { type Result, err, ok } from './result.js'

/** How the bot's transactions pay their fee. Never in the payout token from the payout limit. */
export const FEE_MODES = ['sponsor', 'fee_budget'] as const
export const FeeModeSchema = z.enum(FEE_MODES)
export type FeeMode = z.infer<typeof FeeModeSchema>

/** A community is a Discord guild. Its own Tempo account (the treasury) holds the funds. */
export const CommunitySchema = z
  .object({
    id: DiscordIdSchema,
    name: z.string().max(100).nullable(),
    network: z.enum(NETWORK_NAMES as [NetworkName, ...NetworkName[]]),
    treasuryAddress: AddressSchema,
    payoutToken: AddressSchema,
    feeMode: FeeModeSchema,
    /** Required in fee_budget mode: the token the bot pays fees in, under its own limit. */
    feeToken: AddressSchema.nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((c) => c.feeMode !== 'fee_budget' || c.feeToken !== null, 'fee_budget mode needs a fee token')
  .refine((c) => c.feeToken === null || c.feeToken !== c.payoutToken, 'the fee token must differ from the payout token')
export type Community = z.infer<typeof CommunitySchema>

/**
 * What the bot's access key is allowed to do, as authorised by the treasury's root key.
 * `recipients: null` means no on-chain allowlist (v1 default); a list turns it on.
 */
export const KeyPolicySchema = z.object({
  token: AddressSchema,
  limit: z.bigint().positive(),
  periodSeconds: z.number().int().positive().nullable(),
  expiresAt: z.number().int().positive(),
  recipients: z.array(AddressSchema).min(1).nullable(),
  feeToken: AddressSchema.nullable(),
  feeBudget: z.bigint().positive().nullable(),
})
export type KeyPolicy = z.infer<typeof KeyPolicySchema>

export const BOT_KEY_STATUSES = ['pending_authorization', 'active', 'revoked', 'superseded'] as const
export const BotKeyStatusSchema = z.enum(BOT_KEY_STATUSES)
export type BotKeyStatus = z.infer<typeof BotKeyStatusSchema>

/** The bot's access key for one community. The secret is only ever held sealed by the KeyVault. */
export const BotKeySchema = z.object({
  address: AddressSchema,
  communityId: DiscordIdSchema,
  sealedSecret: z.string().min(1),
  status: BotKeyStatusSchema,
  policy: KeyPolicySchema,
  createdAt: z.date(),
  authorizedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
})
export type BotKey = z.infer<typeof BotKeySchema>

/** The key authorisation the root key signs (shape matches viem's `accessKey.authorize`). */
export type KeyAuthorization = {
  expiry: number
  limits: { token: Address; limit: Micros; period?: number }[]
  scopes: { address: Address; selector: string; recipients?: Address[] }[]
}

export function keyAuthorization(p: KeyPolicy): KeyAuthorization {
  const period = p.periodSeconds === null ? {} : { period: p.periodSeconds }
  const limits: KeyAuthorization['limits'] = [{ token: p.token, limit: p.limit, ...period }]
  if (p.feeToken && p.feeBudget) limits.push({ token: p.feeToken, limit: p.feeBudget, ...period })
  const scope = { address: p.token, selector: TRANSFER_WITH_MEMO_SIGNATURE }
  return { expiry: p.expiresAt, limits, scopes: [p.recipients ? { ...scope, recipients: p.recipients } : scope] }
}

/** The bot key as the chain sees it right now. Times are unix seconds of chain time. */
export type KeyState = {
  status: 'active' | 'revoked' | 'expired' | 'not_authorized'
  expiry: number
  remaining: Micros
  periodEnd: number | null
  chainTime: number
  feeBudgetRemaining: Micros | null
}

export type KeyCheckError =
  | { code: 'key_not_authorized' }
  | { code: 'key_revoked' }
  | { code: 'key_expired'; expiry: number }
  | { code: 'key_expires_too_soon'; expiry: number }
  | { code: 'insufficient_limit'; remaining: Micros; needed: Micros; periodEnd: number | null }
  | { code: 'fee_budget_exhausted' }

/** Pre-flight for a run. Revoked or expired keys otherwise fail late with an opaque RPC error. */
export function checkKeyForRun(state: KeyState, run: { total: Micros; needsFeeBudget: boolean }): Result<void, KeyCheckError> {
  if (state.status === 'not_authorized') return err({ code: 'key_not_authorized' })
  if (state.status === 'revoked') return err({ code: 'key_revoked' })
  if (state.status === 'expired') return err({ code: 'key_expired', expiry: state.expiry })
  if (state.expiry <= state.chainTime + VALID_BEFORE_SECONDS) return err({ code: 'key_expires_too_soon', expiry: state.expiry })
  if (state.remaining < run.total)
    return err({ code: 'insufficient_limit', remaining: state.remaining, needed: run.total, periodEnd: state.periodEnd })
  if (run.needsFeeBudget && (state.feeBudgetRemaining ?? 0n) <= 0n) return err({ code: 'fee_budget_exhausted' })
  return ok(undefined)
}

/** A bot key without its sealed secret: the only form that leaves the services. */
export type BotKeyView = Omit<BotKey, 'sealedSecret'>
export const toBotKeyView = ({ sealedSecret: _sealed, ...view }: BotKey): BotKeyView => view

/** Vault context binding a sealed bot secret to its community and key. */
export const botKeyContext = (communityId: string, keyAddress: string) => `bot-key:${communityId}:${keyAddress.toLowerCase()}`
