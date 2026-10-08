// The dashboard, live. A community's pages carry their stream's URL (`<body data-live>`) and mark the
// parts that change (`data-live-region`). When an event arrives, this re-reads the page from the
// server (the same URL, the same session) and swaps those parts in, so all rendering and escaping
// stays on the server and every page still works without this script. A run's page
// (`data-live-run`) re-reads only for events about that run.
import { type EventSourceFactory, type EventSourceLike, type RegionLike, coalesce, follow, swapRegions } from './live.js'

export type DashboardLiveEnv = {
  document: {
    body: { getAttribute(name: string): string | null } | null
    querySelectorAll(selector: string): ArrayLike<RegionLike & { getAttribute(name: string): string | null }>
  }
  EventSource: EventSourceFactory
  fetch: (url: string, init: { credentials: 'same-origin'; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  /** HTML to a document to read the fresh regions from (DOMParser in the browser). */
  parse: (html: string) => { querySelector(selector: string): { innerHTML: string } | null }
  /** The page's own URL, query included (filters, page number, a notice). */
  href: () => string
  setTimeout?: (fn: () => void, ms: number) => unknown
}

/** Merges a burst of events (approved, executing, paid within a second) into one re-read. */
const REREAD_DELAY_MS = 250

/** Starts following this page's stream, or does nothing on a page with nothing live. Returns the stream. */
export function startDashboardLive(env: DashboardLiveEnv): EventSourceLike | null {
  const url = env.document.body?.getAttribute('data-live') ?? null
  const regions = () => env.document.querySelectorAll('[data-live-region]')
  if (!url || regions().length === 0) return null
  const onlyRun = Array.from(regions())
    .map((r) => r.getAttribute('data-live-run'))
    .find((id): id is string => !!id)
  let source: EventSourceLike | null = null
  const reread = coalesce(
    async () => {
      const res = await env.fetch(env.href(), { credentials: 'same-origin', headers: { accept: 'text/html' } })
      // Signed out, or no longer a member: stop listening; the next click shows why.
      if (res.status === 401 || res.status === 403) return source?.close()
      if (!res.ok) return
      swapRegions(regions(), env.parse(await res.text()))
    },
    REREAD_DELAY_MS,
    env.setTimeout,
  )
  source = follow(
    url,
    {
      audit: (data) => {
        const runId = (data as { runId?: string | null } | null)?.runId ?? null
        if (onlyRun && runId !== onlyRun) return
        reread()
      },
    },
    { EventSource: env.EventSource, onReconnect: reread },
  )
  return source
}
