import type { Community, KeyStatusView, NetworkName } from '@payrun/core'
import type { Embed, Message } from '../api.js'
import { COLORS, NO_PINGS, addressUrl, roleMention, shortAddress, tokenLabel } from './format.js'
import { keyText } from './key.js'

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
