// A fake EventSource for the browser code's tests.

/** An EventSource the test drives: `emit` a named event, `open` the connection (again). */
export class FakeEventSource {
  static last: FakeEventSource | null = null
  closed = false
  private readonly listeners = new Map<string, ((e: { data?: string }) => void)[]>()
  constructor(readonly url: string) {
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  close() {
    this.closed = true
  }
}
