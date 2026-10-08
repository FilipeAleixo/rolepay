// The passkey wrapper on the real Accounts SDK Provider, with the WebAuthn ceremony faked: a
// fake adapter plays the server's Handler.webAuthn (it knows some credentials, and answers an
// unknown one the way the server does, "Unknown credential") and the store lives in memory.
// What it pins: a browser that remembers an account from before the server's database was reset
// can still create a new passkey, and the person reads a plain sentence when something fails.
// The real ceremonies are the Playwright e2e (apps/server/e2e/passkeys.spec.ts).
import { Storage, local } from 'accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { payeePasskeyName } from '../passkeyNames.js'
import { explainPasskeyError } from './dom.js'
import { passkeys } from './passkey.js'

const RP_ID = 'rolepay.test'

/** A P256 public key per credential (a fixed private key per index, so addresses are stable). */
const p256 = (n: number) => Account.fromP256(`0x${n.toString(16).padStart(2, '0').repeat(32)}`)

/**
 * The server side of the passkey ceremonies, as the SDK sees it through the webAuthn adapter:
 * `createAccount` registers a new credential, `loadAccounts` signs in with one and fails with
 * "Unknown credential" when the server does not hold it (WebAuthnCeremony.server turns the 400
 * into exactly that Error). `reset()` is the server's database being reset.
 */
function fakeServer(storage: Storage.Storage) {
  const known = new Set<string>()
  const calls: string[] = []
  let minted = 0
  let failNextCreate: Error | null = null
  let failNextLoad: Error | null = null
  const accountFor = (id: string, label?: string) => {
    const key = p256(Number(id.slice('cred-'.length)))
    return {
      address: Account.fromWebAuthnP256({ id, publicKey: key.publicKey }).address,
      ...(label ? { label } : {}),
      keyType: 'webAuthn' as const,
      credential: { id, publicKey: key.publicKey, rpId: RP_ID },
    }
  }
  const base = local({
    async createAccount({ name }) {
      calls.push(`create:${name}`)
      if (failNextCreate) {
        const e = failNextCreate
        failNextCreate = null
        throw e
      }
      const id = `cred-${++minted}`
      known.add(id)
      await storage.setItem('lastCredentialId', id) // as the webAuthn adapter does
      return { accounts: [accountFor(id, name)] }
    },
    async loadAccounts(parameters) {
      const id = typeof parameters?.credentialId === 'string' ? parameters.credentialId : 'picked' // 'picked': chosen in the device's passkey list
      calls.push(`load:${id}`)
      if (failNextLoad) {
        const e = failNextLoad
        failNextLoad = null
        throw e
      }
      if (!known.has(id)) throw new Error('Unknown credential')
      await storage.setItem('lastCredentialId', id)
      return { accounts: [accountFor(id)] }
    },
  })
  // The webAuthn adapter keeps every account it has seen (persistAccounts), so a later register
  // with the same name finds the old one: the behaviour behind the bug.
  const adapter = Object.assign((p: Parameters<typeof base>[0]) => ({ ...base(p), persistAccounts: true }), base)
  return {
    adapter,
    calls,
    reset: () => known.clear(),
    failNextCreate: (e: Error) => {
      failNextCreate = e
    },
    failNextLoad: (e: Error) => {
      failNextLoad = e
    },
  }
}

function setup() {
  const storage = Storage.memory()
  const server = fakeServer(storage)
  const keys = passkeys('moderato', { adapter: server.adapter, storage })
  return { storage, server, keys }
}

/** What the SDK store remembers: each account's label and credential. */
const remembered = (keys: ReturnType<typeof passkeys>) => keys.remembered().map((a) => `${a.label ?? ''}:${a.credentialId}`)

