// The treasurer setup page: the community account (passkey as root), funding, and the bot
// key's authorisation and revocation, signed with the passkey.
import { $, busy, explainPasskeyError, fill, formatMicros, get, post, shortAddress, show, status } from './dom.js'
import { treasuryFeeToken } from './fees.js'
import { type KeyForm, STABLECOIN_DEX, authorizationMismatch, buildAuthorization, describeAuthorization } from './keychain.js'
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
  /** The stablecoins the key may swap into and deliver when preferred stablecoins are on. */
  swapTokens: { address: string; label: string }[]
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
  community: { treasury: string; payoutToken: string; feeMode: string; feeToken: string | null; preferredTokens: boolean } | null
  /** Preferred stablecoins are on but the active key was authorised without the swap scope. */
  keyNeedsSwapScope: boolean
  key: KeyView | null
  /** Every key not yet revoked; the ones live on chain are listed with a Revoke button each. */
  keys: KeyView[]
  session: { address: string } | null
  isTreasurer: boolean
  /** Signed in as the treasury's address, but not with a passkey login: sign in to act. */
  signInRequired: boolean
}

const LINK_ERRORS: Record<string, string> = {
  link_expired: 'This setup link has expired. Run /rolepay setup in Discord for a new one.',
  link_not_found: 'This setup link is not valid. Run /rolepay setup in Discord for a new one.',
  treasury_mismatch: 'This passkey is not the treasury of this server.',
  not_the_treasury: 'This passkey is not the treasury of this server. Sign in with the treasury passkey.',
  no_passkey_session: 'Sign in with your passkey first.',
  sign_in_required: 'Sign in with the treasury passkey first: this session does not prove it.',
}
const explain = (e: { code: string } & Record<string, unknown>) =>
  e.code === 'treasury_mismatch' && typeof e.treasuryAddress === 'string'
    ? `This passkey is not the treasury of this server. The treasury is ${e.treasuryAddress}.`
    : (LINK_ERRORS[e.code] ?? `That did not work (${e.code}${Array.isArray(e.issues) ? `: ${e.issues.join('; ')}` : ''}).`)

const date = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Signing the key is one passkey prompt (one transaction, see keychain.ts). Only when this
 * browser does not remember the treasury account (site data cleared, say) while its session is
 * still live does the page need a sign-in first, which is a second prompt: say so up front.
 */
const PROMPTS_ONCE = 'Your device will ask for your passkey once, to sign the key.'
const PROMPTS_TWICE = 'Your device will ask twice: once to sign in, once to sign the key.'

