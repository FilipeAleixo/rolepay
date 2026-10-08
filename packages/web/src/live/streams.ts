import { toJson } from '../json.js'

/**
 * Server-sent events for the pages that update live (`/dashboard/:guildId/live`, `/account/live`).
 * A stream sends `retry:` first (how long a browser waits before reconnecting), then events as
 * they happen, and a comment line every `heartbeatMs` (20 s) so the proxy in front (Fly's) never
 * sees an idle connection. Each heartbeat also asks the route whether the stream may go on (the
 * session still live, the member still in the guild); a "no" closes it. Closing for any reason
 * (the browser left, the route said no, the server ends it) runs the route's cleanup exactly once.
 */

/** How a route writes to its stream. */
export type EventSink = {
  /** One event: `event: name`, `id:` when given (a browser sends the last one back as Last-Event-ID), `data:` as JSON. */
  send(name: string, data: unknown, id?: number): void
  close(): void
}

/** Open streams per key (a session, a client address). Over the limit, the stream is refused with 429. */
export class StreamCap {
  private readonly open = new Map<string, number>()

  /** Takes one slot under every key, or none when any is full: returns the release (idempotent), or null. */
  take(slots: { key: string; max: number }[]): (() => void) | null {
    if (slots.some((s) => (this.open.get(s.key) ?? 0) >= s.max)) return null
    for (const s of slots) this.open.set(s.key, (this.open.get(s.key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const s of slots) {
        const n = (this.open.get(s.key) ?? 1) - 1
        if (n <= 0) this.open.delete(s.key)
        else this.open.set(s.key, n)
      }
    }
  }

  /** Streams open under `key` (tests check that a closed stream gives its slot back). */
  count(key: string): number {
    return this.open.get(key) ?? 0
  }
}

/** The limits and timings every live stream shares. One per web app. */
export type LiveStreams = {
  cap: StreamCap
  /** The client's address as the rate limits take it (the proxy's header). */
  clientKey: (req: Request) => string
  heartbeatMs: number
  retryMs: number
  /** Open streams per signed-in session (a person with a few tabs), and per client address (a household, an office). */
  perSession: number
  perClient: number
}

export type LiveStreamOptions = Partial<Omit<LiveStreams, 'clientKey' | 'cap'>>

export function liveStreams(clientKey: (req: Request) => string, opts: LiveStreamOptions = {}): LiveStreams {
  return { cap: new StreamCap(), clientKey, heartbeatMs: 20_000, retryMs: 5_000, perSession: 6, perClient: 30, ...opts }
}

const encoder = new TextEncoder()

/**
 * The stream for one request, or 429 when its session or client already has as many open as allowed.
 * `open` subscribes and returns the unsubscribe; `stillAllowed` is asked at every heartbeat.
 */
export function eventStream(
  live: LiveStreams,
  req: Request,
  opts: { sessionKey: string; open: (sink: EventSink) => (() => void) | Promise<() => void>; stillAllowed?: () => Promise<boolean> },
): Response {
  const release = live.cap.take([
    { key: `session:${opts.sessionKey}`, max: live.perSession },
    { key: `client:${live.clientKey(req)}`, max: live.perClient },
  ])
  if (!release) {
    return new Response(toJson({ ok: false, error: { code: 'too_many_streams' } }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' } })
  }
  let closed = false
  let cleanup: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const write = (text: string) => {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      close()
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    req.signal.removeEventListener('abort', close)
    cleanup?.()
    cleanup = null
    release()
    try {
      controller?.close()
    } catch {
      // already closed or cancelled by the browser
    }
  }
  const sink: EventSink = {
    send(name, data, id) {
      write(`event: ${name}\n${id === undefined ? '' : `id: ${id}\n`}data: ${toJson(data)}\n\n`)
    },
    close,
  }
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c
      write(`retry: ${live.retryMs}\n\n`)
      req.signal.addEventListener('abort', close)
      try {
        const stop = await opts.open(sink)
        if (closed) stop()
        else cleanup = stop
      } catch {
        close()
        return
      }
      heartbeat = setInterval(() => {
        write(': ping\n\n')
        void (opts.stillAllowed?.() ?? Promise.resolve(true)).then(
          (ok) => {
            if (!ok) close()
          },
          () => close(),
        )
      }, live.heartbeatMs)
      ;(heartbeat as { unref?: () => void }).unref?.()
    },
    cancel() {
      close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' },
  })
}
