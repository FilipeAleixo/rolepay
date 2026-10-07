import { esc, page } from './page.js'

export type PolicyBudgetPageConfig = {
  page: 'policy-budget'
  token: string
  policyId: string
  policyName: string
  /** The policy's status: an archived one can only have its key revoked here. */
  policyStatus: 'draft' | 'active' | 'paused' | 'archived'
  guildName: string
  network: string
  testnet: boolean
  rpcUrl: string
  sponsorUrl: string | null
  explorerUrl: string
  treasury: string
  payoutToken: string
  tokenLabel: string
  feeMode: 'sponsor' | 'fee_budget'
  feeToken: string | null
  feeTokenLabel: string | null
  /** The policy in words: its schedule and caps, so the treasurer sees what the budget is for. */
  about: string
  defaults: { limit: string; periodDays: number; validityDays: number; feeBudget: string }
}

/**
 * A policy's own budget, on the treasury's page: the treasurer signs in with the treasury passkey,
 * chooses what this one policy may spend (its own access key: a limit per period, an expiry, and
 * transferWithMemo on the payout token only), and signs it, or revokes the policy's key. The page
 * builds what it signs from this form, like the setup page; the server only names the new key.
 */
export function policyBudgetPage(c: PolicyBudgetPageConfig): string {
  const name = esc(c.policyName)
  const token = esc(c.tokenLabel)
  const feeLabel = esc(c.feeTokenLabel ?? 'the fee token')
  const feeField =
    c.feeMode === 'fee_budget'
      ? `<div><label for="feeBudget">Fee budget per period (${feeLabel})</label><input id="feeBudget" inputmode="decimal" value="${esc(c.defaults.feeBudget)}"></div>`
      : ''
  const archived = c.policyStatus === 'archived'
  return page({
    title: `Rolepay: a budget for ${c.policyName}`,
    testnet: c.testnet,
    config: c,
    body: `<h1>A budget of its own for ${name}</h1>
<p>Give this standing policy its own access key on the ${esc(c.guildName)} treasury. Its runs are then signed with that key alone, so this policy can never spend more than you set here, whatever the bot key has left. Manual runs, AI-proposed runs and other policies keep using the bot key.</p>
<section data-step="policy">
  <h2>The policy</h2>
  <p>${esc(c.about)}</p>
  <p>Treasury: <code data-field="treasury">${esc(c.treasury)}</code></p>
  <p data-field="budget-status" class="muted"></p>
  <button id="signin" type="button" data-when="signed-out">Sign in with the treasury passkey</button>
</section>
<section data-step="budget" hidden>
  <h2>What this policy may spend</h2>
  ${
    archived
      ? '<p class="muted">This policy is archived: it never runs again. Revoke its key below so nothing can ever spend with it.</p>'
      : `<form id="budget-form">
    <div class="row">
      <div><label for="limit">Spend limit (${token})</label><input id="limit" inputmode="decimal" value="${esc(c.defaults.limit)}"></div>
      <div><label for="periodDays">Resets every (days, 0 = never)</label><input id="periodDays" inputmode="numeric" value="${c.defaults.periodDays}"></div>
    </div>
    <div class="row">
      <div><label for="validityDays">Key expires after (days)</label><input id="validityDays" inputmode="numeric" value="${c.defaults.validityDays}"></div>
      ${feeField}
    </div>
    <p class="muted">The key can only call transferWithMemo on ${token}, up to this limit, until it expires. The chain enforces it, whatever Rolepay's code does. Fees are ${c.feeMode === 'sponsor' ? 'paid by the sponsor' : `paid from the fee budget in ${feeLabel}`}.</p>
    <p data-field="key-signs"></p>
    <p data-field="key-replaces" class="muted"></p>
    <p data-field="key-prompts"></p>
    <button id="authorize" type="submit">Give this policy its own budget</button>
  </form>`
  }
  <div id="live-keys"></div>
</section>
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript for the passkey.</p></noscript>`,
  })
}
