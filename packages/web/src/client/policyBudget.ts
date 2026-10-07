// A policy's own budget, on the treasury's page: its own access key's authorisation, rotation and
// revocation, signed with the treasury passkey. The same safety model as the setup page: the page
// signs what it builds from this form (buildAuthorization), never the server's copy, and refuses to
// sign at all when the server's copy differs (authorizationMismatch). One passkey prompt per action.
import { $, busy, explainPasskeyError, fill, formatMicros, get, post, shortAddress, show, status } from './dom.js'
import { treasuryFeeToken } from './fees.js'
import { type KeyForm, authorizationMismatch, buildAuthorization, describeAuthorization } from './keychain.js'
import { passkeys } from './passkey.js'
import { type ChainConfig, type WireAuthorization, authorizeAccessKey, balanceOf, revokeAccessKey } from './tempo.js'

export type PolicyBudgetConfig = {
  page: 'policy-budget'
  token: string
  policyId: string
  policyName: string
  policyStatus: 'draft' | 'active' | 'paused' | 'archived'
  guildName: string
  network: string
  testnet: boolean
  rpcUrl: string
  sponsorUrl: string | null
  explorerUrl: string
  treasury: string
  payoutToken: string
  tokenLabel: string
  feeMode: 'sponsor' | 'fee_budget'
  feeToken: string | null
  feeTokenLabel: string | null
  about: string
  defaults: { limit: string; periodDays: number; validityDays: number; feeBudget: string }
}

type KeyView = {
  address: string
  status: 'pending_authorization' | 'active' | 'revoked' | 'superseded'
  policy: { limit: string; periodSeconds: number | null; expiresAt: number }
  chain: { status: 'active' | 'revoked' | 'expired' | 'not_authorized'; remaining: string; expiry: number; periodEnd: number | null } | null
}
type State = {
  policy: { id: string; name: string; status: string }
  /** Whose budget pays the policy's runs: the bot key's, its own key, or nothing (its key revoked). */
  signs: 'bot' | 'own' | 'retired'
  key: KeyView | null
  /** This policy's keys not yet revoked; the ones live on chain get a Revoke button each. */
  keys: KeyView[]
  session: { address: string } | null
  isTreasurer: boolean
  signInRequired: boolean
}

const ERRORS: Record<string, string> = {
  link_expired: 'This link has expired. Open the policy again in Discord (/rolepay policy show) or on the dashboard for a new one.',
  link_not_found: 'This link is not valid. Open the policy again in Discord or on the dashboard for a new one.',
  not_the_treasury: 'This passkey is not the treasury of this server. Sign in with the treasury passkey.',
  no_passkey_session: 'Sign in with the treasury passkey first.',
  sign_in_required: 'Sign in with the treasury passkey first: this session does not prove it.',
  policy_archived: 'This policy is archived: it gets no new key. You can still revoke its old one.',
  policy_not_found: 'This policy no longer exists.',
}
const explain = (e: { code: string } & Record<string, unknown>) => ERRORS[e.code] ?? `That did not work (${e.code}${Array.isArray(e.issues) ? `: ${e.issues.join('; ')}` : ''}).`
const date = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const PROMPTS_ONCE = 'Your device will ask for your passkey once, to sign the key.'
const PROMPTS_TWICE = 'Your device will ask twice: once to sign in, once to sign the key.'

