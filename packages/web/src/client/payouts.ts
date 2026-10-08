// The payee's choice of stablecoin, per community that pays them: one select each, saved through
// /account/preference for the passkey session's own address (the server never takes an address
// from the page). Used by the account page and, for one community, by the claim page.
import { get, post } from './dom.js'

export type Choice = { address: string; label: string }
/** One community that pays this passkey account, as /account/payouts answers. */
export type Payout = { guildId: string; communityName: string | null; payoutToken: Choice; preferredToken: string | null; enabled: boolean; choices: Choice[] }

const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

/** What a choice stores: null for the community's own payout token (no preference). */
export const storedChoice = (payoutToken: string, value: string): string | null => (same(value, payoutToken) ? null : value)

/** In words: what this community pays the payee in, given their choice. */
export function payoutText(p: Payout, chosen: string | null): string {
  const name = p.communityName ?? 'This community'
  const label = p.choices.find((c) => same(c.address, chosen))?.label ?? chosen ?? ''
  if (chosen === null || same(chosen, p.payoutToken.address)) return `${name} pays you in ${p.payoutToken.label}.`
  if (p.enabled) return `${name} pays you in ${label}, bought with ${p.payoutToken.label} on Tempo's stablecoin exchange in the same transaction.`
  return `${name} pays everyone in ${p.payoutToken.label} for now; you get ${label} once its treasurer turns on preferred stablecoins.`
}

/**
 * The coins the account page lists for these communities (lowercase addresses): what each one pays
 * this account in, its payout token or the payee's choice, and the choice even while the community
 * still pays everyone in its payout token (both then). `preferred` is the choices alone, which the
 * page marks.
 */
export function coinsToList(payouts: Payout[]): { listed: Set<string>; preferred: Set<string> } {
  const listed = new Set<string>()
  const preferred = new Set<string>()
  for (const p of payouts) {
    const chosen = p.preferredToken === null || same(p.preferredToken, p.payoutToken.address) ? null : p.preferredToken.toLowerCase()
    if (chosen) {
      preferred.add(chosen)
      listed.add(chosen)
    }
    if (!chosen || !p.enabled) listed.add(p.payoutToken.address.toLowerCase())
  }
  return { listed, preferred }
}

/** Saves one community's choice. The answer says what is stored, or why not, in words. */
export async function savePreference(guildId: string, payoutToken: string, value: string): Promise<{ ok: true; preferredToken: string | null } | { ok: false; error: string }> {
  const r = await post<{ preferredToken: string | null }>('/account/preference', { guildId, token: storedChoice(payoutToken, value) })
  if (r.ok) return { ok: true, preferredToken: r.preferredToken }
  const why: Record<string, string> = {
    no_passkey_session: 'sign in with your passkey first',
    payee_not_found: 'this passkey is not registered with that community',
    token_not_allowed: 'that community cannot pay in this token',
  }
  return { ok: false, error: why[r.error.code] ?? r.error.code }
}

/**
 * One labelled select per community, built with the DOM (never HTML strings), saving on change.
 * `report` shows the outcome (the page's status line); `saved` hears each choice the server stored.
 */
export function renderPayouts(
  box: HTMLElement,
  payouts: Payout[],
  report: (text: string, tone: 'ok' | 'bad') => void,
  saved: (guildId: string, preferredToken: string | null) => void = () => {},
) {
  if (payouts.length === 0) {
    const none = document.createElement('p')
    none.className = 'muted'
    none.textContent = 'This account is not registered with any community on this server yet.'
    box.replaceChildren(none)
    return
  }
  box.replaceChildren(
    ...payouts.flatMap((p) => {
      const id = `payout-${p.guildId}`
      const label = document.createElement('label')
      label.htmlFor = id
      label.textContent = `Paid by ${p.communityName ?? 'a community'} in`
      const select = document.createElement('select')
      select.id = id
      select.replaceChildren(
        ...p.choices.map((c, i) => {
          const o = document.createElement('option')
          o.value = c.address
          o.textContent = i === 0 ? `${c.label} (the default)` : c.label
          return o
        }),
      )
      select.value = p.choices.find((c) => same(c.address, p.preferredToken))?.address ?? p.payoutToken.address
      const says = document.createElement('p')
      says.className = 'muted'
      says.textContent = payoutText(p, p.preferredToken)
      select.addEventListener('change', () => {
        void savePreference(p.guildId, p.payoutToken.address, select.value).then((r) => {
          if (!r.ok) return report(`Not saved: ${r.error}.`, 'bad')
          says.textContent = payoutText(p, r.preferredToken)
          saved(p.guildId, r.preferredToken)
          report('Saved.', 'ok')
        })
      })
      return [label, select, says]
    }),
  )
}

/** Where the signed-in passkey is paid. null when the server has no passkey session for this browser (sign in first). */
export async function loadPayouts(): Promise<Payout[] | null> {
  const r = await get<{ payouts: Payout[] }>('/account/payouts')
  return r.ok ? r.payouts : null
}
