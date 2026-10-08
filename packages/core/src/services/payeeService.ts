import { z } from 'zod'
import { NETWORKS, type NetworkName } from '../constants/tempo.js'
import type { Community } from '../domain/community.js'
import { preferenceChoices } from '../domain/delivery.js'
import { type Address, AddressSchema, DiscordIdSchema } from '../domain/ids.js'
import { type AddressKind, DiscordUsernameSchema, type LinkToken, type Payee, checkLinkToken } from '../domain/payee.js'
import { type Result, err, ok } from '../domain/result.js'
import {
  MAX_WALLET_CLAIM_MESSAGE_LENGTH,
  type WalletClaimError,
  checkWalletClaim,
  parseWalletClaimMessage,
  walletClaimMessage,
  walletNonceExpired,
} from '../domain/walletClaim.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { KeyVault } from '../ports/keyVault.js'
import type { MessageSignatures, SignatureProblem } from '../ports/messageSignatures.js'
import type { CommunityRepository, PayeeRepository } from '../ports/repositories.js'
import type { AuditTrail } from './auditTrail.js'
import { type InvalidInput, invalidInput } from './common.js'

export type PayeeServiceDeps = {
  communities: CommunityRepository
  payees: PayeeRepository
  vault: KeyVault
  ids: IdGenerator
  clock: Clock
  linkTtlSeconds: number
  /** The chain a wallet claim must name (its chain ID). */
  network: NetworkName
  /** Who signed a wallet claim. Without it, "use a wallet I already have" answers `not_configured`. */
  signatures?: MessageSignatures | null
  /** `payee.address_changed` when a re-claim moves someone's pay. */
  audit?: AuditTrail
}

const IssueLinkInputSchema = z.object({ guildId: DiscordIdSchema, discordUserId: DiscordIdSchema, discordUsername: z.string().nullable().optional() })
const RegisterInputSchema = z.object({ token: z.string().min(1), address: AddressSchema })

const SetPreferredTokenInputSchema = z.object({ guildId: DiscordIdSchema, discordUserId: DiscordIdSchema, token: AddressSchema.nullable() })
const SetPreferredTokenByAddressInputSchema = z.object({ guildId: DiscordIdSchema, address: AddressSchema, token: AddressSchema.nullable() })

const OriginSchema = z.string().refine((o) => URL.canParse(o) && new URL(o).origin === o && /^https?:$/.test(new URL(o).protocol), 'expected an origin such as https://web.rolepay.app')
const WalletChallengeInputSchema = z.object({ token: z.string().min(1), address: AddressSchema, origin: OriginSchema })
const RegisterExternalInputSchema = z.object({
  token: z.string().min(1),
  message: z.string().min(1).max(MAX_WALLET_CLAIM_MESSAGE_LENGTH),
  signature: z.string().min(1).max(20_000),
  origin: OriginSchema,
})

type LinkError = { code: 'link_not_found' } | { code: 'link_expired' } | { code: 'link_already_used' }
type NotConfigured = { code: 'not_configured' }
/**
 * Why a wallet claim registered nothing. `nonce_mismatch`: not the link's live nonce (made up,
 * replaced by a newer one, or already taken by an earlier attempt); `signature_mismatch`: the
 * signature is valid but someone other than the address in the message signed it.
 */
export type WalletProofError =
  | WalletClaimError
  | SignatureProblem
  | { code: 'nonce_mismatch' }
  | { code: 'nonce_expired' }
  | { code: 'signature_mismatch' }
export type PreferenceError = InvalidInput | { code: 'community_not_found' } | { code: 'payee_not_found' } | { code: 'token_not_allowed'; choices: Address[] }

/**
 * Where one address is paid, for the payee's own account page: per community, its payout token, the
 * stablecoins they may choose from (the payout token first), whether the community has preferred
 * stablecoins on, and their current choice (null = the payout token).
 */
export type PayeeRegistration = {
  guildId: string
  communityName: string | null
  discordUserId: string
  payoutToken: Address
  preferredToken: Address | null
  choices: Address[]
  enabled: boolean
}

