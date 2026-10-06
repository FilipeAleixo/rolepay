// The recipient claim page: one passkey, one address, registered with the community.
import { $, busy, explainPasskeyError, post, status } from './dom.js'
import { passkeys } from './passkey.js'

export type ClaimConfig = { page: 'claim'; token: string; communityName: string; passkeyName: string; network: string; explorerUrl: string }

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
    const r = await post<{ address: string }>(`/claim/${encodeURIComponent(config.token)}`)
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
    status('Done. You will be paid here.', 'ok')
  }

  create?.addEventListener('click', busy([create, signin], () => register(() => keys.create(config.passkeyName)), explainPasskeyError))
  signin?.addEventListener('click', busy([create, signin], () => register(() => keys.signIn()), explainPasskeyError))
}
