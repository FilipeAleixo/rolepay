// The account page's browser code on a small fake DOM, with the passkey and the chain faked: who
// pays the fee of a send, that the balance is read right before sending, that nothing is signed
// for a refused or cancelled send. The real passkey and chain path is the Playwright e2e
// (apps/server/e2e/mainnetPath.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '../../test/fakeEventSource.js'

const h = vi.hoisted(() => ({
  account: null as null | { address: string },
  signIn: async (): Promise<string> => '',
  balances: new Map<string, bigint>(),
  /** How many balances the page read from the chain. */
  reads: 0,
  sent: [] as { chain: { sponsorUrl: string | null; feeToken: string }; token: string; to: string; amount: bigint }[],
}))

vi.mock('./passkey.js', () => ({
  passkeys: () => ({ create: async () => '', signIn: () => h.signIn(), account: () => h.account, ready: async () => {} }),
}))
vi.mock('./tempo.js', () => ({
  balanceOf: async (_c: unknown, token: string) => {
    h.reads++
    return h.balances.get(token) ?? 0n
  },
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
  attrs: Record<string, string> = {}
  classes = new Set<string>()
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c) }
  /** The list items a server fragment holds (one per data-key), kept between reads like real nodes. */
  items: El[] = []
  private html = ''
  get innerHTML() {
    return this.html
  }
  set innerHTML(v: string) {
    this.html = v
    this.items = [...v.matchAll(/data-key="([^"]+)"/g)].map((m) => {
      const li = new El()
      li.attrs['data-key'] = m[1] ?? ''
      return li
    })
  }
  querySelectorAll(_selector: string) {
    return this.items
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null
  }
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
const BETA = '0x20c0000000000000000000000000000000000002'
const THETA = '0x20c0000000000000000000000000000000000003'
const ME = '0x7777777777777777777777777777777777777777'
const TO = '0x1234567890123456789012345678901234567890'
const GUILD = '1094309218049937418'
const TOKENS = [
  { address: ALPHA, label: 'AlphaUSD' },
  { address: PATH, label: 'pathUSD' },
  { address: BETA, label: 'BetaUSD' },
  { address: THETA, label: 'ThetaUSD' },
]
const CHOICES = [
  { address: ALPHA, label: 'AlphaUSD' },
  { address: BETA, label: 'BetaUSD' },
  { address: THETA, label: 'ThetaUSD' },
]
/** One community that pays this account, as /account/payouts answers: AlphaUSD, preferred stablecoins on, no preference. */
const payout = (over: Record<string, unknown> = {}) => ({
  guildId: GUILD,
  communityName: 'Mods guild',
  payoutToken: { address: ALPHA, label: 'AlphaUSD' },
  preferredToken: null as string | null,
  enabled: true,
  choices: CHOICES,
  ...over,
})
/** Each balance row as a person reads it, the mark included ("0 BetaUSD preferred"). */
const balanceRows = () => (ids.balances as El).children.map((c) => (typeof c === 'string' ? c : c.text))

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
  h.reads = 0
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
    // What it holds (no passkey session yet, so no choices known); the other tokens at 0 stay out.
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

  describe('the balances: every coin they are paid in, the one they prefer marked, and what they hold', () => {
    let answer: unknown
    let saved: unknown[]

    beforeEach(() => {
      saved = []
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url !== '/account/preference') return new Response(JSON.stringify(answer))
        const body = JSON.parse(String(init?.body)) as { token: string | null }
        saved.push(body)
        return new Response(JSON.stringify({ ok: true, preferredToken: body.token }))
      })
    })

    const opened = (payouts: unknown[]) => {
      answer = { ok: true, payouts }
      page(null, ['payouts', 'payouts-signin'])
    }
    /** Picks `token` in the `n`th community's select under "How you are paid" (label, select, words: three children each). */
    const choose = (n: number, token: string) => {
      const select = (ids.payouts as El).children[n * 3 + 1] as El
      select.value = token
      select.fire('change')
    }

    it('a coin they chose shows even before they hold any, marked "preferred" in words; the payout token they hold none of does not', async () => {
      h.balances = new Map()
      opened([payout({ preferredToken: BETA })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 BetaUSD preferred']))
      const mark = ((ids.balances as El).children[0] as El).children.at(-1) as El
      expect([mark.className, mark.textContent]).toEqual(['pill', 'preferred'])
    })

    it('with no preference, the coin the community pays in, unmarked, even at 0 and even when it is not the usual one', async () => {
      h.balances = new Map()
      opened([payout({ payoutToken: { address: THETA, label: 'ThetaUSD' } })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 ThetaUSD']))
    })

    it('what they hold still shows, after the coin they prefer, in the page order', async () => {
      h.balances = new Map([
        [ALPHA, 2_000_000n],
        [PATH, 500_000n],
      ])
      opened([payout({ preferredToken: BETA })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 BetaUSD preferred', '2 AlphaUSD', '0.5 pathUSD']))
    })

    it('while the community has preferred stablecoins off: their choice, marked, and the payout token it still pays them in', async () => {
      h.balances = new Map()
      opened([payout({ preferredToken: BETA, enabled: false })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 BetaUSD preferred', '0 AlphaUSD']))
    })

    it('two communities with different choices: each chosen coin is marked', async () => {
      h.balances = new Map([[ALPHA, 2_000_000n]])
      opened([payout({ preferredToken: THETA }), payout({ guildId: '1094309218049937419', communityName: 'Art club', preferredToken: BETA })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 BetaUSD preferred', '0 ThetaUSD preferred', '2 AlphaUSD']))
    })

    it('a new choice moves the row and its mark at once, without reading the chain again', async () => {
      h.balances = new Map([[PATH, 1_000_000n]])
      opened([payout({ preferredToken: BETA })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 BetaUSD preferred', '1 pathUSD']))
      const reads = h.reads
      choose(0, THETA)
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 ThetaUSD preferred', '1 pathUSD']))
      choose(0, ALPHA) // the community's own coin: no preference any more
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 AlphaUSD', '1 pathUSD']))
      expect(saved).toEqual([
        { guildId: GUILD, token: THETA },
        { guildId: GUILD, token: null },
      ])
      expect(h.reads).toBe(reads)
    })

    it('a choice the server refused leaves the balances as they were', async () => {
      h.balances = new Map()
      opened([payout({ preferredToken: BETA })])
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 BetaUSD preferred']))
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: false, error: { code: 'token_not_allowed' } })))
      choose(0, THETA)
      await vi.waitFor(() => expect(status()).toBe('Not saved: that community cannot pay in this token.'))
      expect(balanceRows()).toEqual(['0 BetaUSD preferred'])
    })

    it('with no passkey session (no choices known) and nothing held: the usual payout token at 0, so the list is never empty', async () => {
      h.balances = new Map()
      answer = { ok: false, error: { code: 'no_passkey_session' } }
      page(null, ['payouts', 'payouts-signin'])
      await vi.waitFor(() => expect((ids['payouts-signin'] as El).hidden).toBe(false))
      await vi.waitFor(() => expect(balanceRows()).toEqual(['0 AlphaUSD']))
    })
  })

  describe('live: a payment lands while the page is open', () => {
    let payouts: unknown = { ok: true, payouts: [] }
    const row = (key: string) => `<li data-key="${key}"><strong>+1 AlphaUSD</strong><span> · from Mods · pay run ${key.split(':')[0]}, line 1</span></li>`
    let receivedHtml = ''
    let frames = 0
    let reduced = false

    beforeEach(() => {
      payouts = { ok: true, payouts: [] }
      receivedHtml = row('run_1:1')
      frames = 0
      reduced = false
      vi.stubGlobal('fetch', async (url: string) => (url === '/account/payouts' ? new Response(JSON.stringify(payouts)) : new Response(receivedHtml)))
      vi.stubGlobal('EventSource', FakeEventSource)
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }))
      let now = 0
      vi.stubGlobal('requestAnimationFrame', (step: (t: number) => void) => {
        frames++
        setTimeout(() => step((now += 100)), 0)
      })
    })

    const amount = () => ((ids.balances as El).children[0] as El).children[0] as El
    const balanceRow = () => (ids.balances as El).children[0] as El
    /** The page open and listening, its first balance row showing `first`. */
    async function opened(first = '2') {
      FakeEventSource.last = null
      page('https://sponsor.moderato.tempo.xyz', ['payouts', 'payouts-signin', 'received'])
      await vi.waitFor(() => expect(FakeEventSource.last?.url).toBe('/account/live'))
      await vi.waitFor(() => expect((ids.received as El).items).toHaveLength(1))
      await vi.waitFor(() => expect(amount().textContent).toBe(first))
      return FakeEventSource.last as unknown as FakeEventSource
    }

    it('counts the balance up from the old value to what the chain says, with a glow, and slides the new row in', async () => {
      const source = await opened()
      const shown: string[] = []
      const el = amount()
      let text = el.textContent
      Object.defineProperty(el, 'textContent', { get: () => text, set: (v: string) => shown.push((text = v)) })
      h.balances.set(ALPHA, 3_000_000n)
      receivedHtml = row('run_2:1') + row('run_1:1')
      source.emit('payment', { key: 'run_2:1', tokenAddress: ALPHA })
      await vi.waitFor(() => expect(text).toBe('3'))
      expect(frames).toBeGreaterThan(3)
      expect(shown.length).toBeGreaterThan(3) // in between values, not one jump
      expect(shown.some((v) => v !== '2' && v !== '3')).toBe(true)
      expect(balanceRow().classes.has('glow')).toBe(true)
      const [fresh, old] = (ids.received as El).items
      expect([fresh?.attrs['data-key'], fresh?.classes.has('arrived')]).toEqual(['run_2:1', true])
      expect([old?.attrs['data-key'], old?.classes.has('arrived')]).toEqual(['run_1:1', false])
      expect((steps.received as El | undefined)?.hidden ?? false).toBe(false)
    })

    it('with reduced motion, just shows the new balance: no animation frames, no glow', async () => {
      reduced = true
      const source = await opened()
      h.balances.set(ALPHA, 5_000_000n)
      source.emit('payment', { key: 'run_2:1', tokenAddress: ALPHA })
      await vi.waitFor(() => expect(amount().textContent).toBe('5'))
      expect(frames).toBe(0)
      expect(balanceRow().classes.has('glow')).toBe(false)
    })

    it('reads the balance again when the RPC answers behind the event, and shows a token it did not hold yet', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        reduced = true
        const source = await opened()
        source.emit('payment', { key: 'run_2:1', tokenAddress: PATH })
        await vi.advanceTimersByTimeAsync(100)
        h.balances.set(PATH, 4_000_000n) // the chain catches up after the first read
        await vi.advanceTimersByTimeAsync(2_000)
        await vi.waitFor(() => expect((ids.balances as El).text).toBe('2 AlphaUSD4 pathUSD'))
      } finally {
        vi.useRealTimers()
      }
    })

    it('a payment in the coin they prefer counts up from 0 on the row already there, with a glow, and the mark stays', async () => {
      payouts = { ok: true, payouts: [payout({ preferredToken: BETA })] }
      const source = await opened('0')
      const preferredRow = balanceRow()
      expect(balanceRows()).toEqual(['0 BetaUSD preferred', '2 AlphaUSD'])
      const shown: string[] = []
      const el = amount()
      let text = el.textContent
      Object.defineProperty(el, 'textContent', { get: () => text, set: (v: string) => shown.push((text = v)) })
      h.balances.set(BETA, 1_500_000n)
      receivedHtml = row('run_2:1') + row('run_1:1')
      source.emit('payment', { key: 'run_2:1', tokenAddress: BETA })
      await vi.waitFor(() => expect(text).toBe('1.5'))
      expect(shown.length).toBeGreaterThan(3) // counted, not one jump
      expect(shown.some((v) => v !== '0' && v !== '1.5')).toBe(true)
      expect(balanceRow()).toBe(preferredRow) // the same row, not a new one
      expect(preferredRow.classes.has('glow')).toBe(true)
      expect(balanceRows()).toEqual(['1.5 BetaUSD preferred', '2 AlphaUSD'])
    })
  })
})
