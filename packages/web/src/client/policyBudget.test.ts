// A policy's budget page, its browser code on a small fake DOM, with the passkey, the chain and the
// server faked: the page signs the authorisation it built from the form, refuses to sign (no passkey
// prompt at all) when the server's copy differs, and a replacement revokes only this policy's live
// key in the same transaction. The real passkey and chain path is the Playwright e2e.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: null as null | { address: string },
  authorized: [] as { keyAddress: string; auth: { expiry: number; limits: { token: string; limit: string; period?: number }[] }; revoke: readonly string[] }[],
  revoked: [] as string[],
  requests: [] as { path: string; body: unknown }[],
  answer: (_path: string, _body: unknown): unknown => ({ ok: true }),
}))

vi.mock('./passkey.js', () => ({
  passkeys: () => ({ create: async () => '', signIn: async () => '', account: () => h.account, ready: async () => {} }),
}))
vi.mock('./tempo.js', () => ({
  balanceOf: async () => 10_000_000n,
  authorizeAccessKey: async (_c: unknown, _root: unknown, keyAddress: string, auth: (typeof h.authorized)[number]['auth'], revoke: readonly string[] = []) => {
    h.authorized.push({ keyAddress, auth, revoke })
    return '0xabc'
  },
  revokeAccessKey: async (_c: unknown, _root: unknown, keyAddress: string) => {
    h.revoked.push(keyAddress)
    return '0xdef'
  },
}))

const { startPolicyBudget } = await import('./policyBudget.js')

class El {
  hidden = false
  value = ''
  textContent = ''
  className = ''
  type = ''
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
}

const TREASURY = '0x7777777777777777777777777777777777777777'
const ALPHA = '0x20c0000000000000000000000000000000000001'
const OLD_KEY = '0x5555555555555555555555555555555555555551'
const NEW_KEY = '0x5555555555555555555555555555555555555552'
const NOW = Math.floor(Date.now() / 1000)

let ids: Record<string, El>
let fields: Record<string, El>
const flush = () => new Promise((r) => setTimeout(r, 0))

const keyView = (address: string, status = 'active') => ({
  address,
  status,
  policy: { limit: '30000000', periodSeconds: 604_800, expiresAt: NOW + 30 * 86_400 },
  chain: { status: 'active', remaining: '20000000', expiry: NOW + 30 * 86_400, periodEnd: NOW + 86_400 },
})
let state: Record<string, unknown>

function page() {
  ids = Object.fromEntries(['signin', 'authorize', 'limit', 'periodDays', 'validityDays', 'budget-form', 'live-keys', 'status'].map((k) => [k, new El()]))
  ;(ids.limit as El).value = '30'
  ;(ids.periodDays as El).value = '7'
  ;(ids.validityDays as El).value = '30'
  fields = Object.fromEntries(['budget-status', 'key-signs', 'key-replaces', 'key-prompts', 'treasury'].map((k) => [k, new El()]))
  vi.stubGlobal('document', {
    querySelector: (s: string) => (s.startsWith('#') ? (ids[s.slice(1)] ?? null) : null),
    querySelectorAll: (s: string) => {
      const field = /^\[data-field="(.+)"\]$/.exec(s)?.[1]
      if (field) return fields[field] ? [fields[field]] : []
      if (s === '#live-keys button') return (ids['live-keys'] as El).children.flatMap((row) => (typeof row === 'string' ? [] : row.children.filter((c): c is El => typeof c !== 'string' && c.type === 'button')))
      return []
    },
    createElement: () => new El(),
  })
  vi.stubGlobal('window', { confirm: () => true })
  vi.stubGlobal('fetch', async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null
    h.requests.push({ path, body })
    const answer = path.endsWith('/state') ? { ok: true, ...state } : h.answer(path, body)
    return { json: async () => answer }
  })
  startPolicyBudget({
    page: 'policy-budget',
    token: 'tok',
    policyId: 'pol_000001',
    policyName: 'Judges',
    policyStatus: 'active',
    guildName: 'Mods guild',
    network: 'moderato',
    testnet: true,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
    treasury: TREASURY,
    payoutToken: ALPHA,
    tokenLabel: 'AlphaUSD',
    feeMode: 'sponsor',
    feeToken: null,
    feeTokenLabel: null,
    about: 'Every day at 18:00 (UTC).',
    defaults: { limit: '30', periodDays: 7, validityDays: 30, feeBudget: '1' },
  })
}