/**
 * Recipients register BEFORE they are paid: `/payee link` issues a one-time token, and the claim
 * page either creates a passkey account and calls `register` with its address (from the verified
 * passkey session), or proves a wallet the payee already has with a signature (`walletChallenge`,
 * then `registerExternal`, which registers the recovered signer). Only a keyed fingerprint of the
 * token is stored, so a database reader cannot claim someone's link and redirect their pay.
 */
export class PayeeService {
  constructor(private readonly deps: PayeeServiceDeps) {}

  /** `discordUsername`: the caller's username from the signed interaction, which names their passkey on the claim page (kept only if it is one). */
  async issueLink(input: {
    guildId: string
    discordUserId: string
    discordUsername?: string | null
  }): Promise<Result<{ token: string; expiresAt: Date }, InvalidInput | { code: 'community_not_found' }>> {
    const parsed = IssueLinkInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    if (!(await this.deps.communities.get(parsed.data.guildId))) return err({ code: 'community_not_found' })
    const now = this.deps.clock.now()
    const token = this.deps.ids.linkToken()
    const expiresAt = new Date(now.getTime() + this.deps.linkTtlSeconds * 1000)
    await this.deps.payees.insertLinkToken({
      tokenHash: await this.deps.vault.fingerprint(token),
      communityId: parsed.data.guildId,
      discordUserId: parsed.data.discordUserId,
      createdAt: now,
      expiresAt,
      consumedAt: null,
      discordUsername: DiscordUsernameSchema.safeParse(parsed.data.discordUsername).data ?? null,
      walletNonce: null,
      walletNonceIssuedAt: null,
    })
    return ok({ token, expiresAt })
  }

  /** For the claim page: who is this link for? Does not consume it. */
  async describeLink(input: {
    token: string
  }): Promise<Result<{ guildId: string; communityName: string | null; discordUserId: string; discordUsername: string | null; expiresAt: Date }, LinkError>> {
    const link = await this.deps.payees.getLinkToken(await this.deps.vault.fingerprint(input.token))
    if (!link) return err({ code: 'link_not_found' })
    const usable = checkLinkToken(link, this.deps.clock.now())
    if (!usable.ok) return usable
    const community = await this.deps.communities.get(link.communityId)
    return ok({
      guildId: link.communityId,
      communityName: community?.name ?? null,
      discordUserId: link.discordUserId,
      discordUsername: link.discordUsername,
      expiresAt: link.expiresAt,
    })
  }

  /**
   * Consumes the link (exactly once) and maps the Discord user to the address of their passkey
   * account. `address` comes from the passkey session the server verified, never from a page.
   */
  async register(input: { token: string; address: string }): Promise<Result<Payee, InvalidInput | LinkError>> {
    const parsed = RegisterInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const tokenHash = await this.deps.vault.fingerprint(parsed.data.token)
    const link = await this.deps.payees.getLinkToken(tokenHash)
    if (!link) return err({ code: 'link_not_found' })
    const usable = checkLinkToken(link, this.deps.clock.now())
    if (!usable.ok) return usable
    return this.claim(link, parsed.data.address, 'passkey')
  }

  /**
   * "Use a wallet I already have", step one: a fresh nonce for this claim link (replacing any
   * before it) and the exact message the wallet signs, naming this server's `origin` (from its
   * config, never the request), its chain, the community, the member and `address`. The address
   * here only fills in the text: what is registered is whoever the signature says signed it.
   */
  async walletChallenge(input: {
    token: string
    address: string
    origin: string
  }): Promise<Result<{ message: string; nonce: string; issuedAt: Date }, InvalidInput | LinkError | NotConfigured>> {
    if (!this.deps.signatures) return err({ code: 'not_configured' })
    const parsed = WalletChallengeInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const tokenHash = await this.deps.vault.fingerprint(parsed.data.token)
    const link = await this.deps.payees.getLinkToken(tokenHash)
    if (!link) return err({ code: 'link_not_found' })
    const now = this.deps.clock.now()
    const usable = checkLinkToken(link, now)
    if (!usable.ok) return usable
    const community = await this.deps.communities.get(link.communityId)
    if (!community) return err({ code: 'link_not_found' })
    const nonce = this.deps.ids.linkToken()
    if (!(await this.deps.payees.setLinkNonce(tokenHash, nonce, now))) return err({ code: 'link_already_used' })
    const message = walletClaimMessage({
      origin: parsed.data.origin,
      communityName: claimName(community),
      address: parsed.data.address,
      chainId: NETWORKS[this.deps.network].chainId,
      discordUserId: link.discordUserId,
      discordUsername: link.discordUsername,
      nonce,
      issuedAt: now,
    })
    return ok({ message, nonce, issuedAt: now })
  }

