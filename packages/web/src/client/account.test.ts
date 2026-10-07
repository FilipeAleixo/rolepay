// The account page's browser code on a small fake DOM, with the passkey and the chain faked: who
// pays the fee of a send, that the balance is read right before sending, that nothing is signed
// for a refused or cancelled send. The real passkey and chain path is the Playwright e2e
// (apps/server/e2e/mainnetPath.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: null as null | { address: string },
  signIn: async (): Promise<string> => '',
  balances: new Map<string, bigint>(),
  sent: [] as { chain: { sponsorUrl: string | null; feeToken: string }; token: string; to: string; amount: bigint }[],
}))

vi.mock('./passkey.js', () => ({
  passkeys: () => ({ create: async () => '', signIn: () => h.signIn(), account: () => h.account, ready: async () => {} }),
}))
vi.mock('./tempo.js', () => ({
  balanceOf: async (_c: unknown, token: string) => h.balances.get(token) ?? 0n,
  sendToken: async (chain: { sponsorUrl: string | null; feeToken: string }, _from: unknown, token: string, to: string, amount: bigint) => {
    h.sent.push({ chain, token, to, amount })
    return '0xfeed'
  },
}))

const { startAccount } = await import('./account.js')

/** Just enough DOM for the page: elements by id, data-field and data-step, events, children. */
class El {
  hidden = false
  value = ''
  textContent = ''
  href = ''
  id = ''
  htmlFor = ''
  className = ''
  disabled = false
  children: (El | string)[] = []
  private listeners = new Map<string, ((e: { preventDefault(): void }) => void)[]>()
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {} })
  }
  replaceChildren(...c: (El | string)[]) {
    this.children = c
  }
  append(...c: (El | string)[]) {
    this.children.push(...c)
  }
  get text(): string {
    return this.textContent + this.children.map((c) => (typeof c === 'string' ? c : c.text)).join('')
  }
}

const ALPHA = '0x20c0000000000000000000000000000000000001'
const PATH = '0x20c0000000000000000000000000000000000000'
const ME = '0x7777777777777777777777777777777777777777'
const TO = '0x1234567890123456789012345678901234567890'
const TOKENS = [
  { address: ALPHA, label: 'AlphaUSD' },
  { address: PATH, label: 'pathUSD' },
]

let ids: Record<string, El>
let fields: Record<string, El>
let steps: Record<string, El>
let confirmAnswer = true
const flush = () => new Promise((r) => setTimeout(r, 0))

function page(sponsorUrl: string | null, extra: string[] = []) {
  ids = Object.fromEntries(['signin', 'send', 'max', 'token', 'amount', 'to', 'send-form', 'balances', 'status', ...extra].map((k) => [k, new El()]))
  ;(ids.token as El).value = ALPHA
  fields = { address: new El(), explorer: new El(), 'send-says': new El() }
  steps = { signin: new El(), account: new El(), send: new El(), payouts: new El() }
  ;(steps.account as El).hidden = true
  ;(steps.send as El).hidden = true
  ;(steps.payouts as El).hidden = true
  if (ids['payouts-signin']) ids['payouts-signin'].hidden = true
  vi.stubGlobal('document', {
    querySelector: (s: string) => (s.startsWith('#') ? (ids[s.slice(1)] ?? null) : null),
    querySelectorAll: (s: string) => {
      const field = /^\[data-field="(.+)"\]$/.exec(s)?.[1]
      const step = /^\[data-step="(.+)"\]$/.exec(s)?.[1]
      const el = field ? fields[field] : step ? steps[step] : undefined
      return el ? [el] : []
    },
    createElement: () => new El(),
  })
  vi.stubGlobal('window', { confirm: () => confirmAnswer })
  startAccount({ page: 'account', network: 'mainnet', testnet: false, rpcUrl: 'https://rpc.tempo.xyz', sponsorUrl, explorerUrl: 'https://explore.tempo.xyz', tokens: TOKENS })
}

const type = (id: string, value: string) => {
  ;(ids[id] as El).value = value
  ;(ids['send-form'] as El).fire('input')
}
const send = async () => {
  ;(ids['send-form'] as El).fire('submit')
  await vi.waitFor(() => expect((ids.send as El).disabled).toBe(false))
  await flush()
}
const status = () => (ids.status as El).textContent