export function startPolicyBudget(config: PolicyBudgetConfig) {
  const keys = passkeys(config.network)
  const base = `/setup/${encodeURIComponent(config.token)}/policies/${encodeURIComponent(config.policyId)}`
  const treasury = config.treasury.toLowerCase()
  const chain: ChainConfig = { rpcUrl: config.rpcUrl, sponsorUrl: config.sponsorUrl, testnet: config.testnet, feeToken: config.feeToken ?? config.payoutToken }
  let state: State | null = null
  const fixed = ['#signin', '#authorize'].map((s) => $<HTMLButtonElement>(s))
  const buttons = () => [...fixed, ...document.querySelectorAll<HTMLButtonElement>('#live-keys button')]
  const action = (work: () => Promise<void>) => () => busy(buttons(), work, explainPasskeyError)()
  /** This policy's keys the chain says can still sign for the treasury. Never the bot key or another policy's. */
  const liveKeys = (s: State | null) => (s?.keys ?? []).filter((k) => k.chain?.status === 'active')
  const holdsTreasury = () => keys.account()?.address.toLowerCase() === treasury

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
    show('[data-when="signed-out"]', !s.isTreasurer)
    show('[data-step="budget"]', s.isTreasurer)
    fill('budget-status', budgetText(s))
    if (!s.isTreasurer) return
    fill('key-prompts', holdsTreasury() ? PROMPTS_ONCE : PROMPTS_TWICE)
    const live = liveKeys(s)
    fill('key-replaces', live.length ? `The same transaction revokes this policy's current key, so its old budget never stays spendable. The bot key and other policies' keys are not touched.` : '')
    const authorize = $<HTMLButtonElement>('#authorize')
    if (authorize) authorize.textContent = live.length ? "Replace this policy's key with these limits" : 'Give this policy its own budget'
    renderLiveKeys(live)
  }

  function budgetText(s: State): string {
    const t = config.tokenLabel
    const k = s.key
    if (s.signs === 'retired') return "This policy's own key is revoked: it pays nothing until you give it a new budget. It never falls back to the bot key."
    if (s.signs === 'bot' || !k) {
      const waiting = k?.status === 'pending_authorization' ? ` A key (${shortAddress(k.address)}) is waiting for your signature.` : ''
      return `This policy pays from the bot key's budget, shared with manual runs, AI-proposed runs and other policies.${waiting}`
    }
    const c = k.chain
    if (!c || c.status === 'revoked') return `This policy's key ${shortAddress(k.address)} is revoked: it pays nothing until you give it a new budget.`
    if (c.status === 'expired') return `This policy's key ${shortAddress(k.address)} has expired: it pays nothing until you give it a new budget.`
    if (c.status !== 'active') return `This policy's key ${shortAddress(k.address)} is not authorised on chain.`
    const resets = c.periodEnd ? `, resets ${date(c.periodEnd)}` : ''
    return `This policy has its own key ${shortAddress(k.address)}: ${formatMicros(c.remaining)} of ${formatMicros(k.policy.limit)} ${t} left${resets}. Expires ${date(c.expiry)}. The chain enforces it.`
  }

  /** One line and one Revoke button per key of this policy live on chain. Built with the DOM, never HTML strings. */
  function renderLiveKeys(live: KeyView[]) {
    const box = $('#live-keys')
    if (!box) return
    box.replaceChildren(
      ...live.map((k) => {
        const row = document.createElement('p')
        const label = document.createElement('span')
        const left = k.chain ? `${formatMicros(k.chain.remaining)} of ${formatMicros(k.policy.limit)} ${config.tokenLabel} left, expires ${date(k.chain.expiry)}` : ''
        label.textContent = `${k.status === 'active' ? "This policy's key" : "This policy's old key, still live"} ${shortAddress(k.address)}: ${left}. `
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'danger'
        button.textContent = live.length === 1 ? "Revoke this policy's key" : `Revoke ${shortAddress(k.address)}`
        button.addEventListener('click', action(() => revoke(k.address)))
        row.append(label, button)
        return row
      }),
    )
  }

  /** The passkey account that is the treasury, signing in if needed. */
  async function treasuryAccount() {
    if (!holdsTreasury()) {
      status('First, sign in with the treasury passkey. Your device will then ask once more, to sign.')
      await keys.signIn()
    }
    const account = keys.account()
    if (!account || account.address.toLowerCase() !== treasury) throw new Error(`this passkey is not the treasury (${treasury})`)
    return account
  }

  /** Sponsored: as configured. Without a sponsor the treasury pays its own fee, as on the setup page (fees.ts). */
  async function chainForTreasury(): Promise<ChainConfig> {
    if (config.sponsorUrl) return chain
    const feeToken = config.feeMode === 'fee_budget' ? config.feeToken : null
    const [fee, payout] = await Promise.all([
      feeToken ? balanceOf(chain, feeToken, treasury).catch(() => null) : Promise.resolve(null),
      balanceOf(chain, config.payoutToken, treasury).catch(() => 0n),
    ])
    return { ...chain, feeToken: treasuryFeeToken({ feeToken, payoutToken: config.payoutToken, balances: { fee, payout } }) }
  }

  const input = (id: string) => $<HTMLInputElement>(`#${id}`)?.value.trim() ?? ''
  const form = (): KeyForm => ({
    limit: input('limit'),
    periodDays: input('periodDays'),
    validityDays: input('validityDays'),
    ...(config.feeMode === 'fee_budget' ? { feeBudget: input('feeBudget') } : {}),
  })
  /** What this page signs comes from the form and the page config, never from the server. */
  const keyPage = { payoutToken: config.payoutToken, feeToken: config.feeMode === 'fee_budget' ? config.feeToken : null }
  const labels = {
    label: (token: string) => (token.toLowerCase() === config.payoutToken.toLowerCase() ? config.tokenLabel : token.toLowerCase() === config.feeToken?.toLowerCase() ? (config.feeTokenLabel ?? token) : token),
    date,
  }
  const nowSeconds = () => Math.floor(Date.now() / 1000)
  function showSigns() {
    const built = buildAuthorization(form(), keyPage, nowSeconds())
    fill('key-signs', built.ok ? `You will sign, for this policy only: ${describeAuthorization(built.value, labels)}` : `Check the form: ${built.error}.`)
  }

  async function authorize() {
    const built = buildAuthorization(form(), keyPage, nowSeconds())
    if (!built.ok) return status(`Nothing was signed: ${built.error}.`, 'bad')
    const mine = built.value
    const account = await treasuryAccount()
    status("Preparing this policy's key...")
    const f = form()
    const body = { limit: f.limit, periodDays: Number(f.periodDays), expiresAt: mine.expiry, ...(f.feeBudget !== undefined ? { feeBudget: f.feeBudget } : {}) }
    const revoke = liveKeys(state).map((k) => k.address)
    const p = await post<{ keyAddress: string; authorization: WireAuthorization }>(`${base}/key`, body)
    if (!p.ok) return status(explain(p.error), 'bad')
    // The server only names the key. If its copy of the authorisation differs from what this page
    // built from the form, something is wrong with the server: sign nothing.
    const mismatch = authorizationMismatch(mine, p.authorization)
    if (mismatch) return status(`Nothing was signed: the server's copy of the authorisation has ${mismatch}, not what you chose. Do not sign until this is explained.`, 'bad')
    fill('key-signs', `You are signing, for this policy only: ${describeAuthorization(mine, labels)}`)
    status(revoke.length ? "Confirm with your passkey to replace this policy's key (one signature)..." : "Confirm with your passkey to give this policy its own key...")
    const tx = await authorizeAccessKey(await chainForTreasury(), account, p.keyAddress, mine, revoke.filter((a) => a !== p.keyAddress))
    status('Authorised on chain. Checking...')
    const c = await post<{ key: unknown }>(`${base}/key/confirm`, { keyAddress: p.keyAddress })
    if (!c.ok) return status(explain(c.error), 'bad')
    await refresh()
    status(`${config.policyName} has its own budget now. Transaction: ${config.explorerUrl}/tx/${tx}`, 'ok')
  }

  async function revoke(keyAddress: string) {
    if (!window.confirm(`Revoke this policy's key ${shortAddress(keyAddress)}? ${config.policyName} then pays nothing until you give it a new budget; it never falls back to the bot key.`)) return
    const account = await treasuryAccount()
    status("Confirm with your passkey to revoke this policy's key...")
    await revokeAccessKey(await chainForTreasury(), account, keyAddress)
    const r = await post<{ key: unknown }>(`${base}/key/revoked`, { keyAddress })
    if (!r.ok) return status(explain(r.error), 'bad')
    await refresh()
    status("This policy's key is revoked.", 'ok')
  }

  async function signIn() {
    status('Waiting for your passkey...')
    await keys.signIn()
    await refresh()
    if (state && !state.isTreasurer) status(explain({ code: 'not_the_treasury' }), 'bad')
  }

  const [signin] = fixed
  signin?.addEventListener('click', action(signIn))
  $('#budget-form')?.addEventListener('input', showSigns)
  showSigns()
  $('#budget-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    void action(authorize)()
  })
  void refresh()
}
