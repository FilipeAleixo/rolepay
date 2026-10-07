import type { PolicyBudgetView, PolicyKeysPort } from '../dashboard/policyPort.js'

/**
 * Policies' own budgets in memory, for the dashboard's page tests: whatever a test sets is what the
 * policy page shows, and `shared` (the bot key's budget) by default. Core's behaviour (which key
 * signs, what the chain says) is tested in core and through the server's adapter (`policyKeysPortFromCore`).
 */
export class InMemoryPolicyKeys implements PolicyKeysPort {
  private readonly views = new Map<string, PolicyBudgetView | null | Error>()

  set(guildId: string, policyId: string, view: PolicyBudgetView | null | Error) {
    this.views.set(`${guildId}:${policyId}`, view)
  }

  async budget(input: { guildId: string; policyId: string }): Promise<PolicyBudgetView | null> {
    const v = this.views.get(`${input.guildId}:${input.policyId}`)
    if (v instanceof Error) throw v
    return v === undefined ? { kind: 'shared' } : v
  }
}