describe('passkeys over the Accounts SDK (a remembered account the server no longer knows)', () => {
  it('create: the SDK signs in with the remembered account of the same name, the server rejects it as unknown, so it is forgotten and a new passkey is registered, once', async () => {
    const { server, keys, storage } = setup()
    const old = await keys.create('Treasury of Test guild')
    await keys.create('Payee of Other guild') // a remembered account under another name is left alone
    server.reset()
    server.calls.length = 0

    const created = await keys.create('Treasury of Test guild')

    expect(server.calls).toEqual(['load:cred-1', 'create:Treasury of Test guild'])
    expect(created).not.toBe(old)
    expect(created).toBe(Account.fromWebAuthnP256({ id: 'cred-3', publicKey: p256(3).publicKey }).address.toLowerCase())
    expect(remembered(keys)).toEqual(['Treasury of Test guild:cred-3', 'Payee of Other guild:cred-2'])
    expect(await storage.getItem('lastCredentialId')).toBe('cred-3')
    expect(keys.account()?.address.toLowerCase()).toBe(created)
  })

  it('create: when the new registration fails too, the stale account stays forgotten, nothing is retried again, and the person reads a plain sentence', async () => {
    const { server, keys, storage } = setup()
    await keys.create('Treasury of Test guild')
    server.reset()
    server.calls.length = 0
    server.failNextCreate(new Error('Request failed'))

    const error = await keys.create('Treasury of Test guild').then(
      () => null,
      (e: unknown) => e,
    )

    expect(server.calls).toEqual(['load:cred-1', 'create:Treasury of Test guild'])
    expect(remembered(keys)).toEqual([])
    expect(await storage.getItem('lastCredentialId')).toBeNull()
    const text = explainPasskeyError(error)
    expect(text).not.toMatch(/RpcResponse|InternalError|Request failed/)
    expect(text).toBe('Something went wrong. The details are in the browser console; try again in a moment.')
  })

  it('create: when the new passkey prompt is closed, the person is told so, plainly', async () => {
    const { server, keys } = setup()
    await keys.create('Treasury of Test guild')
    server.reset()
    server.failNextCreate(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }))
    const error = await keys.create('Treasury of Test guild').catch((e: unknown) => e)
    expect(explainPasskeyError(error)).toBe('The passkey prompt was closed before it finished. Try again.')
  })

  it('create: any other failure is not retried and forgets nothing', async () => {
    const { server, keys } = setup()
    await keys.create('Treasury of Test guild')
    server.calls.length = 0
    server.failNextLoad(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }))
    await expect(keys.create('Treasury of Test guild')).rejects.toThrow(/not allowed/)
    expect(server.calls).toEqual(['load:cred-1'])
    expect(remembered(keys)).toEqual(['Treasury of Test guild:cred-1'])
  })

  it('sign in with a passkey the server does not know: a plain sentence, not RpcResponse.InternalError', async () => {
    const { keys } = setup()
    const error = await keys.signIn().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('RpcResponse.InternalError') // what the SDK throws
    expect(explainPasskeyError(error)).toBe('This server does not know that passkey (it may be from before the server was reset). Create a new passkey, or sign in with another one.')
  })

  it('on page load, a remembered account the server no longer knows leaves the page working: ready() resolves and the account can still sign (signing needs the passkey, not the server)', async () => {
    const { storage, server } = setup()
    const first = passkeys('moderato', { adapter: server.adapter, storage })
    const address = await first.create('Treasury of Test guild')
    server.reset()
    // A new page load: a fresh provider over the same storage.
    const reloaded = passkeys('moderato', { adapter: server.adapter, storage })
    await reloaded.ready()
    expect(reloaded.account()?.address.toLowerCase()).toBe(address)
    // And creating still works from there.
    expect(await reloaded.create('Treasury of Test guild')).not.toBe(address)
  })

  it('on page load, a store that cannot be read is the same as remembering nothing', async () => {
    const broken: Storage.Storage = {
      getItem: async () => {
        throw new Error('IndexedDB unavailable')
      },
      setItem: async () => {},
      removeItem: async () => {},
    }
    const keys = passkeys('moderato', { adapter: fakeServer(Storage.memory()).adapter, storage: broken })
    await expect(keys.ready()).resolves.toBeUndefined()
    expect(keys.account()).toBeNull()
  })
})

// The bug this pins (2026-10-08): payee passkeys were all named "Rolepay: <community>", and the SDK,
// asked to register a name it remembers, signs in with that account instead. So a second payee of
// the same community claiming in the same browser got the first payee's account, and the server
// linked the second Discord user to the first person's address. Names now carry the person.
describe('one browser, several people (a shared device)', () => {
  const addressOf = (cred: number) => Account.fromWebAuthnP256({ id: `cred-${cred}`, publicKey: p256(cred).publicKey }).address.toLowerCase()

  it('two payees of one community claiming in the same browser get two passkeys, two accounts, two addresses', async () => {
    const { server, keys } = setup()
    const alice = await keys.create(payeePasskeyName('Mods guild', 'alice'))
    const bob = await keys.create(payeePasskeyName('Mods guild', 'bob'))
    expect(server.calls).toEqual(['create:Rolepay: Mods guild (alice)', 'create:Rolepay: Mods guild (bob)'])
    expect([alice, bob]).toEqual([addressOf(1), addressOf(2)])
    expect(alice).not.toBe(bob)
    expect(remembered(keys)).toEqual(['Rolepay: Mods guild (bob):cred-2', 'Rolepay: Mods guild (alice):cred-1']) // newest first
  })

  it('the same payee claiming again (a new /payee link) is signed back in to their own account, not given a second one', async () => {
    const { server, keys } = setup()
    const first = await keys.create(payeePasskeyName('Mods guild', 'alice'))
    await keys.create(payeePasskeyName('Mods guild', 'bob'))
    server.calls.length = 0
    const again = await keys.create(payeePasskeyName('Mods guild', 'alice'))
    expect(server.calls).toEqual(['load:cred-1'])
    expect(again).toBe(first)
  })

  it('the treasury passkey ("Rolepay treasury: <community>") still signs its treasurer back in, and a payee in the same browser stays apart from it', async () => {
    const { server, keys } = setup()
    const treasury = await keys.create('Rolepay treasury: Mods guild')
    const payee = await keys.create(payeePasskeyName('Mods guild', 'alice'))
    server.calls.length = 0
    expect(await keys.create('Rolepay treasury: Mods guild')).toBe(treasury)
    expect(server.calls).toEqual(['load:cred-1'])
    expect(payee).not.toBe(treasury)
  })
})
