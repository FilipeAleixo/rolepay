import { type AiUsage, type AiUsagePurpose, type AiUsageSummary, summarizeAiUsage } from '../domain/aiUsage.js'
import type { Clock } from '../ports/clock.js'
import type { AiUsageRepository } from '../ports/repositories.js'

/** A month's AI spend: the summary from the first of the month (UTC) up to now. */
export type AiSpend = AiUsageSummary & { since: Date }

const MAX_LIST = 500

/**
 * What the AI cost a community, for its dashboard: the rows ProposalService and PolicyService
 * write, one per model call (counts, codes, IDs and the estimated cost; never any text).
 */
export class AiUsageService {
  constructor(private readonly deps: { usage: AiUsageRepository; clock: Clock }) {}

  /** This UTC calendar month so far: the total, the calls without a price, and the average cost of a drafted proposal. */
  async month(input: { guildId: string }): Promise<AiSpend> {
    const now = this.deps.clock.now()
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return { since, ...summarizeAiUsage(await this.deps.usage.list(input.guildId, { since })) }
  }

  /** Model calls, newest first: by purpose (the proposals), one policy's compiles, or all; at most 500. */
  list(input: { guildId: string; purposes?: readonly AiUsagePurpose[]; policyId?: string; limit?: number }): Promise<AiUsage[]> {
    return this.deps.usage.list(input.guildId, {
      ...(input.purposes ? { purposes: input.purposes } : {}),
      ...(input.policyId ? { policyId: input.policyId } : {}),
      limit: Math.min(MAX_LIST, Math.max(1, input.limit ?? 50)),
    })
  }
}
