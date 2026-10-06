import { z } from 'zod'
import type { NetworkName } from '../constants/tempo.js'
import {
  type BotKey,
  type BotKeyView,
  type Community,
  CommunitySchema,
  FeeModeSchema,
  type KeyAuthorization,
  type KeyState,
  botKeyContext,
  keyAuthorization,
  toBotKeyView,
} from '../domain/community.js'
import type { Hex } from '../domain/hex.js'
import { type Address, AddressSchema, DiscordIdSchema } from '../domain/ids.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Clock } from '../ports/clock.js'
import type { KeyVault } from '../ports/keyVault.js'
import type { ChainRejection, PayoutChain, RootSigner } from '../ports/payoutChain.js'
import type { CommunityRepository } from '../ports/repositories.js'
import { type InvalidInput, invalidInput } from './common.js'

export type CommunityServiceDeps = {
  communities: CommunityRepository
  chain: PayoutChain
  vault: KeyVault
  clock: Clock
  network: NetworkName
}

export const RegisterCommunityInputSchema = z.object({
  guildId: DiscordIdSchema,
  name: z.string().max(100).nullable().default(null),
  treasuryAddress: AddressSchema,
  payoutToken: AddressSchema,
  feeMode: FeeModeSchema,
  feeToken: AddressSchema.nullable().default(null),
})
export type RegisterCommunityInput = z.input<typeof RegisterCommunityInputSchema>

export const ProvisionBotKeyInputSchema = z.object({
  guildId: DiscordIdSchema,
  /** Spend limit in payout-token micro-units, per period (or once, if no period). */
  limit: z.bigint().positive(),
  periodSeconds: z.number().int().positive().nullable().default(null),
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
  /** Optional on-chain recipient allowlist. Omit or null for none (v1 default). */
  recipients: z.array(AddressSchema).min(1).nullable().default(null),
  /** Required when the community pays fees from a fee budget. */
  feeBudget: z.bigint().positive().nullable().default(null),
})
export type ProvisionBotKeyInput = z.input<typeof ProvisionBotKeyInputSchema>

export type NotFound = { code: 'community_not_found' }
export type KeyStatusView = { key: BotKeyView; state: KeyState }

/**
 * Communities (= Discord guilds) and the bot's access key for each. The treasury's
 * root key never touches this service except as an opaque RootSigner on the
 * dev/CLI path; in production the treasurer signs the authorisation in a browser
 * and `confirmBotKey` picks it up from the chain.
 */
export class CommunityService {
  constructor(private readonly deps: CommunityServiceDeps) {}

  async register(input: RegisterCommunityInput): Promise<Result<Community, InvalidInput | { code: 'already_registered' }>> {
    const parsed = RegisterCommunityInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const now = this.deps.clock.now()
    const candidate = CommunitySchema.safeParse({
      id: parsed.data.guildId,
      name: parsed.data.name,
      network: this.deps.network,
      treasuryAddress: parsed.data.treasuryAddress,
      payoutToken: parsed.data.payoutToken,
      feeMode: parsed.data.feeMode,
      feeToken: parsed.data.feeToken,
      createdAt: now,
      updatedAt: now,
    })
    if (!candidate.success) return invalidInput(candidate.error)
    const inserted = await this.deps.communities.insert(candidate.data)
    if (!inserted.ok) return err({ code: 'already_registered' })
    return ok(candidate.data)
  }

  async get(guildId: string): Promise<Result<Community, NotFound>> {
    const c = await this.deps.communities.get(guildId)
    return c ? ok(c) : err({ code: 'community_not_found' })
  }

