// The passkey account, through the Tempo Accounts SDK's webAuthn adapter. The ceremonies
// run against this server's Handler.webAuthn at /webauthn, which keeps the credential's
// public key and issues a session cookie; the server derives the account address from it.
import { Provider, Store, webAuthn } from 'accounts'
import type { Account } from 'viem/tempo'
import { tempo, tempoModerato } from 'viem/tempo/chains'

export type Passkeys = {
  /** A new passkey (and with it a new Tempo account). Returns its address. */
  create(name: string): Promise<string>
  /** An existing passkey on this device or synced to it. Returns its address. */
  signIn(): Promise<string>
  /** The signed-in account, able to sign Tempo transactions with the passkey, or null. */
  account(): Account.Account | null
  /** Resolves once the account this browser remembers (IndexedDB) is loaded, so account() is meaningful. */
  ready(): Promise<void>
}

export function passkeys(network: string): Passkeys {
  const provider = Provider.create({ adapter: webAuthn({ auth: '/webauthn' }), chains: [network === 'mainnet' ? tempo : tempoModerato] })
  const connect = async (capabilities: Record<string, unknown>) => {
    const r = (await provider.request({ method: 'wallet_connect', params: [{ capabilities }] } as never)) as { accounts: { address: string }[] }
    const address = r.accounts[0]?.address
    if (!address) throw new Error('no account returned by the passkey')
    return address.toLowerCase()
  }
  return {
    create: (name) => connect({ method: 'register', name }),
    signIn: () => connect({ method: 'login', selectAccount: true }),
    account() {
      try {
        return provider.getAccount({ signable: true })
      } catch {
        return null
      }
    },
    ready: () => Store.waitForHydration(provider.store),
  }
}
