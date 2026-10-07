import { z } from 'zod'
import { DiscordIdSchema, RunIdSchema } from './ids.js'
import type { Micros } from './money.js'
import { PolicyIdSchema } from './policy/policy.js'
import { ProposalIdSchema } from './proposal/proposal.js'

/**
 * One row per model call: what the AI cost a community, for its dashboard and the operators. Who
 * asked, what for, the model, the tokens (uncached input, cache writes, cache reads, output), the
 * latency, the estimated cost and how it ended, linked to the proposal and the pay run it became,
 * or to the policy version it compiled. Content-free on purpose: never the instruction, messages,
 * names or reasons (they stay on their own records, or nowhere).
 */
export const AI_USAGE_PURPOSES = ['proposal_messages', 'proposal_criteria', 'policy_compile'] as const
export const AiUsagePurposeSchema = z.enum(AI_USAGE_PURPOSES)
export type AiUsagePurpose = z.infer<typeof AiUsagePurposeSchema>

/** null when the call returned no usage (an API error before any token was counted). */
const Count = z.number().int().nonnegative().nullable()

export const NewAiUsageSchema = z.object({
  communityId: DiscordIdSchema,
  purpose: AiUsagePurposeSchema,
  /** The Discord user who asked. */
  actor: DiscordIdSchema,
  model: z.string().min(1).max(100),
  inputTokens: Count,
  cacheCreationInputTokens: Count,
  cacheReadInputTokens: Count,
  outputTokens: Count,
  latencyMs: Count,
  /** Estimated from the list price, in micro-dollars (stored as decimal USD text); null without a price or a usage. */
  costMicroUsd: z.bigint().nonnegative().nullable(),
  /** `proposed` (a proposal drafted, or a policy rule compiled), or the error code that stopped it. */
  outcome: z.string().regex(/^[a-z_]{1,40}$/),
  createdAt: z.date(),
  proposalId: ProposalIdSchema.nullable(),
  /** The pay run the proposal became, set when it does. */
  runId: RunIdSchema.nullable(),
  /** The policy version a compile made (a failed compile made none). */
  policyId: PolicyIdSchema.nullable(),
  policyVersion: z.number().int().min(1).nullable(),
})
export type NewAiUsage = z.infer<typeof NewAiUsageSchema>

/** A stored row: `seq` is assigned by the store, increasing. */
export const AiUsageSchema = NewAiUsageSchema.extend({ seq: z.number().int().min(1) })
export type AiUsage = z.infer<typeof AiUsageSchema>

/** "claude-sonnet-5-5" -> "Sonnet 5.5", "claude-opus-5" -> "Opus 5" (a date suffix dropped). Anything else as it is. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model)
  if (!m) return model
  const family = m[1] as string
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

const roundTo = (micros: Micros, unit: bigint) => (micros + unit / 2n) / unit

/**
 * Dollars for people, rounded half up: three decimals under 10 cents ("$0.004", "$0.018"), two
 * from there ("$0.42"), and "<$0.001" for less than that rounds to.
 */
export function usdText(micros: Micros): string {
  if (micros === 0n) return '$0'
  if (micros < 500n) return '<$0.001'
  if (micros < 99_500n) return `$0.${String(roundTo(micros, 1_000n)).padStart(3, '0')}`
  const cents = roundTo(micros, 10_000n)
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

/** Milliseconds as seconds with one decimal, "2.1 s"; "<0.1 s" under that. */
export function secondsText(ms: number): string {
  const tenths = Math.round(ms / 100)
  return tenths === 0 ? '<0.1 s' : `${Math.floor(tenths / 10)}.${tenths % 10} s`
}

export type AiUsageSummary = {
  calls: number
  /** Calls whose model has no price: counted here, not in the total. */
  unpriced: number
  totalMicroUsd: Micros
  /** Drafted proposals (a proposal call whose outcome is `proposed`). */
  proposals: number
  /** The mean cost of a drafted proposal with a price, rounded half up to a micro-dollar; null with none. */
  averagePerProposalMicroUsd: Micros | null
}

export function summarizeAiUsage(rows: readonly AiUsage[]): AiUsageSummary {
  const priced = rows.filter((r) => r.costMicroUsd !== null)
  const drafted = rows.filter((r) => r.purpose !== 'policy_compile' && r.outcome === 'proposed')
  const draftedCosts = drafted.flatMap((r) => (r.costMicroUsd === null ? [] : [r.costMicroUsd]))
  const sum = (xs: readonly Micros[]) => xs.reduce((a, b) => a + b, 0n)
  const n = BigInt(draftedCosts.length)
  return {
    calls: rows.length,
    unpriced: rows.length - priced.length,
    totalMicroUsd: sum(priced.map((r) => r.costMicroUsd as Micros)),
    proposals: drafted.length,
    averagePerProposalMicroUsd: n === 0n ? null : (sum(draftedCosts) + n / 2n) / n,
  }
}