  /**
   * Mints a fresh access key for the bot and returns the authorisation the treasury
   * root must sign. The key stays `pending_authorization` until the chain shows it.
   */
  async provisionBotKey(
    input: ProvisionBotKeyInput,
  ): Promise<Result<{ keyAddress: Address; account: Address; authorization: KeyAuthorization }, InvalidInput | NotFound>> {
    const parsed = ProvisionBotKeyInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const p = parsed.data
    const community = await this.deps.communities.get(p.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const now = this.deps.clock.now()
    const issues: string[] = []
    if (p.expiresAt <= Math.floor(now.getTime() / 1000)) issues.push('expiresAt: must be in the future')
    if (community.feeMode === 'fee_budget' && p.feeBudget === null) issues.push('feeBudget: required in fee_budget mode')
    if (issues.length) return err({ code: 'invalid_input', issues })

    const { address, secret } = await this.deps.chain.newAccessKey()
    const key: BotKey = {
      address,
      communityId: community.id,
      sealedSecret: await this.deps.vault.seal(secret, botKeyContext(community.id, address)),
      status: 'pending_authorization',
      policy: {
        token: community.payoutToken,
        limit: p.limit,
        periodSeconds: p.periodSeconds,
        expiresAt: p.expiresAt,
        recipients: p.recipients,
        feeToken: community.feeMode === 'fee_budget' ? community.feeToken : null,
        feeBudget: community.feeMode === 'fee_budget' ? p.feeBudget : null,
      },
      createdAt: now,
      authorizedAt: null,
      revokedAt: null,
    }
    for (const old of await this.deps.communities.listBotKeys(community.id)) {
      if (old.status === 'pending_authorization') await this.deps.communities.saveBotKey({ ...old, status: 'superseded' })
    }
    await this.deps.communities.saveBotKey(key)
    return ok({ keyAddress: address, account: community.treasuryAddress, authorization: keyAuthorization(key.policy) })
  }

  /** Dev/CLI path: the root signer authorises the pending key on chain, then it is confirmed. */
  async authorizeBotKey(input: {
    guildId: string
    root: RootSigner
  }): Promise<Result<{ key: BotKeyView; txHash: Hex }, NotFound | { code: 'no_pending_key' } | ChainRejection | ConfirmError>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const pending = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status === 'pending_authorization')
    if (!pending) return err({ code: 'no_pending_key' })
    const tx = await this.deps.chain.authorizeKey({ root: input.root, accessKey: pending.address, authorization: keyAuthorization(pending.policy) })
    if (!tx.ok) return tx
    const confirmed = await this.confirmBotKey({ guildId: community.id })
    return confirmed.ok ? ok({ key: confirmed.value, txHash: tx.value.txHash }) : confirmed
  }

  /** Marks the pending key active once the chain shows it authorised; supersedes the old active key. */
  async confirmBotKey(input: { guildId: string }): Promise<Result<BotKeyView, NotFound | ConfirmError>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const keys = await this.deps.communities.listBotKeys(community.id)
    const pending = keys.find((k) => k.status === 'pending_authorization')
    if (!pending) return err({ code: 'no_pending_key' })
    const state = await this.readState(community, pending)
    if (state.status !== 'active') return err({ code: 'key_not_authorized_on_chain' })
    for (const old of keys) {
      if (old.status === 'active') await this.deps.communities.saveBotKey({ ...old, status: 'superseded' })
    }
    const active: BotKey = { ...pending, status: 'active', authorizedAt: this.deps.clock.now() }
    await this.deps.communities.saveBotKey(active)
    return ok(toBotKeyView(active))
  }

  /** The current bot key (latest not superseded) and what the chain says about it. */
  async keyStatus(input: { guildId: string }): Promise<Result<KeyStatusView, NotFound | { code: 'no_bot_key' }>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const key = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status !== 'superseded')
    if (!key) return err({ code: 'no_bot_key' })
    return ok({ key: toBotKeyView(key), state: await this.readState(community, key) })
  }

  /** Dev/CLI path: the root signer revokes the active key on chain. Revoked key IDs can never return. */
  async revokeBotKey(input: {
    guildId: string
    root: RootSigner
  }): Promise<Result<{ key: BotKeyView; txHash: Hex }, NotFound | { code: 'no_active_key' } | ChainRejection>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const active = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status === 'active')
    if (!active) return err({ code: 'no_active_key' })
    const tx = await this.deps.chain.revokeKey({ root: input.root, accessKey: active.address })
    if (!tx.ok) return tx
    const revoked: BotKey = { ...active, status: 'revoked', revokedAt: this.deps.clock.now() }
    await this.deps.communities.saveBotKey(revoked)
    return ok({ key: toBotKeyView(revoked), txHash: tx.value.txHash })
  }

  private readState(community: Community, key: BotKey) {
    return this.deps.chain.keyState({
      account: community.treasuryAddress,
      accessKey: key.address,
      token: key.policy.token,
      feeToken: key.policy.feeToken,
    })
  }
}

export type ConfirmError = { code: 'no_pending_key' } | { code: 'key_not_authorized_on_chain' }
