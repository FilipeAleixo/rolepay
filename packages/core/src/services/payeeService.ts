import { z } from 'zod'
import type { Community } from '../domain/community.js'
import { preferenceChoices } from '../domain/delivery.js'
import { type Address, AddressSchema, DiscordIdSchema } from '../domain/ids.js'
import { type Payee, checkLinkToken } from '../domain/payee.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { KeyVault } from '../ports/keyVault.js'
import type { CommunityRepository, PayeeRepository } from '../ports/repositories.js'
import { type InvalidInput, invalidInput } from './common.js'

export type PayeeServiceDeps = {
  communities: CommunityRepository
  payees: PayeeRepository
  vault: KeyVault
  ids: IdGenerator
  clock: Clock
  linkTtlSeconds: number
}

const IssueLinkInputSchema = z.object({ guildId: DiscordIdSchema, discordUserId: DiscordIdSchema })
const RegisterInputSchema = z.object({ token: z.string().min(1), address: AddressSchema })

const SetPreferredTokenInputSchema = z.object({ guildId: DiscordIdSchema, discordUserId: DiscordIdSchema, token: AddressSchema.nullable() })
const SetPreferredTokenByAddressInputSchema = z.object({ guildId: DiscordIdSchema, address: AddressSchema, token: AddressSchema.nullable() })

type LinkError = { code: 'link_not_found' } | { code: 'link_expired' } | { code: 'link_already_used' }
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
 * Recipients register BEFORE they are paid: `/payee link` issues a one-time token,
 * the claim page creates a passkey account and calls `register` with its address.
 * Only a keyed fingerprint of the token is stored, so a database reader cannot
 * claim someone's link and redirect their pay.
 */
export class PayeeService {
  constructor(private readonly deps: PayeeServiceDeps) {}

  async issueLink(input: {
    guildId: string
    discordUserId: string
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
    })
    return ok({ token, expiresAt })
  }

  /** For the claim page: who is this link for? Does not consume it. */
  async describeLink(input: {
    token: string
  }): Promise<Result<{ guildId: string; communityName: string | null; discordUserId: string; expiresAt: Date }, LinkError>> {
    const link = await this.deps.payees.getLinkToken(await this.deps.vault.fingerprint(input.token))
    if (!link) return err({ code: 'link_not_found' })
    const usable = checkLinkToken(link, this.deps.clock.now())
    if (!usable.ok) return usable
    const community = await this.deps.communities.get(link.communityId)
    return ok({ guildId: link.communityId, communityName: community?.name ?? null, discordUserId: link.discordUserId, expiresAt: link.expiresAt })
  }

  /** Consumes the link (exactly once) and maps the Discord user to the address. */
  async register(input: { token: string; address: string }): Promise<Result<Payee, InvalidInput | LinkError>> {
    const parsed = RegisterInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const tokenHash = await this.deps.vault.fingerprint(parsed.data.token)
    const link = await this.deps.payees.getLinkToken(tokenHash)
    if (!link) return err({ code: 'link_not_found' })
    const now = this.deps.clock.now()
    const usable = checkLinkToken(link, now)
    if (!usable.ok) return usable
    if (!(await this.deps.payees.consumeLinkToken(tokenHash, now))) return err({ code: 'link_already_used' })
    const existing = await this.deps.payees.get(link.communityId, link.discordUserId)
    const payee: Payee = {
      communityId: link.communityId,
      discordUserId: link.discordUserId,
      address: parsed.data.address,
      // A new address keeps the stablecoin they chose.
      preferredToken: existing?.preferredToken ?? null,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    }
    await this.deps.payees.upsert(payee)
    return ok(payee)
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

  private async savePreference(payee: Payee, token: Address | null): Promise<Payee> {
    const updated: Payee = { ...payee, preferredToken: token, updatedAt: this.deps.clock.now() }
    await this.deps.payees.upsert(updated)
    return updated
  }
}

/** A choice the community can honour, stored as null when it is the payout token (no preference). */
function choose(community: Community, token: Address | null): Result<Address | null, { code: 'token_not_allowed'; choices: Address[] }> {
  if (token === null || token === community.payoutToken) return ok(null)
  const choices = preferenceChoices(community)
  return choices.includes(token) ? ok(token) : err({ code: 'token_not_allowed', choices })
}
