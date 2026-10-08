import { findTreasuryChannel, mayFindTreasuryChannel } from '@rolepay/core'
import type { CommunityAccess } from './access.js'
import type { DashboardKit } from './kit.js'
import type { GuildChannel } from './ports.js'
import type { TreasuryChannelState } from './views/treasuryChannel.js'

/** A Discord read slower than this is shown as unavailable rather than holding the page. */
const DISCORD_TIMEOUT_MS = 5_000

/** The server's text channels, or null when Discord does not answer in time (the page never waits longer). */
export async function readChannels(kit: DashboardKit, guildId: string): Promise<GuildChannel[] | null> {
  if (!kit.channels) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DISCORD_TIMEOUT_MS)
    })
    return await Promise.race([kit.channels.textChannels(guildId), late])
  } catch (error) {
    kit.onError?.(error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The treasury channel for the Overview. The channels are read for a Treasurer (the select) or to
 * name the channel set. When a Treasurer opens the page while nobody has chosen one (or the channel
 * set is gone from the server), Rolepay looks for a text channel named "treasury", posts its
 * confirmation there and takes it, as the Discord side does before its first such message: the
 * same rule (core's `findTreasuryChannel`), the same audited pick, and a Treasurer's choice still wins.
 */
export async function treasuryChannelState(kit: DashboardKit, a: CommunityAccess): Promise<TreasuryChannelState> {
  const c = a.community
  const state: TreasuryChannelState = { channelId: c.treasuryChannelId, source: c.treasuryChannelSource, channels: null, found: false, listable: kit.channels !== undefined }
  if (!kit.channels || !(a.viewer.canAct || c.treasuryChannelId !== null)) return state
  const channels = await readChannels(kit, c.id)
  if (!channels) return state
  state.channels = channels
  if (!a.viewer.canAct) return state
  const gone = c.treasuryChannelId !== null && !channels.some((x) => x.id === c.treasuryChannelId)
  const replacing = gone ? c.treasuryChannelId : null
  if (!mayFindTreasuryChannel(c, replacing)) return state
  const found = findTreasuryChannel(channels.filter((x) => x.id !== replacing))
  if (!found || !(await kit.channels.confirm(found.id)).ok) return state
  const taken = await kit.rolepay.communities.useFoundTreasuryChannel({ guildId: c.id, channelId: found.id, replacing })
  if (taken.ok) return { ...state, channelId: found.id, source: 'found', found: true }
  // Decided meanwhile (a Treasurer, or Discord's side found it first): show what is set now.
  const now = await kit.rolepay.communities.get(c.id)
  return now.ok ? { ...state, channelId: now.value.treasuryChannelId, source: now.value.treasuryChannelSource } : state
}
