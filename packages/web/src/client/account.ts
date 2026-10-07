// The payee's account page: sign in with the passkey the claim page made, see what arrived, and
// send it on. The passkey signs in the browser and the transfer goes straight to Tempo: the
// server serves this page and the passkey ceremony, nothing else.
import { $, busy, displayMicros, explainPasskeyError, fill, formatMicros, show, status } from './dom.js'
import { passkeys } from './passkey.js'
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

  async function open(account: string) {
    address = account.toLowerCase()
    fill('address', address)
    for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-field="explorer"]')) a.href = `${config.explorerUrl}/address/${address}`
    show('[data-step="signin"]', false)
    show('[data-step="account"]', true)
    show('[data-step="send"]', true)
    await refresh()
  }

  /** Every known token's balance; the ones held are listed (the usual payout token always). Built with the DOM, never HTML strings. */
  async function refresh() {
    if (!address) return
    const account = address
    const rows = await Promise.all(
      config.tokens.map(async (t) => {
        const balance = await balanceOf(chain, t.address, account).catch(() => null)
        if (balance !== null) balances.set(t.address, balance)
        return { t, balance }
      }),
    )
    $('#balances')?.replaceChildren(
      ...rows
        .filter((r, i) => i === 0 || (r.balance ?? 0n) > 0n)
        .map((r) => {
          const p = document.createElement('p')
          const strong = document.createElement('strong')
          strong.textContent = r.balance === null ? 'unknown' : displayMicros(r.balance.toString())
          p.append(strong, ` ${r.t.label}`)
          return p
        }),
    )
    describe()
  }

  const checked = () => checkSend({ to: input('to'), amount: input('amount'), from: address ?? '', balance: balances.get(selected()) ?? 0n, sponsored })

  /** What the form would send, in plain words, as it is typed. */
  function describe() {
    if (!input('to') && !input('amount')) return fill('send-says', '')
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
