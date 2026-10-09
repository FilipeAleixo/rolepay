// The payee's account page: sign in with the passkey the claim page made, see what arrived, and
// send it on. The passkey signs in the browser and the transfer goes straight to Tempo: the
// server serves this page and the passkey ceremony, nothing else.
import { $, busy, displayMicros, explainPasskeyError, fill, formatMicros, show, status } from './dom.js'
import { type EventSourceFactory, type EventSourceLike, countUp, follow, nextFrame, prefersReducedMotion } from './live.js'
import { passkeys } from './passkey.js'
import { type Payout, coinsToList, loadPayouts, renderPayouts } from './payouts.js'
import { checkSend, maxSendable } from './send.js'
import { type ChainConfig, balanceOf, sendToken } from './tempo.js'

export type AccountConfig = {
  page: 'account'
  network: string
  testnet: boolean
  rpcUrl: string
  sponsorUrl: string | null
  explorerUrl: string
  tokens: { address: string; label: string }[]
}

/** One payment as /account/live sends it (the parts this page uses). */
type Payment = { key: string; tokenAddress: string }
type Token = AccountConfig['tokens'][number]

/** The RPC may answer a moment behind the payment event: read again this often, this many times, until the balance moves. */
const BALANCE_RETRY_MS = 750
const BALANCE_TRIES = 4
/** How long the gold glow stays on a balance that just grew. */
const GLOW_MS = 1_600

