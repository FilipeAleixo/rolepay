import type { KeyStatusView } from '@payrun/core'
import { money, relativeTime, shortAddress, tokenLabel } from './format.js'

/** The bot key in one paragraph: what it may spend and what the chain says about it now. */
export function keyText({ key, state }: KeyStatusView): string {
  const p = key.policy
  const per = p.periodSeconds ? ` per ${period(p.periodSeconds)}` : ' in total'
  const scope = `It can only send ${tokenLabel(p.token)} with transferWithMemo, up to ${money(p.limit, p.token)}${per}, until ${relativeTime(p.expiresAt)}.`
  const id = shortAddress(key.address)
  if (key.status === 'pending_authorization') return `${id}: Waiting for the treasury to authorise it. ${scope}`
  if (key.status === 'revoked' || state.status === 'revoked') return `${id}: Revoked by the treasury.`
  if (state.status === 'expired') return `${id}: Expired.`
  if (state.status !== 'active') return `${id}: The chain does not show it as authorised.`
  const resets = state.periodEnd ? ` (resets ${relativeTime(state.periodEnd)})` : ''
  return `${id}: Active. ${money(state.remaining, p.token)} of ${money(p.limit, p.token)} left${resets}. Expires ${relativeTime(state.expiry)}.`
}

function period(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'day' : `${seconds / 86_400} days`
  if (seconds % 3_600 === 0) return seconds === 3_600 ? 'hour' : `${seconds / 3_600} hours`
  return `${seconds} seconds`
}
