import type { LiveEvent } from '@rolepay/core'
import { Hono } from 'hono'
import { failure } from '../../json.js'
import { eventStream } from '../../live/streams.js'
import { communityAccess } from '../access.js'
import type { DashboardKit } from '../kit.js'

/** What a dashboard page hears about an event: its kind and what it is about, never who or what was said. */
const view = (e: LiveEvent) => ({ seq: e.seq, type: e.type, runId: e.runId, policyId: e.policyId, policyRunId: e.policyRunId })

/**
 * `GET /dashboard/:guildId/live`: one community's events as server-sent events, for its pages to
 * re-read what changed. Gated like the pages it serves: a signed-in session whose member the bot sees
 * in that guild right now (read fresh at connect, as for an action), and checked again at every
 * heartbeat (the session still exists, the member is still there), so signing out or leaving the
 * guild ends the stream within a heartbeat. A reconnecting page gets what it missed after its
 * Last-Event-ID (the audit sequence number), at most 50 events.
 */
export function liveRoutes(kit: DashboardKit): Hono {
  const app = new Hono()
  app.get('/dashboard/:guildId/live', async (c) => {
    const live = kit.live
    if (!live || !kit.rolepay.live.enabled) return failure(404, { code: 'live_not_available' })
    const access = await communityAccess(kit, c, { fresh: true })
    if (!access.ok) return access.response
    const guildId = access.value.community.id
    const userId = access.value.viewer.userId
    const lastId = Number.parseInt(c.req.header('last-event-id') ?? '', 10)
    return eventStream(live, c.req.raw, {
      sessionKey: `discord:${userId}`,
      open: async (sink) => {
        const stop = kit.rolepay.live.community({ guildId }, (e) => sink.send('audit', view(e), e.seq))
        if (Number.isSafeInteger(lastId) && lastId > 0) for (const e of await kit.rolepay.live.since({ guildId, after: lastId })) sink.send('audit', view(e), e.seq)
        return stop
      },
      stillAllowed: async () => {
        const current = await kit.session(c.req.raw)
        return current !== null && current.session.userId === userId && (await kit.members.member(guildId, userId)) !== null
      },
    })
  })
  return app
}