  /**
   * "Use a wallet I already have", step two: registers the address that signed `message`, once.
   * The message must be exactly one `walletChallenge` builds, naming the link's live nonce (taken
   * by this attempt whatever happens next, so each nonce is tried once), issued less than ten
   * minutes ago, this server's origin and chain, and the link's community and member; the signature
   * must recover (secp256k1, offline) to the address the message names. The address registered is
   * the recovered one, as an `external` address. Consumes the link like `register`.
   */
  async registerExternal(input: {
    token: string
    message: string
    signature: string
    origin: string
  }): Promise<Result<Payee, InvalidInput | LinkError | NotConfigured | WalletProofError>> {
    const signatures = this.deps.signatures
    if (!signatures) return err({ code: 'not_configured' })
    const parsed = RegisterExternalInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const tokenHash = await this.deps.vault.fingerprint(parsed.data.token)
    const link = await this.deps.payees.getLinkToken(tokenHash)
    if (!link) return err({ code: 'link_not_found' })
    const now = this.deps.clock.now()
    const usable = checkLinkToken(link, now)
    if (!usable.ok) return usable
    const community = await this.deps.communities.get(link.communityId)
    if (!community) return err({ code: 'link_not_found' })
    const claim = parseWalletClaimMessage(parsed.data.message)
    if (!claim.ok) return claim
    const c = claim.value
    // Single use: only the live nonce counts, and naming it spends it, before anything else is checked.
    if (link.walletNonce === null || c.nonce !== link.walletNonce || !(await this.deps.payees.takeLinkNonce(tokenHash, c.nonce))) return err({ code: 'nonce_mismatch' })
    if (link.walletNonceIssuedAt === null || c.issuedAt.getTime() !== link.walletNonceIssuedAt.getTime()) return err({ code: 'nonce_mismatch' })
    if (walletNonceExpired(c.issuedAt, now)) return err({ code: 'nonce_expired' })
    const fits = checkWalletClaim(c, {
      origin: parsed.data.origin,
      chainId: NETWORKS[this.deps.network].chainId,
      communityName: claimName(community),
      discordUserId: link.discordUserId,
      discordUsername: link.discordUsername,
    })
    if (!fits.ok) return fits
    const signer = await signatures.recover(parsed.data.message, parsed.data.signature)
    if (!signer.ok) return signer
    if (signer.value !== c.address) return err({ code: 'signature_mismatch' })
    return this.claim(link, signer.value, 'external')
  }

  async get(input: { guildId: string; discordUserId: string }): Promise<Result<Payee, { code: 'payee_not_found' }>> {
    const p = await this.deps.payees.get(input.guildId, input.discordUserId)
    return p ? ok(p) : err({ code: 'payee_not_found' })
  }

  async list(input: { guildId: string }): Promise<Payee[]> {
    return this.deps.payees.list(input.guildId)
  }

  /**
   * The USD stablecoin a payee wants to receive (`/payee prefer` in Discord, as the caller). The
   * payout token, or null, means no preference. Only a stablecoin the community can deliver
   * (`preferenceChoices`). Stored even while the community has preferred stablecoins off: it then
   * applies once a treasurer turns them on. It never changes where they are paid, only in what.
   */
  async setPreferredToken(input: { guildId: string; discordUserId: string; token: string | null }): Promise<Result<Payee, PreferenceError>> {
    const parsed = SetPreferredTokenInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { guildId, discordUserId, token } = parsed.data
    const community = await this.deps.communities.get(guildId)
    if (!community) return err({ code: 'community_not_found' })
    const payee = await this.deps.payees.get(guildId, discordUserId)
    if (!payee) return err({ code: 'payee_not_found' })
    const chosen = choose(community, token)
    if (!chosen.ok) return chosen
    return ok(await this.savePreference(payee, chosen.value))
  }