export function startSetup(config: SetupConfig) {
  const keys = passkeys(config.network)
  const base = `/setup/${encodeURIComponent(config.token)}`
  const chain: ChainConfig = { rpcUrl: config.rpcUrl, sponsorUrl: config.sponsorUrl, testnet: config.testnet, feeToken: config.feeToken ?? config.payoutToken }
  let state: State | null = null
  const fixed = ['#create', '#signin', '#signin-bound', '#faucet', '#authorize'].map((s) => $<HTMLButtonElement>(s))
  const preferred = $<HTMLInputElement>('#preferred-tokens')
  /** The page's buttons right now: the fixed ones and one Revoke per live key. */
  const buttons = () => [...fixed, ...document.querySelectorAll<HTMLButtonElement>('#live-keys button')]
  const action = (work: () => Promise<void>) => () => busy(buttons(), work, explainPasskeyError)()
  /** Keys the chain says can still sign for the treasury (active, or replaced but not revoked). */
  const liveKeys = (s: State | null) => (s?.keys ?? []).filter((k) => k.chain.status === 'active')

  /** Whether this browser holds the treasury's passkey account, so it can sign without signing in. */
  const holdsTreasury = (treasury: string) => keys.account()?.address.toLowerCase() === treasury

  async function refresh() {
    const [s] = await Promise.all([get<State>(`${base}/state`), keys.ready()])
    if (!s.ok) {
      status(explain(s.error), 'bad')
      for (const b of buttons()) if (b) b.disabled = true
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
    if (config.feeMode === 'fee_budget' && config.feeToken) {
      void balanceOf(chain, config.feeToken, s.community.treasury)
        .then((b) => fill('fee-balance', formatMicros(b.toString())))
        .catch(() => fill('fee-balance', 'unknown'))
    }
    fill('key-status', keyText(s.key))
    if (preferred) preferred.checked = s.community.preferredTokens
    fill('preferred-status', preferredText(s))
    showSigns()
    fill('key-prompts', holdsTreasury(s.community.treasury) ? PROMPTS_ONCE : PROMPTS_TWICE)
    const live = liveKeys(s)
    fill('key-replaces', live.length ? `The same transaction revokes ${live.length === 1 ? 'the current key' : `all ${live.length} live keys`}, so no old key stays spendable.` : '')
    const authorize = $<HTMLButtonElement>('#authorize')
    if (authorize) authorize.textContent = live.length ? 'Replace the bot key with these limits' : 'Authorise the bot key with my passkey'
    renderLiveKeys(live)
  }

  /** One line and one Revoke button per key live on chain. Built with the DOM, never HTML strings. */
  function renderLiveKeys(live: KeyView[]) {
    const box = $('#live-keys')
    if (!box) return
    box.replaceChildren(
      ...live.map((k) => {
        const row = document.createElement('p')
        const label = document.createElement('span')
        const left = `${formatMicros(k.chain.remaining)} of ${formatMicros(k.policy.limit)} ${config.tokenLabel} left, expires ${date(k.chain.expiry)}`
        label.textContent = `${k.status === 'active' ? 'Bot key' : 'Old bot key, still live'} ${shortAddress(k.address)}: ${left}. `
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'danger'
        button.textContent = live.length === 1 ? 'Revoke the bot key' : `Revoke the bot key ${shortAddress(k.address)}`
        button.addEventListener('click', action(() => revoke(k.address)))
        row.append(label, button)
        return row
      }),
    )
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

  /** Where preferred stablecoins stand, and whether the key must be replaced for them. */
  function preferredText(s: State): string {
    if (!s.community?.preferredTokens) return `Off: everyone is paid in ${config.tokenLabel}.`
    if (s.keyNeedsSwapScope) return 'On, but the current bot key cannot swap: authorise a new key below. Until then, runs that pay someone in another stablecoin wait, and nothing is sent.'
    return 'On: people who chose another stablecoin get it, bought in the same transaction that pays them.'
  }

  async function setPreferred(enabled: boolean) {
    await treasuryAccount()
    const r = await post<{ preferredTokens: boolean; keyNeedsSwapScope: boolean }>(`${base}/preferred-tokens`, { enabled })
    if (!r.ok) {
      if (preferred) preferred.checked = !enabled
      return status(explain(r.error), 'bad')
    }
    await refresh()
    status(
      r.keyNeedsSwapScope ? 'Preferred stablecoins are on. Authorise a new bot key below so it can swap.' : `Preferred stablecoins are ${r.preferredTokens ? 'on' : 'off'}.`,
      'ok',
    )
  }

  /** The passkey account that is the treasury, signing in if needed. */
  async function treasuryAccount() {
    const treasury = state?.community?.treasury
    if (!treasury) throw new Error('the treasury is not set up yet')
    if (!holdsTreasury(treasury)) {
      status('First, sign in with the treasury passkey. Your device will then ask once more, to sign.')
      await keys.signIn()
    }
    const account = keys.account()
    if (!account || account.address.toLowerCase() !== treasury) throw new Error(`this passkey is not the treasury (${treasury})`)
    return account
  }

  /**
   * The chain settings for a transaction the treasury signs. Sponsored: as configured. Without a
   * sponsor (mainnet) the treasury pays its own fee: in the fee token while it has enough, else in
   * the payout token, so a revoke never fails for want of the fee token (fees.ts).
   */
  async function chainForTreasury(treasury: string): Promise<ChainConfig> {
    if (config.sponsorUrl) return chain
    const feeToken = config.feeMode === 'fee_budget' ? config.feeToken : null
    const [fee, payout] = await Promise.all([
      feeToken ? balanceOf(chain, feeToken, treasury).catch(() => null) : Promise.resolve(null),
      balanceOf(chain, config.payoutToken, treasury).catch(() => 0n),
    ])
    return { ...chain, feeToken: treasuryFeeToken({ feeToken, payoutToken: config.payoutToken, balances: { fee, payout } }) }
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
  const form = (): KeyForm => ({
    limit: input('limit'),
    periodDays: input('periodDays'),
    validityDays: input('validityDays'),
    ...(config.feeMode === 'fee_budget' ? { feeBudget: input('feeBudget') } : {}),
  })
  /**
   * What this page signs comes from the form and the page config, never from the server (H4). With
   * preferred stablecoins on (the switch above the form), it adds the swap scope for the page
   * config's swap tokens.
   */
  const keyPage = () => ({
    payoutToken: config.payoutToken,
    feeToken: config.feeMode === 'fee_budget' ? config.feeToken : null,
    swapTokens: state?.community?.preferredTokens ? config.swapTokens.map((t) => t.address) : null,
  })
  const labels = {
    label: (token: string) =>
      token.toLowerCase() === config.payoutToken.toLowerCase()
        ? config.tokenLabel
        : token.toLowerCase() === config.feeToken?.toLowerCase()
          ? (config.feeTokenLabel ?? token)
          : token.toLowerCase() === STABLECOIN_DEX
            ? "Tempo's stablecoin exchange"
            : (config.swapTokens.find((t) => t.address.toLowerCase() === token.toLowerCase())?.label ?? token),
    date,
  }
  const nowSeconds = () => Math.floor(Date.now() / 1000)
  /** The exact values the passkey will sign, in plain words, kept up to date as the form changes. */
  function showSigns() {
    const built = buildAuthorization(form(), keyPage(), nowSeconds())
    fill('key-signs', built.ok ? `You will sign: ${describeAuthorization(built.value, labels)}` : `Check the form: ${built.error}.`)
  }

  async function authorize() {
    const built = buildAuthorization(form(), keyPage(), nowSeconds())
    if (!built.ok) return status(`Nothing was signed: ${built.error}.`, 'bad')
    const mine = built.value
    const account = await treasuryAccount()
    status('Preparing the bot key...')
    const f = form()
    const body = { limit: f.limit, periodDays: Number(f.periodDays), expiresAt: mine.expiry, ...(f.feeBudget !== undefined ? { feeBudget: f.feeBudget } : {}) }
    const revoke = liveKeys(state).map((k) => k.address)
    const p = await post<{ keyAddress: string; authorization: WireAuthorization }>(`${base}/key`, body)
    if (!p.ok) return status(explain(p.error), 'bad')
    // The server only names the key. If its copy of the authorisation differs from what this page
    // built from the form, something is wrong with the server: sign nothing.
    const mismatch = authorizationMismatch(mine, p.authorization)
    if (mismatch) return status(`Nothing was signed: the server's copy of the authorisation has ${mismatch}, not what you chose. Do not sign until this is explained.`, 'bad')
    fill('key-signs', `You are signing: ${describeAuthorization(mine, labels)}`)
    status(revoke.length ? 'Confirm with your passkey to replace the bot key (one signature)...' : 'Confirm with your passkey to authorise the bot key...')
    const tx = await authorizeAccessKey(await chainForTreasury(account.address), account, p.keyAddress, mine, revoke.filter((a) => a !== p.keyAddress))
    status('Authorised on chain. Checking...')
    const c = await post<{ key: unknown }>(`${base}/key/confirm`, { keyAddress: p.keyAddress })
    if (!c.ok) return status(explain(c.error), 'bad')
    await refresh()
    status(`The bot key is active. Transaction: ${config.explorerUrl}/tx/${tx}`, 'ok')
  }

  async function revoke(keyAddress: string) {
    const isActive = state?.key?.address === keyAddress && state.key.status === 'active'
    const question = isActive ? 'Revoke the bot key? The bot cannot pay anyone until you authorise a new one.' : `Revoke the old bot key ${shortAddress(keyAddress)}?`
    if (!window.confirm(question)) return
    const account = await treasuryAccount()
    status('Confirm with your passkey to revoke the bot key...')
    await revokeAccessKey(await chainForTreasury(account.address), account, keyAddress)
    const r = await post<{ key: unknown }>(`${base}/key/revoked`, { keyAddress })
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

  const [create, signin, signinBound, faucetButton] = fixed
  create?.addEventListener('click', action(() => bind(() => keys.create(config.passkeyName))))
  signin?.addEventListener('click', action(() => bind(() => keys.signIn())))
  signinBound?.addEventListener('click', action(() => bind(() => keys.signIn())))
  faucetButton?.addEventListener('click', action(fund))
  preferred?.addEventListener('change', () => void action(() => setPreferred(preferred.checked))())
  $('#key-form')?.addEventListener('input', showSigns)
  showSigns()
  $('#key-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    void action(authorize)()
  })
  void refresh()
}
