/**
 * Small JSON records with an optional expiry, for state that is not a domain entity:
 * passkey credentials, challenges and sessions (the web layer, through the Accounts SDK's
 * `Handler.webAuthn`), and once-only delivery markers (the Discord layer). The shape
 * matches the Accounts SDK's `Kv`, so adapting it is a passthrough.
 *
 * Values must be JSON-serialisable. TTLs are in seconds.
 */
export interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<void>
  delete(key: string): Promise<void>
  /** Atomic create-if-absent (an expired value counts as absent). True only for the one call that wrote it. */
  create(key: string, value: unknown, options?: { ttl?: number }): Promise<boolean>
  /** Atomic read-and-delete: across concurrent callers exactly one gets the value. */
  take<T = unknown>(key: string): Promise<T | undefined>
  /**
   * Deletes every expired record and says how many. Expiry is otherwise lazy (an expired record
   * reads as absent), so records nobody reads again (an abandoned modal's message, a proposal)
   * would stay on disk; the server sweeps on its recovery interval.
   */
  sweep(): Promise<number>
}
