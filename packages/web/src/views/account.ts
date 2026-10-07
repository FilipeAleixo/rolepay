import { esc, page } from './page.js'

export type AccountPageConfig = {
  page: 'account'
  network: string
  testnet: boolean
  rpcUrl: string
  /** null = no sponsor (mainnet): the fee of a send is paid from the token sent. */
  sponsorUrl: string | null
  explorerUrl: string
  /** The stablecoins the page shows and can send, the usual payout token first. */
  tokens: { address: string; label: string }[]
}

/**
 * The payee's own account: sign in with the passkey the claim page made, see what arrived, send it
 * on (to their own wallet, an exchange or a bridge on Tempo), and choose the stablecoin each
 * community pays them in. The browser signs and sends straight to Tempo; this server never takes an
 * address or an amount from the page (the choice is stored for the passkey session's own address).
 */
export function accountPage(c: AccountPageConfig): string {
  const options = c.tokens.map((t) => `<option value="${esc(t.address)}">${esc(t.label)}</option>`).join('')
  const fee = c.sponsorUrl
    ? 'The network fee is paid by the sponsor.'
    : 'The network fee (about a cent) is paid from the token you send, so keep a little: Max leaves 0.1 for it.'
  return page({
    title: 'Rolepay: your account',
    testnet: c.testnet,
    config: c,
    body: `<h1>Your Rolepay account</h1>
<p>What communities pay you through Rolepay arrives in this Tempo account. Your passkey is its only key: Rolepay cannot move your money, and nobody else can either.</p>
<section data-step="signin">
  <p class="muted">Sign in with the passkey you made when you registered to be paid.</p>
  <button id="signin" type="button">Sign in with my passkey</button>
</section>
<section data-step="account" hidden>
  <h2>Balance</h2>
  <p>Account: <code data-field="address"></code> <a data-field="explorer" href="#" target="_blank" rel="noreferrer">explorer</a></p>
  <p class="muted">On the explorer, balances are under Holdings, and payments received under Transfers.</p>
  <div id="balances"></div>
</section>
<section data-step="payouts" hidden>
  <h2>How you are paid</h2>
  <p class="muted">Choose the USD stablecoin each community pays you in. When it is not the community's own, Rolepay buys it for you on Tempo's stablecoin exchange, in the same transaction that pays you.</p>
  <div id="payouts"></div>
  <button id="payouts-signin" type="button" class="secondary" hidden>Sign in to choose</button>
</section>
<section data-step="send" hidden>
  <h2>Send</h2>
  <form id="send-form">
    <div class="row">
      <div><label for="token">Token</label><select id="token">${options}</select></div>
      <div><label for="amount">Amount</label><input id="amount" inputmode="decimal" autocomplete="off"></div>
    </div>
    <label for="to">To (an address on Tempo)</label>
    <input id="to" autocomplete="off" spellcheck="false" placeholder="0x...">
    <p class="muted">${fee}</p>
    <p class="muted">Only send to an address on Tempo: your own Tempo account, or an exchange or bridge that says it accepts this token on Tempo. A transfer cannot be undone.</p>
    <p data-field="send-says"></p>
    <button id="max" type="button" class="secondary">Max</button>
    <button id="send" type="submit">Send with my passkey</button>
  </form>
</section>
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript for the passkey.</p></noscript>`,
  })
}
