// The passkey account, through the Tempo Accounts SDK's webAuthn adapter. The ceremonies
// run against this server's Handler.webAuthn at /webauthn, which keeps the credential's
// public key and issues a session cookie; the server derives the account address from it.
import { type Adapter, Provider, Storage, Store, webAuthn } from 'accounts'
import type { Account } from 'viem/tempo'
import { tempo, tempoModerato } from 'viem/tempo/chains'

export type Passkeys = {
  /**
   * A new passkey (and with it a new Tempo account). Returns its address. `name` must belong to one
   * person: the SDK, asked to register a name this browser remembers, signs in with that account
   * instead (Provider's "If a stored account already has this label"). The pages pass one name per
   * person (`passkeyNames.ts`: a payee's carries their Discord username, the treasury's its
   * community), so on a shared device a second person always gets their own passkey, and the same
   * person creating again is signed back in to their own account rather than given a second one.
   * That is why names are made unique rather than remembered accounts cleared before each register:
   * clearing would also give a returning payee or treasurer a new, empty account each time.
   */
  create(name: string): Promise<string>
  /** An existing passkey on this device or synced to it. Returns its address. */
  signIn(): Promise<string>
  /** The signed-in account, able to sign Tempo transactions with the passkey, or null. */
  account(): Account.Account | null
  /** Resolves once the account this browser remembers (IndexedDB) is loaded, so account() is meaningful. Never fails. */
  ready(): Promise<void>
  /** The passkey accounts this browser remembers, newest first: each one's name and credential. */
  remembered(): { label: string | null; credentialId: string | null }[]
}

/** The SDK's pieces, for tests: a fake adapter in place of the WebAuthn ceremonies, and memory storage. */
export type PasskeyOptions = { adapter?: Adapter.Adapter; storage?: Storage.Storage }

/**
 * The server answered a sign-in with a credential it does not hold: the browser remembers a
 * passkey from before the server's database was reset (Handler.webAuthn's "Unknown credential",
 * which the SDK wraps in RpcResponse.InternalError with the original as its cause).
 */
export function isUnknownCredential(error: unknown): boolean {
  let e: unknown = error
  for (let i = 0; i < 5 && e instanceof Error; i++, e = e.cause) if (/Unknown credential/i.test(e.message)) return true
  return false
}

/**
 * The part of the SDK's store (a zustand store) used here. Its type comes from zustand, which this
 * package does not depend on directly, so the compiler cannot see it.
 */
type AccountStore = {
  getState(): { accounts: readonly Store.Account[] }
  setState(state: { accounts: readonly Store.Account[]; activeAccount: number }): void
}

export function passkeys(network: string, opts: PasskeyOptions = {}): Passkeys {
  // The SDK's own default storage (IndexedDB under its "tempo" prefix), held here so a stale
  // credential is forgotten through the SDK's storage API, never by touching IndexedDB directly.
  const storage = opts.storage ?? Storage.idb()
  const provider = Provider.create({ adapter: opts.adapter ?? webAuthn({ auth: '/webauthn' }), chains: [network === 'mainnet' ? tempo : tempoModerato], storage })
  const store = provider.store as unknown as AccountStore
  const credentialOf = (a: Store.Account) => ('credential' in a && a.credential ? a.credential.id : null)
  const connect = async (capabilities: Record<string, unknown>) => {
    const r = (await provider.request({ method: 'wallet_connect', params: [{ capabilities }] } as never)) as { accounts: { address: string }[] }
    const address = r.accounts[0]?.address
    if (!address) throw new Error('no account returned by the passkey')
    return address.toLowerCase()
  }

  /**
   * Forgets the remembered accounts that a register with `name` would sign in with instead (the
   * SDK matches the label, ignoring case), and the last credential if it was one of them, through
   * the SDK's store and storage. Returns how many accounts it forgot.
   */
  async function forget(name: string): Promise<number> {
    const { accounts } = store.getState()
    const stale = accounts.filter((a) => credentialOf(a) !== null && a.label?.toLowerCase() === name.toLowerCase())
    if (stale.length === 0) return 0
    store.setState({ accounts: accounts.filter((a) => !stale.includes(a)), activeAccount: 0 })
    const last = await storage.getItem<string>('lastCredentialId')
    if (last !== null && stale.some((a) => credentialOf(a) === last)) await storage.removeItem('lastCredentialId')
    return stale.length
  }

  return {
    async create(name) {
      try {
        return await connect({ method: 'register', name })
      } catch (error) {
        // When this browser remembers an account under the same name, the SDK signs in with it
        // instead of registering. If the server no longer knows that credential (its database was
        // reset), forget it and register once more, which makes a new passkey. Once only: if that
        // fails too, the person reads why (explainPasskeyError).
        if (!isUnknownCredential(error) || (await forget(name)) === 0) throw error
        return await connect({ method: 'register', name })
      }
    },
    signIn: () => connect({ method: 'login', selectAccount: true }),
    account() {
      try {
        return provider.getAccount({ signable: true })
      } catch {
        return null
      }
    },
    // A remembered account is kept even if this server no longer knows its credential: signing a
    // transaction needs only the passkey and the public key the browser keeps, not the server, so
    // the money in that account can still be moved. The server is asked only on create and sign
    // in, which handle an unknown credential (above, and in explainPasskeyError). A store that
    // cannot be read counts as remembering nothing.
    ready: () => Store.waitForHydration(provider.store).catch(() => {}),
    remembered: () => store.getState().accounts.map((a) => ({ label: a.label ?? null, credentialId: credentialOf(a) })),
  }
}
