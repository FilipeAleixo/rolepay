import type { Community, KeyStatusView, NetworkName } from '@payrun/core'
import type { Embed, Message } from '../api.js'
import { COLORS, NO_PINGS, addressUrl, relativeTime, roleMention, shortAddress, tokenLabel } from './format.js'
import { keyText } from './key.js'

/** The treasury page link, issued to the person who ran /payrun setup. */
export type SetupLinkView = { url: string; expiresAt: Date }

export type SetupView = {
  community: Community
  key: KeyStatusView | null
  notices: string[]
  /** The treasury page for this caller, or null when they may not have it (they are not a treasurer). */
  setupLink: SetupLinkView | null
  authorizeHint: string | null
  network: NetworkName
}

const approverText = (roleId: string | null, separate: boolean | undefined, unset: string) =>
  roleId ? `${roleMention(roleId)} approves runs.${separate ? ' The person who created a run cannot approve it.' : ''}` : unset

const feesText = (feeMode: string, feeToken: string | null) => (feeMode === 'sponsor' ? 'Sponsored' : `From a fee budget in ${tokenLabel(feeToken ?? '')}`)

const linkField = (link: SetupLinkView) => ({
  name: 'Treasury page',
  value: `[Open the treasury page](${link.url}) (only for you, works until ${relativeTime(link.expiresAt)}). There you sign with your passkey: authorise or change the bot key, see the deposit address, or revoke the key.`,
})

/** The admin's view of a community after /payrun setup: what is configured and what is left to do. */
export function setupMessage(v: SetupView): Message {
  const c = v.community
  const keyReady = v.key?.key.status === 'active' && v.key.state.status === 'active'
  const keyUnusable = !v.key || v.key.key.status === 'revoked' || v.key.state.status === 'revoked' || v.key.state.status === 'expired'
  const next: string[] = []
  if (!c.approverRoleId) next.push('Set the approver role: `/payrun setup approver_role:@Treasurer`.')
  if (v.key?.key.status === 'pending_authorization') {
    next.push(`Authorise the bot key on the treasury page with the treasury passkey.${v.authorizeHint ? ` ${v.authorizeHint}` : ''}`)
  } else if (keyUnusable) {
    next.push('Authorise a new bot key on the treasury page with the treasury passkey.')
  }
  if (keyReady && c.approverRoleId) next.push('Ready. Members register with `/payee link`; create a run with `/payrun new`.')
  if (!v.setupLink && c.approverRoleId) {
    next.push(`The treasury page link goes to members with Manage Server and ${roleMention(c.approverRoleId)}: one of them runs /payrun setup.`)
  }

  const fields: NonNullable<Embed['fields']> = [
    { name: 'Treasury', value: `[${shortAddress(c.treasuryAddress)}](${addressUrl(v.network, c.treasuryAddress)})`, inline: true },
    { name: 'Payout token', value: tokenLabel(c.payoutToken), inline: true },
    { name: 'Fees', value: feesText(c.feeMode, c.feeToken), inline: true },
    { name: 'Approver role', value: approverText(c.approverRoleId, c.requireSeparateApprover, 'Not set. Nobody can approve runs until you set one.') },
    { name: 'Bot key', value: v.key ? keyText(v.key) : 'None yet.' },
  ]
  if (v.notices.length) fields.push({ name: 'Note', value: v.notices.join('\n') })
  if (v.setupLink) fields.push(linkField(v.setupLink))
  if (next.length) fields.push({ name: 'Next', value: next.map((n) => `• ${n}`).join('\n') })

  return {
    embeds: [{ title: c.name ? `payrun setup: ${c.name}` : 'payrun setup', color: keyReady && c.approverRoleId ? COLORS.paid : COLORS.pending, fields }],
    allowed_mentions: NO_PINGS,
  }
}

/** The first /payrun setup: nothing is registered until the treasurer creates the treasury on the page. */
export function firstSetupMessage(v: {
  settings: { name: string | null; payoutToken: string; feeMode: string; feeToken: string | null; approverRoleId: string | null; requireSeparateApprover?: boolean }
  setupLink: SetupLinkView
}): Message {
  const s = v.settings
  return {
    embeds: [
      {
        title: s.name ? `payrun setup: ${s.name}` : 'payrun setup',
        color: COLORS.pending,
        description:
          "One step left, on the treasury page: create the community's Tempo account with your passkey (it becomes the account's root key, payrun never holds it), then choose what the bot may spend and authorise it.",
        fields: [
          { name: 'Payout token', value: tokenLabel(s.payoutToken), inline: true },
          { name: 'Fees', value: feesText(s.feeMode, s.feeToken), inline: true },
          { name: 'Approver role', value: approverText(s.approverRoleId, s.requireSeparateApprover, 'Not set.') },
          linkField(v.setupLink),
        ],
      },
    ],
    allowed_mentions: NO_PINGS,
  }
}