  /**
   * The same from a page signed in with the payee's passkey (the claim and account pages): `address`
   * comes from the passkey session the server verified, never from the page, and only that address's
   * registrations in this community change.
   */
  async setPreferredTokenByAddress(input: { guildId: string; address: string; token: string | null }): Promise<Result<Payee[], PreferenceError>> {
    const parsed = SetPreferredTokenByAddressInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { guildId, address, token } = parsed.data
    const community = await this.deps.communities.get(guildId)
    if (!community) return err({ code: 'community_not_found' })
    const mine = (await this.deps.payees.listByAddress(address)).filter((p) => p.communityId === guildId)
    if (mine.length === 0) return err({ code: 'payee_not_found' })
    const chosen = choose(community, token)
    if (!chosen.ok) return chosen
    return ok(await Promise.all(mine.map((p) => this.savePreference(p, chosen.value))))
  }

  /** For a page about one community (the claim page): its payout token, what a payee may choose, and whether preferred stablecoins are on. */
  async preferenceOptions(input: { guildId: string }): Promise<Result<{ payoutToken: Address; choices: Address[]; enabled: boolean }, { code: 'community_not_found' }>> {
    const c = await this.deps.communities.get(input.guildId)
    if (!c) return err({ code: 'community_not_found' })
    return ok({ payoutToken: c.payoutToken, choices: preferenceChoices(c), enabled: c.preferredTokens })
  }

  /** Every community that pays this address (from a verified passkey session), with its choices: see PayeeRegistration. */
  async registrations(input: { address: string }): Promise<PayeeRegistration[]> {
    const address = AddressSchema.safeParse(input.address)
    if (!address.success) return []
    const out: PayeeRegistration[] = []
    for (const p of await this.deps.payees.listByAddress(address.data)) {
      const c = await this.deps.communities.get(p.communityId)
      if (!c) continue
      out.push({
        guildId: c.id,
        communityName: c.name,
        discordUserId: p.discordUserId,
        payoutToken: c.payoutToken,
        preferredToken: p.preferredToken,
        choices: preferenceChoices(c),
        enabled: c.preferredTokens,
      })
    }
    return out
  }

  /**
   * Consumes the link (exactly once) and maps its member to `address`. A re-claim keeps the
   * stablecoin they chose and when they first registered; one that moves their pay (another address
   * or another kind) is audited as `payee.address_changed`, with the kinds only.
   */
  private async claim(link: LinkToken, address: Address, addressKind: AddressKind): Promise<Result<Payee, LinkError>> {
    const now = this.deps.clock.now()
    if (!(await this.deps.payees.consumeLinkToken(link.tokenHash, now))) return err({ code: 'link_already_used' })
    const existing = await this.deps.payees.get(link.communityId, link.discordUserId)
    const payee: Payee = {
      communityId: link.communityId,
      discordUserId: link.discordUserId,
      address,
      addressKind,
      preferredToken: existing?.preferredToken ?? null,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }
    await this.deps.payees.upsert(payee)
    if (existing && (existing.address !== address || existing.addressKind !== addressKind)) {
      // Written as part of the action (an outage throws, like any write); the actor is the member the link was issued to.
      await this.deps.audit?.record({
        communityId: link.communityId,
        type: 'payee.address_changed',
        actor: link.discordUserId,
        details: { fromKind: existing.addressKind, toKind: addressKind },
      })
    }
    return ok(payee)
  }

  private async savePreference(payee: Payee, token: Address | null): Promise<Payee> {
    const updated: Payee = { ...payee, preferredToken: token, updatedAt: this.deps.clock.now() }
    await this.deps.payees.upsert(updated)
    return updated
  }
}

/** The community as a wallet claim names it: its name, or its ID when its name was never read. */
const claimName = (c: Community) => c.name ?? `community ${c.id}`

/** A choice the community can honour, stored as null when it is the payout token (no preference). */
function choose(community: Community, token: Address | null): Result<Address | null, { code: 'token_not_allowed'; choices: Address[] }> {
  if (token === null || token === community.payoutToken) return ok(null)
  const choices = preferenceChoices(community)
  return choices.includes(token) ? ok(token) : err({ code: 'token_not_allowed', choices })
}
