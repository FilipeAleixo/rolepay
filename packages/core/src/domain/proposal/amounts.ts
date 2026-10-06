import { z } from 'zod'
import { MAX_LINES_PER_RUN } from '../../constants/limits.js'
import { DiscordIdSchema } from '../ids.js'
import type { Micros } from '../money.js'
import { type Result, err, ok } from '../result.js'

/** What criteria mode counts per person, and what an amount rule can scale with. */
export const METRICS = ['messages', 'activeDays', 'replies'] as const
export const MetricSchema = z.enum(METRICS)
export type Metric = z.infer<typeof MetricSchema>

/** A person's counts. null = not counted (the criteria had no condition on it). */
export const MetricsSchema = z.object({
  messages: z.number().int().nonnegative().nullable(),
  activeDays: z.number().int().nonnegative().nullable(),
  replies: z.number().int().nonnegative().nullable(),
})
export type Metrics = z.infer<typeof MetricsSchema>

/**
 * How much each matched person gets:
 * - `flat`: the same amount each;
 * - `perUnit`: an amount per message, active day or reply, optionally capped per person;
 * - `pool`: a total split by messages, active days, replies, or equally (see `splitPool`).
 */
export const AmountRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flat'), amount: z.bigint().positive() }),
  z.object({ kind: z.literal('perUnit'), amount: z.bigint().positive(), per: MetricSchema, cap: z.bigint().positive().nullable() }),
  z.object({ kind: z.literal('pool'), total: z.bigint().positive(), splitBy: z.enum([...METRICS, 'equal']) }),
])
export type AmountRule = z.infer<typeof AmountRuleSchema>

/** The rule, per-person overrides (they win over the rule and the cap), and an optional cap on computed amounts. */
export const AmountPlanSchema = z.object({
  rule: AmountRuleSchema,
  overrides: z.array(z.object({ discordUserId: DiscordIdSchema, amount: z.bigint().positive() })).max(MAX_LINES_PER_RUN),
  perPersonCap: z.bigint().positive().nullable(),
})
export type AmountPlan = z.infer<typeof AmountPlanSchema>

export type Payable = { userId: string; metrics: Metrics }
/** `amount` may be 0n (no activity in a perUnit or pool rule): the caller leaves that person out. */
export type Amounted = { userId: string; amount: Micros; capped: boolean; override: boolean }
export type AmountPlanError = { code: 'overrides_exceed_pool' } | { code: 'metric_missing'; metric: Metric }

const byIdAsc = (a: string, b: string) => {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Splits `total` by weight with exact integer arithmetic (largest remainder): each person gets
 * floor(total * weight / sum of weights) micro-units, and the micro-units left over (fewer than
 * the number of people) go one each to the largest remainders, ties broken by Discord user ID
 * ascending. The shares always add up to `total` exactly, and the same input always gives the
 * same split. People with weight 0 get 0; with no weight at all, nobody gets anything.
 */
export function splitPool(total: Micros, shares: readonly { userId: string; weight: bigint }[]): { userId: string; amount: Micros }[] {
  const sum = shares.reduce((s, x) => s + x.weight, 0n)
  if (sum === 0n) return shares.map((s) => ({ userId: s.userId, amount: 0n }))
  const parts = shares.map((s) => ({ userId: s.userId, amount: (total * s.weight) / sum, remainder: (total * s.weight) % sum }))
  let left = total - parts.reduce((s, p) => s + p.amount, 0n)
  const order = [...parts].sort((a, b) => (a.remainder === b.remainder ? byIdAsc(a.userId, b.userId) : a.remainder > b.remainder ? -1 : 1))
  for (const p of order) {
    if (left === 0n) break
    p.amount += 1n
    left -= 1n
  }
  return parts.map(({ userId, amount }) => ({ userId, amount }))
}

const unitsOf = (p: Payable, metric: Metric) => p.metrics[metric]

/** Amounts for the matched people, in their order. Overrides only for people who matched. */
export function applyAmountPlan(plan: AmountPlan, people: readonly Payable[]): Result<Amounted[], AmountPlanError> {
  const overrides = new Map(plan.overrides.map((o) => [o.discordUserId, o.amount]))
  const rule = plan.rule
  const metric = rule.kind === 'perUnit' ? rule.per : rule.kind === 'pool' && rule.splitBy !== 'equal' ? rule.splitBy : null
  if (metric && people.some((p) => !overrides.has(p.userId) && unitsOf(p, metric) === null)) return err({ code: 'metric_missing', metric })

  const computed = new Map<string, Micros>()
  const ruled = people.filter((p) => !overrides.has(p.userId))
  if (rule.kind === 'flat') {
    for (const p of ruled) computed.set(p.userId, rule.amount)
  } else if (rule.kind === 'perUnit') {
    for (const p of ruled) {
      const raw = rule.amount * BigInt(unitsOf(p, rule.per) ?? 0)
      computed.set(p.userId, rule.cap !== null && raw > rule.cap ? rule.cap : raw)
    }
  } else {
    const reserved = people.reduce((s, p) => s + (overrides.get(p.userId) ?? 0n), 0n)
    if (reserved > rule.total) return err({ code: 'overrides_exceed_pool' })
    const weights = ruled.map((p) => ({ userId: p.userId, weight: rule.splitBy === 'equal' ? 1n : BigInt(unitsOf(p, rule.splitBy) ?? 0) }))
    for (const s of splitPool(rule.total - reserved, weights)) computed.set(s.userId, s.amount)
  }

  return ok(
    people.map((p) => {
      const override = overrides.get(p.userId)
      if (override !== undefined) return { userId: p.userId, amount: override, capped: false, override: true }
      const base = computed.get(p.userId) ?? 0n
      const ruleCapped = rule.kind === 'perUnit' && rule.cap !== null && rule.amount * BigInt(unitsOf(p, rule.per) ?? 0) > rule.cap
      const amount = plan.perPersonCap !== null && base > plan.perPersonCap ? plan.perPersonCap : base
      return { userId: p.userId, amount, capped: ruleCapped || amount < base, override: false }
    }),
  )
}
