import type { TreasuryChannelSource } from '@rolepay/core'
import type { GuildChannel } from '../ports.js'
import { esc } from './format.js'
import { csrfField } from './layout.js'

/** What the Overview shows of the treasury channel (`treasuryChannelState` reads it). */
export type TreasuryChannelState = {
  channelId: string | null
  source: TreasuryChannelSource
  /** The server's text channels; null when not read (no channels port, nobody needs them, or Discord did not answer). */
  channels: GuildChannel[] | null
  /** Rolepay found the channel named "treasury" and took it on this page view (its confirmation is posted). */
  found: boolean
  /** The server lists channels on this Rolepay server (the port is wired). */
  listable: boolean
}

/** The question when nobody has chosen a treasury channel and none named "treasury" was found. */
const ASK = 'Rolepay posts what needs a Treasurer in a channel of its own. Create a private #treasury channel, or choose one:'

const DONE: Record<string, string> = {
  treasury_set: 'Saved. Rolepay posted a message there to show it works: what needs a Treasurer goes there from now on.',
  treasury_set_public:
    "Saved, but everyone in the server can see that channel. Make it visible only to the Treasurer role and Rolepay, in the channel's permissions in Discord.",
  treasury_none: 'Saved. No treasury channel: each run is posted in its policy\'s channel (or where it was made), with its buttons.',
}
const ERRORS: Record<string, string> = {
  cannot_post: 'Rolepay could not post in that channel, so nothing was saved. Add Rolepay to the channel, with permission to send messages.',
  unavailable: 'Discord did not answer, so nothing was saved. Try again in a moment.',
  unknown_channel: 'That is not a text channel of this server. Nothing was saved.',
  invalid_input: 'Choose a channel, or None.',
  not_permitted: 'Only the Treasurer role can choose the treasury channel.',
  not_available: 'This Rolepay server cannot list Discord channels, so the treasury channel cannot be chosen here.',
}

/** The answer to the setting's form, shown in its card. */
export function treasuryChannelNotice(done: string | undefined, error: string | undefined): string {
  if (done && DONE[done]) return `<p class="notice ${done === 'treasury_set_public' ? 'warn' : 'ok'}" role="status">${DONE[done]}</p>`
  if (error && /^[a-z_]{1,40}$/.test(error)) return `<p class="notice bad" role="alert">${ERRORS[error] ?? `That did not work (${esc(error)}).`}</p>`
  return ''
}

/**
 * Above the Overview's panels, for a Treasurer: Rolepay just found #treasury and took it, or nobody
 * has chosen a treasury channel yet and there is none to find (the question, pointing to the setting).
 */
export function treasuryChannelPrompt(s: TreasuryChannelState, canAct: boolean): string {
  if (!canAct || !s.listable) return ''
  const name = s.channels?.find((c) => c.id === s.channelId)?.name
  if (s.found && name) return `<p class="notice ok" role="status">Rolepay found #${esc(name)} and posts there what needs a Treasurer from now on (it said so in the channel). <a href="#treasury-channel">Change it</a>.</p>`
  if (s.source === 'unset' && s.channelId === null) return `<p class="notice warn" role="status">${ASK.replace('choose one:', '<a href="#treasury-channel">choose one</a>.')}</p>`
  return ''
}

/**
 * The treasury channel setting (the Overview's card): where it is now, what goes there and that it
 * should be private, and for a Treasurer the choice of the server's text channels, or none. Outside the
 * live regions: a choice being made is never swapped away.
 */
export function treasuryChannelCard(d: { guildId: string; state: TreasuryChannelState; canAct: boolean; csrf: string; notice: string }): string {
  const s = d.state
  const current = s.channelId ? s.channels?.find((c) => c.id === s.channelId) : undefined
  const head = '<h2>Treasury channel</h2>'
  const now = current
    ? `<p class="big">#${esc(current.name)}</p><p class="muted small">${s.source === 'found' ? 'Found by its name.' : 'Chosen by a Treasurer.'}</p>`
    : s.channelId && s.channels
      ? `<p>A channel that is no longer in this server (ID <code>${esc(s.channelId)}</code>). Until another is chosen, runs are posted in their policy's channel with their buttons.</p>`
      : s.channelId
        ? `<p>Set (channel ID <code>${esc(s.channelId)}</code>).</p>`
        : s.source === 'chosen'
          ? "<p>None: each run is posted in its policy's channel (or where it was made), with its buttons.</p>"
          : `<p>Not set yet. ${d.canAct ? ASK : 'A Treasurer chooses it here, or creates a private #treasury channel in Discord, which Rolepay then uses.'}</p>`
  const what =
    '<p class="muted small">Rolepay posts there everything only a Treasurer can act on: runs to approve, runs you can veto, and runs it holds, with their buttons. The channel each would have gone to gets a copy without the buttons.</p>' +
    "<p class=\"muted small\">Make it visible only to the Treasurer role and Rolepay: set that in Discord, in the channel's permissions. The buttons only ever work for the Treasurer role.</p>"
  const open = current?.everyoneCanView
    ? `<p class="notice warn" role="alert">Everyone in the server can see #${esc(current.name)}. Make it visible only to the Treasurer role and Rolepay, in the channel's permissions in Discord.</p>`
    : ''
  return `<section class="card" id="treasury-channel">${head}${now}${open}${d.notice}${what}${d.canAct ? form(d) : ''}</section>`
}

function form(d: { guildId: string; state: TreasuryChannelState; csrf: string }): string {
  const s = d.state
  if (!s.listable) return ''
  if (!s.channels) return '<p class="muted small">Discord did not answer, so the channels cannot be listed. Reload in a moment.</p>'
  const unset = s.source === 'unset' && s.channelId === null
  const opt = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`
  const options = [
    unset ? '<option value="" disabled selected>Choose a channel</option>' : '',
    opt('none', "None: post in each policy's own channel", s.source === 'chosen' && s.channelId === null),
    ...s.channels.map((c) => opt(c.id, `#${c.name}${c.everyoneCanView ? ' (everyone can see it)' : ''}`, c.id === s.channelId)),
  ].join('')
  return `<form method="post" action="/dashboard/${esc(d.guildId)}/treasury-channel">${csrfField(d.csrf)}
<div class="field"><label for="treasury-channel-choice">Channel</label><select id="treasury-channel-choice" name="channel" required>${options}</select></div>
<button type="submit">Save</button><p class="muted small">Saving posts a short message in the channel, so you can see Rolepay can post there.</p></form>`
}
