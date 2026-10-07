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
  type SetupLink,
  type SetupSettings,
  SetupSettingsSchema,
  botKeyContext,
  canChangeApprovalRules,
  keyAuthorization,
  toBotKeyView,
} from '../domain/community.js'
import { keyLacksSwapScope, swapTokensFor } from '../domain/delivery.js'
import type { Hex } from '../domain/hex.js'
import { type Address, AddressSchema, DiscordIdSchema } from '../domain/ids.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
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
  ids: IdGenerator
  /** How long a setup link stays valid. */
  setupLinkTtlSeconds: number
}

export const RegisterCommunityInputSchema = z.object({
  guildId: DiscordIdSchema,
  name: z.string().max(100).nullable().default(null),
  treasuryAddress: AddressSchema,
  payoutToken: AddressSchema,
  feeMode: FeeModeSchema,
  feeToken: AddressSchema.nullable().default(null),
  approverRoleId: DiscordIdSchema.nullable().default(null),
  requireSeparateApprover: z.boolean().default(false),
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

export const IssueSetupLinkInputSchema = z.object({
  guildId: DiscordIdSchema,
  discordUserId: DiscordIdSchema,
  settings: SetupSettingsSchema,
})
export type IssueSetupLinkInput = z.input<typeof IssueSetupLinkInputSchema>

export type NotFound = { code: 'community_not_found' }
export type NotPermitted = { code: 'not_permitted' }
export type SetupLinkError = { code: 'link_not_found' } | { code: 'link_expired' }
export type SetupLinkView = {
  guildId: string
  discordUserId: string
  expiresAt: Date
  settings: SetupSettings
  /** null until the treasurer binds the treasury on the setup page. */
  community: Community | null
}
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
      approverRoleId: parsed.data.approverRoleId,
      requireSeparateApprover: parsed.data.requireSeparateApprover,
      createdAt: now,
      updatedAt: now,
    })
    if (!candidate.success) return invalidInput(candidate.error)
    const inserted = await this.deps.communities.insert(candidate.data)
    if (!inserted.ok) return err({ code: 'already_registered' })
    return ok(candidate.data)
  }

  /**
   * Changes the approver role. Only a member who holds the CURRENT approver role may (with
   * none set yet, one who holds the new role): Manage Server alone cannot make itself the
   * approver. `actorRoleIds` are the caller's roles from the signed interaction.
   */
  async setApproverRole(input: {
    guildId: string
    approverRoleId: string | null
    actorRoleIds: readonly string[]
  }): Promise<Result<Community, InvalidInput | NotFound | NotPermitted>> {
    const role = DiscordIdSchema.nullable().safeParse(input.approverRoleId)
    if (!role.success) return invalidInput(role.error)
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canChangeApprovalRules(community, input.actorRoleIds, role.data)) return err({ code: 'not_permitted' })
    const updated: Community = { ...community, approverRoleId: role.data, updatedAt: this.deps.clock.now() }
    await this.deps.communities.update(updated)
    return ok(updated)
  }

  /** Four eyes on or off: whether a run's creator may approve it. The same rule as the approver role. */
  async setRequireSeparateApprover(input: {
    guildId: string
    value: boolean
    actorRoleIds: readonly string[]
  }): Promise<Result<Community, NotFound | NotPermitted>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canChangeApprovalRules(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const updated: Community = { ...community, requireSeparateApprover: input.value, updatedAt: this.deps.clock.now() }
    await this.deps.communities.update(updated)
    return ok(updated)
  }

  /**
   * AI proposals on or off, and the optional role that may propose besides the approver role.
   * The same rule as the approver role: proposing sends source messages to Anthropic's API and
   * widens who may draft runs, so Manage Server alone cannot change it. Turning them on needs an
   * approver role (otherwise no run could be approved).
   */
  async setAiProposals(input: {
    guildId: string
    enabled?: boolean
    proposerRoleId?: string | null
    actorRoleIds: readonly string[]
  }): Promise<Result<Community, InvalidInput | NotFound | NotPermitted>> {
    const role = DiscordIdSchema.nullable().optional().safeParse(input.proposerRoleId)
    if (!role.success) return invalidInput(role.error)
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (community.approverRoleId === null || !canChangeApprovalRules(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const updated: Community = {
      ...community,
      aiProposals: input.enabled ?? community.aiProposals,
      // Naming the approver role itself as the proposer role means "the approver role only".
      proposerRoleId: role.data === undefined ? community.proposerRoleId : role.data === community.approverRoleId ? null : role.data,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.communities.update(updated)
    return ok(updated)
  }

  async setName(input: { guildId: string; name: string | null }): Promise<Result<Community, InvalidInput | NotFound>> {
    const name = z.string().max(100).nullable().safeParse(input.name)
    if (!name.success) return invalidInput(name.error)
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const updated: Community = { ...community, name: name.data, updatedAt: this.deps.clock.now() }
    await this.deps.communities.update(updated)
    return ok(updated)
  }

  /**
   * Switches how the bot's transactions pay fees. A key authorised without a fee budget
   * cannot pay fees itself, so `keyNeedsFeeBudget` says when the treasury must authorise
   * a new key (the old one keeps working in sponsor mode). The same rule as the approver role:
   * a wrong fee mode stops every run, so Manage Server alone cannot switch it.
   */
  async setFeeMode(input: {
    guildId: string
    feeMode: string
    feeToken: string | null
    actorRoleIds: readonly string[]
  }): Promise<Result<{ community: Community; keyNeedsFeeBudget: boolean }, InvalidInput | NotFound | NotPermitted>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canChangeApprovalRules(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const candidate = CommunitySchema.safeParse({
      ...community,
      feeMode: input.feeMode,
      feeToken: input.feeMode === 'sponsor' ? null : input.feeToken,
      updatedAt: this.deps.clock.now(),
    })
    if (!candidate.success) return invalidInput(candidate.error)
    await this.deps.communities.update(candidate.data)
    const active = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status === 'active')
    const keyNeedsFeeBudget =
      candidate.data.feeMode === 'fee_budget' && (!active || active.policy.feeToken !== candidate.data.feeToken || active.policy.feeBudget === null)
    return ok({ community: candidate.data, keyNeedsFeeBudget })
  }

  /**
   * Pay each person in the stablecoin they prefer, on or off (off by default). Called by the setup
   * page, which has already checked that the caller holds the treasury's passkey session. Runs made
   * while it is on swap on the DEX for people who chose another stablecoin; turning it off pays
   * everyone in the payout token again. `keyNeedsSwapScope` says when the active key was authorised
   * without the swap scope: runs with swaps are then held until the treasurer authorises a new key,
   * whose authorisation includes it (`provisionBotKey`).
   */
  async setPreferredTokens(input: { guildId: string; enabled: boolean }): Promise<Result<{ community: Community; keyNeedsSwapScope: boolean }, NotFound>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const updated: Community = { ...community, preferredTokens: input.enabled, updatedAt: this.deps.clock.now() }
    await this.deps.communities.update(updated)
    const active = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.status === 'active')
    return ok({ community: updated, keyNeedsSwapScope: keyLacksSwapScope(updated, active?.policy ?? null) })
  }

  /**
   * A short-lived link to the treasurer's setup page. The settings register the community
   * when the treasurer binds the treasury there (it has no address until then).
   */
  async issueSetupLink(input: IssueSetupLinkInput): Promise<Result<{ token: string; expiresAt: Date }, InvalidInput>> {
    const parsed = IssueSetupLinkInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { guildId, discordUserId, settings } = parsed.data
    const now = this.deps.clock.now()
    const token = this.deps.ids.linkToken()
    const expiresAt = new Date(now.getTime() + this.deps.setupLinkTtlSeconds * 1000)
    const link: SetupLink = { tokenHash: await this.deps.vault.fingerprint(token), communityId: guildId, discordUserId, settings, createdAt: now, expiresAt }
    await this.deps.communities.insertSetupLink(link)
    return ok({ token, expiresAt })
  }

  async describeSetupLink(input: { token: string }): Promise<Result<SetupLinkView, SetupLinkError>> {
    const link = await this.usableSetupLink(input.token)
    if (!link.ok) return link
    const community = await this.deps.communities.get(link.value.communityId)
    const { communityId, discordUserId, expiresAt, settings } = link.value
    return ok({ guildId: communityId, discordUserId, expiresAt, settings, community })
  }

  /**
   * Binds the treasury the treasurer just created (or signed in to) on the setup page.
   * Registers the community from the link's settings the first time; after that only the
   * same treasury is accepted. The caller (the web layer) proves the address belongs to
   * the passkey in front of it.
   */
  async bindTreasury(input: {
    token: string
    treasuryAddress: string
  }): Promise<Result<Community, SetupLinkError | InvalidInput | { code: 'treasury_mismatch'; treasuryAddress: Address }>> {
    const address = AddressSchema.safeParse(input.treasuryAddress)
    if (!address.success) {
      const link = await this.usableSetupLink(input.token)
      return link.ok ? invalidInput(address.error) : link
    }
    const link = await this.usableSetupLink(input.token)
    if (!link.ok) return link
    const guildId = link.value.communityId
    const existing = await this.deps.communities.get(guildId)
    if (!existing) {
      const registered = await this.register({ guildId, treasuryAddress: address.data, ...link.value.settings })
      if (registered.ok) return registered
      if (registered.error.code !== 'already_registered') return err(registered.error)
    }
    const current = existing ?? (await this.deps.communities.get(guildId))
    if (!current) throw new Error(`community ${guildId} vanished while binding its treasury`)
    if (current.treasuryAddress !== address.data) return err({ code: 'treasury_mismatch', treasuryAddress: current.treasuryAddress })
    return ok(current)
  }

  private async usableSetupLink(token: string): Promise<Result<SetupLink, SetupLinkError>> {
    const link = await this.deps.communities.getSetupLink(await this.deps.vault.fingerprint(token))
    if (!link) return err({ code: 'link_not_found' })
    if (this.deps.clock.now().getTime() >= link.expiresAt.getTime()) return err({ code: 'link_expired' })
    return ok(link)
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
        ...preferredTokenPolicy(community),
      },
      createdAt: now,
      authorizedAt: null,
      revokedAt: null,
    }
    for (const old of await this.deps.communities.listBotKeys(community.id)) {
      if (old.status === 'pending_authorization') await this.deps.communities.saveBotKey({ ...old, status: 'superseded', sealedSecret: null })
    }
    await this.deps.communities.saveBotKey(key)
    return ok({ keyAddress: address, account: community.treasuryAddress, authorization: keyAuthorization(key.policy) })
  }

  /**
   * Dev/CLI path: the root signer revokes every other key still live on chain, authorises the
   * newest pending key, then it is confirmed. (The setup page does both in one transaction.)
   */
  async authorizeBotKey(input: {
    guildId: string
    root: RootSigner
  }): Promise<Result<{ key: BotKeyView; txHash: Hex }, NotFound | { code: 'no_pending_key' } | ChainRejection | ConfirmError>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const keys = await this.deps.communities.listBotKeys(community.id)
    const pending = keys.find((k) => k.status === 'pending_authorization')
    if (!pending) return err({ code: 'no_pending_key' })
    for (const old of keys) {
      if (old === pending || old.status === 'revoked' || (await this.readState(community, old)).status !== 'active') continue
      const revoked = await this.deps.chain.revokeKey({ root: input.root, accessKey: old.address })
      if (!revoked.ok) return revoked
    }
    const tx = await this.deps.chain.authorizeKey({ root: input.root, accessKey: pending.address, authorization: keyAuthorization(pending.policy) })
    if (!tx.ok) return tx
    const confirmed = await this.confirmBotKey({ guildId: community.id, keyAddress: pending.address })
    return confirmed.ok ? ok({ key: confirmed.value, txHash: tx.value.txHash }) : confirmed
  }

  /**
   * Marks the pending key the treasurer authorised (named by address, never "the newest") active
   * once the chain shows it. Every other key is retired: revoked if the chain shows it revoked
   * (the setup page revokes the old key in the same transaction), otherwise superseded. Either
   * way its sealed secret is destroyed, so the server can never sign with it again. A superseded
   * key that is still live on chain stays in `listKeys`, for the treasurer to revoke.
   */
  async confirmBotKey(input: { guildId: string; keyAddress: string }): Promise<Result<BotKeyView, NotFound | ConfirmError>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const keys = await this.deps.communities.listBotKeys(community.id)
    const pending = keys.find((k) => k.status === 'pending_authorization' && k.address === input.keyAddress.toLowerCase())
    if (!pending) return err({ code: 'no_pending_key' })
    const state = await this.readState(community, pending)
    if (state.status !== 'active') return err({ code: 'key_not_authorized_on_chain' })
    const now = this.deps.clock.now()
    for (const old of keys) {
      if (old === pending || old.status === 'revoked') continue
      const revokedOnChain = (await this.readState(community, old)).status === 'revoked'
      await this.deps.communities.saveBotKey({
        ...old,
        status: revokedOnChain ? 'revoked' : 'superseded',
        revokedAt: revokedOnChain ? now : old.revokedAt,
        sealedSecret: null,
      })
    }
    const active: BotKey = { ...pending, status: 'active', authorizedAt: now }
    await this.deps.communities.saveBotKey(active)
    return ok(toBotKeyView(active))
  }

  /**
   * The bot key that matters, and what the chain says about it: the active key if there is one
   * (a newer key waiting for authorisation never hides it), else the newest one not superseded.
   */
  async keyStatus(input: { guildId: string }): Promise<Result<KeyStatusView, NotFound | { code: 'no_bot_key' }>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const keys = await this.deps.communities.listBotKeys(community.id)
    const key = keys.find((k) => k.status === 'active') ?? keys.find((k) => k.status !== 'superseded')
    if (!key) return err({ code: 'no_bot_key' })
    return ok({ key: toBotKeyView(key), state: await this.readState(community, key) })
  }

  /** What the treasury holds in the payout token right now (reads the chain; throws on an RPC failure). */
  async treasuryBalance(input: { guildId: string }): Promise<Result<{ address: Address; token: Address; balance: bigint }, NotFound>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const balance = await this.deps.chain.balanceOf({ token: community.payoutToken, account: community.treasuryAddress })
    return ok({ address: community.treasuryAddress, token: community.payoutToken, balance })
  }

  /**
   * Every key not yet known to be revoked, newest first, each with what the chain says now. The
   * setup page lists the ones live on chain (active, or superseded but not revoked) for revoking.
   */
  async listKeys(input: { guildId: string }): Promise<Result<KeyStatusView[], NotFound>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const keys = (await this.deps.communities.listBotKeys(community.id)).filter((k) => k.status !== 'revoked')
    return ok(await Promise.all(keys.map(async (k) => ({ key: toBotKeyView(k), state: await this.readState(community, k) }))))
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
    const revoked: BotKey = { ...active, status: 'revoked', revokedAt: this.deps.clock.now(), sealedSecret: null }
    await this.deps.communities.saveBotKey(revoked)
    return ok({ key: toBotKeyView(revoked), txHash: tx.value.txHash })
  }

  /**
   * The treasury revoked one of the community's keys itself (the setup page signs the revoke
   * with the passkey): the active key or any other one still live on chain. Marks it revoked
   * once the chain shows it, never on the caller's word, and destroys its sealed secret.
   */
  async confirmRevocation(input: {
    guildId: string
    keyAddress: string
  }): Promise<Result<BotKeyView, NotFound | { code: 'key_not_found' } | { code: 'key_not_revoked_on_chain' }>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const key = (await this.deps.communities.listBotKeys(community.id)).find((k) => k.address === input.keyAddress.toLowerCase() && k.status !== 'revoked')
    if (!key) return err({ code: 'key_not_found' })
    const state = await this.readState(community, key)
    if (state.status !== 'revoked') return err({ code: 'key_not_revoked_on_chain' })
    const revoked: BotKey = { ...key, status: 'revoked', revokedAt: this.deps.clock.now(), sealedSecret: null }
    await this.deps.communities.saveBotKey(revoked)
    return ok(toBotKeyView(revoked))
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

/** The swap scope a new key carries: only when the community pays people in their preferred stablecoin (`preferredTokenGrants`). */
function preferredTokenPolicy(community: Community): { swapTokens?: Address[] } {
  const tokens = community.preferredTokens ? swapTokensFor(community) : []
  return tokens.length ? { swapTokens: tokens } : {}
}
