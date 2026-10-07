// The recipient claim page: one passkey, one address, registered with the community.
import { $, busy, explainPasskeyError, post, status } from './dom.js'
import { passkeys } from './passkey.js'
import { savePreference } from './payouts.js'

export type ClaimConfig = {
  page: 'claim'
  token: string
  communityName: string
  passkeyName: string
  network: string
  explorerUrl: string
  guildId: string
  payoutLabel: string | null
  preferredTokens: boolean
  /** The payout token first, then the other stablecoins the community can pay in. */
  choices: { address: string; label: string }[]
}

const LINK_ERRORS: Record<string, string> = {
  link_already_used: 'This link was already used. Run /payee link in Discord for a new one.',
  link_expired: 'This link has expired. Run /payee link in Discord for a new one.',
  link_not_found: 'This link is not valid. Run /payee link in Discord for a new one.',
}

export function startClaim(config: ClaimConfig) {
  const keys = passkeys(config.network)
  const create = $<HTMLButtonElement>('#create')
  const signin = $<HTMLButtonElement>('#signin')

  const register = async (connect: () => Promise<string>) => {
    status('Waiting for your passkey...')
    await connect()
    status('Registering your account...')
    const r = await post<{ address: string; preferredToken: string | null }>(`/claim/${encodeURIComponent(config.token)}`)
    if (!r.ok) {
      status(LINK_ERRORS[r.error.code] ?? `Could not register (${r.error.code}).`, 'bad')
      return
    }
    const address = $('#address')
    if (address) address.textContent = r.address
    const explorer = $<HTMLAnchorElement>('#explorer')
    if (explorer) explorer.href = `${config.explorerUrl}/address/${r.address}`
    for (const el of document.querySelectorAll<HTMLElement>('[data-step="choose"]')) el.hidden = true
    for (const el of document.querySelectorAll<HTMLElement>('[data-step="done"]')) el.hidden = false
    const select = $<HTMLSelectElement>('#preferred-token')
    if (select && r.preferredToken) select.value = r.preferredToken
    status('Done. You will be paid here.', 'ok')
  }

  // The stablecoin they want, saved for the passkey that just registered (its session, never an address from here).
  const choice = $<HTMLSelectElement>('#preferred-token')
  const payoutToken = config.choices[0]?.address ?? ''
  choice?.addEventListener('change', () => {
    void savePreference(config.guildId, payoutToken, choice.value).then((r) => {
      if (!r.ok) return status(`Not saved: ${r.error}.`, 'bad')
      const label = config.choices.find((c) => c.address === r.preferredToken)?.label ?? config.payoutLabel ?? 'the payout token'
      status(
        r.preferredToken && !config.preferredTokens
          ? `Saved: ${label}. ${config.communityName} pays in ${config.payoutLabel ?? 'its payout token'} until its treasurer turns on preferred stablecoins.`
          : `Saved: you will be paid in ${label}.`,
        'ok',
      )
    })
  })

  create?.addEventListener('click', busy([create, signin], () => register(() => keys.create(config.passkeyName)), explainPasskeyError))
  signin?.addEventListener('click', busy([create, signin], () => register(() => keys.signIn()), explainPasskeyError))
}
