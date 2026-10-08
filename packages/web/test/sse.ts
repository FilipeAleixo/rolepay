// Reads a server-sent event stream in a test: text as it arrives, the events parsed, and a way to
// hang up like a browser leaving the page.

export type SseEvent = { event: string; id: string | null; data: unknown }

export function sseReader(res: Response) {
  if (!res.body) throw new Error('no stream')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let done = false
  const events = (): SseEvent[] =>
    text
      .split('\n\n')
      .filter((block) => /^event: /m.test(block))
      .map((block) => ({
        event: /^event: (.*)$/m.exec(block)?.[1] ?? '',
        id: /^id: (.*)$/m.exec(block)?.[1] ?? null,
        data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null'),
      }))
  return {
    get text() {
      return text
    },
    get done() {
      return done
    },
    events,
    /** Reads until `until` holds for the text so far, the stream ends, or `ms` pass. */
    async read(until: (text: string) => boolean, ms = 2_000): Promise<string> {
      const deadline = Date.now() + ms
      while (!done && !until(text) && Date.now() < deadline) {
        const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))])
        if (next === null) break
        if (next.done) done = true
        else text += decoder.decode(next.value, { stream: true })
      }
      return text
    },
    /** The browser goes away. */
    cancel: () => reader.cancel(),
  }
}
