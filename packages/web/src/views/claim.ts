import { esc, page } from './page.js'

export type ClaimPageConfig = {
  page: 'claim'
  token: string
  communityName: string
  /** The label the passkey gets in the person's password manager. */
  passkeyName: string
  network: string
  explorerUrl: string
  /** The community, for the payee's choice of stablecoin once registered (`/account/preference`). */
  guildId: string
  payoutLabel: string | null
  /** Whether the community pays people in their preferred stablecoin yet (they may choose either way). */
  preferredTokens: boolean
  /** What they may choose: the payout token first. */
  choices: { address: string; label: string }[]
}

/**
 * The recipient's page: two ways to say where they are paid. A passkey on this device (first: no
 * wallet needed), whose account is where they get paid; or a wallet they already have on Tempo,
 * proven by signing a message (the wallet is in the page, `window.ethereum`: nothing loads from
 * another site).
 */
export function claimPage(config: ClaimPageConfig, testnet: boolean): string {
  const name = esc(config.communityName)
  return page({
    title: `Rolepay: get paid by ${config.communityName}`,
    testnet,
    config,
    body: `<h1>Get paid by ${name}</h1>
<p>This one-time link sets up where ${name} pays you, in stablecoins on Tempo. The simplest way is a passkey on this device, like the ones you use to sign in to websites: there is no app to install, no wallet and no seed phrase. If you already have a wallet on Tempo, you can be paid there instead.</p>
<section data-step="choose">
  <h2>Your payout account</h2>
  <button id="create" type="button">Create my passkey (no wallet needed)</button>
  <button id="wallet" type="button" class="secondary">Use a wallet I already have</button>
  <p class="muted">A passkey is your account: Rolepay never sees it, and nobody else can move what you are paid.</p>
  <p class="muted">Only an address you control on Tempo. Exchange deposit addresses usually cannot receive on Tempo, and they cannot sign, so they will not work here.</p>
  <p class="muted">Paid by Rolepay before? <button id="signin" type="button" class="link">I already have a Rolepay passkey</button></p>
</section>
<section data-step="done" hidden>
  <h2>You will be paid here</h2>
  <p><code id="address"></code></p>
  <p>Nothing to install. Payments from ${name} arrive in this account, and Discord sends you a receipt each time. You can close this page.</p>
  ${preferenceSection(config)}
  <p>To see your balance or send your money on, sign in to <a href="/account">your Rolepay account</a> with the same passkey.</p>
  <p class="muted"><a id="explorer" href="#" target="_blank" rel="noreferrer">See the account on the explorer</a></p>
</section>
<section data-step="done-wallet" hidden>
  <h2>You will be paid at your wallet</h2>
  <p>You will be paid at <code id="wallet-address"></code>. Keep that wallet: Rolepay cannot move or recover money there.</p>
  <p>Payments from ${name} arrive there, and Discord sends you a receipt each time. You can close this page.</p>
  <p class="muted">To be paid in another USD stablecoin, choose it in Discord with /payee prefer.</p>
  <p class="muted"><a id="wallet-explorer" href="#" target="_blank" rel="noreferrer">See the address on the explorer</a></p>
</section>
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript to create your passkey or to ask your wallet.</p></noscript>`,
  })
}

/** The stablecoin they want to be paid in, chosen once they are registered (the client fills and posts it). */
function preferenceSection(c: ClaimPageConfig): string {
  if (c.choices.length < 2) return ''
  const payout = esc(c.payoutLabel ?? 'its payout token')
  const options = c.choices.map((t, i) => `<option value="${esc(t.address)}">${esc(t.label)}${i === 0 ? ' (the default)' : ''}</option>`).join('')
  const when = c.preferredTokens
    ? `${esc(c.communityName)} pays in ${payout}; another USD stablecoin is bought for you on Tempo's stablecoin exchange in the same transaction.`
    : `${esc(c.communityName)} pays everyone in ${payout} for now; your choice applies once its treasurer turns on preferred stablecoins.`
  return `<div id="preference">
    <label for="preferred-token">Paid in</label>
    <select id="preferred-token">${options}</select>
    <p class="muted">${when}</p>
  </div>`
}