/** What the server answers to POST .../key: the key it minted and its copy of the authorisation. */
const provisioned = (over: { limit?: string; period?: number; expiry?: number } = {}) => (path: string, sent: unknown) => {
  const body = sent as { expiresAt: number }
  return path.endsWith('/key')
    ? {
        ok: true,
        keyAddress: NEW_KEY,
        treasury: TREASURY,
        authorization: {
          expiry: over.expiry ?? body.expiresAt,
          limits: [{ token: ALPHA, limit: over.limit ?? '30000000', period: over.period ?? 604_800 }],
          scopes: [{ address: ALPHA, selector: 'transferWithMemo(address,uint256,bytes32)' }],
        },
      }
    : { ok: true, key: {} }
}

const submit = async () => {
  ;(ids['budget-form'] as El).fire('submit')
  await vi.waitFor(() => expect((ids.authorize as El).disabled).toBe(false))
  await flush()
}
const statusText = () => (ids.status as El).textContent

beforeEach(() => {
  h.account = { address: TREASURY }
  h.authorized = []
  h.revoked = []
  h.requests = []
  state = { policy: { id: 'pol_000001', name: 'Judges', status: 'active' }, signs: 'bot', key: null, keys: [], session: { address: TREASURY }, isTreasurer: true, signInRequired: false }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("a policy's budget page (browser code)", () => {
  it('says the policy pays from the shared bot key budget, and shows exactly what will be signed, for this policy only', async () => {
    page()
    await vi.waitFor(() => expect((fields['budget-status'] as El).textContent).toContain("pays from the bot key's budget"))
    expect((fields['key-signs'] as El).textContent).toMatch(/^You will sign, for this policy only: Up to 30 AlphaUSD every 7 days\. Only transferWithMemo on AlphaUSD/)
    expect((ids.authorize as El).textContent).toBe('Give this policy its own budget')
  })

  it('signs the authorisation it built from the form, then confirms it with the server', async () => {
    h.answer = provisioned()
    page()
    await flush()
    await submit()
    expect(h.authorized).toHaveLength(1)
    expect(h.authorized[0]).toMatchObject({ keyAddress: NEW_KEY, auth: { limits: [{ token: ALPHA, limit: '30000000', period: 604_800 }] }, revoke: [] })
    expect(h.requests.map((r) => r.path)).toContain('/setup/tok/policies/pol_000001/key/confirm')
    expect(statusText()).toBe('Judges has its own budget now. Transaction: https://explore.testnet.tempo.xyz/tx/0xabc')
  })

  it('refuses to sign a tampered server answer: a bigger limit, a longer period or another expiry; no passkey prompt, nothing confirmed', async () => {
    for (const tampered of [{ limit: '300000000' }, { period: 30 * 86_400 }, { expiry: NOW + 366 * 86_400 }]) {
      h.answer = provisioned(tampered)
      h.requests = []
      page()
      await flush()
      await submit()
      expect(h.authorized).toEqual([])
      expect(statusText()).toMatch(/^Nothing was signed: the server's copy of the authorisation has (different spending limits|a different expiry)/)
      expect(h.requests.map((r) => r.path)).not.toContain('/setup/tok/policies/pol_000001/key/confirm')
    }
  })

  it("a replacement revokes this policy's live key in the same transaction, and nothing else", async () => {
    state = { ...state, signs: 'own', key: keyView(OLD_KEY), keys: [keyView(OLD_KEY)] }
    h.answer = provisioned()
    page()
    await vi.waitFor(() => expect((fields['budget-status'] as El).textContent).toContain('20 of 30 AlphaUSD left'))
    expect((ids.authorize as El).textContent).toBe("Replace this policy's key with these limits")
    expect((fields['key-replaces'] as El).textContent).toContain("The bot key and other policies' keys are not touched")
    await submit()
    expect(h.authorized).toMatchObject([{ keyAddress: NEW_KEY, revoke: [OLD_KEY] }])
  })

  it('revoking signs the revoke with the passkey, then reports it to the server', async () => {
    state = { ...state, signs: 'own', key: keyView(OLD_KEY), keys: [keyView(OLD_KEY)] }
    page()
    await vi.waitFor(() => expect((ids['live-keys'] as El).children).toHaveLength(1))
    const button = ((ids['live-keys'] as El).children[0] as El).children[1] as El
    expect(button.textContent).toBe("Revoke this policy's key")
    button.fire('click')
    await vi.waitFor(() => expect(statusText()).toBe("This policy's key is revoked."))
    expect(h.revoked).toEqual([OLD_KEY])
    expect(h.requests.find((r) => r.path.endsWith('/key/revoked'))?.body).toEqual({ keyAddress: OLD_KEY })
  })

  it('a revoked key says the policy is stopped and never falls back to the bot key', async () => {
    state = { ...state, signs: 'retired', key: { ...keyView(OLD_KEY, 'revoked'), chain: null }, keys: [] }
    page()
    await vi.waitFor(() => expect((fields['budget-status'] as El).textContent).toBe("This policy's own key is revoked: it pays nothing until you give it a new budget. It never falls back to the bot key."))
  })
})
