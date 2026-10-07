// The payee's choice of stablecoin in the browser (the account and claim pages), on a small fake
// DOM with fetch faked: what is sent (never an address), what is shown, and what a refusal says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Payout, payoutText, renderPayouts, savePreference, storedChoice } from './payouts.js'

const ALPHA = '0x20c0000000000000000000000000000000000001'
const BETA = '0x20c0000000000000000000000000000000000002'
const GUILD = '1094309218049937418'
const payout = (over: Partial<Payout> = {}): Payout => ({
  guildId: GUILD,
  communityName: 'Mods guild',
  payoutToken: { address: ALPHA, label: 'AlphaUSD' },
  preferredToken: null,
  enabled: true,
  choices: [
    { address: ALPHA, label: 'AlphaUSD' },
    { address: BETA, label: 'BetaUSD' },
  ],
  ...over,
})

class El {
  id = ''
  htmlFor = ''
  value = ''
  className = ''
  textContent = ''
  children: El[] = []
  private listeners: (() => void)[] = []
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn)
  }
  change(value: string) {
    this.value = value
    for (const fn of this.listeners) fn()
  }
  replaceChildren(...c: El[]) {
    this.children = c
  }
}

let posted: { url: string; body: unknown }[]
let answer: unknown
beforeEach(() => {
  posted = []
  answer = { ok: true, preferredToken: BETA }
  vi.stubGlobal('document', { createElement: () => new El() })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(answer))
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("a payee's choice of stablecoin, in the browser", () => {
  it('stores the payout token as no preference', () => {
    expect(storedChoice(ALPHA, ALPHA.toUpperCase().replace('0X', '0x'))).toBeNull()
    expect(storedChoice(ALPHA, BETA)).toBe(BETA)
  })

  it('says how they are paid: the payout token, their choice bought on the exchange, or their choice waiting for the treasurer', () => {
    expect(payoutText(payout(), null)).toBe('Mods guild pays you in AlphaUSD.')
    expect(payoutText(payout(), BETA)).toBe("Mods guild pays you in BetaUSD, bought with AlphaUSD on Tempo's stablecoin exchange in the same transaction.")
    expect(payoutText(payout({ enabled: false }), BETA)).toBe('Mods guild pays everyone in AlphaUSD for now; you get BetaUSD once its treasurer turns on preferred stablecoins.')
  })

  it('sends the community and the token, never an address, and explains a refusal in words', async () => {
    expect(await savePreference(GUILD, ALPHA, BETA)).toEqual({ ok: true, preferredToken: BETA })
    expect(posted).toEqual([{ url: '/account/preference', body: { guildId: GUILD, token: BETA } }])
    answer = { ok: false, error: { code: 'no_passkey_session' } }
    expect(await savePreference(GUILD, ALPHA, ALPHA)).toEqual({ ok: false, error: 'sign in with your passkey first' })
    expect(posted[1]?.body).toEqual({ guildId: GUILD, token: null })
  })

  it('renders one select per community with the current choice, and saves a change', async () => {
    const box = new El()
    const reports: string[] = []
    renderPayouts(box as never, [payout({ preferredToken: BETA })], (t) => reports.push(t))
    const [label, select, says] = box.children
    expect(label?.textContent).toBe('Paid by Mods guild in')
    expect(select?.children.map((o) => o.textContent)).toEqual(['AlphaUSD (the default)', 'BetaUSD'])
    expect(select?.value).toBe(BETA)
    expect(says?.textContent).toContain('pays you in BetaUSD')
    answer = { ok: true, preferredToken: null }
    select?.change(ALPHA)
    await vi.waitFor(() => expect(reports).toEqual(['Saved.']))
    expect(posted).toEqual([{ url: '/account/preference', body: { guildId: GUILD, token: null } }])
    expect(says?.textContent).toBe('Mods guild pays you in AlphaUSD.')
  })

  it('says so when the account is not registered anywhere', () => {
    const box = new El()
    renderPayouts(box as never, [], () => {})
    expect(box.children[0]?.textContent).toMatch(/not registered/)
  })
})
