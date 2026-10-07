import type { z } from 'zod'
import { BotKeySchema, type KeyCheckError } from '../community.js'
import type { Micros } from '../money.js'
import { type PolicyCaps, PolicyIdSchema } from './policy.js'
import type { Schedule } from './schedule.js'

/**
 * A standing policy's own access key: the same kind of key as the bot key (an expiry, a spend
 * limit per period, `transferWithMemo` on the payout token only), authorised by the same treasury
 * passkey, but bound to one policy. Only that policy's runs are signed with it, so a buggy or
 * compromised policy can spend at most this key's budget, whatever the bot key has left. Off by
 * default: a policy without one pays from the bot key exactly as before.
 */
export const PolicyKeySchema = BotKeySchema.extend({ policyId: PolicyIdSchema })
export type PolicyKey = z.infer<typeof PolicyKeySchema>

/** A policy key without its sealed secret: the only form that leaves the services. */
export type PolicyKeyView = Omit<PolicyKey, 'sealedSecret'>
export const toPolicyKeyView = ({ sealedSecret: _sealed, ...view }: PolicyKey): PolicyKeyView => view

/**
 * Vault context binding a sealed policy key to its community, policy and key: a row moved to
 * another policy (or read as a bot key) does not open. The bot key's context is `bot-key:...`.
 */
export const policyKeyContext = (communityId: string, policyId: string, keyAddress: string) => `policy-key:${communityId}:${policyId}:${keyAddress.toLowerCase()}`

/**
 * Which key signs a policy's runs, from that policy's keys:
 * - `bot`: it has never had a key of its own authorised (none, or only one waiting for the passkey):
 *   the bot key, as for every other run.
 * - `own`: its own key is active: that key, and only that key.
 * - `retired`: its own key was authorised once and is no longer active (revoked): the policy is
 *   stopped. It never falls back to the bot key, so revoking a policy's key is a kill switch for
 *   that policy alone, and a policy given its own budget can never spend the shared one.
 */
export type PolicySigner = { kind: 'bot' } | { kind: 'own'; key: PolicyKey } | { kind: 'retired'; key: PolicyKey }

export function policySigner(keys: readonly PolicyKey[]): PolicySigner {
  const active = keys.find((k) => k.status === 'active')
  if (active) return { kind: 'own', key: active }
  const authorized = [...keys].filter((k) => k.authorizedAt !== null).sort((a, b) => (b.authorizedAt?.getTime() ?? 0) - (a.authorizedAt?.getTime() ?? 0))[0]
  return authorized ? { kind: 'retired', key: authorized } : { kind: 'bot' }
}

const DAY = 86_400

/**
 * Where the treasury page's form starts for a policy's own key: the policy's cap per run as the
 * limit (null: the server's default), reset once per run of its schedule. A monthly policy resets
 * every 28 days: the shortest month, so no period of the key (anchored when it is authorised) can
 * ever hold two monthly runs, and one run's budget is never shared by two.
 */
export function policyKeyDefaults(p: { caps: PolicyCaps; schedule: Schedule }): { limit: Micros | null; periodSeconds: number } {
  const days = p.schedule.kind === 'daily' ? 1 : p.schedule.kind === 'weekly' ? 7 : 28
  return { limit: p.caps.perRun, periodSeconds: days * DAY }
}

/** A pre-flight that failed on a policy's own key: the same check, marked so it is never explained as the bot key's. */
export type PolicyKeyCheckError = KeyCheckError & { key: 'policy' }
export const policyKeyError = (e: KeyCheckError): PolicyKeyCheckError => ({ ...e, key: 'policy' })
