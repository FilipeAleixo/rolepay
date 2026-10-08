import type { Message } from '../api.js'
import { NO_PINGS } from './format.js'

/**
 * What Rolepay posts in a channel when it becomes the treasury channel (a Treasurer chose it on the
 * dashboard, or Rolepay found a channel named "treasury"): what will be posted there. Posting it is
 * also the check that Rolepay can post there at all.
 */
export const TREASURY_CHANNEL_CONFIRMATION = 'Rolepay will post here what needs a Treasurer: policies and runs to approve, runs you can veto, and runs it holds.'

export const treasuryChannelConfirmation = (): Message => ({ content: TREASURY_CHANNEL_CONFIRMATION, allowed_mentions: NO_PINGS })

/**
 * To the person who made a run (only them), once its message with Approve is in the treasury channel
 * and its copy without the buttons is in this channel. The private channel is never named in public.
 */
export const sentToTreasurers = (): Message => ({
  content: 'Posted. A Treasurer approves it in the treasury channel; this channel shows the run without its buttons.',
  allowed_mentions: NO_PINGS,
})

/** The same, to the author of a policy (only them), once its preview with Approve policy is in the treasury channel. */
export const policySentToTreasurers = (): Message => ({
  content: 'Posted. A Treasurer approves it in the treasury channel; this channel shows the policy without its buttons.',
  allowed_mentions: NO_PINGS,
})
