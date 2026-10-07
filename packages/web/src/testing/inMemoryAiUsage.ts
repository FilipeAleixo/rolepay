import type { AiCallView, AiProposalView, AiSpendView, AiUsagePort } from '../dashboard/policyPort.js'

/**
 * The AI spend port in memory, for the dashboard's page tests: whatever a test adds is what the
 * pages show. Core's behaviour (what is recorded, the month's sums) is tested in core and through
 * the server's adapter (`aiUsagePortFromCore`).
 */
export class InMemoryAiUsage implements AiUsagePort {
  private readonly spends = new Map<string, AiSpendView>()
  private readonly rows = new Map<string, AiProposalView[]>()
  private readonly compileRows = new Map<string, Record<number, AiCallView>>()

  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  setSpend(guildId: string, spend: AiSpendView) {
    this.spends.set(guildId, spend)
  }

  addProposal(guildId: string, view: AiProposalView) {
    this.rows.set(guildId, [...(this.rows.get(guildId) ?? []), view])
  }

  addCompile(guildId: string, policyId: string, version: number, view: AiCallView) {
    this.compileRows.set(`${guildId}:${policyId}`, { ...this.compileRows.get(`${guildId}:${policyId}`), [version]: view })
  }

  async spend(input: { guildId: string }): Promise<AiSpendView> {
    const now = this.clock.now()
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return this.spends.get(input.guildId) ?? { since, calls: 0, totalMicroUsd: 0n, unpriced: 0, proposals: 0, averagePerProposalMicroUsd: null }
  }

  async proposals(input: { guildId: string; limit: number }): Promise<AiProposalView[]> {
    return [...(this.rows.get(input.guildId) ?? [])].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, input.limit)
  }

  async compiles(input: { guildId: string; policyId: string }): Promise<Record<number, AiCallView>> {
    return { ...this.compileRows.get(`${input.guildId}:${input.policyId}`) }
  }
}
