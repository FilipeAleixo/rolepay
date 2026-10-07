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
  /** The stablecoins the key may swap into and deliver when preferred stablecoins are on (the payout and fee tokens left out). */
  swapTokens: { address: string; label: string }[]
  passkeyName: string
  /** Whether this server offers deposit addresses (it reads the chain for them). */
  deposits: boolean
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
  // In fee budget mode network fees are paid in a second token (pathUSD on mainnet, where there is no
  // sponsor): the bot's runs from its fee budget, and the passkey's own transactions on this page.
  const feeLabel = esc(c.feeTokenLabel ?? 'the fee token')
  const feeFunding =
    c.feeMode === 'fee_budget'
      ? `<p>Also send about 2 ${feeLabel} for network fees: the bot pays each run's fee from its fee budget in ${feeLabel}, and your passkey's own transactions on this page pay theirs in it too (a cent or two each).</p>
  <p>Fee balance: <strong data-field="fee-balance">...</strong> ${feeLabel}</p>`
      : ''
  return page({
    title: `Rolepay: treasury for ${c.guildName}`,
    testnet: c.testnet,
    config: c,
    body: `<h1>Treasury for ${name}</h1>
<p>The community's money lives in its own Tempo account. Your passkey is that account's root key: only you can move the funds, and you decide exactly what the Rolepay bot may spend.</p>
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
  <p>Send ${token} on Tempo to this address, from another Tempo account or through a bridge that delivers on Tempo. Never send from a network or exchange that does not support Tempo.</p>
  <p><code data-field="treasury"></code></p>
  <p>Balance: <strong data-field="balance">...</strong> ${token} <a data-field="explorer" href="#" target="_blank" rel="noreferrer">explorer</a></p>
  <p class="muted">On the explorer, balances are under Holdings, and ${c.testnet ? "the faucet's deposits" : 'deposits'} under Transfers.</p>
  ${feeFunding}
  ${c.testnet ? '<button id="faucet" type="button" class="secondary">Get testnet funds</button>' : ''}
</section>
<section data-step="key" hidden>
  <h2>3. What the bot may spend</h2>
  <p data-field="key-status" class="muted"></p>
  ${preferredTokensBox(c)}
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
    <p data-field="key-signs"></p>
    <p data-field="key-replaces" class="muted"></p>
    <p data-field="key-prompts"></p>
    <button id="authorize" type="submit">Authorise the bot key with my passkey</button>
  </form>
  <div id="live-keys"></div>
</section>
${
  c.deposits
    ? `<section data-step="deposits" hidden>
  <h2>4. Deposit addresses</h2>
  <p>Give each funder its own address to send to: a sponsor, a judges pool, a grant. Every deposit lands in this account directly (no sweep), and Rolepay shows which source it came from. A deposit address can only ever add money.</p>
  <p data-field="deposits-status" class="muted"></p>
  <div data-when="deposits-off">
    <p class="muted">Set up once. This browser first works for about a minute (a proof of work Tempo asks of every registration), then your passkey signs one transaction that registers this account as the owner of its deposit addresses.</p>
    <p data-field="deposits-signs"></p>
    <button id="deposits" type="button" class="secondary">Set up deposit addresses</button>
  </div>
  <p data-when="deposits-on" hidden>Create a funding source for each funder on the dashboard's <a data-field="deposits-dashboard" href="#">Funding page</a>, or with <code>/rolepay fund new</code> in Discord. <a data-field="deposits-tx" href="#" target="_blank" rel="noreferrer" hidden>Registration on the explorer</a></p>
</section>`
    : ''
}
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript for the passkey.</p></noscript>`,
  })
}

/**
 * The switch for paying each person in the stablecoin they prefer (off by default). Turning it on
 * changes no key: the next authorisation this page builds includes the swap scope, and the page says
 * when the current key lacks it.
 */
function preferredTokensBox(c: SetupPageConfig): string {
  if (c.swapTokens.length === 0) return ''
  const token = esc(c.tokenLabel)
  const list = c.swapTokens.map((t) => esc(t.label)).join(' or ')
  return `<div id="preferred-tokens-box">
    <label class="check"><input type="checkbox" id="preferred-tokens"> Pay each person in the stablecoin they prefer</label>
    <p class="muted">A payee may choose ${list} instead of ${token} (with /payee prefer in Discord, or on their account page). Each run then buys their choice with ${token} on Tempo's stablecoin exchange, in the same transaction, spending at most a small cap over each amount (1% by default); if it cannot, the run waits and nobody is paid. The bot key also needs the exchange's exact-output swap and transferWithMemo on ${list}, each limited like ${token}: authorise a new key below after turning this on.</p>
    <p data-field="preferred-status" class="muted"></p>
  </div>`
}