beforeEach(() => {
  h.account = { address: ME }
  h.signIn = async () => ME
  h.balances = new Map([[ALPHA, 2_000_000n]])
  h.sent = []
  confirmAnswer = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the account page (browser code)', () => {
  it('a browser that remembers the passkey account shows it and what it holds at once, with no prompt', async () => {
    let prompted = false
    h.signIn = async () => {
      prompted = true
      return ME
    }
    page(null)
    await vi.waitFor(() => expect((fields.address as El).textContent).toBe(ME))
    await vi.waitFor(() => expect((ids.balances as El).children).toHaveLength(1))
    expect((fields.explorer as El).href).toBe(`https://explore.tempo.xyz/address/${ME}`)
    expect([(steps.signin as El).hidden, (steps.account as El).hidden, (steps.send as El).hidden]).toEqual([true, false, false])
    // The usual payout token always; others only when held.
    expect((ids.balances as El).text).toBe('2 AlphaUSD')
    expect(prompted).toBe(false)
  })

  it('a large balance reads with thousands grouped; Max still fills the field with plain digits, which send reads back', async () => {
    h.balances = new Map([[ALPHA, 999_995_000_000n]])
    page('https://sponsor.moderato.tempo.xyz')
    await vi.waitFor(() => expect((ids.balances as El).children).toHaveLength(1))
    expect((ids.balances as El).text).toBe('999,995 AlphaUSD')
    ;(ids.max as El).fire('click')
    expect((ids.amount as El).value).toBe('999995')
    type('to', TO)
    expect((fields['send-says'] as El).textContent).toBe(`You will send 999,995 AlphaUSD to ${TO}.`)
    await send()
    expect(h.sent).toMatchObject([{ amount: 999_995_000_000n }])
    expect(status()).toBe(`Sent 999,995 AlphaUSD to ${TO}. Transaction: https://explore.tempo.xyz/tx/0xfeed`)
  })

  it('otherwise signs in with the passkey first', async () => {
    h.account = null
    page(null)
    await flush()
    expect((fields.address as El).textContent).toBe('')
    ;(ids.signin as El).fire('click')
    await vi.waitFor(() => expect((fields.address as El).textContent).toBe(ME))
  })

  it('without a sponsor: Max keeps 0.1, and the send pays its fee in the token sent', async () => {
    page(null)
    await vi.waitFor(() => expect((ids.balances as El).children).toHaveLength(1))
    ;(ids.max as El).fire('click')
    expect((ids.amount as El).value).toBe('1.9')
    type('to', TO)
    type('amount', '1')
    expect((fields['send-says'] as El).textContent).toBe(`You will send 1 AlphaUSD to ${TO}.`)
    await send()
    expect(h.sent).toEqual([{ chain: expect.objectContaining({ sponsorUrl: null, feeToken: ALPHA }), token: ALPHA, to: TO, amount: 1_000_000n }])
    expect(status()).toBe(`Sent 1 AlphaUSD to ${TO}. Transaction: https://explore.tempo.xyz/tx/0xfeed`)
    expect((ids.amount as El).value).toBe('')
  })

  it('sponsored (testnet): the whole balance can go, and the sponsor carries the fee', async () => {
    page('https://sponsor.moderato.tempo.xyz')
    await vi.waitFor(() => expect((ids.balances as El).children).toHaveLength(1))
    ;(ids.max as El).fire('click')
    expect((ids.amount as El).value).toBe('2')
    type('to', TO)
    await send()
    expect(h.sent).toEqual([{ chain: expect.objectContaining({ sponsorUrl: 'https://sponsor.moderato.tempo.xyz' }), token: ALPHA, to: TO, amount: 2_000_000n }])
  })

  it('reads the balance again right before sending: money that left meanwhile is not sent twice', async () => {
    page(null)
    await vi.waitFor(() => expect((ids.balances as El).children).toHaveLength(1))
    type('to', TO)
    type('amount', '1.5')
    h.balances.set(ALPHA, 1_000_000n) // spent elsewhere since the page loaded
    await send()
    expect(h.sent).toEqual([])
    expect(status()).toBe('Nothing was sent: that is more than you can send: keep 0.1 for the network fee (at most 0.9).')
  })

  it('a refused address or a cancelled confirmation signs and sends nothing', async () => {
    page(null)
    await vi.waitFor(() => expect((ids.balances as El).children).toHaveLength(1))
    type('to', '0x20c000000000000000000000b9537d11c60e8b50')
    type('amount', '1')
    expect((fields['send-says'] as El).textContent).toBe('Check the form: that is a token contract, not an account: tokens cannot be sent there.')
    await send()
    expect(status()).toBe('Nothing was sent: that is a token contract, not an account: tokens cannot be sent there.')
    type('to', TO)
    confirmAnswer = false
    await send()
    expect(h.sent).toEqual([])
  })

  it('says the balance is still being read rather than "at most 0"', async () => {
    h.account = null
    page(null)
    await flush()
    type('to', TO)
    type('amount', '1')
    expect((fields['send-says'] as El).textContent).toBe('Reading your balance...')
  })

  it('shows which stablecoin each community pays in, once the server has a passkey session; without one, a button to sign in first', async () => {
    let session = false
    const payouts = [
      {
        guildId: '1094309218049937418',
        communityName: 'Mods guild',
        payoutToken: { address: ALPHA, label: 'AlphaUSD' },
        preferredToken: null,
        enabled: true,
        choices: [{ address: ALPHA, label: 'AlphaUSD' }],
      },
    ]
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(session ? { ok: true, payouts } : { ok: false, error: { code: 'no_passkey_session' } })))
    page(null, ['payouts', 'payouts-signin'])
    await vi.waitFor(() => expect((ids['payouts-signin'] as El).hidden).toBe(false))
    expect((steps.payouts as El).hidden).toBe(false)
    expect((ids.payouts as El).children).toHaveLength(0)
    session = true
    ;(ids['payouts-signin'] as El).fire('click')
    await vi.waitFor(() => expect((ids.payouts as El).children).toHaveLength(3))
    expect((ids['payouts-signin'] as El).hidden).toBe(true)
    expect((ids.payouts as El).text).toContain('Mods guild pays you in AlphaUSD.')
  })
})
