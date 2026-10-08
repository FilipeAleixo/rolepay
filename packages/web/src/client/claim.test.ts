// The claim page's browser code on a small fake DOM, its requests served by the real routes and core
// services in process (test/harness.ts), and window.ethereum a fake EIP-1193 wallet backed by a viem
// local account. What it pins: "Use a wallet I already have" registers the address that signed,
// shows where they will be paid and why to keep that wallet, and a person declining in the wallet
// reads a calm sentence with nothing registered. The real browser is the Playwright e2e.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeWallet } from '../../test/fakeWallet.js'
import { ALICE, GUILD, claimLink, registeredCommunity, webHarness } from '../../test/harness.js'

vi.mock('./passkey.js', () => ({ passkeys: () => ({ create: async () => '', signIn: async () => '', account: () => null, ready: async () => {} }) }))

const { startClaim } = await import('./claim.js')
const { WALLET_DECLINED } = await import('./wallet.js')

/** Just enough DOM for the page: elements by id and data-step, click events. */
class El {
  hidden = false
  textContent = ''
  href = ''
  value = ''
  className = ''
  disabled = false
  private listeners: (() => void)[] = []
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn)
  }
  click() {
    for (const fn of this.listeners) fn()
  }
}

let ids: Record<string, El>
let steps: Record<string, El>

async function page(wallet: ReturnType<typeof fakeWallet> | null) {
  const h = webHarness()
  await registeredCommunity(h)
  const token = await claimLink(h)
  ids = Object.fromEntries(['create', 'signin', 'wallet', 'status', 'address', 'explorer', 'wallet-address', 'wallet-explorer'].map((k) => [k, new El()]))
  steps = { choose: new El(), done: new El(), 'done-wallet': new El() }
  ;(steps.done as El).hidden = true
  ;(steps['done-wallet'] as El).hidden = true
  vi.stubGlobal('document', {
    querySelector: (s: string) => (s.startsWith('#') ? (ids[s.slice(1)] ?? null) : null),
    querySelectorAll: (s: string) => {
      const step = /^\[data-step="(.+)"\]$/.exec(s)?.[1]
      return step && steps[step] ? [steps[step]] : []
    },
  })
  vi.stubGlobal('ethereum', wallet?.provider)
  // The page's same-origin requests, answered by the real web app.
  const posted: string[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    posted.push(path)
    return h.app.request(path, init)
  })
  startClaim({
    page: 'claim',
    token,
    communityName: 'Mods guild',
    passkeyName: 'Rolepay: Mods guild (alice)',
    network: 'moderato',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
    guildId: GUILD,
    payoutLabel: 'AlphaUSD',
    preferredTokens: false,
    choices: [],
  })
  const click = async () => {
    ;(ids.wallet as El).click()
    await vi.waitFor(() => expect((ids.wallet as El).disabled).toBe(false))
  }
  return { h, posted, click, payee: () => h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE }) }
}
const status = () => ({ text: (ids.status as El).textContent, tone: (ids.status as El).className })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the claim page (browser code): a wallet the payee already has', () => {
  it('switches the wallet to Tempo, signs the server message, and shows where they will be paid and to keep that wallet', async () => {
    const wallet = fakeWallet()
    const p = await page(wallet)
    await p.click()
    const address = wallet.account.address.toLowerCase()
    expect(status()).toEqual({ text: 'Done. You will be paid at your wallet.', tone: 'ok' })
    expect((ids['wallet-address'] as El).textContent).toBe(address)
    expect((ids['wallet-explorer'] as El).href).toBe(`https://explore.testnet.tempo.xyz/address/${address}`)
    expect([(steps.choose as El).hidden, (steps.done as El).hidden, (steps['done-wallet'] as El).hidden]).toEqual([true, true, false])
    expect(wallet.methods()).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts', 'personal_sign'])
    expect(p.posted.map((path) => path.replace(/\/claim\/[^/]+/, '/claim/:token'))).toEqual(['/claim/:token/wallet/challenge', '/claim/:token/wallet'])
    expect(await p.payee()).toMatchObject({ ok: true, value: { address, addressKind: 'external' } })
  })

  it('a person who declines in the wallet reads a calm sentence (not an error), nothing is registered, and they can choose again', async () => {
    for (const method of ['eth_requestAccounts', 'personal_sign']) {
      const p = await page(fakeWallet({ refuse: [method] }))
      await p.click()
      expect(status(), method).toEqual({ text: WALLET_DECLINED, tone: '' })
      expect((await p.payee()).ok, method).toBe(false)
      expect((steps.choose as El).hidden, method).toBe(false)
      expect([(ids.create as El).disabled, (ids.wallet as El).disabled], method).toEqual([false, false])
    }
  })

  it('no wallet in this browser: says so and points to the passkey', async () => {
    const p = await page(null)
    await p.click()
    expect(status().text).toBe('No wallet found in this browser. Open this link in the browser where your wallet is (for example MetaMask), or create a passkey instead.')
    expect(p.posted).toEqual([])
  })

  it('a wallet whose signature type the server cannot check yet (a smart-contract or passkey account) is told to use a passkey', async () => {
    const wallet = fakeWallet()
    const real = wallet.provider.request.bind(wallet.provider)
    wallet.provider.request = async (r) => (r.method === 'personal_sign' ? `0x${'ab'.repeat(200)}` : real(r))
    const p = await page(wallet)
    await p.click()
    expect(status()).toEqual({ text: "This wallet's signature type isn't supported yet; use a passkey.", tone: 'bad' })
    expect((await p.payee()).ok).toBe(false)
  })
})
