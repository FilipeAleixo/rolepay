import { z } from 'zod'
import { type Community, type KeyAuthorization, type KeyState, keyAuthorization } from '../domain/community.js'
import { preferredTokenPolicy } from '../domain/delivery.js'
import type { Hex } from '../domain/hex.js'
import { type Address, DiscordIdSchema } from '../domain/ids.js'
import { type Micros, formatAmount } from '../domain/money.js'
import type { Policy } from '../domain/policy/policy.js'
import { type PolicyKey, type PolicyKeyView, policyKeyContext, policySigner, toPolicyKeyView } from '../domain/policy/policyKey.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Clock } from '../ports/clock.js'
import type { KeyVault } from '../ports/keyVault.js'
import type { ChainRejection, PayoutChain, RootSigner } from '../ports/payoutChain.js'
import type { CommunityRepository, PolicyKeyRepository, PolicyRepository } from '../ports/repositories.js'
import type { AuditTrail } from './auditTrail.js'
import { type InvalidInput, invalidInput } from './common.js'
import type { CommunityService } from './communityService.js'

export type PolicyKeyServiceDeps = {
  communities: CommunityRepository
  /** Read only: which policy a key is for. */
  policies: PolicyRepository
  policyKeys: PolicyKeyRepository
  chain: PayoutChain
  vault: KeyVault
  clock: Clock
  audit: AuditTrail
  /** The bot key's budget, for a policy that has no key of its own. */
  communityService: CommunityService
}

export const ProvisionPolicyKeyInputSchema = z.object({
  guildId: DiscordIdSchema,
  policyId: z.string().min(1).max(40),
  /** Spend limit in payout-token micro-units, per period (or once, if no period). */
  limit: z.bigint().positive(),
  periodSeconds: z.number().int().positive().nullable().default(null),
  /** Unix seconds. */
  expiresAt: z.number().int().positive(),
  /** Required when the community pays fees from a fee budget. */
  feeBudget: z.bigint().positive().nullable().default(null),
})
export type ProvisionPolicyKeyInput = z.input<typeof ProvisionPolicyKeyInputSchema>

type Ref = { guildId: string; policyId: string }
type NotFound = { code: 'community_not_found' } | { code: 'policy_not_found' }
export type PolicyKeyConfirmError = { code: 'no_pending_key' } | { code: 'key_not_authorized_on_chain' }

/**
 * Whose budget pays a policy's runs right now, and what the chain says about the policy key that
 * matters: `bot` (no key of its own: the bot key's budget, shared), `own` (its own active key, and
 * only that), `retired` (its own key was revoked: the policy pays nothing until it gets a new one).
 * `key` is the active key, else the retired one, else the newest one waiting for the passkey.
 */
export type PolicyKeyStatus = { policyId: string; signs: 'bot' | 'own' | 'retired'; key: PolicyKeyView | null; state: KeyState | null }

/** What a policy's next run is checked against: whose key, and what it has left (null: it cannot pay). */
export type PolicyBudget = { key: 'bot' | 'policy'; remaining: Micros | null }

/**
 * A standing policy's own access key ("give this policy its own budget"): minted and sealed here,
 * authorised by the treasury passkey on the treasury page (or an in-process root on the dev path),
 * confirmed and revoked only from what the chain shows. Off by default: a policy with no key of its
 * own pays from the bot key as before. Once it has one, its runs are signed with that key only
 * (PayRunService), so a buggy or compromised policy can spend at most that key's limit; revoking it
 * stops that policy alone. Policy keys live apart from the bot key: replacing or revoking the bot
 * key never touches them, and these methods never touch the bot key.
 */
export class PolicyKeyService {
  constructor(private readonly deps: PolicyKeyServiceDeps) {}

  /**
   * Mints a fresh key for the policy and returns the authorisation the treasury root must sign
   * (the same restrictions as the bot key: `keyAuthorization`, with the swap scope for preferred
   * stablecoins while the community has them on). It stays `pending_authorization` until the chain
   * shows it; a key of this policy still waiting is superseded.
   */
  async provision(
    input: ProvisionPolicyKeyInput,
  ): Promise<Result<{ keyAddress: Address; account: Address; authorization: KeyAuthorization }, InvalidInput | NotFound | { code: 'policy_archived' }>> {
    const parsed = ProvisionPolicyKeyInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const p = parsed.data
    const found = await this.find(p)
    if (!found.ok) return found
    const { community, policy } = found.value
    if (policy.status === 'archived') return err({ code: 'policy_archived' })
    const now = this.deps.clock.now()
    const issues: string[] = []
    if (p.expiresAt <= Math.floor(now.getTime() / 1000)) issues.push('expiresAt: must be in the future')
    if (community.feeMode === 'fee_budget' && p.feeBudget === null) issues.push('feeBudget: required in fee_budget mode')
    if (issues.length) return err({ code: 'invalid_input', issues })

    const { address, secret } = await this.deps.chain.newAccessKey()
    const key: PolicyKey = {
      address,
      communityId: community.id,
      policyId: policy.id,
      sealedSecret: await this.deps.vault.seal(secret, policyKeyContext(community.id, policy.id, address)),
      status: 'pending_authorization',
      policy: {
        token: community.payoutToken,
        limit: p.limit,
        periodSeconds: p.periodSeconds,
        expiresAt: p.expiresAt,
        recipients: null,
        feeToken: community.feeMode === 'fee_budget' ? community.feeToken : null,
        feeBudget: community.feeMode === 'fee_budget' ? p.feeBudget : null,
        // With preferred stablecoins on, the same swap scope as the bot key, under this policy's limit.
        ...preferredTokenPolicy(community),
      },
      createdAt: now,
      authorizedAt: null,
      revokedAt: null,
    }
    for (const old of await this.keysOf(community, policy)) {
      if (old.status === 'pending_authorization') await this.deps.policyKeys.save({ ...old, status: 'superseded', sealedSecret: null })
    }
    await this.deps.policyKeys.save(key)
    return ok({ keyAddress: address, account: community.treasuryAddress, authorization: policyKeyAuthorization(key) })
  }