export function startAccount(config: AccountConfig) {
  const keys = passkeys(config.network)
  const sponsored = config.sponsorUrl !== null
  const chain: ChainConfig = { rpcUrl: config.rpcUrl, sponsorUrl: config.sponsorUrl, testnet: config.testnet, feeToken: config.tokens[0]?.address ?? '' }
  const balances = new Map<string, bigint>()
  const buttons = ['#signin', '#send', '#max'].map((s) => $<HTMLButtonElement>(s))
  const action = (work: () => Promise<void>) => busy(buttons, work, explainPasskeyError)
  const input = (id: string) => $<HTMLInputElement>(`#${id}`)?.value ?? ''
  const selected = () => $<HTMLSelectElement>('#token')?.value ?? chain.feeToken
  const label = (token: string) => config.tokens.find((t) => t.address === token)?.label ?? token
  let address: string | null = null
  /** Each shown balance's row and number, by token: what a payment counts up. */
  const shown = new Map<string, { row: HTMLElement; amount: HTMLElement }>()
  /** Received rows already on the page (run:line), so only new ones slide in. */
  const known = new Set<string>()
  let receivedRead = false
  let live: EventSourceLike | null = null
  let counting = Promise.resolve()
  /** Where this account is paid, per community, once the server has said (it needs the passkey session): which balances to list and mark. */
  let paidBy: Payout[] | null = null
  /** The first read of it. The first balance rows wait for it, so they do not change a moment after they appear. */
  let payoutsRead: Promise<void> = Promise.resolve()
  /** Tokens whose last balance read failed: shown as "unknown", never as an old number. */
  const unread = new Set<string>()
  let balancesRead = false

  async function open(account: string) {
    address = account.toLowerCase()
    fill('address', address)
    for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-field="explorer"]')) a.href = `${config.explorerUrl}/address/${address}`
    show('[data-step="signin"]', false)
    show('[data-step="account"]', true)
    show('[data-step="send"]', true)
    payoutsRead = payouts().catch(() => {})
    await refresh()
  }

  /**
   * Which stablecoin each community pays this account in. It needs the server's passkey session; a
   * browser that only remembers the account (no session) gets a button to sign in first.
   */
  async function payouts() {
    const box = $('#payouts')
    if (!box) return
    show('[data-step="payouts"]', true)
    const list = await loadPayouts()
    const signin = $<HTMLButtonElement>('#payouts-signin')
    if (signin) signin.hidden = list !== null
    if (list) renderPayouts(box, list, status, chose)
    // The server knows this passkey (a session): the coins it is paid in, what arrived, and what arrives from now on.
    if (list) {
      paidBy = list
      listBalances()
      void received().catch(() => {})
      followPayments()
    }
  }

  /** A choice saved under "How you are paid": the balances follow at once, from what was already read. */
  function chose(guildId: string, preferredToken: string | null) {
    paidBy = paidBy?.map((p) => (p.guildId === guildId ? { ...p, preferredToken } : p)) ?? null
    listBalances()
  }

  /**
   * The Received list, rendered by the server for the passkey session's own address (the page sends
   * no address). Rows that were not on the page before slide in.
   */
  async function received() {
    const box = $('#received')
    if (!box) return
    const res = await fetch('/account/received', { credentials: 'same-origin' })
    if (!res.ok) return
    box.innerHTML = await res.text()
    show('[data-step="received"]', true)
    for (const li of Array.from(box.querySelectorAll<HTMLElement>('li[data-key]'))) {
      const key = li.getAttribute('data-key') ?? ''
      if (receivedRead && !known.has(key)) li.classList.add('arrived')
      known.add(key)
    }
    receivedRead = true
  }

  /** Payments to this account as they land (server-sent events), once per page. */
  function followPayments() {
    const Source = (globalThis as { EventSource?: EventSourceFactory }).EventSource
    if (live || !Source) return
    live = follow(
      '/account/live',
      { payment: (data) => void arrived(data as Payment) },
      {
        EventSource: Source,
        // Back after a dropped connection: re-read what may have landed meanwhile.
        onReconnect: () => {
          void received().catch(() => {})
          void refresh().catch(() => {})
        },
      },
    )
  }

  /** A payment landed: the new row slides in, and the balance counts up to what the chain now says. */
  async function arrived(p: Payment) {
    await Promise.all([received().catch(() => {}), (counting = counting.then(() => countBalance(p.tokenAddress)).catch(() => {}))])
  }

  /** Reads the token's balance from the chain (so it is true even if the event raced it) and counts up to it. */
  async function countBalance(token: string) {
    if (!address) return
    const account = address
    const before = balances.get(token) ?? 0n
    let after = before
    for (let i = 0; i < BALANCE_TRIES; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, BALANCE_RETRY_MS))
      after = await balanceOf(chain, token, account).catch(() => after)
      if (after !== before) break
    }
    balances.set(token, after)
    // A token not listed yet (neither held nor paid in): its row appears (at the old value), then counts up.
    if (!shown.has(token)) await refresh(new Map([[token, before]]))
    const el = shown.get(token)
    if (!el) return
    const reduced = prefersReducedMotion()
    if (!reduced && after > before) {
      el.row.classList.add('glow')
      setTimeout(() => el.row.classList.remove('glow'), GLOW_MS)
    }
    await countUp(el.amount, before, after, { format: (m) => displayMicros(m.toString()), reducedMotion: reduced, frame: nextFrame })
    describe()
  }

  /** Reads every known token's balance from the chain, then lists them. `showing`: see listBalances. */
  async function refresh(showing: Map<string, bigint> = new Map()) {
    if (!address) return
    const account = address
    await Promise.all([
      ...config.tokens.map(async (t) => {
        const balance = await balanceOf(chain, t.address, account).catch(() => null)
        if (balance === null) {
          unread.add(t.address)
          return
        }
        unread.delete(t.address)
        balances.set(t.address, balance)
      }),
      payoutsRead,
    ])
    balancesRead = true
    listBalances(showing)
  }

  /**
   * The balances, built with the DOM (never HTML strings): every coin a community pays this account
   * in and every coin it chose, even at 0 (a chosen one marked "preferred", in words), then any other
   * coin it holds. The chosen first, the page's token order otherwise. Never empty: with nothing else
   * to list (no passkey session yet, nothing held), the usual payout token. `showing` overrides what a
   * row first shows (a balance about to count up).
   */
  function listBalances(showing: Map<string, bigint> = new Map()) {
    if (!balancesRead) return
    const { listed, preferred } = coinsToList(paidBy ?? [])
    const isPreferred = (t: Token) => preferred.has(t.address.toLowerCase())
    const held = (t: Token) => !unread.has(t.address) && (balances.get(t.address) ?? 0n) > 0n
    const rows = config.tokens.filter((t) => listed.has(t.address.toLowerCase()) || held(t))
    const ordered = rows.length === 0 ? config.tokens.slice(0, 1) : [...rows.filter(isPreferred), ...rows.filter((t) => !isPreferred(t))]
    shown.clear()
    $('#balances')?.replaceChildren(
      ...ordered.map((t) => {
        const p = document.createElement('p')
        const strong = document.createElement('strong')
        const value = showing.get(t.address) ?? (unread.has(t.address) ? null : (balances.get(t.address) ?? 0n))
        strong.textContent = value === null ? 'unknown' : displayMicros(value.toString())
        p.append(strong, ` ${t.label}`)
        if (isPreferred(t)) {
          const mark = document.createElement('span')
          mark.className = 'pill'
          mark.textContent = 'preferred'
          p.append(' ', mark)
        }
        shown.set(t.address, { row: p, amount: strong })
        return p
      }),
    )
    describe()
  }

  const checked = () => checkSend({ to: input('to'), amount: input('amount'), from: address ?? '', balance: balances.get(selected()) ?? 0n, sponsored })

  /** What the form would send, in plain words, as it is typed: once both fields have something (an amount not typed yet is not a mistake). */
  function describe() {
    if (!input('to').trim() || !input('amount').trim()) return fill('send-says', '')
    if (!balances.has(selected())) return fill('send-says', 'Reading your balance...')
    const c = checked()
    fill('send-says', c.ok ? `You will send ${displayMicros(c.value.amount.toString())} ${label(selected())} to ${c.value.to}.` : `Check the form: ${c.error}.`)
  }

  async function send() {
    if (!address) return status('Sign in with your passkey first.', 'bad')
    // The balance that counts is the one right now (and the page may not have read it yet).
    balances.set(selected(), await balanceOf(chain, selected(), address))
    const c = checked()
    if (!c.ok) return status(`Nothing was sent: ${c.error}.`, 'bad')
    const token = selected()
    const what = `${displayMicros(c.value.amount.toString())} ${label(token)} to ${c.value.to}`
    if (!window.confirm(`Send ${what}? A transfer cannot be undone.`)) return
    let account = keys.account()
    if (!account || account.address.toLowerCase() !== address) {
      status('First, sign in with your passkey. Your device will then ask once more, to send.')
      await keys.signIn()
      account = keys.account()
    }
    if (!account || account.address.toLowerCase() !== address) throw new Error('this passkey is not the account shown')
    status('Confirm with your passkey to send...')
    // Without a sponsor the fee is paid in the token sent: the one this account holds.
    const tx = await sendToken({ ...chain, feeToken: token }, account, token, c.value.to, c.value.amount)
    const amount = $<HTMLInputElement>('#amount')
    if (amount) amount.value = ''
    await refresh()
    status(`Sent ${what}. Transaction: ${config.explorerUrl}/tx/${tx}`, 'ok')
  }

  $('#signin')?.addEventListener(
    'click',
    action(async () => {
      status('Waiting for your passkey...')
      await open(await keys.signIn())
      status('')
    }),
  )
  $('#payouts-signin')?.addEventListener(
    'click',
    action(async () => {
      status('Waiting for your passkey...')
      await keys.signIn()
      await payouts()
      status('')
    }),
  )
  $('#max')?.addEventListener('click', () => {
    const amount = $<HTMLInputElement>('#amount')
    if (amount) amount.value = formatMicros(maxSendable(balances.get(selected()) ?? 0n, sponsored).toString())
    describe()
  })
  $('#send-form')?.addEventListener('input', describe)
  $('#send-form')?.addEventListener('change', describe)
  $('#send-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    void action(send)()
  })
  // A browser that remembers the passkey account shows it at once, without a prompt.
  void keys.ready().then(() => {
    const remembered = keys.account()
    if (remembered) void open(remembered.address).catch((e: unknown) => status(explainPasskeyError(e), 'bad'))
  })
}
