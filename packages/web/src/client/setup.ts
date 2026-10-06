// The treasurer setup page: the community account (passkey as root), funding, and the bot
// key's authorisation and revocation, signed with the passkey.
import { $, busy, explainPasskeyError, fill, formatMicros, get, post, shortAddress, show, status } from './dom.js'
import { passkeys } from './passkey.js'
import { type ChainConfig, type WireAuthorization, authorizeAccessKey, balanceOf, faucet, revokeAccessKey } from './tempo.js'

export type SetupConfig = {
  page: 'setup'
  token: string
  guildName: string
  network: string
  testnet: boolean
  rpcUrl: string
  sponsorUrl: string | null
  explorerUrl: string
  treasury: string | null
  payoutToken: string
  tokenLabel: string
  feeMode: 'sponsor' | 'fee_budget'
  feeToken: string | null
  feeTokenLabel: string | null
  passkeyName: string
  defaults: { limit: string; periodDays: number; validityDays: number; feeBudget: string }
}

type KeyView = {
  address: string
  status: 'pending_authorization' | 'active' | 'revoked' | 'superseded'
  policy: { limit: string; periodSeconds: number | null; expiresAt: number }
  chain: { status: 'active' | 'revoked' | 'expired' | 'not_authorized'; remaining: string; expiry: number; periodEnd: number | null }
}
type State = {
  community: { treasury: string; payoutToken: string; feeMode: string; feeToken: string | null } | null
  key: KeyView | null
  session: { address: string } | null
  isTreasurer: boolean
}

const LINK_ERRORS: Record<string, string> = {
  link_expired: 'This setup link has expired. Run /payrun setup in Discord for a new one.',
  link_not_found: 'This setup link is not valid. Run /payrun setup in Discord for a new one.',
  treasury_mismatch: 'This passkey is not the treasury of this server.',
  not_the_treasury: 'This passkey is not the treasury of this server. Sign in with the treasury passkey.',
  no_passkey_session: 'Sign in with your passkey first.',
}
const explain = (e: { code: string } & Record<string, unknown>) =>
  e.code === 'treasury_mismatch' && typeof e.treasuryAddress === 'string'
    ? `This passkey is not the treasury of this server. The treasury is ${e.treasuryAddress}.`
    : (LINK_ERRORS[e.code] ?? `That did not work (${e.code}${Array.isArray(e.issues) ? `: ${e.issues.join('; ')}` : ''}).`)