  /**
   * Marks the pending key the treasurer authorised (named by address, never "the newest") active
   * once the chain shows it. The policy's other keys are retired: revoked if the chain shows them
   * revoked (the page revokes them in the same transaction), otherwise superseded, and their sealed
   * secrets destroyed. `actor`: who the treasury page link was issued to (the passkey signed it).
   */
  async confirm(input: Ref & { keyAddress: string; actor: string | null }): Promise<Result<PolicyKeyView, NotFound | PolicyKeyConfirmError>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const { community, policy } = found.value
    const keys = await this.keysOf(community, policy)
    const pending = keys.find((k) => k.status === 'pending_authorization' && k.address === input.keyAddress.toLowerCase())
    if (!pending) return err({ code: 'no_pending_key' })
    if ((await this.readState(community, pending)).status !== 'active') return err({ code: 'key_not_authorized_on_chain' })
    const now = this.deps.clock.now()
    let replaced = 0
    for (const old of keys) {
      if (old === pending || old.status === 'revoked') continue
      if (old.status === 'active') replaced++
      const revokedOnChain = (await this.readState(community, old)).status === 'revoked'
      await this.deps.policyKeys.save({ ...old, status: revokedOnChain ? 'revoked' : 'superseded', revokedAt: revokedOnChain ? now : old.revokedAt, sealedSecret: null })
    }
    const active: PolicyKey = { ...pending, status: 'active', authorizedAt: now }
    await this.deps.policyKeys.save(active)
    const { limit, periodSeconds, expiresAt } = active.policy
    await this.event(policy, 'policy_key.authorized', input.actor, {
      key: active.address,
      limit: formatAmount(limit),
      periodSeconds,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      replaced,
    })
    return ok(toPolicyKeyView(active))
  }

  /**
   * The treasury revoked one of the policy's keys with the passkey. Marks it revoked once the chain
   * shows it, never on the caller's word, and destroys its sealed secret. Only this policy's keys.
   */
  async confirmRevocation(
    input: Ref & { keyAddress: string; actor: string | null },
  ): Promise<Result<PolicyKeyView, NotFound | { code: 'key_not_found' } | { code: 'key_not_revoked_on_chain' }>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const { community, policy } = found.value
    const key = (await this.keysOf(community, policy)).find((k) => k.address === input.keyAddress.toLowerCase() && k.status !== 'revoked')
    if (!key) return err({ code: 'key_not_found' })
    if ((await this.readState(community, key)).status !== 'revoked') return err({ code: 'key_not_revoked_on_chain' })
    return ok(await this.markRevoked(policy, key, input.actor))
  }

  /** Whose budget pays the policy's runs, and the policy key that matters with what the chain says now. */
  async status(input: Ref): Promise<Result<PolicyKeyStatus, NotFound>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const { community, policy } = found.value
    const keys = await this.keysOf(community, policy)
    const signer = policySigner(keys)
    const key = signer.kind === 'bot' ? (keys.find((k) => k.status === 'pending_authorization') ?? null) : signer.key
    const signs = signer.kind
    return ok({ policyId: policy.id, signs, key: key ? toPolicyKeyView(key) : null, state: key && key.status !== 'revoked' ? await this.readState(community, key) : null })
  }

  /** Every key of the policy not yet known to be revoked, newest first, each with what the chain says now. */
  async listKeys(input: Ref): Promise<Result<{ key: PolicyKeyView; state: KeyState }[], NotFound>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const { community, policy } = found.value
    const keys = (await this.keysOf(community, policy)).filter((k) => k.status !== 'revoked')
    return ok(await Promise.all(keys.map(async (k) => ({ key: toPolicyKeyView(k), state: await this.readState(community, k) }))))
  }

  /**
   * What a policy's next run is held against: its own key's remaining budget (null when that key
   * cannot pay, or was revoked), or the bot key's for a policy with no key of its own. Reads the chain.
   */
  async budget(input: Ref): Promise<PolicyBudget> {
    const found = await this.find(input)
    if (found.ok) {
      const { community, policy } = found.value
      const signer = policySigner(await this.keysOf(community, policy))
      if (signer.kind === 'retired') return { key: 'policy', remaining: null }
      if (signer.kind === 'own') {
        const state = await this.readState(community, signer.key)
        return { key: 'policy', remaining: state.status === 'active' ? state.remaining : null }
      }
    }
    const status = await this.deps.communityService.keyStatus({ guildId: input.guildId })
    return { key: 'bot', remaining: status.ok && status.value.key.status === 'active' && status.value.state.status === 'active' ? status.value.state.remaining : null }
  }

  /**
   * Dev/CLI path: the root signer revokes the policy's other keys still live on chain, authorises
   * its newest pending key, then it is confirmed. (The treasury page does both in one transaction.)
   */
  async authorize(input: Ref & { root: RootSigner }): Promise<Result<{ key: PolicyKeyView; txHash: Hex }, NotFound | { code: 'no_pending_key' } | ChainRejection | PolicyKeyConfirmError>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const { community, policy } = found.value
    const keys = await this.keysOf(community, policy)
    const pending = keys.find((k) => k.status === 'pending_authorization')
    if (!pending) return err({ code: 'no_pending_key' })
    for (const old of keys) {
      if (old === pending || old.status === 'revoked' || (await this.readState(community, old)).status !== 'active') continue
      const revoked = await this.deps.chain.revokeKey({ root: input.root, accessKey: old.address })
      if (!revoked.ok) return revoked
    }
    const tx = await this.deps.chain.authorizeKey({ root: input.root, accessKey: pending.address, authorization: policyKeyAuthorization(pending) })
    if (!tx.ok) return tx
    const confirmed = await this.confirm({ ...input, keyAddress: pending.address, actor: null })
    return confirmed.ok ? ok({ key: confirmed.value, txHash: tx.value.txHash }) : confirmed
  }

  /** Dev/CLI path: the root signer revokes the policy's active key on chain. */
  async revoke(input: Ref & { root: RootSigner; actor: string | null }): Promise<Result<{ key: PolicyKeyView; txHash: Hex }, NotFound | { code: 'no_active_key' } | ChainRejection>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const { community, policy } = found.value
    const active = (await this.keysOf(community, policy)).find((k) => k.status === 'active')
    if (!active) return err({ code: 'no_active_key' })
    const tx = await this.deps.chain.revokeKey({ root: input.root, accessKey: active.address })
    if (!tx.ok) return tx
    return ok({ key: await this.markRevoked(policy, active, input.actor), txHash: tx.value.txHash })
  }

  // ---- internals -------------------------------------------------------------------------

  private async find(input: Ref): Promise<Result<{ community: Community; policy: Policy }, NotFound>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const policy = await this.deps.policies.get(input.policyId)
    if (!policy || policy.communityId !== community.id) return err({ code: 'policy_not_found' })
    return ok({ community, policy })
  }

  /** The policy's keys, newest first; a key filed under another community is never one of them. */
  private async keysOf(community: Community, policy: Policy): Promise<PolicyKey[]> {
    return (await this.deps.policyKeys.listByPolicy(policy.id)).filter((k) => k.communityId === community.id)
  }

  private async markRevoked(policy: Policy, key: PolicyKey, actor: string | null): Promise<PolicyKeyView> {
    const revoked: PolicyKey = { ...key, status: 'revoked', revokedAt: this.deps.clock.now(), sealedSecret: null }
    await this.deps.policyKeys.save(revoked)
    await this.event(policy, 'policy_key.revoked', actor, { key: key.address })
    return toPolicyKeyView(revoked)
  }

  private readState(community: Community, key: PolicyKey) {
    return this.deps.chain.keyState({ account: community.treasuryAddress, accessKey: key.address, token: key.policy.token, feeToken: key.policy.feeToken })
  }

  private event(p: Policy, type: 'policy_key.authorized' | 'policy_key.revoked', actor: string | null, details: Record<string, string | number | boolean | null>) {
    return this.deps.audit.record({ communityId: p.communityId, type, actor, policyId: p.id, policyVersion: p.version, details })
  }
}

/**
 * What the treasury signs for a policy key: exactly the bot key's restrictions (`keyAuthorization`:
 * the expiry, the limit per period, the fee budget, `transferWithMemo` on the payout token, and,
 * when the key was provisioned with preferred stablecoins on, `preferredTokenGrants`), with the
 * policy's own numbers. The one place the policy key's call scope is decided.
 */
export function policyKeyAuthorization(key: Pick<PolicyKey, 'policy'>): KeyAuthorization {
  return keyAuthorization(key.policy)
}
