import type { Kysely, Selectable } from 'kysely'
import { type AiUsage, type AiUsagePurpose, AiUsageSchema, type NewAiUsage } from '../../domain/aiUsage.js'
import { formatAmount } from '../../domain/money.js'
import type { AiUsageRepository } from '../../ports/repositories.js'
import type { AiUsageTable, Database } from './schema.js'

/** "0.0108" -> 10_800n micro-dollars; undefined for anything else, which the schema then refuses. */
const USD = /^(\d+)(?:\.(\d{1,6}))?$/
function microUsd(text: string): bigint | undefined {
  const m = USD.exec(text)
  return m ? BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0')) : undefined
}

function toUsage(r: Selectable<AiUsageTable>): AiUsage {
  return AiUsageSchema.parse({
    seq: r.seq,
    communityId: r.community_id,
    purpose: r.purpose,
    actor: r.actor,
    model: r.model,
    inputTokens: r.input_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
    costMicroUsd: r.cost_usd === null ? null : microUsd(r.cost_usd),
    outcome: r.outcome,
    createdAt: new Date(r.created_at),
    proposalId: r.proposal_id,
    runId: r.run_id,
    policyId: r.policy_id,
    policyVersion: r.policy_version,
  })
}

/** The AI spend, one row per model call; every read is re-validated by the domain schema. */
export class SqliteAiUsageRepository implements AiUsageRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async append(u: NewAiUsage): Promise<AiUsage> {
    const row = await this.db
      .insertInto('ai_usage')
      .values({
        community_id: u.communityId,
        purpose: u.purpose,
        actor: u.actor,
        model: u.model,
        input_tokens: u.inputTokens,
        cache_creation_input_tokens: u.cacheCreationInputTokens,
        cache_read_input_tokens: u.cacheReadInputTokens,
        output_tokens: u.outputTokens,
        latency_ms: u.latencyMs,
        cost_usd: u.costMicroUsd === null ? null : formatAmount(u.costMicroUsd),
        outcome: u.outcome,
        created_at: u.createdAt.toISOString(),
        proposal_id: u.proposalId,
        run_id: u.runId,
        policy_id: u.policyId,
        policy_version: u.policyVersion,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toUsage(row)
  }

  async linkRun(proposalId: string, runId: string) {
    await this.db.updateTable('ai_usage').set({ run_id: runId }).where('proposal_id', '=', proposalId).execute()
  }

  async list(communityId: string, opts: { purposes?: readonly AiUsagePurpose[]; policyId?: string; since?: Date; limit?: number } = {}) {
    let q = this.db.selectFrom('ai_usage').selectAll().where('community_id', '=', communityId)
    if (opts.purposes) q = opts.purposes.length ? q.where('purpose', 'in', [...opts.purposes]) : q.where('purpose', '=', '')
    if (opts.policyId) q = q.where('policy_id', '=', opts.policyId)
    if (opts.since) q = q.where('created_at', '>=', opts.since.toISOString())
    q = q.orderBy('created_at', 'desc').orderBy('seq', 'desc')
    if (opts.limit !== undefined) q = q.limit(opts.limit)
    return (await q.execute()).map(toUsage)
  }
}
