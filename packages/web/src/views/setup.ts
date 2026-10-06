import { esc, page } from './page.js'

export type SetupPageConfig = {
  page: 'setup'
  token: string
  guildName: string
  network: string
  testnet: boolean
  rpcUrl: string
  sponsorUrl: string | null
  explorerUrl: string
  /** null until the treasury is bound. */
  treasury: string | null
  payoutToken: string
  tokenLabel: string
  feeMode: 'sponsor' | 'fee_budget'
  feeToken: string | null
  feeTokenLabel: string | null
  passkeyName: string
  defaults: { limit: string; periodDays: number; validityDays: number; feeBudget: string }
}

/**
 * The treasurer's page: create the community's Tempo account with a passkey as its root
 * (or sign in to it), fund it, choose what the bot key may spend, sign that with the
 * passkey, or revoke the key. Every key live on chain gets its own Revoke button (#live-keys,
 * filled by the client).
 */
export function setupPage(c: SetupPageConfig): string {
  const name = esc(c.guildName)
  const token = esc(c.tokenLabel)
  const feeField =
    c.feeMode === 'fee_budget'
      ? `<div><label for="feeBudget">Fee budget per period (${esc(c.feeTokenLabel ?? 'fee token')})</label><input id="feeBudget" inputmode="decimal" value="${esc(c.defaults.feeBudget)}"></div>`
      : ''
  return page({
    title: `payrun: treasury for ${c.guildName}`,
    testnet: c.testnet,
    config: c,
    body: `<h1>Treasury for ${name}</h1>
<p>The community's money lives in its own Tempo account. Your passkey is that account's root key: only you can move the funds, and you decide exactly what the payrun bot may spend.</p>
<section data-step="treasury">
  <h2>1. The community account</h2>
  <div data-when="unbound">
    <p class="muted">Creates a passkey on this device and a Tempo account it controls. Keep it safe: it is the only key to the treasury.</p>
    <button id="create" type="button">Create the treasury passkey</button>
    <button id="signin" type="button" class="secondary">Sign in with an existing passkey</button>
  </div>
  <div data-when="bound" hidden>
    <p>Treasury: <code data-field="treasury"></code></p>
    <button id="signin-bound" type="button" data-when="signed-out">Sign in with the treasury passkey</button>
    <p class="muted" data-when="signed-in" hidden>Signed in as the treasury.</p>
  </div>
</section>
<section data-step="fund" hidden>
  <h2>2. Fund it</h2>
  <p>Send ${token} to this address, from an exchange or another account:</p>
  <p><code data-field="treasury"></code></p>
  <p>Balance: <strong data-field="balance">...</strong> ${token} <a data-field="explorer" href="#" target="_blank" rel="noreferrer">explorer</a></p>
  ${c.testnet ? '<button id="faucet" type="button" class="secondary">Get testnet funds</button>' : ''}
</section>
<section data-step="key" hidden>
  <h2>3. What the bot may spend</h2>
  <p data-field="key-status" class="muted"></p>
  <form id="key-form">
    <div class="row">
      <div><label for="limit">Spend limit (${token})</label><input id="limit" inputmode="decimal" value="${esc(c.defaults.limit)}"></div>
      <div><label for="periodDays">Resets every (days, 0 = never)</label><input id="periodDays" inputmode="numeric" value="${c.defaults.periodDays}"></div>
    </div>
    <div class="row">
      <div><label for="validityDays">Key expires after (days)</label><input id="validityDays" inputmode="numeric" value="${c.defaults.validityDays}"></div>
      ${feeField}
    </div>
    <p class="muted">The bot can only call transferWithMemo on ${token}, up to this limit, until it expires. Fees are ${c.feeMode === 'sponsor' ? 'paid by the sponsor' : `paid from the fee budget in ${esc(c.feeTokenLabel ?? 'the fee token')}`}.</p>
    <p data-field="key-replaces" class="muted"></p>
    <p data-field="key-prompts"></p>
    <button id="authorize" type="submit">Authorise the bot key with my passkey</button>
  </form>
  <div id="live-keys"></div>
</section>
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript for the passkey.</p></noscript>`,
  })
}
