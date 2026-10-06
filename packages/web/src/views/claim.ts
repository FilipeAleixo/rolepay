import { esc, page } from './page.js'

export type ClaimPageConfig = {
  page: 'claim'
  token: string
  communityName: string
  /** The label the passkey gets in the person's password manager. */
  passkeyName: string
  network: string
  explorerUrl: string
}

/** The recipient's page: create (or sign in with) a passkey, and that account is where they get paid. */
export function claimPage(config: ClaimPageConfig, testnet: boolean): string {
  const name = esc(config.communityName)
  return page({
    title: `payrun: get paid by ${config.communityName}`,
    testnet,
    config,
    body: `<h1>Get paid by ${name}</h1>
<p>This one-time link sets up where ${name} pays you, in stablecoins on Tempo. You get a passkey on this device, like the ones you use to sign in to websites. There is no app to install, no wallet and no seed phrase.</p>
<section data-step="choose">
  <h2>Your payout account</h2>
  <p class="muted">Your passkey is your account. payrun never sees it, and nobody else can move what you are paid.</p>
  <button id="create" type="button">Create my passkey</button>
  <button id="signin" type="button" class="secondary">I already have a payrun passkey</button>
</section>
<section data-step="done" hidden>
  <h2>You will be paid here</h2>
  <p><code id="address"></code></p>
  <p>Nothing to install. Payments from ${name} arrive in this account, and Discord sends you a receipt each time. You can close this page.</p>
  <p class="muted"><a id="explorer" href="#" target="_blank" rel="noreferrer">See the account on the explorer</a></p>
</section>
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript to create your passkey.</p></noscript>`,
  })
}