const date = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function startSetup(config: SetupConfig) {
  const keys = passkeys(config.network)
  const base = `/setup/${encodeURIComponent(config.token)}`
  const chain: ChainConfig = { rpcUrl: config.rpcUrl, sponsorUrl: config.sponsorUrl, testnet: config.testnet, feeToken: config.feeToken ?? config.payoutToken }
  let state: State | null = null
  const buttons = ['#create', '#signin', '#signin-bound', '#faucet', '#authorize', '#revoke'].map((s) => $<HTMLButtonElement>(s))

  async function refresh() {
    const s = await get<State>(`${base}/state`)
    if (!s.ok) {
      status(explain(s.error), 'bad')
      for (const b of buttons) if (b) b.disabled = true
      return
    }
    state = s
    render(s)
  }

  function render(s: State) {
    const bound = s.community !== null
    show('[data-when="unbound"]', !bound)
    show('[data-when="bound"]', bound)
    show('[data-when="signed-in"]', s.isTreasurer)
    show('[data-when="signed-out"]', bound && !s.isTreasurer)
    show('[data-step="fund"]', s.isTreasurer)
    show('[data-step="key"]', s.isTreasurer)
    if (s.community) {
      fill('treasury', s.community.treasury)
      for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-field="explorer"]')) a.href = `${config.explorerUrl}/address/${s.community.treasury}`
    }
    if (!s.isTreasurer || !s.community) return
    void balanceOf(chain, s.community.payoutToken, s.community.treasury)
      .then((b) => fill('balance', formatMicros(b.toString())))
      .catch(() => fill('balance', 'unknown'))
    fill('key-status', keyText(s.key))
    const active = s.key?.status === 'active' && s.key.chain.status === 'active'
    show('#revoke', active)
    const authorize = $<HTMLButtonElement>('#authorize')
    if (authorize) authorize.textContent = active ? 'Replace the bot key with these limits' : 'Authorise the bot key with my passkey'
  }

  function keyText(k: KeyView | null): string {
    const t = config.tokenLabel
    if (!k) return 'No bot key yet. Choose what it may spend, then authorise it with your passkey.'
    if (k.status === 'pending_authorization') return `A bot key (${shortAddress(k.address)}) is waiting for your signature.`
    if (k.status === 'revoked' || k.chain.status === 'revoked') return `The bot key ${shortAddress(k.address)} is revoked. Authorise a new one to let the bot pay again.`
    if (k.chain.status === 'expired') return `The bot key ${shortAddress(k.address)} has expired. Authorise a new one.`
    if (k.chain.status !== 'active') return `The bot key ${shortAddress(k.address)} is not authorised on chain yet.`
    const resets = k.chain.periodEnd ? `, resets ${date(k.chain.periodEnd)}` : ''
    return `Bot key ${shortAddress(k.address)} is active: ${formatMicros(k.chain.remaining)} of ${formatMicros(k.policy.limit)} ${t} left${resets}. Expires ${date(k.chain.expiry)}.`
  }

  /** The passkey account that is the treasury, signing in if needed. */
  async function treasuryAccount() {
    const treasury = state?.community?.treasury
    if (!treasury) throw new Error('the treasury is not set up yet')
    let account = keys.account()
    if (!account || account.address.toLowerCase() !== treasury) {
      status('Sign in with the treasury passkey...')
      await keys.signIn()
      account = keys.account()
    }
    if (!account || account.address.toLowerCase() !== treasury) throw new Error(`this passkey is not the treasury (${treasury})`)
    return account
  }

  async function bind(connect: () => Promise<string>) {
    status('Waiting for your passkey...')
    await connect()
    const r = await post<{ treasury: string }>(`${base}/treasury`)
    if (!r.ok) return status(explain(r.error), 'bad')
    status('Signed in as the treasury.', 'ok')
    await refresh()
  }

  const input = (id: string) => $<HTMLInputElement>(`#${id}`)?.value.trim() ?? ''

  async function authorize() {
    const account = await treasuryAccount()
    status('Preparing the bot key...')
    const body = { limit: input('limit'), periodDays: Number(input('periodDays')), validityDays: Number(input('validityDays')), ...(config.feeMode === 'fee_budget' ? { feeBudget: input('feeBudget') } : {}) }
    const p = await post<{ keyAddress: string; authorization: WireAuthorization }>(`${base}/key`, body)
    if (!p.ok) return status(explain(p.error), 'bad')
    status('Confirm with your passkey to authorise the bot key...')
    const tx = await authorizeAccessKey(chain, account, p.keyAddress, p.authorization)
    status('Authorised on chain. Checking...')
    const c = await post<{ key: unknown }>(`${base}/key/confirm`)
    if (!c.ok) return status(explain(c.error), 'bad')
    await refresh()
    status(`The bot key is active. Transaction: ${config.explorerUrl}/tx/${tx}`, 'ok')
  }

  async function revoke() {
    const key = state?.key
    if (!key) return
    if (!window.confirm('Revoke the bot key? The bot cannot pay anyone until you authorise a new one.')) return
    const account = await treasuryAccount()
    status('Confirm with your passkey to revoke the bot key...')
    await revokeAccessKey(chain, account, key.address)
    const r = await post<{ key: unknown }>(`${base}/key/revoked`)
    if (!r.ok) return status(explain(r.error), 'bad')
    await refresh()
    status('The bot key is revoked.', 'ok')
  }

  async function fund() {
    const treasury = state?.community?.treasury
    if (!treasury) return
    status('Asking the testnet faucet...')
    await faucet(chain, treasury)
    await refresh()
    status('Testnet funds arrived.', 'ok')
  }

  const [create, signin, signinBound, faucetButton, authorizeButton, revokeButton] = buttons
  create?.addEventListener('click', busy(buttons, () => bind(() => keys.create(config.passkeyName)), explainPasskeyError))
  signin?.addEventListener('click', busy(buttons, () => bind(() => keys.signIn()), explainPasskeyError))
  signinBound?.addEventListener('click', busy(buttons, () => bind(() => keys.signIn()), explainPasskeyError))
  faucetButton?.addEventListener('click', busy(buttons, fund, explainPasskeyError))
  revokeButton?.addEventListener('click', busy(buttons, revoke, explainPasskeyError))
  $('#key-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    void busy(buttons, authorize, explainPasskeyError)()
  })
  void authorizeButton
  void refresh()
}
