import type { Community, KeyStatusView, NetworkName } from '@payrun/core'
import type { Embed, Message } from '../api.js'
import { COLORS, NO_PINGS, addressUrl, money, relativeTime, roleMention, shortAddress, tokenLabel } from './format.js'

export type SetupView = {
  community: Community
  key: KeyStatusView | null
  notices: string[]
  authorizeHint: string | null
  network: NetworkName
}

/** The admin's view of a community after /payrun setup: what is configured and what is left to do. */
export function setupMessage(v: SetupView): Message {
  const c = v.community
  const keyReady = v.key?.key.status === 'active' && v.key.state.status === 'active'
  const next: string[] = []
  if (!c.approverRoleId) next.push('Set the approver role: `/payrun setup approver_role:@Treasurer`.')
  if (v.key?.key.status === 'pending_authorization') next.push(`Authorise the bot key from the treasury. ${v.authorizeHint ?? 'The treasury signs it on the setup page.'}`)
  if (keyReady && c.approverRoleId) next.push('Ready. Members register with `/payee link`; create a run with `/payrun new`.')

  const fields: NonNullable<Embed['fields']> = [
    { name: 'Treasury', value: `[${shortAddress(c.treasuryAddress)}](${addressUrl(v.network, c.treasuryAddress)})`, inline: true },
    { name: 'Payout token', value: tokenLabel(c.payoutToken), inline: true },
    { name: 'Fees', value: c.feeMode === 'sponsor' ? 'Sponsored' : `From a fee budget in ${tokenLabel(c.feeToken ?? '')}`, inline: true },
    {
      name: 'Approver role',
      value: c.approverRoleId ? `${roleMention(c.approverRoleId)} approves runs.` : 'Not set. Nobody can approve runs until you set one.',
    },
    { name: 'Bot key', value: v.key ? keyText(v.key) : 'None yet.' },
  ]
  if (v.notices.length) fields.push({ name: 'Note', value: v.notices.join('\n') })
  if (next.length) fields.push({ name: 'Next', value: next.map((n) => `• ${n}`).join('\n') })

  return {
    embeds: [{ title: 'payrun setup', color: keyReady && c.approverRoleId ? COLORS.paid : COLORS.pending, fields }],
    allowed_mentions: NO_PINGS,
  }
}

function keyText({ key, state }: KeyStatusView): string {
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
