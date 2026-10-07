import { z } from 'zod'
import { AddressSchema, DiscordIdSchema } from '../domain/ids.js'
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

type LinkError = { code: 'link_not_found' } | { code: 'link_expired' } | { code: 'link_already_used' }

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
}
